import type { UiChatLogEntry, WorkflowCheckpointPayload } from "./types"

export type CheckpointState = {
  uiChatLog: UiChatLogEntry[]
}

export function createCheckpointState(): CheckpointState {
  return {
    uiChatLog: [],
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
