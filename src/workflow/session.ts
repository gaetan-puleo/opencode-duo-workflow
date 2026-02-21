import { randomUUID } from "node:crypto"
import {
  WORKFLOW_CLIENT_VERSION,
  WORKFLOW_DEFINITION,
  WORKFLOW_ENVIRONMENT,
} from "../constants"
import { type GitLabClientOptions, post } from "../gitlab/client"
import { fetchProjectDetails, detectProjectPath, resolveRootNamespaceId } from "../gitlab/project"
import { AsyncQueue } from "../utils/async-queue"
import { createCheckpointState, extractAgentTextDeltas, extractToolRequests, type CheckpointState } from "./checkpoint"
import { WorkflowTokenService } from "./token-service"
import type {
  AdditionalContext,
  ClientEvent,
  McpToolDefinition,
  WorkflowAction,
  WorkflowToolAction,
  WorkflowCreateResponse,
} from "./types"
import { isCheckpointAction, isTurnComplete, isToolApproval } from "./types"
import { WorkflowWebSocketClient } from "./websocket-client"
import { mapActionToToolRequest } from "./action-mapper"
import { dlog } from "../utils/debug-log"

/**
 * Optional configuration for overriding the server-side system prompt
 * and/or registering additional MCP tools. When not set, the server
 * uses its default prompt and built-in tools.
 */
export type WorkflowToolsConfig = {
  mcpTools: McpToolDefinition[]
  flowConfig?: Record<string, unknown>
  flowConfigSchemaVersion?: string
}

/** Events emitted by the session's event stream. */
export type SessionEvent =
  | { type: "text-delta"; value: string }
  | { type: "tool-request"; requestId: string; toolName: string; args: Record<string, unknown> }
  | { type: "error"; message: string }

export class WorkflowSession {
  #client: GitLabClientOptions
  #tokenService: WorkflowTokenService
  #modelId: string
  #cwd: string
  #workflowId: string | undefined
  #projectPath: string | undefined
  #rootNamespaceId: string | undefined
  #checkpoint: CheckpointState = createCheckpointState()
  #toolsConfig: WorkflowToolsConfig | undefined
  #socket: WorkflowWebSocketClient | undefined
  #queue: AsyncQueue<SessionEvent> | undefined
  #startRequestSent = false
  #pendingApproval = false
  #resumed = false

  #onWorkflowCreated: ((workflowId: string) => void) | undefined

  constructor(client: GitLabClientOptions, modelId: string, cwd: string, options?: {
    existingWorkflowId?: string
    onWorkflowCreated?: (workflowId: string) => void
  }) {
    this.#client = client
    this.#tokenService = new WorkflowTokenService(client)
    this.#modelId = modelId
    this.#cwd = cwd
    if (options?.existingWorkflowId) {
      this.#workflowId = options.existingWorkflowId
      this.#resumed = true
    }
    this.#onWorkflowCreated = options?.onWorkflowCreated
  }

  /**
   * Opt-in: override the server-side system prompt and/or register MCP tools.
   */
  setToolsConfig(config: WorkflowToolsConfig): void {
    this.#toolsConfig = config
  }

  get workflowId(): string | undefined {
    return this.#workflowId
  }

  get hasStarted(): boolean {
    return this.#startRequestSent
  }

  reset(): void {
    this.#workflowId = undefined
    this.#checkpoint = createCheckpointState()
    this.#tokenService.clear()
    this.#closeConnection()
    this.#pendingApproval = false
    this.#resumed = false
    this.#startRequestSent = false
  }

  // ---------------------------------------------------------------------------
  // Connection lifecycle (persistent)
  // ---------------------------------------------------------------------------

