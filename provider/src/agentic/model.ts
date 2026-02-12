import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2Content,
  LanguageModelV2FinishReason,
  LanguageModelV2StreamPart,
  LanguageModelV2Usage,
} from "@ai-sdk/provider"
import type { GitLabDuoAgenticProviderOptions, AIContextItem, ToolApprovalPolicy, WorkflowType } from "./types"
import { GitLabAgenticRuntime } from "./runtime"
import { asyncIteratorToReadableStream } from "./stream_adapter"
import { createLogger } from "./logger"
import { extractLastUserText, extractToolResults } from "./prompt_utils"
import {
  buildMcpTools,
  buildToolContext,
  extractApprovalArgs,
  mapDuoToolRequest,
  toolKey,
} from "./tool_mapping"

type StreamState = { textStarted: boolean }

export class GitLabDuoAgenticLanguageModel implements LanguageModelV2 {
  readonly specificationVersion = "v2"
  readonly provider = "gitlab-duo-agentic-unofficial"
  readonly modelId: string
  readonly supportedUrls: Record<string, RegExp[]> = {}

  #options: GitLabDuoAgenticProviderOptions
  #logger = createLogger()
  #runtime: GitLabAgenticRuntime
  #pendingApprovals = new Map<string, { toolName: string; args: Record<string, unknown>; key: string }>()
  #approvalCache = new Map<string, { output: string; error?: string }>()
  #pendingToolRequests = new Map<string, { toolName: string; key: string; responseType?: string }>()
  #handledDirectTools = new Set<string>()
  #sentToolCallIds = new Set<string>()
  #mcpTools: Array<{ name: string; description?: string; schema?: unknown; isApproved?: boolean }> = []
  #toolContext: AIContextItem | null = null

  constructor(modelId: string, options: GitLabDuoAgenticProviderOptions, runtime: GitLabAgenticRuntime) {
    this.modelId = modelId
    this.#options = options
    this.#runtime = runtime
  }

  // ---------------------------------------------------------------------------
  // LanguageModelV2 interface
  // ---------------------------------------------------------------------------

  async doGenerate(options: LanguageModelV2CallOptions) {
    let text = ""
    const stream = await this.doStream(options)
    for await (const part of stream.stream) {
      if (part.type === "text-delta") text += part.delta
    }

    const content: LanguageModelV2Content[] = [{ type: "text", text }]
    const finishReason: LanguageModelV2FinishReason = "stop"
    return {
      content,
      finishReason,
      usage: {
        inputTokens: undefined,
        outputTokens: undefined,
        totalTokens: undefined,
      } satisfies LanguageModelV2Usage,
      warnings: [],
    }
  }

