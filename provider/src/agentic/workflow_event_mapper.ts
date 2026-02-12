import type { DuoWorkflowEvent } from "./types"
import { extractUiChatLog } from "./ui_chat_log"
import type { Logger } from "./logger"

export type AgentEvent =
  | { type: "TEXT_CHUNK"; messageId: string; content: string; timestamp: number }
  | { type: "TOOL_COMPLETE"; toolId: string; result: string; error?: string; timestamp: number }
  | { type: "ERROR"; message: string; timestamp: number }

export class WorkflowEventMapper {
  #logger: Logger
  #lastMessageContent = ""
  #lastMessageId = ""

  constructor(logger: Logger) {
    this.#logger = logger
  }

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
      this.#logger.error("Failed to parse workflow checkpoint", workflowMessagesResult.error)
      return events
    }

    const workflowMessages = workflowMessagesResult.value
    if (workflowMessages.length === 0) return events

    const latestMessage = workflowMessages[workflowMessages.length - 1]
    const latestMessageIndex = workflowMessages.length - 1
    this.#logger.warn(`mapper: ${workflowMessages.length} messages, latest[${latestMessageIndex}]=${latestMessage.message_type}`)

    switch (latestMessage.message_type) {
      case "user":
        return events

      case "agent": {
        const currentContent = latestMessage.content
        const currentId = `${latestMessageIndex}`
        const timestamp = this.#parseTimestamp(latestMessage.timestamp)

        if (currentId === this.#lastMessageId) {
          if (!currentContent.startsWith(this.#lastMessageContent)) {
            this.#logger.error(
              `Workflow Service replaced message content unexpectedly. Message ID: ${currentId} Previous message: "${this.#lastMessageContent}", Current message: "${currentContent}"`,
            )
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
        // Checkpoint approval requests are informational only — the direct
        // WebSocket action (TOOL_REQUEST) handles actual execution.
        this.#logger.warn(`mapper request (ignored): tool=${latestMessage.tool_info.name} args=${JSON.stringify(latestMessage.tool_info.args).slice(0, 200)}`)
        break
      }

      case "tool": {
        this.#logger.warn(`mapper tool: name=${latestMessage.tool_info?.name ?? "null"} hasResponse=${!!latestMessage.tool_info?.tool_response} contentLen=${latestMessage.content?.length ?? 0}`)
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
