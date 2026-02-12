#!/usr/bin/env bun
/**
 * Fetch available GitLab Duo models and write them to models.json.
 *
 * Usage:
 *   bun run scripts/fetch_models.ts [--json]
 *
 * Environment:
 *   GITLAB_TOKEN          (required) GitLab personal access token
 *   GITLAB_INSTANCE_URL   (optional) defaults to https://gitlab.com
 *
 * The script auto-detects the GitLab project from the current git remote,
 * resolves the root namespace, and queries the aiChatAvailableModels GraphQL
 * endpoint. Results are written to models.json in the project root.
 */

import path from "path"
import fs from "fs/promises"
import { fileURLToPath } from "node:url"
import {
  detectProjectPath,
  fetchProjectDetailsWithFallback,
  resolveRootNamespaceId,
} from "../provider/src/agentic/gitlab_utils"
import { buildModelEntry } from "../shared/model_entry"

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..")
const OUTPUT_PATH = path.join(PROJECT_ROOT, "models.json")

const apiKey = process.env.GITLAB_TOKEN || ""
const instanceUrl = (process.env.GITLAB_INSTANCE_URL || "https://gitlab.com").replace(/\/$/, "")
const jsonFlag = process.argv.includes("--json")

// ---------------------------------------------------------------------------
// GraphQL query
// ---------------------------------------------------------------------------

