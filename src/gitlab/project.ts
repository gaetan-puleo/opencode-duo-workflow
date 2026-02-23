import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { type GitLabClientOptions, get } from "./client"

const execFileAsync = promisify(execFile)

type ProjectDetails = {
  projectId: string
  namespaceId: string
}

type NamespaceResponse = {
  id: number
  parent_id: number | null
}

/**
 * Detect GitLab project path from the git remote of the nearest repo/worktree.
 * Uses the git CLI so linked worktrees resolve correctly.
 */
export async function detectProjectPath(cwd: string, instanceUrl: string): Promise<string | undefined> {
  const instance = new URL(instanceUrl)
  const instanceHost = instance.host
  const instanceBasePath = instance.pathname.replace(/\/$/, "")

  const url = await readRemoteUrl(cwd)
  if (!url) return undefined

  const remote = parseRemoteUrl(url)
  if (!remote || remote.host !== instanceHost) return undefined

  return normalizeProjectPath(remote.path, instanceBasePath)
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

async function readRemoteUrl(cwd: string): Promise<string | undefined> {
  const root = await runGit(cwd, ["rev-parse", "--path-format=absolute", "--show-toplevel"])
  if (!root) return undefined

  const origin = await runGit(root, ["remote", "get-url", "origin"])
  if (origin) return origin

  const remotes = await runGit(root, ["config", "--get-regexp", "^remote\\..*\\.url$"])
  if (!remotes) return undefined

  const first = remotes
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
  if (!first) return undefined

  const match = /^remote\.[^.]+\.url\s+(.+)$/.exec(first)
  return match?.[1]?.trim()
}

async function runGit(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" })
    const output = String(stdout).trim()
    if (!output) return undefined
    return output
  } catch {
    return undefined
  }
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
