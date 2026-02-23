import { randomUUID } from "node:crypto"
import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2StreamPart,
} from "@ai-sdk/provider"
import { PROVIDER_ID } from "../constants"
import type { GitLabClientOptions } from "../gitlab/client"
import { WorkflowSession, type WorkflowToolsConfig } from "../workflow/session"
import { extractGoal } from "./prompt"
import { extractToolResults, extractSystemPrompt, sanitizeSystemPrompt, extractAgentReminders } from "./prompt-utils"
import { mapDuoToolRequest, type MappedToolCall } from "./tool-mapping"
import { readSessionID } from "./session-context"
import { buildSystemContext } from "./system-context"
import type { AdditionalContext } from "../workflow/types"
import { loadWorkflowId, saveWorkflowId } from "../workflow/session-store"
import { buildFlowConfig } from "../workflow/flow-config"

/**
 * Session cache keyed by `instanceUrl::modelId::sessionID`.
 * Sessions are removed when `disposeSession` is called, preventing
 * unbounded growth during long-running processes.
 */
const sessions = new Map<string, WorkflowSession>()

/** Token usage is not tracked by the workflow service. */
const UNKNOWN_USAGE = {
  inputTokens: undefined,
  outputTokens: undefined,
  totalTokens: undefined,
} as const

export class DuoWorkflowModel implements LanguageModelV2 {
  readonly specificationVersion = "v2" as const
  readonly provider = PROVIDER_ID
  readonly modelId: string
  readonly supportedUrls = {}
  #client: GitLabClientOptions
  #cwd: string
  #toolsConfig: WorkflowToolsConfig | undefined

  // Tool tracking state (per model instance, reset on session change)
  #pendingToolRequests = new Map<string, Record<string, never>>()
  #multiCallGroups = new Map<string, { subIds: string[]; labels: string[]; collected: Map<string, string> }>()
  #sentToolCallIds = new Set<string>()
  #lastSentGoal: string | null = null
  #stateSessionId: string | undefined

  constructor(modelId: string, client: GitLabClientOptions, cwd?: string) {
    this.modelId = modelId
    this.#client = client
    this.#cwd = cwd ?? process.cwd()
  }

  /**
   * Opt-in: override the server-side system prompt and/or register MCP tools.
   */
  setToolsConfig(config: WorkflowToolsConfig): void {
    this.#toolsConfig = config
    for (const session of sessions.values()) {
      session.setToolsConfig(config)
    }
  }

  async doGenerate(options: LanguageModelV2CallOptions) {
    let text = ""
    const { stream } = await this.doStream(options)
    for await (const part of stream) {
      if (part.type === "text-delta") text += part.delta
    }
    return {
      content: [{ type: "text" as const, text }],
      finishReason: "stop" as const,
      usage: UNKNOWN_USAGE,
      warnings: [],
    }
  }

