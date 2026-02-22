import type { Hooks } from "@opencode-ai/plugin"
import { PROVIDER_ID } from "../constants"
import { type AvailableModel, loadAvailableModels } from "../gitlab/models"
import { resolveCredentials } from "../gitlab/resolve-credentials"

type PluginConfig = Parameters<NonNullable<Hooks["config"]>>[0]

export async function applyRuntimeConfig(config: PluginConfig, directory: string): Promise<void> {
  config.provider ??= {}

  const current = config.provider[PROVIDER_ID] ?? {}
  const options = (current.options ?? {}) as Record<string, unknown>
  const { instanceUrl, token } = resolveCredentials(options)

  const available = await loadAvailableModels(instanceUrl, token, directory)
  const modelIds = available.map((m) => m.id)
  const models = toModelsConfig(available)

  config.provider[PROVIDER_ID] = {
    ...current,
    npm: "opencode-gitlab-duo-agentic",
    whitelist: modelIds,
    options: {
      ...options,
      instanceUrl,
    },
    models: {
      ...(current.models ?? {}),
      ...models,
    },
  }
}

function toModelsConfig(available: AvailableModel[]): Record<string, { id: string; name: string }> {
  const out: Record<string, { id: string; name: string }> = {}
  for (const m of available) {
    out[m.id] = { id: m.id, name: m.name }
  }
  return out
}
