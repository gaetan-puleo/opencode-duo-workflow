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
import { buildMcpTools, buildToolContext, mapDuoToolRequest, type MappedToolCall } from "./tool_mapping"
// [DISABLED] Simulated tool calls for todowrite/todoread/task — uncomment to enable
// import {
//   buildSimulatedToolPrompt,
//   extractSimulatedToolCalls,
//   generateSimulatedToolCallId,
//   isSimulatedToolCallId,
// } from "./simulated_tools"

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
  #multiCallGroups = new Map<string, { subIds: string[]; collected: Map<string, string>; responseType?: string }>()
  #sentToolCallIds = new Set<string>()
  #lastSentPrompt: string | null = null
  #mcpTools: Array<{ name: string; description?: string; schema?: unknown; isApproved?: boolean }> = []
  #toolContext: AIContextItem | null = null
  // [DISABLED] Simulated tool queue — uncomment to enable
  // #simulatedToolQueue: Array<{ name: string; args: Record<string, unknown> }> = []

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
    this.#logger.warn(`doStream: toolResults=${toolResults.length} tools=[${toolResults.map((r) => r.toolName).join(",")}]`)
    const providerOpts = (options.providerOptions as Record<string, Record<string, unknown>> | undefined)?.["gitlab-duo-agentic-unofficial"]
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
      // [DISABLED] this.#simulatedToolQueue = []
      this.#lastSentPrompt = null
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
        // [DISABLED] Simulated tool results are NOT forwarded to DWS — it never knew about them
        // if (isSimulatedToolCallId(result.toolCallId)) {
        //   this.#logger.warn(`simToolResult: id=${result.toolCallId} tool=${result.toolName} (consumed locally, not forwarded to DWS)`)
        //   this.#sentToolCallIds.add(result.toolCallId)
        //   this.#pendingToolRequests.delete(result.toolCallId)
        //   sentToolResults = true
        //   continue
        // }

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
              this.#logger.warn(`multiCall complete: ${originalId} (${group.subIds.length} calls) outputLen=${aggregated.length}`)
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

    // [DISABLED] Drain simulated tool queue (before touching DWS)
    // if (this.#simulatedToolQueue.length > 0) {
    //   this.#logger.warn(`draining simulated tool queue: ${this.#simulatedToolQueue.length} remaining`)
    //   const iterator = this.#drainSimulatedQueue()
    //   const stream = asyncIteratorToReadableStream(iterator)
    //   return { stream }
    // }

    // --- Send startRequest for new user messages ---
    if (!sentToolResults && isNewUserMessage) {
      const extraContext: AIContextItem[] = []
      if (toolContext) extraContext.push(toolContext)

      // [DISABLED] Simulated tool instructions
      // extraContext.push({
      //   category: "agent_context",
      //   content: buildSimulatedToolPrompt(),
      //   id: "opencode_simulated_tools",
      //   metadata: {
      //     title: "OpenCode Simulated Tools",
      //     enabled: true,
      //     subType: "simulated_tools",
      //     icon: "wrench",
      //     secondaryText: "Simulated tool instructions",
      //     subTypeLabel: "Simulated Tools",
      //   },
      // })

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

  // [DISABLED] Simulated tool queue drain — uncomment to enable
  // async *#drainSimulatedQueue(): AsyncGenerator<LanguageModelV2StreamPart> {
  //   const usage: LanguageModelV2Usage = {
  //     inputTokens: undefined,
  //     outputTokens: undefined,
  //     totalTokens: undefined,
  //   }
  //   yield { type: "stream-start", warnings: [] }
  //   const call = this.#simulatedToolQueue.shift()!
  //   const callId = generateSimulatedToolCallId()
  //   this.#logger.warn(`simTool (queued): ${call.name} id=${callId} args=${JSON.stringify(call.args).slice(0, 200)}`)
  //   this.#pendingToolRequests.set(callId, { toolName: call.name })
  //   yield* this.#emitToolCall(callId, call.name, call.args, usage)
  // }

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

    // [DISABLED] Buffer text for simulated tool detection at stream end
    // let textBuffer = ""

    try {
      for await (const event of events) {
        if (event.type === "TEXT_CHUNK") {
          if (event.content.length > 0) {
            yield* this.#emitTextDelta(state, event.content)
            // [DISABLED] textBuffer += event.content
          }
          continue
        }

        if (event.type === "TOOL_COMPLETE") {
          continue
        }

        if (event.type === "TOOL_REQUEST") {
          const args = event.args as Record<string, unknown>
          let mapped: ReturnType<typeof mapDuoToolRequest>
          try {
            mapped = mapDuoToolRequest(event.toolName, args)
          } catch (err) {
            this.#logger.error(`mapDuoToolRequest threw: ${err}`)
            continue
          }
          const responseType = (event as { responseType?: string }).responseType as "plain" | "http" | undefined

          if (Array.isArray(mapped)) {
            // Multi-call expansion (e.g. read_files → N × read)
            const subIds = mapped.map((_, i) => `${event.requestId}#${i}`)
            this.#multiCallGroups.set(event.requestId, { subIds, collected: new Map(), responseType })
            this.#pendingToolRequests.set(event.requestId, { toolName: event.toolName, responseType })
            for (const subId of subIds) {
              this.#pendingToolRequests.set(subId, { toolName: mapped[0].toolName })
            }
            this.#logger.warn(`toolRequest (multi): ${event.toolName} -> ${mapped.length}x ${mapped[0].toolName}`)
            yield* this.#emitMultiToolCalls(subIds, mapped, usage)
            return
          }

          this.#logger.warn(`toolRequest: ${event.toolName} -> ${mapped.toolName} args=${JSON.stringify(args).slice(0, 200)}`)
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
    } catch (streamErr) {
      this.#logger.error(`stream iteration error: ${streamErr}`)
      yield { type: "error", error: streamErr instanceof Error ? streamErr : new Error(String(streamErr)) }
      return
    }

    // [DISABLED] Stream ended: check buffered text for simulated tool calls
    // const simCalls = extractSimulatedToolCalls(textBuffer)
    // if (simCalls.length > 0) {
    //   this.#logger.warn(`simulated tool calls detected: ${simCalls.length} [${simCalls.map((c) => c.name).join(", ")}]`)
    //   const first = simCalls[0]
    //   const callId = generateSimulatedToolCallId()
    //   this.#logger.warn(`simTool (first): ${first.name} id=${callId} args=${JSON.stringify(first.args).slice(0, 200)}`)
    //   this.#pendingToolRequests.set(callId, { toolName: first.name })
    //   for (let i = 1; i < simCalls.length; i++) {
    //     this.#simulatedToolQueue.push(simCalls[i])
    //   }
    //   yield* this.#emitToolCall(callId, first.name, first.args, usage)
    //   return
    // }

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

  *#emitMultiToolCalls(
    ids: string[],
    calls: MappedToolCall[],
    usage: LanguageModelV2Usage,
  ): Generator<LanguageModelV2StreamPart> {
    for (let i = 0; i < calls.length; i++) {
      const inputJson = JSON.stringify(calls[i].args ?? {})
      yield { type: "tool-input-start" as const, id: ids[i], toolName: calls[i].toolName }
      yield { type: "tool-input-delta" as const, id: ids[i], delta: inputJson }
      yield { type: "tool-input-end" as const, id: ids[i] }
      yield { type: "tool-call", toolCallId: ids[i], toolName: calls[i].toolName, input: inputJson }
    }
    yield { type: "finish", finishReason: "tool-calls", usage }
  }
}
