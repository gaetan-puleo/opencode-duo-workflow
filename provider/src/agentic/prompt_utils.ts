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
// Agent reminder extraction
// ---------------------------------------------------------------------------

/**
 * Extract agent-injected reminders from the prompt messages.
 *
 * OpenCode injects agent-specific instructions (plan mode, build-switch,
 * custom agents, etc.) as synthetic text parts on user messages. These parts
 * are normally stripped by extractLastUserText() and never reach DWS.
 *
 * This function collects all such reminders so the bridge can forward them
 * as additional context items to DWS.
 */
export function extractAgentReminders(prompt: LanguageModelV2CallOptions["prompt"]): string[] {
  if (!Array.isArray(prompt)) return []
  const reminders: string[] = []
  for (const message of prompt) {
    const msg = message as {
      role?: string
      content?: Array<{ type: string; text?: string; synthetic?: boolean }>
    }
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content) {
      if (part.type !== "text" || !part.text) continue
      // Collect synthetic parts that contain agent instructions
      if (part.synthetic) {
        const text = part.text.trim()
        if (text.length > 0) {
          reminders.push(text)
        }
        continue
      }
      // Also extract inline <system-reminder> blocks from non-synthetic parts
      const matches = part.text.match(/<system-reminder>[\s\S]*?<\/system-reminder>/g)
      if (matches) {
        reminders.push(...matches)
      }
    }
  }
  return reminders
}

// ---------------------------------------------------------------------------
// System prompt extraction
// ---------------------------------------------------------------------------

/**
 * Collect all system messages from the prompt and join their content.
 * The AI SDK places system messages as `{ role: "system", content: string }`
 * at the beginning of the prompt array.
 */
export function extractSystemPrompt(prompt: LanguageModelV2CallOptions["prompt"]): string | null {
  if (!Array.isArray(prompt)) return null
  const parts: string[] = []
  for (const message of prompt) {
    const msg = message as { role?: string; content?: unknown }
    if (msg.role === "system" && typeof msg.content === "string" && msg.content.trim()) {
      parts.push(msg.content)
    }
  }
  return parts.length > 0 ? parts.join("\n") : null
}

// ---------------------------------------------------------------------------
// System prompt sanitization
// ---------------------------------------------------------------------------

/**
 * Sanitize the OpenCode system prompt before forwarding to GitLab DWS.
 *
 * 1. Remove OpenCode identity header lines
 * 2. Remove OpenCode-specific paragraphs (feedback, docs, ctrl+p)
 * 3. Remove OpenCode-specific URLs
 * 4. Replace remaining "OpenCode" / "opencode" references with "GitLab Duo"
 * 5. Strip "opencode/" prefix from model ID lines
 * 6. Collapse excessive blank lines left by removals
 */
export function sanitizeSystemPrompt(prompt: string): string {
  let result = prompt

  // --- 1. Remove identity header lines ---
  // "You are OpenCode, the best coding agent on the planet."
  // "You are opencode, an agent ...", "You are opencode, an interactive CLI ..."
  result = result.replace(/^You are [Oo]pen[Cc]ode[,.].*$/gm, "")
  // "Your name is opencode"
  result = result.replace(/^Your name is opencode\s*$/gm, "")

  // --- 2. Remove OpenCode-specific paragraphs ---
  // Feedback paragraph: "If the user asks for help..." through the GitHub URL
  result = result.replace(
    /If the user asks for help or wants to give feedback[\s\S]*?https:\/\/github\.com\/anomalyco\/opencode\s*/g,
    "",
  )
  // OpenCode docs paragraph: "When the user directly asks about OpenCode..."
  result = result.replace(
    /When the user directly asks about OpenCode[\s\S]*?https:\/\/opencode\.ai\/docs\s*/g,
    "",
  )

  // --- 3. Remove any remaining OpenCode-specific URLs ---
  result = result.replace(/https:\/\/github\.com\/anomalyco\/opencode\S*/g, "")
  result = result.replace(/https:\/\/opencode\.ai\S*/g, "")

  // --- 4. Replace remaining "OpenCode" / "opencode" with "GitLab Duo" ---
  // Use word boundaries to avoid mangling paths like ".opencode/" or package names
  result = result.replace(/\bOpenCode\b/g, "GitLab Duo")
  result = result.replace(/\bopencode\b/g, "GitLab Duo")

  // --- 5. Strip "opencode/" prefix from model ID lines ---
  // e.g. "The exact model ID is opencode/claude-..." -> "The exact model ID is claude-..."
  result = result.replace(/The exact model ID is GitLab Duo\//g, "The exact model ID is ")

  // --- 6. Collapse excessive blank lines (3+ consecutive) into 2 ---
  result = result.replace(/\n{3,}/g, "\n\n")

  return result.trim()
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
