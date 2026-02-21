import crypto from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { z } from "zod"
import { CACHE_TTL_MS, DEFAULT_MODEL_ID } from "../constants"
import { type GitLabClientOptions, graphql } from "./client"
import { detectProjectPath, fetchProjectDetails, resolveRootNamespaceId } from "./project"

export type AvailableModel = {
  id: string
  name: string
}

type GraphQLData = {
  aiChatAvailableModels?: {
    defaultModel?: { name: string; ref: string } | null
    selectableModels?: Array<{ name: string; ref: string }>
    pinnedModel?: { name: string; ref: string } | null
  } | null
}

const CachePayloadSchema = z.object({
  cachedAt: z.string(),
  instanceUrl: z.string(),
  models: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
      }),
    )
    .min(1),
})

type CachePayload = z.infer<typeof CachePayloadSchema>

const QUERY = `query lsp_aiChatAvailableModels($rootNamespaceId: GroupID!) {
  aiChatAvailableModels(rootNamespaceId: $rootNamespaceId) {
    defaultModel { name ref }
    selectableModels { name ref }
    pinnedModel { name ref }
  }
}`

/**
 * Load available models with priority:
 *   1. Fresh cache
 *   2. Live GraphQL fetch (then cache result)
 *   3. Stale cache
 *   4. Hardcoded fallback
 */
export async function loadAvailableModels(instanceUrl: string, token: string, cwd: string): Promise<AvailableModel[]> {
  const cachePath = getCachePath(instanceUrl, cwd)

  // 1. try fresh cache
  const cached = await readCache(cachePath)
  if (cached && !isStale(cached)) {
    return cached.models
  }

  // 2. try live fetch -- failure is non-fatal, we fall through to stale cache / hardcoded default
  if (token) {
    try {
      const models = await fetchModelsFromApi({ instanceUrl, token }, cwd)
      if (models.length > 0) {
        await writeCache(cachePath, { cachedAt: new Date().toISOString(), instanceUrl, models })
        return models
      }
    } catch {
      // API unavailable or unauthorized -- fall through to stale cache / hardcoded fallback
    }
  }

  // 3. try stale cache
  if (cached) {
    return cached.models
  }

  // 4. hardcoded fallback
  return [{ id: DEFAULT_MODEL_ID, name: DEFAULT_MODEL_ID }]
}

async function fetchModelsFromApi(client: GitLabClientOptions, cwd: string): Promise<AvailableModel[]> {
  const projectPath = await detectProjectPath(cwd, client.instanceUrl)
  if (!projectPath) return []

  const project = await fetchProjectDetails(client, projectPath)
  const rootNamespaceId = await resolveRootNamespaceId(client, project.namespaceId)

  const data = await graphql<GraphQLData>(client, QUERY, { rootNamespaceId })
  const available = data.aiChatAvailableModels
  if (!available) return []

  const seen = new Set<string>()
  const models: AvailableModel[] = []

  function add(entry?: { name: string; ref: string } | null) {
    if (!entry?.ref || seen.has(entry.ref)) return
    seen.add(entry.ref)
    models.push({ id: entry.ref, name: entry.name || entry.ref })
  }

  add(available.defaultModel)
  add(available.pinnedModel)
  for (const m of available.selectableModels ?? []) add(m)

  return models
}

// -- cache --

function getCachePath(instanceUrl: string, cwd: string): string {
  const key = `${instanceUrl}::${cwd}`
  const hash = crypto.createHash("sha256").update(key).digest("hex").slice(0, 12)
  const dir = process.env.XDG_CACHE_HOME?.trim()
    ? path.join(process.env.XDG_CACHE_HOME, "opencode")
    : path.join(os.homedir(), ".cache", "opencode")
  return path.join(dir, `gitlab-duo-models-${hash}.json`)
}

function isStale(payload: CachePayload): boolean {
  const age = Date.now() - Date.parse(payload.cachedAt)
  return age > CACHE_TTL_MS
}

async function readCache(cachePath: string): Promise<CachePayload | null> {
  try {
    const raw = await fs.readFile(cachePath, "utf8")
    const parsed = CachePayloadSchema.parse(JSON.parse(raw))
    return parsed
  } catch {
    // Cache missing, corrupt, or schema mismatch -- treat as cache miss
    return null
  }
}

async function writeCache(cachePath: string, payload: CachePayload): Promise<void> {
  try {
    await fs.mkdir(path.dirname(cachePath), { recursive: true })
    await fs.writeFile(cachePath, JSON.stringify(payload, null, 2), "utf8")
  } catch {
    // Cache write failure is non-fatal -- the plugin still works without caching
  }
}
