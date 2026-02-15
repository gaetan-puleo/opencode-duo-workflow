import fs from "node:fs/promises"
import path from "node:path"

// ---------------------------------------------------------------------------
// Git remote detection
// ---------------------------------------------------------------------------

export async function detectProjectPath(cwd: string, instanceUrl: string): Promise<string | undefined> {
  let current = cwd
  const instance = new URL(instanceUrl)
  const instanceHost = instance.host
  const instanceBasePath = instance.pathname.replace(/\/$/, "")
  while (true) {
    try {
      const config = await readGitConfig(current)
      const url = extractGitRemoteUrl(config) || ""
      const remote = parseRemote(url)
      if (!remote) {
        return undefined
      }
      if (remote.host !== instanceHost) {
        // If the host doesn't match, keep searching upward for another repo.
        throw new Error(
          `GitLab remote host mismatch. Expected ${instanceHost}, got ${remote.host}.`,
        )
      }
      return normalizeProjectPath(remote.path, instanceBasePath)
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return undefined
      current = parent
    }
  }
}

function extractGitRemoteUrl(config: string): string | undefined {
  const lines = config.split("\n")
  let inOrigin = false
  let originUrl: string | undefined
  let firstUrl: string | undefined

  for (const line of lines) {
    const trimmed = line.trim()
    const sectionMatch = /^\[remote\s+"([^"]+)"\]$/.exec(trimmed)
    if (sectionMatch) {
      inOrigin = sectionMatch[1] === "origin"
      continue
    }
    const urlMatch = /^url\s*=\s*(.+)$/.exec(trimmed)
    if (urlMatch) {
      const value = urlMatch[1].trim()
      if (!firstUrl) firstUrl = value
      if (inOrigin) originUrl = value
    }
  }

  return originUrl ?? firstUrl
}

