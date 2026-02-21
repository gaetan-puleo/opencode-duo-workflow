import { randomUUID } from "node:crypto"
import type { UiChatLogEntry, WorkflowCheckpointPayload } from "./types"

export type CheckpointState = {
  uiChatLog: UiChatLogEntry[]
  /** Indices of "request" entries already processed (to avoid re-execution). */
  processedRequestIndices: Set<number>
}

export type CheckpointToolRequest = {
  requestId: string
  toolName: string
  args: Record<string, unknown>
}

export function createCheckpointState(): CheckpointState {
  return {
    uiChatLog: [],
    processedRequestIndices: new Set(),
  }
}

export function extractAgentTextDeltas(checkpoint: string, state: CheckpointState): string[] {
  const next = parseCheckpoint(checkpoint)
  const out: string[] = []

  for (let i = 0; i < next.length; i++) {
    const item = next[i]
    if (item.message_type !== "agent") continue

    const previous = state.uiChatLog[i]
    if (!previous || previous.message_type !== "agent") {
      if (item.content) out.push(item.content)
      continue
    }

    if (item.content === previous.content) continue

    if (item.content.startsWith(previous.content)) {
      const delta = item.content.slice(previous.content.length)
      if (delta) out.push(delta)
      continue
    }

    if (item.content) out.push(item.content)
  }

  state.uiChatLog = next
  return out
}

/**
 * Extract new tool requests from a checkpoint.
 *
 * DWS embeds tool requests in checkpoint messages as ui_chat_log entries
 * with message_type "request". Each has tool_info (name + args) and a
 * correlation_id used as the requestId for the actionResponse.
 */
export function extractToolRequests(checkpoint: string, state: CheckpointState): CheckpointToolRequest[] {
  const next = parseCheckpoint(checkpoint)
  const requests: CheckpointToolRequest[] = []

  for (let i = 0; i < next.length; i++) {
    const item = next[i]
    if (item.message_type !== "request") continue
    if (!item.tool_info) continue
    if (state.processedRequestIndices.has(i)) continue

    state.processedRequestIndices.add(i)
    requests.push({
      requestId: item.correlation_id ?? randomUUID(),
      toolName: item.tool_info.name,
      args: item.tool_info.args ?? {},
    })
  }

  return requests
}

function parseCheckpoint(raw: string): UiChatLogEntry[] {
  if (!raw) return []

  try {
    const parsed = JSON.parse(raw) as WorkflowCheckpointPayload
    const log = parsed.channel_values?.ui_chat_log
    if (!Array.isArray(log)) return []

    return log.filter(isUiChatLogEntry)
  } catch {
    return []
  }
}

function isUiChatLogEntry(value: unknown): value is UiChatLogEntry {
  if (!value || typeof value !== "object") return false
  const item = value as Record<string, unknown>
  if (typeof item.message_type !== "string") return false
  if (typeof item.content !== "string") return false

  return (
    item.message_type === "user" ||
    item.message_type === "agent" ||
    item.message_type === "tool" ||
    item.message_type === "request"
  )
}
