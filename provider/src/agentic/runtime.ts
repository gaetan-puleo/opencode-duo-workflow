import type {
  GitLabDuoAgenticProviderOptions,
  ClientEvent,
  DuoWorkflowEvent,
  ToolApproval,
  ToolApprovalPolicy,
  WorkflowAction,
  WorkflowType,
} from "./types"
import { createWorkflow, getWorkflowToken, WorkflowCreateError } from "./workflow_service"
import { WebSocketWorkflowClient } from "./workflow_client"
import { WorkflowEventMapper, type AgentEvent } from "./workflow_event_mapper"
import { ToolInputFormatter } from "./tool_input_formatter"
import { createLogger } from "./logger"
import { getSystemContextItems } from "./system_context"
import fs from "fs/promises"
import path from "path"

type RuntimeEvent = AgentEvent | { type: "TOOL_REQUEST"; requestId: string; toolName: string; args: Record<string, unknown> }

type PendingTool = { requestId: string; toolName: string }

class AsyncQueue<T> {
  #items: T[] = []
  #resolvers: Array<(value: IteratorResult<T>) => void> = []
  #closed = false

  push(item: T): void {
    if (this.#closed) return
    const resolver = this.#resolvers.shift()
    if (resolver) {
      resolver({ value: item, done: false })
      return
    }
    this.#items.push(item)
  }

  close(): void {
    this.#closed = true
    while (this.#resolvers.length > 0) {
      const resolver = this.#resolvers.shift()
      if (resolver) resolver({ value: undefined as unknown as T, done: true })
    }
  }

  async *iterate(): AsyncGenerator<T> {
    while (true) {
      if (this.#items.length > 0) {
        yield this.#items.shift() as T
        continue
      }

      if (this.#closed) return

      const next = await new Promise<IteratorResult<T>>((resolve) => {
        this.#resolvers.push(resolve)
      })
      if (next.done) return
      yield next.value
    }
  }
}

export class GitLabAgenticRuntime {
  #options: GitLabDuoAgenticProviderOptions
  #workflowId?: string
  #client?: WebSocketWorkflowClient
  #queue?: AsyncQueue<RuntimeEvent>
  #mapper = new WorkflowEventMapper(new ToolInputFormatter(), createLogger())
  #pendingTool?: PendingTool
  #containerParams?: { projectId?: string; namespaceId?: string }

  constructor(options: GitLabDuoAgenticProviderOptions) {
    this.#options = options
  }

  get pendingTool(): PendingTool | undefined {
    return this.#pendingTool
  }

  clearPendingTool(): void {
    this.#pendingTool = undefined
  }

  async ensureConnected(goal: string, workflowType: WorkflowType): Promise<void> {
    if (this.#client && this.#workflowId && this.#queue) return

    this.#containerParams = await this.#resolveContainerParams()
    this.#workflowId = await this.#ensureWorkflow(goal, workflowType)
    const token = await getWorkflowToken(this.#options.instanceUrl, this.#options.apiKey, workflowType)

    this.#client = new WebSocketWorkflowClient(createLogger(), {
      gitlabInstanceUrl: new URL(this.#options.instanceUrl),
      token: token.duo_workflow_service.token,
    })

    const stream = await this.#client.executeWorkflow()
    this.#queue = new AsyncQueue<RuntimeEvent>()

    stream.on("data", async (action: WorkflowAction) => {
      if (action.newCheckpoint) {
        const duoEvent: DuoWorkflowEvent = {
          checkpoint: action.newCheckpoint.checkpoint,
          errors: action.newCheckpoint.errors || [],
          workflowGoal: action.newCheckpoint.goal,
          workflowStatus: action.newCheckpoint.status,
        }
        const events = await this.#mapper.mapWorkflowEvent(duoEvent)
        for (const event of events) this.#queue?.push(event)
        return
      }

      if (action.runMCPTool && action.requestID) {
        this.#pendingTool = { requestId: action.requestID, toolName: action.runMCPTool.name }
        this.#queue?.push({
          type: "TOOL_REQUEST",
          requestId: action.requestID,
          toolName: action.runMCPTool.name,
          args: action.runMCPTool.args,
        })
        return
      }
    })

    stream.on("error", (err: Error) => {
      this.#queue?.push({ type: "ERROR", message: err.message, timestamp: Date.now() })
      this.#queue?.close()
    })

    stream.on("end", () => {
      this.#queue?.close()
    })
  }

  sendStartRequest(
    goal: string,
    workflowType: WorkflowType,
    toolApproval?: ToolApproval,
    mcpTools: ClientEvent["startRequest"]["mcpTools"] = [],
    preapprovedTools: string[] = [],
  ): void {
    if (!this.#client || !this.#workflowId) throw new Error("Workflow client not initialized")

    const additionalContext = this.#options.sendSystemContext === false ? [] : getSystemContextItems()
    const startRequest: ClientEvent = {
      startRequest: {
        workflowID: this.#workflowId,
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
          toolApproval && toolApproval.userApproved
            ? { approval: {} }
            : toolApproval && toolApproval.userApproved === false
              ? { rejection: { message: toolApproval.message } }
              : undefined,
      },
    }

    this.#client.write(startRequest)
  }

  sendToolResponse(requestId: string, response: { output: string; error?: string }): void {
    if (!this.#client) throw new Error("Workflow client not initialized")
    const event: ClientEvent = {
      actionResponse: {
        requestID: requestId,
        plainTextResponse: {
          response: response.output,
          error: response.error ?? "",
        },
      },
    }
    this.#client.write(event)
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

  async #resolveContainerParams(): Promise<{ projectId?: string; namespaceId?: string }> {
    const projectPath = await detectProjectPath(process.cwd())
    if (!projectPath) {
      throw new Error(
        "Unable to detect GitLab project. Ensure you run OpenCode in a Git repository with a GitLab remote.",
      )
    }

    try {
      const details = await fetchProjectDetails(
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
    try {
      return await createWorkflow(
        this.#options.instanceUrl,
        this.#options.apiKey,
        goal,
        workflowType,
        this.#containerParams,
      )
    } catch (error) {
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
}

function extractNamespaceIdFromGid(gid?: string): string | undefined {
  if (!gid) return undefined
  const match = /gid:\/\/gitlab\/Group\/(\d+)/.exec(gid)
  return match?.[1]
}

async function detectProjectPath(cwd: string): Promise<string | undefined> {
  let current = cwd
  while (true) {
    const configPath = path.join(current, ".git", "config")
    try {
      const config = await fs.readFile(configPath, "utf8")
      const url = extractGitRemoteUrl(config) || ""
      return parseProjectPathFromRemote(url)
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return undefined
      current = parent
    }
  }
}

function extractGitRemoteUrl(config: string): string | undefined {
  const lines = config.split("\n")
  let inOrigin = false
  let originUrl: string | undefined
  let firstUrl: string | undefined

  for (const line of lines) {
    const trimmed = line.trim()
    const sectionMatch = /^\[remote\s+"([^"]+)"\]$/.exec(trimmed)
    if (sectionMatch) {
      inOrigin = sectionMatch[1] === "origin"
      continue
    }
    const urlMatch = /^url\s*=\s*(.+)$/.exec(trimmed)
    if (urlMatch) {
      const value = urlMatch[1].trim()
      if (!firstUrl) firstUrl = value
      if (inOrigin) originUrl = value
    }
  }

  return originUrl ?? firstUrl
}

function parseProjectPathFromRemote(remoteUrl: string): string | undefined {
  if (!remoteUrl) return undefined
  if (remoteUrl.startsWith("http")) {
    try {
      const url = new URL(remoteUrl)
      return stripGitSuffix(url.pathname.replace(/^\//, ""))
    } catch {
      return undefined
    }
  }

  if (remoteUrl.startsWith("git@")) {
    const match = /^git@[^:]+:(.+)$/.exec(remoteUrl)
    if (!match) return undefined
    return stripGitSuffix(match[1])
  }

  if (remoteUrl.startsWith("ssh://")) {
    try {
      const url = new URL(remoteUrl)
      return stripGitSuffix(url.pathname.replace(/^\//, ""))
    } catch {
      return undefined
    }
  }

  return undefined
}

function stripGitSuffix(pathname: string): string {
  return pathname.endsWith(".git") ? pathname.slice(0, -4) : pathname
}

async function fetchProjectDetails(
  instanceUrl: string,
  apiKey: string,
  projectPath: string,
): Promise<{ projectId?: string; namespaceId?: string }> {
  const url = new URL(`/api/v4/projects/${encodeURIComponent(projectPath)}`, instanceUrl)
  const response = await fetch(url.toString(), {
    headers: { authorization: `Bearer ${apiKey}` },
  })
  if (!response.ok) {
    throw new Error(`Failed to fetch project details: ${response.status}`)
  }
  const data = (await response.json()) as {
    id?: number
    namespace?: { id?: number }
  }
  return {
    projectId: data.id ? String(data.id) : undefined,
    namespaceId: data.namespace?.id ? String(data.namespace.id) : undefined,
  }
}
