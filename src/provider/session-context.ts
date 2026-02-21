import type { LanguageModelV2CallOptions } from "@ai-sdk/provider"
import { PROVIDER_ID } from "../constants"

/**
 * Read the workflow session ID from the call options.
 *
 * Checks (in order):
 *   1. `providerOptions.gitlab.workflowSessionID`
 *   2. `headers["x-opencode-session"]`
 */
export function readSessionID(options: LanguageModelV2CallOptions): string | undefined {
  const providerBlock = readProviderBlock(options)
  if (typeof providerBlock?.workflowSessionID === "string" && providerBlock.workflowSessionID.trim()) {
    return providerBlock.workflowSessionID.trim()
  }

  const headers = options.headers ?? {}
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "x-opencode-session" && value?.trim()) return value.trim()
  }

  return undefined
}

function readProviderBlock(options: LanguageModelV2CallOptions): Record<string, unknown> | undefined {
  const block = options.providerOptions?.[PROVIDER_ID]
  if (block && typeof block === "object" && !Array.isArray(block)) {
    return block as Record<string, unknown>
  }

  return undefined
}