  async doStream(
    options: LanguageModelV2CallOptions,
  ): Promise<Awaited<ReturnType<LanguageModelV2["doStream"]>>> {
    const workflowType: WorkflowType = "chat"
    const promptText = extractLastUserText(options.prompt)
    const toolResults = extractToolResults(options.prompt)
    this.#logger.warn(`doStream: prompt=${promptText?.slice(0, 80) ?? "(none)"} toolResults=${toolResults.length}`)
    const policy = (this.#options.toolApproval ?? "ask") as ToolApprovalPolicy
    const approval = GitLabAgenticRuntime.buildToolApproval(promptText ?? "", this.#runtime.pendingTool, policy)
    const providerOpts = (options.providerOptions as Record<string, Record<string, unknown>> | undefined)?.["gitlab-duo-agentic-unofficial"]
    const sessionId = providerOpts?.opencodeSessionId as string | undefined
    this.#runtime.setSessionId(sessionId)
    this.#runtime.resetMapperState()

    // When stream has ended (new turn), clear per-turn state and mark all
    // existing tool results as already processed so they don't get re-sent.
    if (!this.#runtime.hasStarted) {
      if (this.#sentToolCallIds.size > 0) {
        this.#logger.warn(`new turn: clearing per-turn state (sentIds=${this.#sentToolCallIds.size})`)
      }
      this.#sentToolCallIds.clear()
      this.#approvalCache.clear()
      this.#handledDirectTools.clear()
      this.#pendingApprovals.clear()
      this.#pendingToolRequests.clear()
      for (const r of toolResults) {
        this.#sentToolCallIds.add(r.toolCallId)
      }
    }

    const freshToolResults = toolResults.filter((r) => !this.#sentToolCallIds.has(r.toolCallId))
    this.#logger.warn(`fresh=${freshToolResults.length} stale=${toolResults.length - freshToolResults.length} sent=${this.#sentToolCallIds.size}`)

    const modelRef = this.modelId === "duo-agentic" ? undefined : this.modelId
    this.#runtime.setSelectedModelIdentifier(modelRef)
    await this.#runtime.ensureConnected(promptText || "", workflowType)

    const mcpTools = this.#options.enableMcp === false ? [] : buildMcpTools(options)
    const toolContext = buildToolContext(mcpTools)
    this.#mcpTools = mcpTools
    this.#toolContext = toolContext

    let sentToolResults = false

    // --- Handle approval results ---
    const approvalResults = freshToolResults.filter((result) => result.toolCallId.startsWith("duo-approval:"))
    if (approvalResults.length > 0) {
      this.#logger.warn(`processing ${approvalResults.length} approval results`)
      for (const result of approvalResults) {
        const pending = this.#pendingApprovals.get(result.toolCallId)
        if (!pending) {
          this.#logger.warn(`approvalResult: no pending approval for ${result.toolCallId}`)
          continue
        }
        this.#logger.warn(`approvalResult: id=${result.toolCallId} tool=${pending.toolName} approved=${!result.error}`)
        this.#pendingApprovals.delete(result.toolCallId)
        this.#sentToolCallIds.add(result.toolCallId)
        if (!result.error) {
          this.#approvalCache.set(pending.key, { output: result.output, error: result.error })
        }
        this.#runtime.sendStartRequest(
          "",
          workflowType,
          result.error
            ? { userApproved: false as const, message: result.error }
            : { userApproved: true as const, toolName: pending.toolName, type: "approve_once" as const },
          this.#mcpTools,
          [],
          this.#toolContext ? [this.#toolContext] : [],
        )
        sentToolResults = true
      }
    }

    // --- Handle tool results for the workflow ---
    const toolResultsForWorkflow = freshToolResults.filter(
      (result) => !result.toolCallId.startsWith("duo-approval:"),
    )
    if (toolResultsForWorkflow.length > 0) {
      this.#logger.warn(`sending ${toolResultsForWorkflow.length} tool results to workflow`)
      for (const result of toolResultsForWorkflow) {
        const pending = this.#pendingToolRequests.get(result.toolCallId)
        this.#logger.warn(`toolResult: id=${result.toolCallId} tool=${result.toolName} error=${!!result.error} pending=${!!pending} outputLen=${result.output?.length ?? 0}`)
        this.#runtime.sendToolResponse(
          result.toolCallId,
          { output: result.output, error: result.error },
          pending?.responseType as "plain" | "http" | undefined,
        )
        this.#sentToolCallIds.add(result.toolCallId)
        if (pending) {
          this.#pendingToolRequests.delete(result.toolCallId)
          this.#approvalCache.set(pending.key, { output: result.output, error: result.error })
          this.#handledDirectTools.add(pending.toolName)
          this.#logger.warn(`approvalCache: set key=${pending.key.slice(0, 120)} handledDirectTools+=${pending.toolName}`)
        }
      }
      this.#runtime.clearPendingTool()
      sentToolResults = true
    }

    // --- Initial start request ---
    if (!sentToolResults && !this.#runtime.hasStarted && (promptText || approval)) {
      this.#logger.warn(`sending initial startRequest: hasPrompt=${!!promptText} hasApproval=${!!approval}`)
      this.#runtime.sendStartRequest(
        promptText || "",
        workflowType,
        approval,
        mcpTools,
        [],
        toolContext ? [toolContext] : [],
      )
    }

    const iterator = this.#mapEventsToStream(this.#runtime.getEventStream())
    const stream = asyncIteratorToReadableStream(iterator)

    return {
      stream,
    }
  }

  // ---------------------------------------------------------------------------
  // Event → stream mapping
  // ---------------------------------------------------------------------------

