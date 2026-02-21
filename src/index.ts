import type { ProviderV2 } from "@ai-sdk/provider"
import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin"
import { createPluginHooks } from "./plugin/hooks"
import { createFallbackProvider } from "./provider"

type EntryInput = PluginInput | Record<string, unknown>
type EntryOutput = Promise<Hooks> | ProviderV2

function isPluginInput(value: unknown): value is PluginInput {
  if (!value || typeof value !== "object") return false

  const input = value as Record<string, unknown>
  return (
    "client" in input &&
    "project" in input &&
    "directory" in input &&
    "worktree" in input &&
    "serverUrl" in input
  )
}

const entry = (input: EntryInput): EntryOutput => {
  if (isPluginInput(input)) {
    return createPluginHooks(input)
  }

  return createFallbackProvider(input)
}

export const createGitLabDuoAgentic = entry
export const GitLabDuoAgenticPlugin: Plugin = entry as Plugin
export default GitLabDuoAgenticPlugin
