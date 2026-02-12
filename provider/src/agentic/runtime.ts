import type {
  GitLabDuoAgenticProviderOptions,
  ClientEvent,
  DuoWorkflowEvent,
  ToolApproval,
  ToolApprovalPolicy,
  ToolResponseType,
  WorkflowAction,
  WorkflowType,
} from "./types"
import { createWorkflow, getWorkflowToken, WorkflowCreateError, type GenerateTokenResponse } from "./workflow_service"
import { WebSocketWorkflowClient } from "./workflow_client"
import { WorkflowEventMapper, type AgentEvent } from "./workflow_event_mapper"
import { createLogger } from "./logger"
import { getSystemContextItems } from "./system_context"
import { detectProjectPath, fetchProjectDetailsWithFallback } from "./gitlab_utils"
import { AsyncQueue } from "./async_queue"
import { mapWorkflowActionToToolRequest } from "./action_handler"
import fs from "fs/promises"
import path from "path"
import os from "os"
import { ProxyAgent } from "proxy-agent"

type RuntimeEvent = AgentEvent | { type: "TOOL_REQUEST"; requestId: string; toolName: string; args: Record<string, unknown>; responseType?: ToolResponseType }

type PendingTool = { requestId: string; toolName: string; responseType?: ToolResponseType }

export class GitLabAgenticRuntime {
  #options: GitLabDuoAgenticProviderOptions
  #selectedModelIdentifier?: string
  #logger = createLogger()
  #workflowIds = new Map<string, string>()
  #wsClient?: WebSocketWorkflowClient
  #workflowToken?: GenerateTokenResponse
  #queue?: AsyncQueue<RuntimeEvent>
  #stream?: { write: (data: unknown) => boolean; on: (event: string, handler: (...args: any[]) => void) => void }
  #mapper = new WorkflowEventMapper(createLogger())
  #pendingTool?: PendingTool
  #containerParams?: { projectId?: string; namespaceId?: string }
  #sessionId?: string
  #startRequestSent = false