  async ensureConnected(goal: string): Promise<void> {
    if (this.#socket && this.#queue) return

    if (!this.#workflowId) {
      this.#workflowId = await this.#createWorkflow(goal)
    }

    const queue = new AsyncQueue<SessionEvent>()
    this.#queue = queue
    await this.#connectSocket(queue)
  }

  /**
   * Open a WebSocket and wire its callbacks to the given queue.
   * Replaces any existing socket but does NOT create a new queue.
   */
  async #connectSocket(queue: AsyncQueue<SessionEvent>): Promise<void> {
    await this.#tokenService.get(this.#rootNamespaceId)

    const socket = new WorkflowWebSocketClient({
      action: (action) => this.#handleAction(action, queue),
      error: (error) => queue.push({ type: "error", message: error.message }),
      close: (code, reason) => {
        dlog(`ws-close: code=${code} reason=${reason} pendingApproval=${this.#pendingApproval}`)
        this.#socket = undefined
        if (this.#pendingApproval) {
          this.#pendingApproval = false
          this.#reconnectWithApproval(queue)
        } else {
          this.#queue = undefined
          queue.close()
        }
      },
    })

    const url = buildWebSocketUrl(this.#client.instanceUrl, this.#modelId)
    await socket.connect(url, {
      authorization: `Bearer ${this.#client.token}`,
      origin: new URL(this.#client.instanceUrl).origin,
      "x-request-id": randomUUID(),
      "x-gitlab-client-type": "node-websocket",
    })

    this.#socket = socket
  }

  // ---------------------------------------------------------------------------
  // Messaging
  // ---------------------------------------------------------------------------

  sendStartRequest(
    goal: string,
    additionalContext: AdditionalContext[] = [],
  ): void {
    if (!this.#socket || !this.#workflowId) throw new Error("Not connected")

    const mcpTools = this.#toolsConfig?.mcpTools ?? []
    const preapprovedTools = mcpTools.map((t) => t.name)

    this.#socket.send({
      startRequest: {
        workflowID: this.#workflowId,
        clientVersion: WORKFLOW_CLIENT_VERSION,
        workflowDefinition: WORKFLOW_DEFINITION,
        goal,
        workflowMetadata: JSON.stringify({
          extended_logging: false,
        }),
        clientCapabilities: ["shell_command"],
        mcpTools,
        additional_context: additionalContext,
        preapproved_tools: preapprovedTools,
        ...(this.#toolsConfig?.flowConfig ? {
          flowConfig: this.#toolsConfig.flowConfig,
          flowConfigSchemaVersion: this.#toolsConfig.flowConfigSchemaVersion ?? "v1",
        } : {}),
      },
    })
    this.#startRequestSent = true
  }

