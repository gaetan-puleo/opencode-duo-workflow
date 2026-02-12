import fs from "fs"
import path from "path"
import os from "os"

export type Logger = {
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

const PREFIX = "[gitlab-duo-agentic]"

function getLogFilePath(): string {
  const dir = path.join(os.homedir(), ".local", "share", "opencode", "logs")
  try { fs.mkdirSync(dir, { recursive: true }) } catch {}
  return path.join(dir, "gitlab-duo-agentic.log")
}

let logFile: string | undefined

type RecentEntry = { line: string; count: number }
const recent: RecentEntry[] = []
const MAX_RECENT = 3

function appendLine(line: string): void {
  if (!logFile) logFile = getLogFilePath()
  try { fs.appendFileSync(logFile, line) } catch {}
}

function flushEntry(entry: RecentEntry): void {
  if (entry.count > 0) {
    const ts = new Date().toISOString()
    const preview = entry.line.length > 40 ? entry.line.slice(0, 40) + "..." : entry.line
    appendLine(`${ts}   ↑ "${preview}" repeated ${entry.count}x\n`)
  }
}

function writeToFile(level: string, args: unknown[]): void {
  const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")
  const line = `${level} ${msg}`

  const idx = recent.findIndex((e) => e.line === line)
  if (idx !== -1) {
    recent[idx].count++
    return
  }

  if (recent.length >= MAX_RECENT) {
    flushEntry(recent.shift()!)
  }

  recent.push({ line, count: 0 })
  const ts = new Date().toISOString()
  appendLine(`${ts} ${line}\n`)
}

process.on("exit", () => {
  for (const entry of recent.splice(0)) flushEntry(entry)
})

export const createLogger = (): Logger => ({
  warn: (...args: unknown[]) => {
    writeToFile("WARN", args)
  },
  error: (...args: unknown[]) => {
    writeToFile("ERROR", args)
    console.error(PREFIX, ...args)
  },
})
