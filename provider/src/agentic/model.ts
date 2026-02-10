import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2FinishReason,
  LanguageModelV2StreamPart,
  LanguageModelV2Usage,
} from "@ai-sdk/provider"
import type { GitLabDuoAgenticProviderOptions, ToolApprovalPolicy, WorkflowType } from "./types"
import { GitLabAgenticRuntime } from "./runtime"

type StreamState = { textStarted: boolean }

export class GitLabDuoAgenticLanguageModel implements LanguageModelV2 {
  readonly specificationVersion = "v2"
  readonly provider = "gitlab-duo-agentic-unofficial"
  readonly modelId: string

  #options: GitLabDuoAgenticProviderOptions
  #runtime: GitLabAgenticRuntime

  constructor(modelId: string, options: GitLabDuoAgenticProviderOptions) {
    this.modelId = modelId
    this.#options = options
    this.#runtime = new GitLabAgenticRuntime(options)
  }

  async doGenerate(options: LanguageModelV2CallOptions) {
    let text = ""
    const stream = await this.doStream(options)
    for await (const part of stream.stream) {
      if (part.type === "text-delta") text += part.delta
    }

    return {
      text,
      finishReason: "stop" satisfies LanguageModelV2FinishReason,
      usage: {
        inputTokens: undefined,
        outputTokens: undefined,
        totalTokens: undefined,
      } satisfies LanguageModelV2Usage,
      rawCall: { rawValue: null },
      rawResponse: { rawValue: null },
      response: { headers: {} },
      warnings: [],
    }
  }

  async doStream(
    options: LanguageModelV2CallOptions,
  ): Promise<Awaited<ReturnType<LanguageModelV2["doStream"]>>> {
    const workflowType: WorkflowType = "chat"
    const promptText = extractLastUserText(options.prompt)
    const toolResults = extractToolResults(options.prompt)

    const policy = (this.#options.toolApproval ?? "ask") as ToolApprovalPolicy
    const approval = GitLabAgenticRuntime.buildToolApproval(promptText ?? "", this.#runtime.pendingTool, policy)

    await this.#runtime.ensureConnected(promptText || "", workflowType)

    if (toolResults.length > 0) {
      for (const result of toolResults) {
        this.#runtime.sendToolResponse(result.toolCallId, {
          output: result.output,
          error: result.error,
        })
      }
      this.#runtime.clearPendingTool()
    }

    const mcpTools = this.#options.enableMcp === false ? [] : buildMcpTools(options)
    const preapprovedTools = policy === "auto" ? mcpTools.map((tool) => tool.name) : []

    if (promptText || approval) {
      this.#runtime.sendStartRequest(promptText || "", workflowType, approval, mcpTools, preapprovedTools)
    }

    const stream = this.#mapEventsToStream(this.#runtime.getEventStream())

    return {
      stream,
      warnings: [],
      rawCall: { rawValue: null },
      rawResponse: { rawValue: null },
      response: { headers: {} },
    }
  }

  async *#mapEventsToStream(
    events: AsyncIterable<ReturnType<GitLabAgenticRuntime["getEventStream"]> extends AsyncGenerator<infer T> ? T : never>,
  ): AsyncGenerator<LanguageModelV2StreamPart> {
    const state: StreamState = { textStarted: false }
    const usage: LanguageModelV2Usage = {
      inputTokens: undefined,
      outputTokens: undefined,
      totalTokens: undefined,
    }

    yield { type: "start-step" }

    for await (const event of events) {
      if (event.type === "TEXT_CHUNK") {
        yield* this.#emitTextDelta(state, event.content)
        continue
      }

      if (event.type === "TOOL_AWAITING_APPROVAL") {
        yield* this.#emitTextDelta(
          state,
          `\n[tool approval] ${event.toolName} requested. Reply with /approve or /reject.\n`,
        )
        continue
      }

      if (event.type === "TOOL_COMPLETE") {
        if (event.error) {
          yield* this.#emitTextDelta(state, `\n[tool error] ${event.error}\n`)
        } else {
          yield* this.#emitTextDelta(state, `\n[tool result] ${event.result}\n`)
        }
        continue
      }

      if (event.type === "TOOL_REQUEST") {
        yield {
          type: "tool-call",
          toolCallId: event.requestId,
          toolName: event.toolName,
          input: JSON.stringify(event.args ?? {}),
        }
        continue
      }

      if (event.type === "ERROR") {
        yield* this.#emitTextDelta(state, `\n[error] ${event.message}\n`)
        break
      }
    }

    yield { type: "finish-step", finishReason: "stop", usage }
  }

  *#emitTextDelta(state: StreamState, delta: string): Generator<LanguageModelV2StreamPart> {
    if (!state.textStarted) {
      state.textStarted = true
      yield { type: "text-start", id: "txt-0" }
    }
    yield { type: "text-delta", id: "txt-0", delta }
  }
}

function extractLastUserText(prompt: LanguageModelV2CallOptions["prompt"]): string | null {
  if (!Array.isArray(prompt)) return null
  for (let i = prompt.length - 1; i >= 0; i -= 1) {
    const message = prompt[i] as { role?: string; content?: Array<{ type: string; text?: string }> }
    if (message?.role === "user" && Array.isArray(message.content)) {
      return message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text || "")
        .join("")
        .trim()
    }
  }
  return null
}

function extractToolResults(prompt: LanguageModelV2CallOptions["prompt"]): Array<{ toolCallId: string; output: string; error?: string }> {
  if (!Array.isArray(prompt)) return []
  const results: Array<{ toolCallId: string; output: string; error?: string }> = []

  for (const message of prompt) {
    const content = (message as { content?: Array<Record<string, unknown>> }).content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (part.type === "tool-result") {
        const toolCallId = String((part as { toolCallId?: string }).toolCallId ?? "")
        const output = String((part as { result?: unknown }).result ?? "")
        results.push({ toolCallId, output })
      }
    }
  }

  return results
}

function buildMcpTools(
  options: LanguageModelV2CallOptions,
): Array<{ name: string; description?: string; schema?: unknown; isApproved?: boolean }> {
  const tools = options.tools ?? {}
  return Object.entries(tools).map(([name, tool]) => ({
    name,
    description: tool.description,
    schema: tool.parameters,
    isApproved: false,
  }))
}
