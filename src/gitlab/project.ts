import fs from "node:fs/promises"
import path from "node:path"
import { type GitLabClientOptions, get } from "./client"

type ProjectDetails = {
  projectId: string
  namespaceId: string
}

type NamespaceResponse = {
  id: number
  parent_id: number | null
}

/**
 * Detect GitLab project path from the git remote of the nearest repo.
 * Walks up from `cwd` looking for `.git/config`, parses the origin remote URL,
 * and extracts the project path relative to the instance.
 */
export async function detectProjectPath(cwd: string, instanceUrl: string): Promise<string | undefined> {
  const instance = new URL(instanceUrl)
  const instanceHost = instance.host
  const instanceBasePath = instance.pathname.replace(/\/$/, "")

  let current = cwd
  for (;;) {
    try {
      const config = await readGitConfig(current)
      const url = extractOriginUrl(config)
      if (!url) return undefined

      const remote = parseRemoteUrl(url)
      if (!remote || remote.host !== instanceHost) return undefined

      return normalizeProjectPath(remote.path, instanceBasePath)
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return undefined
      current = parent
    }
  }
}

/**
 * Fetch project details from the GitLab REST API.
 * Returns projectId + namespaceId.
 */
export async function fetchProjectDetails(client: GitLabClientOptions, projectPath: string): Promise<ProjectDetails> {
  const encoded = encodeURIComponent(projectPath)
  const data = await get<{ id: number; namespace?: { id: number } }>(client, `projects/${encoded}`)

  if (!data.id || !data.namespace?.id) {
    throw new Error(`Project ${projectPath}: missing id or namespace`)
  }

  return {
    projectId: String(data.id),
    namespaceId: String(data.namespace.id),
  }
}

/**
 * Walk up the namespace hierarchy to find the root (top-level) namespace.
 * Returns the root namespace ID as a GraphQL GroupID (e.g. "gid://gitlab/Group/123").
 */
export async function resolveRootNamespaceId(client: GitLabClientOptions, namespaceId: string): Promise<string> {
  let currentId = namespaceId

  for (let depth = 0; depth < 20; depth++) {
    let ns: NamespaceResponse
    try {
      ns = await get<NamespaceResponse>(client, `namespaces/${currentId}`)
    } catch {
      // Namespace lookup failed (permissions or network) -- use the deepest ID resolved so far
      break
    }

    if (!ns.parent_id) {
      currentId = String(ns.id ?? currentId)
      break
    }

    currentId = String(ns.parent_id)
  }

  return `gid://gitlab/Group/${currentId}`
}

// -- git helpers --

async function readGitConfig(cwd: string): Promise<string> {
  const gitPath = path.join(cwd, ".git")
  const stat = await fs.stat(gitPath)

  if (stat.isDirectory()) {
    return fs.readFile(path.join(gitPath, "config"), "utf8")
  }

  // worktree: .git is a file pointing to the real gitdir
  const content = await fs.readFile(gitPath, "utf8")
  const match = /^gitdir:\s*(.+)$/m.exec(content)
  if (!match) throw new Error("Invalid .git file")

  const gitdir = match[1].trim()
  const resolved = path.isAbsolute(gitdir) ? gitdir : path.join(cwd, gitdir)
  return fs.readFile(path.join(resolved, "config"), "utf8")
}

function extractOriginUrl(config: string): string | undefined {
  const lines = config.split("\n")
  let inOrigin = false
  let originUrl: string | undefined
  let firstUrl: string | undefined

  for (const line of lines) {
    const trimmed = line.trim()
    const section = /^\[remote\s+"([^"]+)"\]$/.exec(trimmed)
    if (section) {
      inOrigin = section[1] === "origin"
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

function parseRemoteUrl(url: string): { host: string; path: string } | undefined {
  // git@host:path
  if (url.startsWith("git@")) {
    const match = /^git@([^:]+):(.+)$/.exec(url)
    return match ? { host: match[1], path: match[2] } : undefined
  }

  // http(s)://host/path or ssh://host/path
  try {
    const parsed = new URL(url)
    return { host: parsed.host, path: parsed.pathname.replace(/^\//, "") }
  } catch {
    return undefined
  }
}

function normalizeProjectPath(remotePath: string, instanceBasePath: string): string | undefined {
  let p = remotePath
  if (instanceBasePath && instanceBasePath !== "/") {
    const base = instanceBasePath.replace(/^\//, "") + "/"
    if (p.startsWith(base)) p = p.slice(base.length)
  }
  // strip .git suffix
  if (p.endsWith(".git")) p = p.slice(0, -4)
  return p.length > 0 ? p : undefined
}
