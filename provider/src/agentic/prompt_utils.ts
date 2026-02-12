/**
 * Utilities for extracting user text and tool results from the AI SDK prompt format.
 */

import type { LanguageModelV2CallOptions } from "@ai-sdk/provider"

// ---------------------------------------------------------------------------
// Primitive helpers
// ---------------------------------------------------------------------------

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string")
}

// ---------------------------------------------------------------------------
// Prompt text extraction
// ---------------------------------------------------------------------------

/**
 * Walk the prompt messages backwards and return the text content of the last
 * real user message (ignoring synthetic / ignored parts and system reminders).
 */
export function extractLastUserText(prompt: LanguageModelV2CallOptions["prompt"]): string | null {
  if (!Array.isArray(prompt)) return null
  for (let i = prompt.length - 1; i >= 0; i -= 1) {
    const message = prompt[i] as {
      role?: string
      content?: Array<{ type: string; text?: string; synthetic?: boolean; ignored?: boolean }>
    }
    if (message?.role === "user" && Array.isArray(message.content)) {
      const texts = message.content
        .filter((part) => part.type === "text" && !part.synthetic && !part.ignored)
        .map((part) => stripSystemReminder(part.text || ""))
        .filter((text) => text.trim().length > 0)
      if (texts.length === 0) continue
      return texts.join("").trim()
    }
  }
  return null
}

function stripSystemReminder(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim()
}

// ---------------------------------------------------------------------------
// Tool result extraction
// ---------------------------------------------------------------------------

/**
 * Collect tool results (and tool errors) from every message in the prompt,
 * normalising across AI SDK v4 (`result`) and v5 (`output`) shapes.
 */
export function extractToolResults(
  prompt: LanguageModelV2CallOptions["prompt"],
): Array<{ toolCallId: string; toolName: string; output: string; error?: string }> {
  if (!Array.isArray(prompt)) return []
  const results: Array<{ toolCallId: string; toolName: string; output: string; error?: string }> = []

  for (const message of prompt) {
    const content = (message as unknown as { content?: Array<Record<string, unknown>> }).content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (part.type === "tool-result") {
        const toolCallId = String((part as { toolCallId?: string }).toolCallId ?? "")
        const toolName = String((part as { toolName?: string }).toolName ?? "")
        const outputField = (part as { output?: unknown }).output
        const resultField = (part as { result?: unknown }).result
        let output = ""
        let error: string | undefined
        if (isPlainObject(outputField) && "type" in outputField) {
          const outputType = String(outputField.type)
          const outputValue = (outputField as { value?: unknown }).value
          if (outputType === "text" || outputType === "json") {
            output = typeof outputValue === "string" ? outputValue : JSON.stringify(outputValue ?? "")
          } else if (outputType === "error-text" || outputType === "error-json") {
            error = typeof outputValue === "string" ? outputValue : JSON.stringify(outputValue ?? "")
          } else if (outputType === "content" && Array.isArray(outputValue)) {
            output = outputValue
              .filter((v: Record<string, unknown>) => v.type === "text")
              .map((v: Record<string, unknown>) => String(v.text ?? ""))
              .join("\n")
          }
        } else if (outputField !== undefined) {
          output = String(outputField)
        } else if (resultField !== undefined) {
          output = typeof resultField === "string" ? resultField : JSON.stringify(resultField)
          if (isPlainObject(resultField)) error = asString(resultField.error)
        }
        if (!error) {
          error =
            asString((part as { error?: unknown }).error) ??
            asString((part as { errorText?: unknown }).errorText)
        }
        results.push({ toolCallId, toolName, output, error })
      }
      if (part.type === "tool-error") {
        const toolCallId = String((part as { toolCallId?: string }).toolCallId ?? "")
        const toolName = String((part as { toolName?: string }).toolName ?? "")
        const errorValue =
          (part as { error?: unknown }).error ??
          (part as { errorText?: unknown }).errorText ??
          (part as { message?: unknown }).message
        const error = asString(errorValue) ?? String(errorValue ?? "")
        results.push({ toolCallId, toolName, output: "", error })
      }
    }
  }

  return results
}