  async doStream(options: LanguageModelV2CallOptions) {
    const sessionID = readSessionID(options)
    if (!sessionID) throw new Error("missing workflow session ID")

    const goal = extractGoal(options.prompt)
    const toolResults = extractToolResults(options.prompt)
    const session = this.#resolveSession(sessionID)
    const textId = randomUUID()

    // Reset tracking state on session change
    if (sessionID !== this.#stateSessionId) {
      this.#pendingToolRequests.clear()
      this.#multiCallGroups.clear()
      this.#sentToolCallIds.clear()
      this.#lastSentGoal = null
      this.#stateSessionId = sessionID
    }

    const model = this

    return {
      stream: new ReadableStream<LanguageModelV2StreamPart>({
        start: async (controller) => {
          controller.enqueue({ type: "stream-start", warnings: [] })

          // Abort handling
          const onAbort = () => session.abort()
          options.abortSignal?.addEventListener("abort", onAbort, { once: true })

          try {
            // Pre-populate sentToolCallIds when starting fresh.
            // Prevents stale tool results from previous turns being re-forwarded.
            if (!session.hasStarted) {
              model.#sentToolCallIds.clear()
              for (const r of toolResults) {
                if (!model.#pendingToolRequests.has(r.toolCallId)) {
                  model.#sentToolCallIds.add(r.toolCallId)
                }
              }
              model.#lastSentGoal = null
            }

            // Ensure connection is alive before sending tool results.
            // The socket may have dropped (network, timeout) while OpenCode
            // was waiting for user approval on a tool like bash.
            await session.ensureConnected(goal || "")

            // ── Phase 1: Forward fresh tool results to DWS ──────────
            const freshResults = toolResults.filter(
              (r) => !model.#sentToolCallIds.has(r.toolCallId),
            )
            let sentToolResults = false

            for (const result of freshResults) {
              const subIdx = result.toolCallId.indexOf("_sub_")

              // Multi-call group member (e.g. read_files → N × read)
              if (subIdx !== -1) {
                const originalId = result.toolCallId.substring(0, subIdx)
                const group = model.#multiCallGroups.get(originalId)
                if (!group) {
                  model.#sentToolCallIds.add(result.toolCallId)
                  continue
                }

                group.collected.set(result.toolCallId, result.error ?? result.output)
                model.#sentToolCallIds.add(result.toolCallId)
                model.#pendingToolRequests.delete(result.toolCallId)

                if (group.collected.size === group.subIds.length) {
                  const result: Record<string, { content?: string; error?: string }> = {}
                  for (let i = 0; i < group.subIds.length; i++) {
                    const label = group.labels[i] || `file_${i}`
                    const value = group.collected.get(group.subIds[i]) ?? ""
                    result[label] = { content: value }
                  }
                  session.sendToolResult(originalId, JSON.stringify(result))
                  model.#multiCallGroups.delete(originalId)
                  model.#pendingToolRequests.delete(originalId)
                  sentToolResults = true
                }
                continue
              }

              // Single tool result
              const pending = model.#pendingToolRequests.get(result.toolCallId)
              if (!pending) {
                model.#sentToolCallIds.add(result.toolCallId)
                continue
              }

              session.sendToolResult(result.toolCallId, result.output, result.error)
              sentToolResults = true
              model.#sentToolCallIds.add(result.toolCallId)
              model.#pendingToolRequests.delete(result.toolCallId)
            }

            // ── Phase 2: Send start request for new user messages ───
            const isNewGoal = goal && goal !== model.#lastSentGoal
            if (!sentToolResults && isNewGoal) {
              await session.ensureConnected(goal)
              if (!session.hasStarted) {
                const extraContext: AdditionalContext[] = []

                const extractedSystemPrompt = extractSystemPrompt(options.prompt)
                const sanitizedSystemPrompt = sanitizeSystemPrompt(
                  extractedSystemPrompt ?? "You are GitLab Duo, an AI coding assistant.",
                )

                // Use flowConfig to send system prompt via system_template_override.
                session.setToolsConfig({
                  mcpTools: [],
                  flowConfig: buildFlowConfig(sanitizedSystemPrompt),
                  flowConfigSchemaVersion: "v1",
                })

                extraContext.push(...buildSystemContext())

                const agentReminders = extractAgentReminders(options.prompt)
                if (agentReminders.length > 0) {
                  extraContext.push({
                    category: "agent_context",
                    content: sanitizeSystemPrompt(
                      `[context-id:${Date.now()}]\n${agentReminders.join("\n\n")}`
                    ),
                    id: "agent_reminders",
                    metadata: JSON.stringify({
                      title: "Agent Reminders",
                      enabled: true,
                      subType: "agent_reminders",
                    }),
                  })
                }

                session.sendStartRequest(goal, extraContext)
              }
              model.#lastSentGoal = goal
            }

            // ── Phase 3: Consume events from session ────────────────
            let hasText = false

            while (true) {
              const event = await session.waitForEvent()
              if (!event) break

              if (event.type === "text-delta") {
                if (!event.value) continue
                if (!hasText) {
                  hasText = true
                  controller.enqueue({ type: "text-start", id: textId })
                }
                controller.enqueue({ type: "text-delta", id: textId, delta: event.value })
                continue
              }

              if (event.type === "tool-request") {
                let mapped: MappedToolCall | MappedToolCall[]
                try {
                  mapped = mapDuoToolRequest(event.toolName, event.args)
                } catch {
                  continue
                }

                if (hasText) {
                  controller.enqueue({ type: "text-end", id: textId })
                }

                if (Array.isArray(mapped)) {
                  // Multi-call expansion (e.g. read_files → N × read)
                  const subIds = mapped.map((_, i) => `${event.requestId}_sub_${i}`)
                  model.#multiCallGroups.set(event.requestId, {
                    subIds,
                    labels: mapped.map((m) => String(m.args.filePath ?? m.args.path ?? "")),
                    collected: new Map(),
                  })
                  model.#pendingToolRequests.set(event.requestId, {})
                  for (const subId of subIds) {
                    model.#pendingToolRequests.set(subId, {})
                  }

                  for (let i = 0; i < mapped.length; i++) {
                    const inputJson = JSON.stringify(mapped[i].args)
                    controller.enqueue({ type: "tool-input-start" as const, id: subIds[i], toolName: mapped[i].toolName })
                    controller.enqueue({ type: "tool-input-delta" as const, id: subIds[i], delta: inputJson })
                    controller.enqueue({ type: "tool-input-end" as const, id: subIds[i] })
                    controller.enqueue({
                      type: "tool-call",
                      toolCallId: subIds[i],
                      toolName: mapped[i].toolName,
                      input: inputJson,
                    })
                  }
                } else {
                  model.#pendingToolRequests.set(event.requestId, {})
                  const inputJson = JSON.stringify(mapped.args)
                  controller.enqueue({ type: "tool-input-start" as const, id: event.requestId, toolName: mapped.toolName })
                  controller.enqueue({ type: "tool-input-delta" as const, id: event.requestId, delta: inputJson })
                  controller.enqueue({ type: "tool-input-end" as const, id: event.requestId })
                  controller.enqueue({
                    type: "tool-call",
                    toolCallId: event.requestId,
                    toolName: mapped.toolName,
                    input: inputJson,
                  })
                }

                controller.enqueue({
                  type: "finish",
                  finishReason: "tool-calls",
                  usage: UNKNOWN_USAGE,
                })
                controller.close()
                return
              }

              if (event.type === "error") {
                controller.enqueue({ type: "error", error: new Error(event.message) })
                controller.enqueue({ type: "finish", finishReason: "error", usage: UNKNOWN_USAGE })
                controller.close()
                return
              }
            }

            // Stream ended normally
            if (hasText) {
              controller.enqueue({ type: "text-end", id: textId })
            }
            controller.enqueue({ type: "finish", finishReason: "stop", usage: UNKNOWN_USAGE })
            controller.close()
          } catch (error) {
            controller.enqueue({ type: "error", error })
            controller.enqueue({ type: "finish", finishReason: "error", usage: UNKNOWN_USAGE })
            controller.close()
          } finally {
            options.abortSignal?.removeEventListener("abort", onAbort)
          }
        },
      }),
      request: {
        body: {
          goal,
          workflowID: session.workflowId,
        },
      },
    }
  }

  /** Remove a cached session, freeing its resources. */
  disposeSession(sessionID: string): boolean {
    return sessions.delete(sessionKey(this.#client.instanceUrl, this.modelId, sessionID))
  }

  #resolveSession(sessionID: string): WorkflowSession {
    const key = sessionKey(this.#client.instanceUrl, this.modelId, sessionID)
    const existing = sessions.get(key)
    if (existing) return existing

    const existingWorkflowId = loadWorkflowId(key)

    const created = new WorkflowSession(this.#client, this.modelId, this.#cwd, {
      existingWorkflowId,
      onWorkflowCreated: (workflowId) => {
        saveWorkflowId(key, workflowId)
      },
    })
    if (this.#toolsConfig) created.setToolsConfig(this.#toolsConfig)
    sessions.set(key, created)
    return created
  }
}

function sessionKey(instanceUrl: string, modelId: string, sessionID: string): string {
  return `${instanceUrl}::${modelId}::${sessionID}`
}
