import { appendFileSync } from "node:fs"

const LOG_FILE = "/tmp/duo-workflow-debug.log"

export function dlog(msg: string): void {
  const ts = new Date().toISOString()
  appendFileSync(LOG_FILE, `[${ts}] ${msg}\n`)
}
