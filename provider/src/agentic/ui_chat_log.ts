import { z } from "zod"
import { err, ok, Result } from "neverthrow"
import type { DuoWorkflowEvent } from "./types"

const ToolInfoArgsSchema = z.record(z.unknown())

const ToolResponseSchema = z.object({
  content: z.string(),
  additional_kwargs: z.record(z.unknown()),
  response_metadata: z.record(z.unknown()),
  type: z.string(),
  name: z.string(),
  id: z.string().nullable(),
  tool_call_id: z.string(),
  artifact: z.unknown(),
  status: z.string(),
})

const ToolInfoSchema = z.object({
  name: z.string(),
  args: ToolInfoArgsSchema,
  tool_response: z.union([ToolResponseSchema, z.string()]).optional(),
})

const BaseMessageSchema = z.object({
  message_sub_type: z.string().nullable(),
  content: z.string(),
  timestamp: z.string(),
  status: z.string().nullable(),
  correlation_id: z.string().nullable(),
  additional_context: z.unknown(),
})

const WorkflowMessageSchema = BaseMessageSchema.extend({
  message_type: z.enum(["user", "agent"]),
  tool_info: z.null(),
})

const WorkflowRequestSchema = BaseMessageSchema.extend({
  message_type: z.literal("request"),
  tool_info: ToolInfoSchema,
})

const WorkflowToolSchema = BaseMessageSchema.extend({
  message_type: z.literal("tool"),
  tool_info: z.union([ToolInfoSchema, z.null()]),
})

const ChatLogSchema = z.discriminatedUnion("message_type", [
  WorkflowMessageSchema,
  WorkflowRequestSchema,
  WorkflowToolSchema,
])

type ChatLog = z.infer<typeof ChatLogSchema>

type CheckpointData = {
  channel_values: {
    ui_chat_log?: unknown[]
    plan?: { steps: unknown[] }
    [key: string]: unknown
  }
}

export function extractUiChatLog(message: DuoWorkflowEvent): Result<ChatLog[], Error> {
  if (!message.checkpoint) return ok([])

  let checkpoint: CheckpointData
  try {
    checkpoint = JSON.parse(message.checkpoint)
  } catch (error) {
    return err(
      new Error(`Failed to parse workflow checkpoint. Checkpoint: ${message.checkpoint}`, {
        cause: error,
      }),
    )
  }

  if (!checkpoint.channel_values?.ui_chat_log || !Array.isArray(checkpoint.channel_values.ui_chat_log)) {
    return ok([])
  }

  const validatedMessages: ChatLog[] = []
  for (let i = 0; i < checkpoint.channel_values.ui_chat_log.length; i += 1) {
    const rawMessage = checkpoint.channel_values.ui_chat_log[i]
    const parseResult = ChatLogSchema.safeParse(rawMessage)
    if (!parseResult.success) {
      return err(
        new Error(
          `Failed to validate message at index ${i}: ${parseResult.error.message}. Raw message: ${JSON.stringify(
            rawMessage,
          )}`,
        ),
      )
    }
    validatedMessages.push(parseResult.data)
  }

  return ok(validatedMessages)
}
