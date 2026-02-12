import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2Content,
  LanguageModelV2FinishReason,
  LanguageModelV2StreamPart,
  LanguageModelV2Usage,
} from "@ai-sdk/provider"
import type { GitLabDuoAgenticProviderOptions, AIContextItem, WorkflowType } from "./types"
import { GitLabAgenticRuntime } from "./runtime"
import { asyncIteratorToReadableStream } from "./stream_adapter"
import { createLogger } from "./logger"
import { extractLastUserText, extractSystemPrompt, extractToolResults } from "./prompt_utils"
import { buildMcpTools, buildToolContext, mapDuoToolRequest } from "./tool_mapping"

type StreamState = { textStarted: boolean }

export class GitLabDuoAgenticLanguageModel implements LanguageModelV2 {
  readonly specificationVersion = "v2"
  readonly provider = "gitlab-duo-agentic-unofficial"
  readonly modelId: string
  readonly supportedUrls: Record<string, RegExp[]> = {}

  #options: GitLabDuoAgenticProviderOptions
  #logger = createLogger()
  #runtime: GitLabAgenticRuntime
  #pendingToolRequests = new Map<string, { toolName: string; responseType?: string }>()
  #sentToolCallIds = new Set<string>()
  #lastSentPrompt: string | null = null
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

    const agentPrompt = providerOpts?.agentPrompt as string | undefined
    const isNewUserMessage = promptText != null && promptText !== this.#lastSentPrompt

    let sentToolResults = false

    // --- Handle tool results (send back to workflow service) ---
    if (freshToolResults.length > 0) {
      this.#logger.warn(`sending ${freshToolResults.length} tool results to workflow`)
      for (const result of freshToolResults) {
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
        }
      }
      this.#runtime.clearPendingTool()
      sentToolResults = true
    }

    // --- Send startRequest for new user messages ---
    if (!sentToolResults && isNewUserMessage) {
      const extraContext: AIContextItem[] = []
      if (toolContext) extraContext.push(toolContext)

      if (!this.#runtime.hasStarted) {
        // First message: send the full system prompt (agent prompt + env + instructions)
        const systemPrompt = extractSystemPrompt(options.prompt)
        if (systemPrompt) {
          extraContext.push({
            category: "agent_context",
            content: systemPrompt,
            id: "opencode_system_prompt",
            metadata: {
              title: "OpenCode System Prompt",
              enabled: true,
              subType: "system_prompt",
              icon: "file-text",
              secondaryText: "Full system prompt",
              subTypeLabel: "System Prompt",
            },
          })
        }
        this.#logger.warn(`sending initial startRequest: prompt=${promptText!.slice(0, 80)} systemPromptLen=${systemPrompt?.length ?? 0}`)
      } else {
        // Follow-up message: send only the agent prompt (plan/build/explore/custom)
        if (agentPrompt) {
          extraContext.push({
            category: "agent_context",
            content: agentPrompt,
            id: "opencode_agent_prompt",
            metadata: {
              title: "OpenCode Agent Prompt",
              enabled: true,
              subType: "agent_prompt",
              icon: "file-text",
              secondaryText: "Agent prompt",
              subTypeLabel: "Agent Prompt",
            },
          })
        }
        this.#logger.warn(`sending follow-up startRequest: prompt=${promptText!.slice(0, 80)} hasAgentPrompt=${!!agentPrompt}`)
      }

      this.#runtime.sendStartRequest(
        promptText!,
        workflowType,
        mcpTools,
        [],
        extraContext,
      )
      this.#lastSentPrompt = promptText
    }

    const iterator = this.#mapEventsToStream(this.#runtime.getEventStream())
    const stream = asyncIteratorToReadableStream(iterator)

    return {
      stream,
    }
  }

  // ---------------------------------------------------------------------------
  // Event → stream mapping (2 paths: TEXT_CHUNK + TOOL_REQUEST)
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

      if (event.type === "TOOL_COMPLETE") {
        this.#logger.warn(`toolComplete: id=${event.toolId} (ignored, handled locally by OpenCode)`)
        continue
      }

      if (event.type === "TOOL_REQUEST") {
        const args = event.args as Record<string, unknown>
        const mapped = mapDuoToolRequest(event.toolName, args)
        this.#logger.warn(`toolRequest: ${event.toolName} -> ${mapped.toolName} args=${JSON.stringify(args).slice(0, 200)}`)
        const responseType = (event as { responseType?: string }).responseType as "plain" | "http" | undefined
        this.#pendingToolRequests.set(event.requestId, { toolName: event.toolName, responseType })
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