  get #currentWorkflowId(): string | undefined {
    return this.#workflowIds.get(this.#sessionId ?? "__default__")
  }

  set #currentWorkflowId(value: string | undefined) {
    const key = this.#sessionId ?? "__default__"
    if (value) this.#workflowIds.set(key, value)
    else this.#workflowIds.delete(key)
  }

  constructor(options: GitLabDuoAgenticProviderOptions) {
    this.#options = options
  }

  // ---------------------------------------------------------------------------
  // Public accessors
  // ---------------------------------------------------------------------------

  get pendingTool(): PendingTool | undefined {
    return this.#pendingTool
  }

  get hasStarted(): boolean {
    return this.#startRequestSent
  }

  setSessionId(sessionId?: string): void {
    if (sessionId && sessionId !== this.#sessionId) {
      this.#logger.warn(`session changed: ${this.#sessionId ?? "(none)"} -> ${sessionId}, resetting connection`)
      this.#resetStreamState()
    }
    this.#sessionId = sessionId
  }

  setSelectedModelIdentifier(ref?: string): void {
    if (ref === this.#selectedModelIdentifier) return
    this.#logger.warn(`model changed: ${this.#selectedModelIdentifier ?? "(default)"} -> ${ref ?? "(default)"}`)
    this.#selectedModelIdentifier = ref
    this.#resetStreamState()
  }

  clearPendingTool(): void {
    this.#pendingTool = undefined
  }

  resetMapperState(): void {
    this.#mapper.resetStreamState()
  }

  // ---------------------------------------------------------------------------
  // Connection lifecycle
  // ---------------------------------------------------------------------------

  async ensureConnected(goal: string, workflowType: WorkflowType): Promise<void> {
    if (this.#stream && this.#currentWorkflowId && this.#queue) {
      this.#logger.warn("already connected, reusing")
      return
    }

    if (!this.#containerParams) {
      this.#logger.warn(`detecting project from cwd=${process.cwd()} instance=${this.#options.instanceUrl}`)
      this.#containerParams = await this.#resolveContainerParams()
      this.#logger.warn(`resolved project=${this.#containerParams.projectId} namespace=${this.#containerParams.namespaceId}`)
    }

    if (!this.#currentWorkflowId) {
      this.#currentWorkflowId = await this.#ensureWorkflow(goal, workflowType)
      this.#logger.warn(`workflow=${this.#currentWorkflowId} type=${workflowType}`)
    }

    this.#logger.warn(`fetching workflow token for type=${workflowType}`)
    const token = await getWorkflowToken(this.#options.instanceUrl, this.#options.apiKey, workflowType)
    this.#workflowToken = token
    this.#logger.warn("workflow token acquired")

    const MAX_LOCK_RETRIES = 3
    const LOCK_RETRY_DELAY_MS = 3000

    for (let attempt = 1; attempt <= MAX_LOCK_RETRIES; attempt++) {
      this.#queue = new AsyncQueue<RuntimeEvent>()
      try {
        this.#logger.warn(`connecting websocket to ${this.#options.instanceUrl} (attempt ${attempt}/${MAX_LOCK_RETRIES})`)
        await this.#connectWebSocket()
        this.#logger.warn("websocket connected")
        return
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if ((msg.includes("1013") || msg.includes("lock")) && attempt < MAX_LOCK_RETRIES) {
          this.#logger.warn(`workflow ${this.#currentWorkflowId} locked, retrying in ${LOCK_RETRY_DELAY_MS}ms (attempt ${attempt}/${MAX_LOCK_RETRIES})`)
          this.#resetStreamState()
          await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_DELAY_MS))
          const retryToken = await getWorkflowToken(this.#options.instanceUrl, this.#options.apiKey, workflowType)
          this.#workflowToken = retryToken
          continue
        }
        if (msg.includes("1013") || msg.includes("lock")) {
          this.#logger.error(`workflow ${this.#currentWorkflowId} still locked after ${MAX_LOCK_RETRIES} attempts`)
          throw new Error("GitLab Duo workflow is locked (another session may still be active). Please try again in a few seconds.")
        }
        this.#logger.error(`websocket connection failed: ${msg}`)
        throw new Error(`GitLab Duo connection failed: ${msg}`)
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Messaging
  // ---------------------------------------------------------------------------

  sendStartRequest(
    goal: string,
    workflowType: WorkflowType,
    toolApproval?: ToolApproval,
    mcpTools: NonNullable<ClientEvent["startRequest"]>["mcpTools"] = [],
    preapprovedTools: string[] = [],
    extraContext: Array<{ category: string; content?: string | null; id?: string; metadata?: Record<string, unknown> }> = [],
  ): void {
    if (!this.#stream || !this.#currentWorkflowId) throw new Error("Workflow client not initialized")
    this.#logger.warn(`startRequest: tools=${mcpTools.length} preapproved=${preapprovedTools.length} approval=${!!toolApproval}`)
    const additionalContext =
      this.#options.sendSystemContext === false
        ? []
        : getSystemContextItems(this.#options.systemRules)
    additionalContext.push(...extraContext)
    const startRequest: ClientEvent = {
      startRequest: {
        workflowID: this.#currentWorkflowId!,
        clientVersion: "1.0",
        workflowDefinition: workflowType,
        goal: toolApproval ? "" : goal,
        workflowMetadata: JSON.stringify({
          project_id: this.#containerParams?.projectId,
          namespace_id: this.#containerParams?.namespaceId,
        }),
        additional_context: additionalContext.map((context) => ({
          ...context,
          metadata: context.metadata ? JSON.stringify(context.metadata) : undefined,
        })),
        clientCapabilities: ["shell_command"],
        mcpTools,
        preapproved_tools: preapprovedTools,
        approval:
          toolApproval
            ? {
                approval: toolApproval.userApproved === true ? {} : undefined,
                rejection:
                  toolApproval.userApproved === false
                    ? { message: toolApproval.message }
                    : undefined,
              }
            : undefined,
      },
    }

    this.#stream.write(startRequest)
    this.#startRequestSent = true
  }

  sendToolResponse(requestId: string, response: { output: string; error?: string }, responseType?: ToolResponseType): void {
    if (!this.#stream) throw new Error("Workflow client not initialized")
    this.#logger.warn(`toolResponse: requestId=${requestId} type=${responseType ?? "plain"} error=${!!response.error} outputLen=${response.output?.length ?? 0}`)

    if (responseType === "http") {
      const parsed = parseHttpToolOutput(response.output)
      const event: ClientEvent = {
        actionResponse: {
          requestID: requestId,
          httpResponse: {
            status: parsed.status,
            headers: parsed.headers,
            response: parsed.body,
            error: response.error ?? "",
          },
        },
      }
      this.#stream.write(event)
      return
    }

    const event: ClientEvent = {
      actionResponse: {
        requestID: requestId,
        plainTextResponse: {
          response: response.output,
          error: response.error ?? "",
        },
      },
    }
    this.#stream.write(event)
  }

  getEventStream(): AsyncGenerator<RuntimeEvent> {
    if (!this.#queue) throw new Error("Workflow stream not initialized")
    return this.#queue.iterate()
  }

  static buildToolApproval(prompt: string, pending: PendingTool | undefined, policy: ToolApprovalPolicy): ToolApproval | undefined {
    if (policy !== "ask") return undefined
    if (!pending) return undefined
    if (prompt.trim() === "/approve") {
      return { userApproved: true, toolName: pending.toolName, type: "approve-for-session" }
    }
    if (prompt.trim() === "/reject") {
      return { userApproved: false, message: "User rejected tool call" }
    }
    return undefined
  }

  // ---------------------------------------------------------------------------
  // Private: project / workflow resolution
  // ---------------------------------------------------------------------------

  async #resolveContainerParams(): Promise<{ projectId?: string; namespaceId?: string }> {
    const projectPath = await detectProjectPath(process.cwd(), this.#options.instanceUrl)
    if (!projectPath) {
      throw new Error(
        "Unable to detect GitLab project. Ensure you run OpenCode in a Git repository with a GitLab remote.",
      )
    }

    try {
      const details = await fetchProjectDetailsWithFallback(
        this.#options.instanceUrl,
        this.#options.apiKey,
        projectPath,
      )
      return {
        projectId: details.projectId,
        namespaceId: details.namespaceId,
      }
    } catch {
      throw new Error(
        "Failed to fetch GitLab project details. Check that the remote URL is correct and the token has access.",
      )
    }
  }

  async #ensureWorkflow(goal: string, workflowType: WorkflowType): Promise<string> {
    await this.#loadWorkflowId()
    if (this.#currentWorkflowId) {
      this.#logger.warn(`reusing cached workflow=${this.#currentWorkflowId}`)
      return this.#currentWorkflowId
    }
    this.#logger.warn(`creating new workflow type=${workflowType}`)
    try {
      const workflowId = await createWorkflow(
        this.#options.instanceUrl,
        this.#options.apiKey,
        goal,
        workflowType,
        this.#containerParams,
      )
      this.#currentWorkflowId = workflowId
      this.#logger.warn(`created workflow=${workflowId}`)
      await this.#persistWorkflowId()
      return workflowId
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error)
      this.#logger.error(`workflow creation failed: ${errMsg}`)
      if (
        error instanceof WorkflowCreateError &&
        error.status === 400 &&
        error.body.includes("No default namespace found")
      ) {
        throw new Error(
          "No default namespace found. Ensure this repository has a GitLab remote so the namespace can be detected.",
        )
      }
      throw error
    }
  }

  // ---------------------------------------------------------------------------
  // Private: WebSocket stream binding
  // ---------------------------------------------------------------------------

  #bindStream(
    stream: AsyncIterable<WorkflowAction>,
    queue: AsyncQueue<RuntimeEvent>,
  ): void {
    const handleAction = async (action: WorkflowAction) => {
      // --- Checkpoint updates (non-tool actions) ---
      if (action.newCheckpoint) {
        const duoEvent: DuoWorkflowEvent = {
          checkpoint: action.newCheckpoint.checkpoint,
          errors: action.newCheckpoint.errors || [],
          workflowGoal: action.newCheckpoint.goal,
          workflowStatus: action.newCheckpoint.status,
        }
        const events = await this.#mapper.mapWorkflowEvent(duoEvent)
        const interesting = events.filter((e) => e.type !== "TEXT_CHUNK")
        if (interesting.length > 0) {
          this.#logger.warn(`ckpt ${action.newCheckpoint.status} → ${interesting.map((e) => e.type).join(", ")}`)
        }
        for (const event of events) queue.push(event)
        return
      }

      // --- Tool requests (delegated to action_handler) ---
      const toolRequest = mapWorkflowActionToToolRequest(action)
      if (toolRequest) {
        this.#logger.warn(`ws ${toolRequest.toolName}: requestID=${toolRequest.requestId} args=${JSON.stringify(toolRequest.args).slice(0, 200)}`)
        this.#pendingTool = {
          requestId: toolRequest.requestId,
          toolName: toolRequest.toolName,
          responseType: toolRequest.responseType,
        }
        queue.push({
          type: "TOOL_REQUEST",
          ...toolRequest,
        })
        return
      }

      const actionKey = Object.keys(action).find((k) => k !== "requestID" && (action as Record<string, unknown>)[k])
      this.#logger.warn(`ws action (unhandled): ${actionKey ?? "unknown"}`)
    }

    if ("on" in (stream as any)) {
      ;(stream as any).on("data", (action: WorkflowAction) => {
        handleAction(action)
      })
      ;(stream as any).on("error", (err: Error) => {
        this.#logger.warn(`stream error: ${err.message}`)
        queue.push({ type: "ERROR", message: err.message, timestamp: Date.now() })
        queue.close()
        this.#resetStreamState()
      })
      ;(stream as any).on("end", () => {
        this.#logger.warn("stream ended")
        queue.close()
        this.#resetStreamState()
      })
    }
  }

  async #connectWebSocket(): Promise<void> {
    if (!this.#queue) return
    if (!this.#workflowToken) throw new Error("Workflow token unavailable")

    this.#wsClient = new WebSocketWorkflowClient(createLogger(), {
      gitlabInstanceUrl: new URL(this.#options.instanceUrl),
      token: this.#options.apiKey,
      headers: buildWorkflowHeaders(
        this.#workflowToken.duo_workflow_service.headers,
        this.#containerParams,
      ),
      selectedModelIdentifier: this.#selectedModelIdentifier,
      ...resolveWebSocketAgentOptions(),
    })

    const stream = await this.#wsClient.executeWorkflow()
    this.#stream = stream
    this.#bindStream(stream as unknown as AsyncIterable<WorkflowAction>, this.#queue)
  }

  #resetStreamState(): void {
    this.#stream = undefined
    this.#queue = undefined
    this.#pendingTool = undefined
    this.#startRequestSent = false
    this.#wsClient?.dispose()
    this.#wsClient = undefined
  }

  // ---------------------------------------------------------------------------
  // Private: workflow ID persistence
  // ---------------------------------------------------------------------------

  async #loadWorkflowId(): Promise<void> {
    if (this.#currentWorkflowId || !this.#sessionId) return
    const filePath = workflowMapFile()
    try {
      const raw = await fs.readFile(filePath, "utf8")
      const data = JSON.parse(raw) as Record<string, { workflowId?: string; updatedAt?: number }>
      const entry = data[this.#sessionId]
      if (entry?.workflowId) {
        this.#currentWorkflowId = entry.workflowId
        this.#logger.warn(`loaded cached workflowId=${entry.workflowId} for session=${this.#sessionId}`)
      }
    } catch {
      this.#logger.warn(`no cached workflow for session=${this.#sessionId}`)
    }
  }

  async #persistWorkflowId(): Promise<void> {
    if (!this.#sessionId || !this.#currentWorkflowId) return
    const dir = workflowMapDir()
    await fs.mkdir(dir, { recursive: true })
    const filePath = workflowMapFile()
    let data: Record<string, { workflowId: string; updatedAt: number }> = {}
    try {
      const raw = await fs.readFile(filePath, "utf8")
      data = JSON.parse(raw) as typeof data
    } catch {
      // file doesn't exist yet, start fresh
    }
    data[this.#sessionId] = { workflowId: this.#currentWorkflowId, updatedAt: Date.now() }
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8")
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

function buildWorkflowHeaders(
  headers: Record<string, string>,
  containerParams?: { projectId?: string; namespaceId?: string },
): Record<string, string> {
  const result = normalizeHeaders(headers)
  if (containerParams?.projectId) {
    result["x-gitlab-project-id"] = containerParams.projectId
  }
  if (containerParams?.namespaceId) {
    result["x-gitlab-namespace-id"] = containerParams.namespaceId
  }
  const featureSetting = process.env.GITLAB_AGENT_PLATFORM_FEATURE_SETTING_NAME
  if (featureSetting) {
    result["x-gitlab-agent-platform-feature-setting-name"] = featureSetting
  }
  return result
}

function workflowMapDir(): string {
  return path.join(os.homedir(), ".local", "share", "opencode", "duo-workflow")
}

function workflowMapFile(): string {
  return path.join(workflowMapDir(), "workflow-map.json")
}

function normalizeHeaders(headers: Record<string, string>): Record<string, string> {
  const normalized: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers || {})) {
    normalized[key.toLowerCase()] = value
  }
  return normalized
}

function resolveWebSocketAgentOptions(): { agent?: object; agentType?: "proxy" } {
  if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY) {
    return { agent: new ProxyAgent(), agentType: "proxy" }
  }
  return {}
}

function parseHttpToolOutput(output: string): { status: number; headers: Record<string, string>; body: string } {
  const lines = output.trimEnd().split("\n")
  const lastLine = lines[lines.length - 1]?.trim() ?? ""
  const statusCode = parseInt(lastLine, 10)

  if (!Number.isNaN(statusCode) && statusCode >= 100 && statusCode < 600) {
    return {
      status: statusCode,
      headers: {},
      body: lines.slice(0, -1).join("\n"),
    }
  }

  return { status: 0, headers: {}, body: output }
}
