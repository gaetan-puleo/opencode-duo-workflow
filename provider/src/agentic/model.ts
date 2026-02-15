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
import { extractAgentReminders, extractLastUserText, extractSystemPrompt, extractToolResults, sanitizeSystemPrompt } from "./prompt_utils"
import { buildMcpTools, buildToolContext } from "./tool_mapping"
import { TokenUsageEstimator } from "./token_usage"

type StreamState = { textStarted: boolean }

export class GitLabDuoAgenticLanguageModel implements LanguageModelV2 {
  readonly specificationVersion = "v2"
  readonly provider = "gitlab-duo-agentic"
  readonly modelId: string
  readonly supportedUrls: Record<string, RegExp[]> = {}

  #options: GitLabDuoAgenticProviderOptions
  #runtime: GitLabAgenticRuntime
  #pendingToolRequests = new Map<string, { toolName: string; responseType?: string }>()
  #multiCallGroups = new Map<string, { subIds: string[]; collected: Map<string, string>; responseType?: string }>()
  #pendingMultiCalls: Array<{ id: string; toolName: string; args: Record<string, unknown> }> | null = null
  #sentToolCallIds = new Set<string>()
  #lastSentPrompt: string | null = null
  #mcpTools: Array<{ name: string; description?: string; schema?: unknown; isApproved?: boolean }> = []
  #toolContext: AIContextItem | null = null
  #usageEstimator = new TokenUsageEstimator()

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
        inputTokens: this.#usageEstimator.inputTokens,
        outputTokens: this.#usageEstimator.outputTokens,
        totalTokens: this.#usageEstimator.totalTokens,
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
    const providerOpts = (options.providerOptions as Record<string, Record<string, unknown>> | undefined)?.["gitlab-duo-agentic"]
    const sessionId = providerOpts?.opencodeSessionId as string | undefined
    this.#runtime.setSessionId(sessionId)
    this.#runtime.resetMapperState()

    // When stream has ended (new turn), clear per-turn state and mark
    // existing tool results as already processed — but keep results that
    // have a pending request (tool executed but result not yet sent to DWS,
    // e.g. because the WebSocket closed before we could send it back).
    if (!this.#runtime.hasStarted) {
      this.#sentToolCallIds.clear()
      for (const r of toolResults) {
        if (!this.#pendingToolRequests.has(r.toolCallId)) {
          this.#sentToolCallIds.add(r.toolCallId)
        }
      }
      this.#pendingToolRequests.clear()
      this.#multiCallGroups.clear()
      this.#pendingMultiCalls = null
      this.#lastSentPrompt = null
      this.#usageEstimator.reset()
    }