  /**
   * Send a tool result back to DWS on the existing connection.
   */
  sendToolResult(requestId: string, output: string, error?: string): void {
    dlog(`sendToolResult: reqId=${requestId} output=${output.length}b error=${error ?? "none"} socket=${!!this.#socket}`)
    if (!this.#socket) throw new Error("Not connected")
    this.#socket.send({
      actionResponse: {
        requestID: requestId,
        plainTextResponse: {
          response: output,
          error: error ?? "",
        },
      },
    })
  }

  /**
   * Send an HTTP response back to DWS on the existing connection.
   * Used for gitlab_api_request which requires httpResponse (not plainTextResponse).
   */
  sendHttpResult(requestId: string, statusCode: number, headers: Record<string, string>, body: string, error?: string): void {
    dlog(`sendHttpResult: reqId=${requestId} status=${statusCode} body=${body.length}b error=${error ?? "none"} socket=${!!this.#socket}`)
    if (!this.#socket) throw new Error("Not connected")
    this.#socket.send({
      actionResponse: {
        requestID: requestId,
        httpResponse: {
          statusCode,
          headers,
          body,
          error: error ?? "",
        },
      },
    })
  }

  /**
   * Wait for the next event from the session.
   * Returns null when the stream is closed (turn complete or connection lost).
   */
  async waitForEvent(): Promise<SessionEvent | null> {
    if (!this.#queue) return null
    return this.#queue.shift()
  }

  /**
   * Send an abort signal to DWS and close the connection.
   */
  abort(): void {
    this.#socket?.send({ stopWorkflow: { reason: "ABORTED" } })
    this.#closeConnection()
  }

  // ---------------------------------------------------------------------------
  // Private: action handling
  // ---------------------------------------------------------------------------

  #handleAction(action: WorkflowAction, queue: AsyncQueue<SessionEvent>): void {
    // --- Checkpoint actions ---
    if (isCheckpointAction(action)) {
      const ckpt = action.newCheckpoint.checkpoint
      const status = action.newCheckpoint.status

      dlog(`checkpoint: status=${status} ckptLen=${ckpt.length}`)

      // Extract agent text deltas (always — to keep checkpoint state current).
      const deltas = extractAgentTextDeltas(ckpt, this.#checkpoint)
      if (this.#resumed) {
        // First checkpoint after resume: state is now populated with old text.
        // Discard deltas to avoid re-emitting old messages to OpenCode.
        dlog(`checkpoint: RESUMED — discarding ${deltas.length} old deltas, fast-forwarding state`)
        this.#resumed = false
      } else {
        for (const delta of deltas) {
          queue.push({ type: "text-delta", value: delta })
        }
        if (deltas.length > 0) {
          dlog(`checkpoint: ${deltas.length} text deltas`)
        }
      }

      if (isToolApproval(status)) {
        // DWS wants tool approval. Don't extract tool requests from the
        // checkpoint — the actual tool will arrive as a standalone action
        // after we auto-approve. Don't close the queue; DWS will close
        // the stream, triggering #reconnectWithApproval via the close callback.
        dlog(`checkpoint: TOOL_APPROVAL → pendingApproval=true (waiting for DWS close)`)
        this.#pendingApproval = true
        return
      }

      // Checkpoint "request" entries are for UI display only (VS Code approval UI).
      // Real tool calls arrive as standalone WebSocket actions with proper requestIDs.
      // const toolRequests = extractToolRequests(ckpt, this.#checkpoint)
      // for (const req of toolRequests) {
      //   queue.push({
      //     type: "tool-request",
      //     requestId: req.requestId,
      //     toolName: req.toolName,
      //     args: req.args,
      //   })
      // }

      if (isTurnComplete(status)) {
        dlog(`checkpoint: turnComplete → close queue+connection`)
        queue.close()
        this.#closeConnection()
      }
      return
    }

    // --- HTTP requests: handle directly (DWS expects httpResponse, not plainTextResponse) ---
    const toolAction = action as WorkflowToolAction
    if (toolAction.runHTTPRequest && toolAction.requestID) {
      dlog(`standalone: httpRequest ${toolAction.runHTTPRequest.method} ${toolAction.runHTTPRequest.path} reqId=${toolAction.requestID}`)
      this.#executeHttpRequest(toolAction.requestID, toolAction.runHTTPRequest)
        .catch(() => {}) // errors handled internally
      return
    }

    // --- Standalone WebSocket tool actions ---
    // Forward to OpenCode via the queue so they go through the tool
    // execution and permission system (instead of executing locally).
    const mapped = mapActionToToolRequest(toolAction)
    if (mapped) {
      dlog(`standalone: ${mapped.toolName} reqId=${mapped.requestId} args=${JSON.stringify(mapped.args).slice(0, 200)}`)
      queue.push({
        type: "tool-request",
        requestId: mapped.requestId,
        toolName: mapped.toolName,
        args: mapped.args,
      })
    } else {
      dlog(`standalone: UNMAPPED action keys=${Object.keys(action).join(",")}`)
    }
  }

  // ---------------------------------------------------------------------------
  // Private: HTTP request handling (gitlab_api_request)
  // ---------------------------------------------------------------------------

  /**
   * Execute a GitLab API request directly and send the response as httpResponse.
   * DWS is the only action that expects httpResponse instead of plainTextResponse.
   * Runs async in the background (fire-and-forget from #handleAction).
   */
  async #executeHttpRequest(requestId: string, request: { method: string; path: string; body?: string }): Promise<void> {
    try {
      const url = `${this.#client.instanceUrl}/api/v4/${request.path}`
      dlog(`httpRequest: ${request.method} ${request.path} reqId=${requestId}`)

      const init: RequestInit = {
        method: request.method,
        headers: {
          "authorization": `Bearer ${this.#client.token}`,
          "content-type": "application/json",
        },
      }
      if (request.body) {
        init.body = request.body
      }

      const response = await fetch(url, init)
      const body = await response.text()
      const headers: Record<string, string> = {}
      response.headers.forEach((value, key) => { headers[key] = value })

      dlog(`httpRequest: ${request.method} ${request.path} → ${response.status} body=${body.length}b`)
      this.sendHttpResult(requestId, response.status, headers, body)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      dlog(`httpRequest: ERROR ${request.method} ${request.path} → ${message}`)
      this.sendHttpResult(requestId, 0, {}, "", message)
    }
  }

  // ---------------------------------------------------------------------------
  // Private: connection management
  // ---------------------------------------------------------------------------

  /**
   * Auto-approve at DWS protocol level and reconnect.
   *
   * DWS closed the stream after TOOL_CALL_APPROVAL_REQUIRED. We open a new
   * WebSocket, send startRequest with approval, and wire it to the SAME queue
   * so Phase 3 in the model continues consuming events seamlessly.
   *
   * The actual tool execution still goes through OpenCode's permission system
   * when the standalone action arrives on the new stream.
   */
  #reconnectWithApproval(queue: AsyncQueue<SessionEvent>): void {
    dlog(`reconnectWithApproval: starting (workflowId=${this.#workflowId})`)
    this.#connectSocket(queue)
      .then(() => {
        if (!this.#socket || !this.#workflowId) {
          dlog(`reconnectWithApproval: FAILED no socket/workflowId`)
          queue.close()
          return
        }

        const mcpTools = this.#toolsConfig?.mcpTools ?? []
        dlog(`reconnectWithApproval: sending startRequest with approval (mcpTools=${mcpTools.length})`)

        this.#socket.send({
          startRequest: {
            workflowID: this.#workflowId,
            clientVersion: WORKFLOW_CLIENT_VERSION,
            workflowDefinition: WORKFLOW_DEFINITION,
            goal: "",
            workflowMetadata: JSON.stringify({ extended_logging: false }),
            clientCapabilities: ["shell_command"],
            mcpTools,
            additional_context: [],
            preapproved_tools: mcpTools.map((t) => t.name),
            approval: { approval: {} },
          },
        })
        this.#startRequestSent = true
        dlog(`reconnectWithApproval: approval sent, waiting for standalone actions`)
      })
      .catch((err) => {
        dlog(`reconnectWithApproval: ERROR ${err instanceof Error ? err.message : String(err)}`)
        this.#queue = undefined
        queue.close()
      })
  }

  #closeConnection(): void {
    this.#pendingApproval = false
    this.#socket?.close()
    this.#socket = undefined
    this.#queue = undefined
    this.#startRequestSent = false
  }

  async #createWorkflow(goal: string): Promise<string> {
    await this.#loadProjectContext()

    const body = {
      goal,
      workflow_definition: WORKFLOW_DEFINITION,
      environment: WORKFLOW_ENVIRONMENT,
      allow_agent_to_request_user: true,
      ...(this.#projectPath ? { project_id: this.#projectPath } : {}),
    }

    const created = await post<WorkflowCreateResponse>(this.#client, "ai/duo_workflows/workflows", body)
    if (created.id === undefined || created.id === null) {
      const details = [created.message, created.error].filter(Boolean).join("; ")
      throw new Error(`failed to create workflow${details ? `: ${details}` : ""}`)
    }

    const workflowId = String(created.id)
    this.#onWorkflowCreated?.(workflowId)
    return workflowId
  }

  async #loadProjectContext(): Promise<void> {
    if (this.#projectPath !== undefined) return

    const projectPath = await detectProjectPath(this.#cwd, this.#client.instanceUrl)
    this.#projectPath = projectPath

    if (!projectPath) return

    try {
      const project = await fetchProjectDetails(this.#client, projectPath)
      this.#rootNamespaceId = await resolveRootNamespaceId(this.#client, project.namespaceId)
    } catch {
      this.#rootNamespaceId = undefined
    }
  }
}

function buildWebSocketUrl(instanceUrl: string, modelId: string): string {
  const base = new URL(instanceUrl.endsWith("/") ? instanceUrl : `${instanceUrl}/`)
  const url = new URL("api/v4/ai/duo_workflows/ws", base)
  if (base.protocol === "https:") url.protocol = "wss:"
  if (base.protocol === "http:") url.protocol = "ws:"
  if (modelId) url.searchParams.set("user_selected_model_identifier", modelId)
  return url.toString()
}
