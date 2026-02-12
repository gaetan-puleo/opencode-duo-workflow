/**
 * The `config` hook for the OpenCode plugin.  Registers the GitLab Duo
 * Agentic provider, merging env-vars with any existing user-supplied options.
 */

import path from "node:path"
import fs from "node:fs"
import { pathToFileURL } from "node:url"
import { resolveProviderPath } from "./resolve_provider"
import { loadGitLabModels } from "./models"

const PROVIDER_ID = "gitlab-duo-agentic-unofficial"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function configHook(input: Record<string, any>): Promise<void> {
  input.provider ??= {}

  const existing = input.provider[PROVIDER_ID]
  const existingOptions = (existing?.options ?? {}) as Record<string, unknown>
  const providerPath = resolveProviderPath()
  const apiKey = process.env.GITLAB_TOKEN || ""
  const instanceUrl = process.env.GITLAB_INSTANCE_URL || "https://gitlab.com"
  const systemRules = typeof existingOptions.systemRules === "string" ? existingOptions.systemRules : ""
  const systemRulesPath =
    typeof existingOptions.systemRulesPath === "string" ? existingOptions.systemRulesPath : ""
  const mergedSystemRules = await mergeSystemRules(systemRules, systemRulesPath)
  const sendSystemContext =
    typeof existingOptions.sendSystemContext === "boolean" ? existingOptions.sendSystemContext : true
  const enableMcp = typeof existingOptions.enableMcp === "boolean" ? existingOptions.enableMcp : true

  if (!apiKey) {
    console.warn(
      "[gitlab-duo] GITLAB_TOKEN is empty for the OpenCode process. Ensure it is exported in the same shell.",
    )
  }

  input.provider[PROVIDER_ID] = {
    name: existing?.name ?? "GitLab Duo Agentic (Unofficial)",
    npm: existing?.npm ?? pathToFileURL(providerPath).href,
    options: {
      instanceUrl,
      apiKey,
      sendSystemContext,
      enableMcp,
      systemRules: mergedSystemRules || undefined,
    },
    models: await loadGitLabModels(),
  }
}

// ---------------------------------------------------------------------------
// System rules merging
// ---------------------------------------------------------------------------

async function mergeSystemRules(rules: string, rulesPath: string): Promise<string> {
  const baseRules = rules.trim()
  if (!rulesPath) return baseRules

  const resolvedPath = path.isAbsolute(rulesPath) ? rulesPath : path.resolve(process.cwd(), rulesPath)
  try {
    const fileRules = (await fs.promises.readFile(resolvedPath, "utf8")).trim()
    if (!fileRules) return baseRules
    return baseRules ? `${baseRules}\n\n${fileRules}` : fileRules
  } catch (error) {
    console.warn(`[gitlab-duo] Failed to read systemRulesPath at ${resolvedPath}:`, error)
    return baseRules
  }
}