  async *#mapEventsToStream(
    events: AsyncIterable<ReturnType<GitLabAgenticRuntime["getEventStream"]> extends AsyncGenerator<infer T> ? T : never>,
  ): AsyncGenerator<LanguageModelV2StreamPart> {
    const state: StreamState = { textStarted: false }
    const usage: LanguageModelV2Usage = {
      inputTokens: undefined,
      outputTokens: undefined,
      totalTokens: undefined,
    }

    yield { type: "stream-start", warnings: [] }

    for await (const event of events) {
      if (event.type === "TEXT_CHUNK") {
        if (event.content.length > 0) {
          yield* this.#emitTextDelta(state, event.content)
        }
        continue
      }

      if (event.type === "TOOL_AWAITING_APPROVAL") {
        const toolCallId = `duo-approval:${event.toolId}`
        if (this.#pendingApprovals.has(toolCallId)) {
          this.#logger.warn(`toolApproval: ${event.toolName} id=${toolCallId} skipped (already pending)`)
          continue
        }
        const approvalArgs = extractApprovalArgs(event.input)
        const key = toolKey(event.toolName, approvalArgs)
        this.#logger.warn(`toolApproval: ${event.toolName} id=${toolCallId} args=${JSON.stringify(approvalArgs).slice(0, 200)} key=${key.slice(0, 120)}`)

        if (this.#handledDirectTools.has(event.toolName)) {
          this.#handledDirectTools.delete(event.toolName)
          this.#logger.warn(`toolApproval: ${event.toolName} skipped (already handled via direct action)`)
          continue
        }

        if (this.#approvalCache.has(key)) {
          this.#logger.warn(`toolApproval: ${event.toolName} skipped (approvalCache hit)`)
          continue
        }

        const mapped = mapDuoToolRequest(event.toolName, approvalArgs)
        this.#logger.warn(`toolApproval: ${event.toolName} -> ${mapped.toolName} mapped args=${JSON.stringify(mapped.args).slice(0, 200)}`)
        this.#pendingApprovals.set(toolCallId, {
          toolName: event.toolName,
          args: approvalArgs,
          key,
        })
        yield* this.#emitToolCall(toolCallId, mapped.toolName, mapped.args, usage)
        return
      }

      if (event.type === "TOOL_COMPLETE") {
        this.#logger.warn(`toolComplete: id=${event.toolId} (ignored, handled locally by OpenCode)`)
        continue
      }

      if (event.type === "TOOL_REQUEST") {
        const args = event.args as Record<string, unknown>
        const mapped = mapDuoToolRequest(event.toolName, args)
        const key = toolKey(event.toolName, args)
        this.#logger.warn(`toolRequest: ${event.toolName} -> ${mapped.toolName} args=${JSON.stringify(args).slice(0, 200)} key=${key.slice(0, 120)}`)
        const responseType = (event as { responseType?: string }).responseType as "plain" | "http" | undefined
        const cached = this.#approvalCache.get(key)
        if (cached) {
          this.#logger.warn(`toolRequest: ${event.toolName} cache hit key=${key.slice(0, 120)}, auto-responding`)
          this.#approvalCache.delete(key)
          this.#runtime.sendToolResponse(event.requestId, cached, responseType)
          this.#runtime.clearPendingTool()
          continue
        }
        this.#pendingToolRequests.set(event.requestId, { toolName: event.toolName, key, responseType })
        yield* this.#emitToolCall(event.requestId, mapped.toolName, mapped.args, usage)
        return
      }

      if (event.type === "ERROR") {
        this.#logger.error(`stream event ERROR: ${event.message}`)
        const msg = event.message
        if (msg.includes("1013") || msg.includes("lock")) {
          yield { type: "error", error: new Error("GitLab Duo workflow is locked (another session may still be active). Please try again in a few seconds.") }
        } else {
          yield { type: "error", error: new Error(`GitLab Duo: ${msg}`) }
        }
        return
      }
    }

    yield { type: "finish", finishReason: "stop", usage }
  }

  // ---------------------------------------------------------------------------
  // Stream part helpers
  // ---------------------------------------------------------------------------

  *#emitTextDelta(state: StreamState, delta: string): Generator<LanguageModelV2StreamPart> {
    if (!state.textStarted) {
      state.textStarted = true
      yield { type: "text-start", id: "txt-0" }
    }
    yield { type: "text-delta", id: "txt-0", delta }
  }

  *#emitToolCall(
    id: string,
    toolName: string,
    args: Record<string, unknown>,
    usage: LanguageModelV2Usage,
  ): Generator<LanguageModelV2StreamPart> {
    const inputJson = JSON.stringify(args ?? {})
    yield { type: "tool-input-start" as const, id, toolName }
    yield { type: "tool-input-delta" as const, id, delta: inputJson }
    yield { type: "tool-input-end" as const, id }
    yield { type: "tool-call", toolCallId: id, toolName, input: inputJson }
    yield { type: "finish", finishReason: "tool-calls", usage }
  }
}
