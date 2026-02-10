import type { DuoWorkflowEvent, ToolInputDisplay } from "./types"
import { extractUiChatLog } from "./ui_chat_log"
import { ToolInputFormatter } from "./tool_input_formatter"
import type { Logger } from "./logger"

export type AgentEvent =
  | { type: "TEXT_CHUNK"; messageId: string; content: string; timestamp: number }
  | {
      type: "TOOL_START" | "TOOL_AWAITING_APPROVAL"
      toolId: string
      toolName: string
      input: ToolInputDisplay
      timestamp: number
    }
  | { type: "TOOL_COMPLETE"; toolId: string; result: string; error?: string; timestamp: number }
  | { type: "ERROR"; message: string; timestamp: number }

export class WorkflowEventMapper {
  #toolInputFormatter: ToolInputFormatter
  #logger: Logger
  #lastMessageContent = ""
  #lastMessageId = ""

  constructor(toolInputFormatter: ToolInputFormatter, logger: Logger) {
    this.#toolInputFormatter = toolInputFormatter
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

  #argsMatch(args1: Record<string, unknown>, args2: Record<string, unknown>): boolean {
    if ("program" in args1 && "program" in args2) {
      return (args1 as { program?: unknown }).program === (args2 as { program?: unknown }).program
    }
    return JSON.stringify(args1) === JSON.stringify(args2)
  }

  async mapWorkflowEvent(duoEvent: DuoWorkflowEvent): Promise<AgentEvent[]> {
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
        events.push({
          type: "TOOL_AWAITING_APPROVAL",
          toolId: `${latestMessageIndex}`,
          toolName: latestMessage.tool_info.name,
          input: await this.#toolInputFormatter.formatToolInput(
            latestMessage.tool_info.name,
            latestMessage.tool_info.args,
          ),
          timestamp: this.#parseTimestamp(latestMessage.timestamp),
        })
        break
      }

      case "tool": {
        let approvalRequestIndex: number | undefined
        for (let i = latestMessageIndex - 1; i >= 0; i -= 1) {
          const prevMsg = workflowMessages[i]
          if (
            prevMsg.message_type === "request" &&
            prevMsg.tool_info !== null &&
            latestMessage.tool_info !== null &&
            prevMsg.tool_info.name === latestMessage.tool_info.name &&
            this.#argsMatch(prevMsg.tool_info.args, latestMessage.tool_info.args)
          ) {
            approvalRequestIndex = i
            break
          }
        }

        const toolId = `${approvalRequestIndex ?? latestMessageIndex}`
        const timestamp = this.#parseTimestamp(latestMessage.timestamp)

        if (approvalRequestIndex === undefined) {
          events.push({
            type: "TOOL_AWAITING_APPROVAL",
            toolId,
            toolName: latestMessage.tool_info?.name || "unknown tool",
            input: await this.#toolInputFormatter.formatToolInput(
              latestMessage.tool_info?.name || "unknown tool",
              latestMessage.tool_info?.args || {},
            ),
            timestamp,
          })
        }

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
