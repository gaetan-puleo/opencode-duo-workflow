import type { LanguageModelV2Prompt } from "@ai-sdk/provider"

const SYSTEM_REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g

const WRAPPED_USER_RE =
  /^<system-reminder>\s*The user sent the following message:\s*\n([\s\S]*?)\n\s*Please address this message and continue with your tasks\.\s*<\/system-reminder>$/

/**
 * Extract the user's goal from the last user message in the prompt.
 * Strips `<system-reminder>` tags but preserves any genuine user text
 * wrapped inside them.
 */
export function extractGoal(prompt: LanguageModelV2Prompt): string {
  for (let i = prompt.length - 1; i >= 0; i--) {
    const message = prompt[i]
    if (message.role !== "user") continue
    const content = Array.isArray(message.content) ? message.content : []
    const text = content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => stripSystemReminders(part.text))
      .filter(Boolean)
      .join("\n")
      .trim()

    if (text) return text
  }

  return ""
}

function stripSystemReminders(value: string): string {
  return value
    .replace(SYSTEM_REMINDER_RE, (block) => {
      const wrapped = WRAPPED_USER_RE.exec(block)
      return wrapped?.[1]?.trim() ?? ""
    })
    .trim()
}
