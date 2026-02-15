import crypto from "node:crypto"
import type { DuoWorkflowEvent } from "./types"
import { extractUiChatLog } from "./ui_chat_log"

export type AgentEvent =
  | { type: "TEXT_CHUNK"; messageId: string; content: string; timestamp: number }
  | { type: "TOOL_COMPLETE"; toolId: string; result: string; error?: string; timestamp: number }
  | { type: "TOOL_REQUEST"; requestId: string; toolName: string; args: Record<string, unknown>; timestamp: number }
  | { type: "ERROR"; message: string; timestamp: number }

export class WorkflowEventMapper {
  #lastMessageContent = ""
  #lastMessageId = ""

  resetStreamState(): void {
    this.#lastMessageContent = ""
    this.#lastMessageId = ""
  }

  #parseTimestamp(timestamp: string): number {
    const parsed = Date.parse(timestamp)
    return Number.isNaN(parsed) ? Date.now() : parsed
  }

  mapWorkflowEvent(duoEvent: DuoWorkflowEvent): AgentEvent[] {
    const events: AgentEvent[] = []
    const workflowMessagesResult = extractUiChatLog(duoEvent)
    if (workflowMessagesResult.isErr()) {
      return events
    }

    const workflowMessages = workflowMessagesResult.value
    if (workflowMessages.length === 0) return events

    const latestMessage = workflowMessages[workflowMessages.length - 1]
    const latestMessageIndex = workflowMessages.length - 1

    switch (latestMessage.message_type) {
      case "user":
        return events

      case "agent": {
        const currentContent = latestMessage.content
        const currentId = `${latestMessageIndex}`
        const timestamp = this.#parseTimestamp(latestMessage.timestamp)

        if (currentId === this.#lastMessageId) {
          if (!currentContent.startsWith(this.#lastMessageContent)) {
            events.push({
              type: "TEXT_CHUNK",
              messageId: currentId,
              content: currentContent,
              timestamp,
            })
            this.#lastMessageContent = currentContent
          }
          const delta = currentContent.slice(this.#lastMessageContent.length)
          if (delta.length > 0) {
            events.push({
              type: "TEXT_CHUNK",
              messageId: currentId,
              content: delta,
              timestamp,
            })
            this.#lastMessageContent = currentContent
          }
        } else {
          events.push({
            type: "TEXT_CHUNK",
            messageId: currentId,
            content: currentContent,
            timestamp,
          })
          this.#lastMessageContent = currentContent
          this.#lastMessageId = currentId
        }
        break
      }

      case "request": {
        const requestId = latestMessage.correlation_id || crypto.randomUUID()
        events.push({
          type: "TOOL_REQUEST",
          requestId,
          toolName: latestMessage.tool_info.name,
          args: (latestMessage.tool_info.args ?? {}) as Record<string, unknown>,
          timestamp: this.#parseTimestamp(latestMessage.timestamp),
        })
        break
      }

      case "tool": {
        const toolId = `${latestMessageIndex}`
        const timestamp = this.#parseTimestamp(latestMessage.timestamp)

        const toolResponse = latestMessage.tool_info?.tool_response
        const output =
          typeof toolResponse === "string"
            ? toolResponse
            : (toolResponse?.content ?? latestMessage.content)

        if (output.startsWith("Action error:")) {
          events.push({
            type: "TOOL_COMPLETE",
            toolId,
            result: "",
            error: output,
            timestamp,
          })
        } else {
          events.push({
            type: "TOOL_COMPLETE",
            toolId,
            result: output,
            timestamp,
          })
        }
        break
      }

      default:
        break
    }

    return events
  }
}