const AVAILABLE_MODELS_QUERY = `query lsp_aiChatAvailableModels($rootNamespaceId: GroupID!) {
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

type AvailableModel = { name: string; ref: string }

type GraphQLResponse = {
  data?: {
    metadata?: {
      featureFlags?: Array<{ name: string; enabled: boolean }>
      version?: string
    }
    aiChatAvailableModels?: {
      defaultModel?: AvailableModel | null
      selectableModels?: AvailableModel[]
      pinnedModel?: AvailableModel | null
    } | null
  }
  errors?: Array<{ message: string }>
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // 1. Validate env
  if (!apiKey) {
    console.error("Error: GITLAB_TOKEN environment variable is required.")
    console.error("  export GITLAB_TOKEN=glpat-...")
    process.exit(1)
  }

  console.log(`Instance:  ${instanceUrl}`)

  // 2. Detect project from git remote
  const cwd = process.cwd()
  const projectPath = await detectProjectPath(cwd, instanceUrl)
  if (!projectPath) {
    console.error("Error: Could not detect GitLab project from git remote.")
    console.error("  Ensure you are in a git repository with a GitLab remote matching the instance URL.")
    process.exit(1)
  }

  console.log(`Project:   ${projectPath}`)

  // 3. Fetch project details to get namespace ID
  let namespaceId: string | undefined
  try {
    const details = await fetchProjectDetailsWithFallback(instanceUrl, apiKey, projectPath)
    namespaceId = details.namespaceId
  } catch (err) {
    console.error(`Error: Failed to fetch project details: ${err instanceof Error ? err.message : err}`)
    process.exit(1)
  }

  if (!namespaceId) {
    console.error("Error: Could not determine namespace ID from project.")
    process.exit(1)
  }

  console.log(`Namespace: ${namespaceId}`)

  // 4. Resolve root namespace (walk up subgroups)
  let rootNamespaceId: string
  try {
    rootNamespaceId = await resolveRootNamespaceId(instanceUrl, apiKey, namespaceId)
  } catch (err) {
    console.error(`Error: Failed to resolve root namespace: ${err instanceof Error ? err.message : err}`)
    process.exit(1)
  }

  console.log(`Root NS:   ${rootNamespaceId}`)
  console.log()

  // 5. Run GraphQL query
  const graphqlUrl = `${instanceUrl}/api/graphql`
  const response = await fetch(graphqlUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query: AVAILABLE_MODELS_QUERY,
      variables: { rootNamespaceId },
    }),
  })

  if (!response.ok) {
    const text = await response.text()
    console.error(`Error: GraphQL request failed: ${response.status}`)
    console.error(text)
    process.exit(1)
  }

  const result = (await response.json()) as GraphQLResponse

  if (result.errors?.length) {
    console.error("GraphQL errors:")
    for (const err of result.errors) {
      console.error(`  - ${err.message}`)
    }
    process.exit(1)
  }

  // 6. Parse response
  const metadata = result.data?.metadata
  const available = result.data?.aiChatAvailableModels
  const featureFlags: Record<string, boolean> = {}
  for (const flag of metadata?.featureFlags ?? []) {
    featureFlags[flag.name] = flag.enabled
  }

  const defaultModel = available?.defaultModel ?? null
  const pinnedModel = available?.pinnedModel ?? null
  const selectableModels = available?.selectableModels ?? []

  // 7. Build models map
  const models: Record<string, Record<string, unknown>> = {}

  // Always include the default model
  if (defaultModel?.ref) {
    models[defaultModel.ref] = buildModelEntry(defaultModel.name || defaultModel.ref)
  }

  // Include pinned model
  if (pinnedModel?.ref) {
    models[pinnedModel.ref] = buildModelEntry(pinnedModel.name || pinnedModel.ref)
  }

  // Include all selectable models
  for (const model of selectableModels) {
    if (model.ref && !models[model.ref]) {
      models[model.ref] = buildModelEntry(model.name || model.ref)
    }
  }

  // Fallback if no models found
  if (Object.keys(models).length === 0) {
    console.warn("Warning: No models returned from the API. Writing fallback model.")
    models["duo-agentic"] = buildModelEntry("Duo Agentic")
  }

  // 8. Build output
  const output = {
    metadata: {
      instanceUrl,
      rootNamespaceId,
      gitlabVersion: metadata?.version ?? null,
      fetchedAt: new Date().toISOString(),
      featureFlags,
      defaultModel: defaultModel?.ref ?? null,
      pinnedModel: pinnedModel?.ref ?? null,
    },
    models,
  }

  // 9. Write models.json
  await fs.writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2) + "\n", "utf8")

  // 10. Build the OpenCode config snippet
  const defaultModelRef = defaultModel?.ref ?? Object.keys(models)[0] ?? "duo-agentic"
  const opencodeConfig = {
    $schema: "https://opencode.ai/config.json",
    provider: {
      "gitlab-duo-agentic-unofficial": {
        name: "GitLab Duo Agentic (Unofficial)",
        npm: "file:///path/to/opencode-gitlab-duo-workflow/provider",
        options: {
          instanceUrl,
          apiKey: "",
          toolApproval: "ask",
          sendSystemContext: true,
          enableMcp: true,
        },
        models,
      },
    },
    model: `gitlab-duo-agentic-unofficial/${defaultModelRef}`,
  }

  // 11. Output
  if (jsonFlag) {
    console.log(JSON.stringify(result.data, null, 2))
  } else {
    console.log("GitLab Duo Available Models")
    console.log("─".repeat(50))
    console.log()
    console.log(`Default: ${defaultModel ? `${defaultModel.name} (${defaultModel.ref})` : "(none)"}`)
    console.log(`Pinned:  ${pinnedModel ? `${pinnedModel.name} (${pinnedModel.ref})` : "(none)"}`)
    console.log()

    if (selectableModels.length > 0) {
      console.log("Selectable models:")
      const maxRefLen = Math.max(...selectableModels.map((m) => m.ref.length))
      for (const model of selectableModels) {
        console.log(`  ${model.ref.padEnd(maxRefLen + 2)} ${model.name}`)
      }
    } else {
      console.log("No selectable models returned.")
    }

    console.log()
    console.log(`GitLab version: ${metadata?.version ?? "unknown"}`)
    console.log()
    console.log(`Written to ${OUTPUT_PATH}`)
    console.log(`Models count: ${Object.keys(models).length}`)
  }

  // Always print the OpenCode config JSON at the end
  console.log()
  console.log("─".repeat(50))
  console.log("OpenCode config (copy-paste into opencode.json):")
  console.log("─".repeat(50))
  console.log(JSON.stringify(opencodeConfig, null, 2))
}

main().catch((err) => {
  console.error("Fatal error:", err instanceof Error ? err.message : err)
  process.exit(1)
})