function parseRemote(remoteUrl: string): { host: string; path: string } | undefined {
  if (!remoteUrl) return undefined
  if (remoteUrl.startsWith("http")) {
    try {
      const url = new URL(remoteUrl)
      return { host: url.host, path: url.pathname.replace(/^\//, "") }
    } catch {
      return undefined
    }
  }

  if (remoteUrl.startsWith("git@")) {
    const match = /^git@([^:]+):(.+)$/.exec(remoteUrl)
    if (!match) return undefined
    return { host: match[1], path: match[2] }
  }

  if (remoteUrl.startsWith("ssh://")) {
    try {
      const url = new URL(remoteUrl)
      return { host: url.host, path: url.pathname.replace(/^\//, "") }
    } catch {
      return undefined
    }
  }

  return undefined
}

function normalizeProjectPath(remotePath: string, instanceBasePath: string): string | undefined {
  let pathValue = remotePath
  if (instanceBasePath && instanceBasePath !== "/") {
    const base = instanceBasePath.replace(/^\//, "") + "/"
    if (pathValue.startsWith(base)) {
      pathValue = pathValue.slice(base.length)
    }
  }
  const cleaned = stripGitSuffix(pathValue)
  return cleaned.length > 0 ? cleaned : undefined
}

function stripGitSuffix(pathname: string): string {
  return pathname.endsWith(".git") ? pathname.slice(0, -4) : pathname
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

export function buildApiUrl(instanceUrl: string, apiPath: string): string {
  const base = instanceUrl.endsWith("/") ? instanceUrl : `${instanceUrl}/`
  return new URL(apiPath.replace(/^\//, ""), base).toString()
}

export function buildAuthHeaders(apiKey: string): Record<string, string> {
  return { authorization: `Bearer ${apiKey}` }
}

// ---------------------------------------------------------------------------
// GitLab project API
// ---------------------------------------------------------------------------

async function fetchProjectDetails(
  instanceUrl: string,
  apiKey: string,
  projectPath: string,
): Promise<{ projectId?: string; namespaceId?: string }> {
  const url = buildApiUrl(instanceUrl, `api/v4/projects/${encodeURIComponent(projectPath)}`)
  const response = await fetch(url, {
    headers: buildAuthHeaders(apiKey),
  })
  if (!response.ok) {
    throw new Error(`Failed to fetch project details: ${response.status}`)
  }
  const data = (await response.json()) as {
    id?: number
    namespace?: { id?: number }
  }
  return {
    projectId: data.id ? String(data.id) : undefined,
    namespaceId: data.namespace?.id ? String(data.namespace.id) : undefined,
  }
}

export async function fetchProjectDetailsWithFallback(
  instanceUrl: string,
  apiKey: string,
  projectPath: string,
): Promise<{ projectId?: string; namespaceId?: string }> {
  const candidates = getProjectPathCandidates(projectPath)
  for (const candidate of candidates) {
    try {
      return await fetchProjectDetails(instanceUrl, apiKey, candidate)
    } catch {
      continue
    }
  }

  try {
    const name = projectPath.split("/").pop() || projectPath
    const searchUrl = new URL(buildApiUrl(instanceUrl, "api/v4/projects"))
    searchUrl.searchParams.set("search", name)
    searchUrl.searchParams.set("simple", "true")
    searchUrl.searchParams.set("per_page", "100")
    searchUrl.searchParams.set("membership", "true")
    const response = await fetch(searchUrl.toString(), {
      headers: buildAuthHeaders(apiKey),
    })
    if (!response.ok) {
      throw new Error(`Failed to search projects: ${response.status}`)
    }
    const data = (await response.json()) as Array<{ id: number; namespace?: { id?: number }; path_with_namespace?: string }>
    const match = data.find((project) => project.path_with_namespace === projectPath)
    if (!match) {
      throw new Error("Project not found via search")
    }
    return {
      projectId: match.id ? String(match.id) : undefined,
      namespaceId: match.namespace?.id ? String(match.namespace.id) : undefined,
    }
  } catch {
    throw new Error("Project not found via API")
  }
}

function getProjectPathCandidates(projectPath: string): string[] {
  const candidates = new Set<string>()
  candidates.add(projectPath)
  const parts = projectPath.split("/")
  if (parts.length > 2) {
    const withoutFirst = parts.slice(1).join("/")
    candidates.add(withoutFirst)
  }
  return Array.from(candidates)
}

// ---------------------------------------------------------------------------
// Git config reading
// ---------------------------------------------------------------------------

async function readGitConfig(cwd: string): Promise<string> {
  const gitPath = path.join(cwd, ".git")
  const stat = await fs.stat(gitPath)
  if (stat.isDirectory()) {
    return fs.readFile(path.join(gitPath, "config"), "utf8")
  }

  const file = await fs.readFile(gitPath, "utf8")
  const match = /^gitdir:\s*(.+)$/m.exec(file)
  if (!match) throw new Error("Invalid .git file")
  const gitdir = match[1].trim()
  const resolved = path.isAbsolute(gitdir) ? gitdir : path.join(cwd, gitdir)
  return fs.readFile(path.join(resolved, "config"), "utf8")
}

// ---------------------------------------------------------------------------
// Root namespace resolution
// ---------------------------------------------------------------------------

/**
 * Walks up the GitLab namespace hierarchy to find the root (top-level) namespace.
 * Returns the root namespace ID as a GitLab GroupID string (e.g. "gid://gitlab/Group/12345").
 *
 * The aiChatAvailableModels GraphQL query requires the root namespace ID, but the
 * project API returns the direct namespace which may be a subgroup.
 */
export async function resolveRootNamespaceId(
  instanceUrl: string,
  apiKey: string,
  namespaceId: string,
): Promise<string> {
  let currentId = namespaceId

  // Walk up the namespace hierarchy (max 20 levels to prevent infinite loops)
  for (let depth = 0; depth < 20; depth++) {
    const url = buildApiUrl(instanceUrl, `api/v4/namespaces/${currentId}`)
    const response = await fetch(url, {
      headers: buildAuthHeaders(apiKey),
    })

    if (!response.ok) {
      // If we can't fetch namespace details, use the current ID as-is
      break
    }

    const data = (await response.json()) as {
      id?: number
      parent_id?: number | null
    }

    if (!data.parent_id) {
      // No parent -> this is the root namespace
      currentId = String(data.id ?? currentId)
      break
    }

    // Walk up to the parent
    currentId = String(data.parent_id)
  }

  return `gid://gitlab/Group/${currentId}`
}
