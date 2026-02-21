import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

function getStorePath(): string {
  const dir = process.env.XDG_CACHE_HOME?.trim()
    ? join(process.env.XDG_CACHE_HOME, "opencode")
    : join(homedir(), ".cache", "opencode")
  return join(dir, "duo-workflow-sessions.json")
}

function readStore(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(getStorePath(), "utf8")) as Record<string, string>
  } catch {
    return {}
  }
}

function writeStore(store: Record<string, string>): void {
  try {
    const storePath = getStorePath()
    mkdirSync(join(storePath, ".."), { recursive: true })
    writeFileSync(storePath, JSON.stringify(store, null, 2), "utf8")
  } catch {
    // Non-fatal — plugin works without persistence
  }
}

export function saveWorkflowId(key: string, workflowId: string): void {
  const store = readStore()
  store[key] = workflowId
  writeStore(store)
}

export function loadWorkflowId(key: string): string | undefined {
  const store = readStore()
  return store[key]
}
