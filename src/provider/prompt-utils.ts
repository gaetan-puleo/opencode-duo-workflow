/**
 * Utilities for extracting information from AI SDK LanguageModelV2 prompts.
 * Ported from the old provider/src/core/prompt_utils.ts
 */

type PromptMessage = {
  role?: string
  content?: unknown
}

type ExtractedToolResult = {
  toolCallId: string
  toolName: string
  output: string
  error?: string
}

/**
 * Extract tool results from an AI SDK prompt.
 * Handles both tool-result and tool-error parts.
 * Normalises across AI SDK v4 (result) and v5 (output) shapes.
 */
export function extractToolResults(prompt: unknown[]): ExtractedToolResult[] {
  if (!Array.isArray(prompt)) return []
  const results: ExtractedToolResult[] = []

  for (const message of prompt) {
    const content = (message as PromptMessage).content
    if (!Array.isArray(content)) continue

    for (const part of content) {
      const p = part as Record<string, unknown>

      if (p.type === "tool-result") {
        const toolCallId = String(p.toolCallId ?? "")
        const toolName = String(p.toolName ?? "")
        if (!toolCallId) continue

        const { output, error } = parseToolResultOutput(p)
        // Fallback error fields from part itself
        const finalError = error
          ?? asString(p.error)
          ?? asString(p.errorText)
        results.push({ toolCallId, toolName, output, error: finalError })
      }

      if (p.type === "tool-error") {
        const toolCallId = String(p.toolCallId ?? "")
        const toolName = String(p.toolName ?? "")
        const errorValue = p.error ?? p.errorText ?? p.message
        const error = asString(errorValue) ?? String(errorValue ?? "")
        results.push({ toolCallId, toolName, output: "", error })
      }
    }
  }

  return results
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function parseToolResultOutput(part: Record<string, unknown>): { output: string; error?: string } {
  const outputField = part.output
  const resultField = part.result

  // AI SDK v2 structured output: { type: "text"|"error-text"|..., value: ... }
  if (isPlainObject(outputField) && "type" in outputField) {
    const outputType = String(outputField.type)
    const outputValue = (outputField as Record<string, unknown>).value

    if (outputType === "text" || outputType === "json") {
      return { output: typeof outputValue === "string" ? outputValue : JSON.stringify(outputValue ?? "") }
    }
    if (outputType === "error-text" || outputType === "error-json") {
      return { output: "", error: typeof outputValue === "string" ? outputValue : JSON.stringify(outputValue ?? "") }
    }
    if (outputType === "content" && Array.isArray(outputValue)) {
      const text = outputValue
        .filter((v: Record<string, unknown>) => v.type === "text")
        .map((v: Record<string, unknown>) => String(v.text ?? ""))
        .join("\n")
      return { output: text }
    }
  }

  // Plain value
  if (outputField !== undefined) {
    return { output: typeof outputField === "string" ? outputField : JSON.stringify(outputField) }
  }
  if (resultField !== undefined) {
    const output = typeof resultField === "string" ? resultField : JSON.stringify(resultField)
    // Check for error nested in result object
    const error = isPlainObject(resultField) ? asString(resultField.error) : undefined
    return { output, error }
  }

  return { output: "" }
}

/**
 * Extract the system prompt from the AI SDK prompt messages.
 */
export function extractSystemPrompt(prompt: unknown[]): string | null {
  if (!Array.isArray(prompt)) return null
  const parts: string[] = []
  for (const message of prompt) {
    const msg = message as PromptMessage
    if (msg.role === "system" && typeof msg.content === "string" && msg.content.trim()) {
      parts.push(msg.content)
    }
  }
  return parts.length > 0 ? parts.join("\n") : null
}

/**
 * Sanitize the OpenCode system prompt before forwarding to GitLab DWS.
 * Removes OpenCode-specific identity, URLs, and references.
 */
export function sanitizeSystemPrompt(prompt: string): string {
  let result = prompt

  // Remove identity header lines
  result = result.replace(/^You are [Oo]pen[Cc]ode[,.].*$/gm, "")
  result = result.replace(/^Your name is opencode\s*$/gm, "")

  // Remove OpenCode-specific paragraphs
  result = result.replace(
    /If the user asks for help or wants to give feedback[\s\S]*?https:\/\/github\.com\/anomalyco\/opencode\s*/g,
    "",
  )
  result = result.replace(
    /When the user directly asks about OpenCode[\s\S]*?https:\/\/opencode\.ai\/docs\s*/g,
    "",
  )

  // Remove OpenCode URLs
  result = result.replace(/https:\/\/github\.com\/anomalyco\/opencode\S*/g, "")
  result = result.replace(/https:\/\/opencode\.ai\S*/g, "")

  // Replace "OpenCode" / "opencode" with "GitLab Duo"
  result = result.replace(/\bOpenCode\b/g, "GitLab Duo")
  result = result.replace(/\bopencode\b/g, "GitLab Duo")

  // Strip "opencode/" prefix from model ID lines
  result = result.replace(/The exact model ID is GitLab Duo\//g, "The exact model ID is ")

  // Collapse excessive blank lines
  result = result.replace(/\n{3,}/g, "\n\n")

  return result.trim()
}

/**
 * Extract agent-injected reminders (plan mode, build-switch, custom agent instructions)
 * from synthetic text parts and system-reminder tags.
 */
export function extractAgentReminders(prompt: unknown[]): string[] {
  if (!Array.isArray(prompt)) return []

  // Find last user message text parts
  let textParts: Array<Record<string, unknown>> = []
  for (let i = prompt.length - 1; i >= 0; i--) {
    const message = prompt[i] as PromptMessage
    if (message?.role !== "user" || !Array.isArray(message.content)) continue
    textParts = (message.content as Array<Record<string, unknown>>).filter((p) => p.type === "text")
    if (textParts.length > 0) break
  }
  if (textParts.length === 0) return []

  const reminders: string[] = []
  for (const part of textParts) {
    if (!part.text) continue
    const text = String(part.text)

    if (part.synthetic) {
      const trimmed = text.trim()
      if (trimmed.length > 0) reminders.push(trimmed)
      continue
    }

    const matches = text.match(/<system-reminder>[\s\S]*?<\/system-reminder>/g)
    if (matches) reminders.push(...matches)
  }

  return reminders
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
