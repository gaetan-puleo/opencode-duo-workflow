import type { Plugin } from "@opencode-ai/plugin"

const PROVIDER_ID = "gitlab-duo-agentic-unofficial"

export const GitLabDuoAgenticPlugin: Plugin = async () => {
  return {
    config: async (input) => {
      input.provider ??= {}

      const existing = input.provider[PROVIDER_ID]
      const providerPath =
        process.env.GITLAB_DUO_AGENTIC_PROVIDER_PATH ??
        new URL("../provider", import.meta.url).pathname

      const existingOptions = (existing?.options ?? {}) as Record<string, unknown>
      const apiKey = resolveStringOption(existingOptions.apiKey) || process.env.GITLAB_TOKEN || ""
      const instanceUrl =
        resolveStringOption(existingOptions.instanceUrl) ||
        process.env.GITLAB_INSTANCE_URL ||
        "https://gitlab.com"

      input.provider[PROVIDER_ID] = {
        name: existing?.name ?? "GitLab Duo Agentic (Unofficial)",
        npm: existing?.npm ?? `file://${providerPath}`,
        options: {
          instanceUrl,
          apiKey,
          toolApproval: existingOptions.toolApproval ?? "ask",
          sendSystemContext: existingOptions.sendSystemContext ?? true,
          enableMcp: existingOptions.enableMcp ?? true,
        },
        models: await loadGitLabModels({
          instanceUrl,
          apiKey,
          rootNamespaceId: undefined,
        }),
      }
    },
  }
}

function resolveStringOption(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

type AvailableModel = { name: string; ref: string }

async function loadGitLabModels({
  instanceUrl,
  apiKey,
  rootNamespaceId,
}: {
  instanceUrl: string
  apiKey: string
  rootNamespaceId?: string
}): Promise<Record<string, Record<string, unknown>>> {
  if (!apiKey || !rootNamespaceId) {
    return {
      "duo-agentic": fallbackModel("Duo Agentic"),
    }
  }

  const query = `query lsp_aiChatAvailableModels($rootNamespaceId: GroupID!) {
  metadata {
    featureFlags(names: ["ai_user_model_switching"]) {
      enabled
      name
    }
    version
  }
  aiChatAvailableModels(rootNamespaceId: $rootNamespaceId) {
    defaultModel { name ref }
    selectableModels { name ref }
    pinnedModel { name ref }
  }
}`

  const response = await fetch(new URL("/api/graphql", instanceUrl).toString(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ query, variables: { rootNamespaceId } }),
  })

  if (!response.ok) {
    return { "duo-agentic": fallbackModel("Duo Agentic") }
  }

  const data = (await response.json()) as {
    data?: {
      aiChatAvailableModels?: {
        defaultModel?: AvailableModel | null
        selectableModels?: AvailableModel[]
        pinnedModel?: AvailableModel | null
      } | null
    }
  }

  const available = data?.data?.aiChatAvailableModels
  if (!available) {
    return { "duo-agentic": fallbackModel("Duo Agentic") }
  }

  const models = new Map<string, AvailableModel>()
  const addModel = (model?: AvailableModel | null) => {
    if (!model?.ref) return
    models.set(model.ref, model)
  }

  addModel(available.defaultModel ?? null)
  addModel(available.pinnedModel ?? null)
  for (const model of available.selectableModels ?? []) {
    addModel(model)
  }

  if (models.size === 0) {
    return { "duo-agentic": fallbackModel("Duo Agentic") }
  }

  const entries: Record<string, Record<string, unknown>> = {}
  for (const [ref, model] of models.entries()) {
    entries[ref] = fallbackModel(model.name || ref)
  }
  return entries
}

function fallbackModel(name: string): Record<string, unknown> {
  return {
    name,
    release_date: "",
    attachment: false,
    reasoning: false,
    temperature: true,
    tool_call: true,
    limit: {
      context: 0,
      output: 0,
    },
    modalities: {
      input: ["text"],
      output: ["text"],
    },
    options: {},
  }
}