    const freshToolResults = toolResults.filter((r) => !this.#sentToolCallIds.has(r.toolCallId))

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
      for (const result of freshToolResults) {
        // Track tool result content as input (sent to DWS)
        this.#usageEstimator.addInputChars(result.output)
        if (result.error) this.#usageEstimator.addInputChars(result.error)

        // Check if this result belongs to a multi-call group (e.g. read_files)
        const hashIdx = result.toolCallId.indexOf("#")
        if (hashIdx !== -1) {
          const originalId = result.toolCallId.substring(0, hashIdx)
          const group = this.#multiCallGroups.get(originalId)
          if (group) {
            group.collected.set(result.toolCallId, result.error ?? result.output)
            this.#sentToolCallIds.add(result.toolCallId)
            this.#pendingToolRequests.delete(result.toolCallId)

            if (group.collected.size === group.subIds.length) {
              // All sub-results collected — aggregate and send to DWS
              const aggregated = group.subIds.map((id) => group.collected.get(id) ?? "").join("\n")
              this.#runtime.sendToolResponse(
                originalId,
                { output: aggregated },
                group.responseType as "plain" | "http" | undefined,
              )
              this.#multiCallGroups.delete(originalId)
              this.#pendingToolRequests.delete(originalId)
            }
            continue
          }
        }

        const pending = this.#pendingToolRequests.get(result.toolCallId)
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
            content: sanitizeSystemPrompt(systemPrompt),
            id: "agent_system_prompt",
            metadata: {
              title: "Agent System Prompt",
              enabled: true,
              subType: "system_prompt",
              icon: "file-text",
              secondaryText: "Full system prompt",
              subTypeLabel: "System Prompt",
            },
          })
        }
      } else {
        // Follow-up message: send agent prompt if available, otherwise fall back
        // to the full system prompt (for agents like 'build' that have no .prompt)
        const promptContent = agentPrompt ?? extractSystemPrompt(options.prompt)
        if (promptContent) {
          extraContext.push({
            category: "agent_context",
            content: sanitizeSystemPrompt(promptContent),
            id: "agent_system_prompt",
            metadata: {
              title: "Agent System Prompt",
              enabled: true,
              subType: "system_prompt",
              icon: "file-text",
              secondaryText: "System prompt",
              subTypeLabel: "System Prompt",
            },
          })
        }
      }

      // Forward agent reminders (plan mode, build-switch, custom agent instructions)
      const agentReminders = extractAgentReminders(options.prompt)
      if (agentReminders.length > 0) {
        const reminderContent = sanitizeSystemPrompt(agentReminders.join("\n\n"))
        extraContext.push({
          category: "agent_context",
          content: reminderContent,
          id: "agent_reminders",
          metadata: {
            title: "Agent Reminders",
            enabled: true,
            subType: "agent_reminders",
            icon: "file-text",
            secondaryText: "Agent mode instructions",
            subTypeLabel: "Agent Reminders",
          },
        })
      }

      this.#runtime.sendStartRequest(
        promptText!,
        workflowType,
        mcpTools,
        [],
        extraContext,
      )
      this.#lastSentPrompt = promptText

      // Track input: prompt text + all extra context sent to DWS
      this.#usageEstimator.addInputChars(promptText!)
      for (const ctx of extraContext) {
        if (ctx.content) this.#usageEstimator.addInputChars(ctx.content)
      }
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
    const estimator = this.#usageEstimator

    yield { type: "stream-start", warnings: [] }

    try {
      for await (const event of events) {
        if (event.type === "TEXT_CHUNK") {
          if (event.content.length > 0) {
            estimator.addOutputChars(event.content)
            yield* this.#emitTextDelta(state, event.content)
          }
          continue
        }

        if (event.type === "TOOL_COMPLETE") {
          continue
        }

        if (event.type === "TOOL_REQUEST") {
          const args = event.args as Record<string, unknown>
          const responseType = (event as { responseType?: string }).responseType as "plain" | "http" | undefined

          // Track tool request args as output (generated by the model)
          estimator.addOutputChars(JSON.stringify(args))

          // Multi-call events arrive as individual TOOL_REQUEST events with
          // sub-IDs like "origId#0", "origId#1" (generated by action_handler).
          // Collect them into a group and emit all at once when the last one
          // arrives (the runtime pushes them sequentially).
          const hashIdx = event.requestId.indexOf("#")
          if (hashIdx !== -1) {
            const originalId = event.requestId.substring(0, hashIdx)

            if (!this.#multiCallGroups.has(originalId)) {
              this.#multiCallGroups.set(originalId, { subIds: [], collected: new Map(), responseType })
              this.#pendingToolRequests.set(originalId, { toolName: event.toolName, responseType })
            }
            const group = this.#multiCallGroups.get(originalId)!
            group.subIds.push(event.requestId)
            this.#pendingToolRequests.set(event.requestId, { toolName: event.toolName })

            // Buffer the call — we'll emit them all when the stream
            // yields a non-multi-call event or ends.
            if (!this.#pendingMultiCalls) this.#pendingMultiCalls = []
            this.#pendingMultiCalls.push({ id: event.requestId, toolName: event.toolName, args })
            continue
          }

          // Flush any buffered multi-call events before emitting a single call
          if (this.#pendingMultiCalls && this.#pendingMultiCalls.length > 0) {
            yield* this.#flushMultiCalls()
            return
          }

          this.#pendingToolRequests.set(event.requestId, { toolName: event.toolName, responseType })
          yield* this.#emitToolCall(event.requestId, event.toolName, args)
          return
        }

        if (event.type === "ERROR") {
          const msg = event.message
          if (msg.includes("1013") || msg.includes("lock")) {
            yield { type: "error", error: new Error("GitLab Duo workflow is locked (another session may still be active). Please try again in a few seconds.") }
          } else {
            yield { type: "error", error: new Error(`GitLab Duo: ${msg}`) }
          }
          return
        }
      }
    } catch (streamErr) {
      yield { type: "error", error: streamErr instanceof Error ? streamErr : new Error(String(streamErr)) }
      return
    }

    // Flush any remaining buffered multi-call events (stream ended after them)
    if (this.#pendingMultiCalls && this.#pendingMultiCalls.length > 0) {
      yield* this.#flushMultiCalls()
      return
    }

    yield { type: "finish", finishReason: "stop", usage: this.#currentUsage }
  }

  // ---------------------------------------------------------------------------
  // Stream part helpers
  // ---------------------------------------------------------------------------

  get #currentUsage(): LanguageModelV2Usage {
    return {
      inputTokens: this.#usageEstimator.inputTokens,
      outputTokens: this.#usageEstimator.outputTokens,
      totalTokens: this.#usageEstimator.totalTokens,
    }
  }

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
  ): Generator<LanguageModelV2StreamPart> {
    const inputJson = JSON.stringify(args ?? {})
    yield { type: "tool-input-start" as const, id, toolName }
    yield { type: "tool-input-delta" as const, id, delta: inputJson }
    yield { type: "tool-input-end" as const, id }
    yield { type: "tool-call", toolCallId: id, toolName, input: inputJson }
    yield { type: "finish", finishReason: "tool-calls", usage: this.#currentUsage }
  }

  *#flushMultiCalls(): Generator<LanguageModelV2StreamPart> {
    const calls = this.#pendingMultiCalls ?? []
    this.#pendingMultiCalls = null
    for (const call of calls) {
      const inputJson = JSON.stringify(call.args ?? {})
      yield { type: "tool-input-start" as const, id: call.id, toolName: call.toolName }
      yield { type: "tool-input-delta" as const, id: call.id, delta: inputJson }
      yield { type: "tool-input-end" as const, id: call.id }
      yield { type: "tool-call", toolCallId: call.id, toolName: call.toolName, input: inputJson }
    }
    yield { type: "finish", finishReason: "tool-calls", usage: this.#currentUsage }
  }
}
