/**
 * Resolves the path to the provider directory, used by the config hook to
 * register the AI SDK provider with OpenCode.
 *
 * Resolution order:
 *   1. GITLAB_DUO_AGENTIC_PROVIDER_PATH env var (explicit override)
 *   2. ../provider relative to this file (standard repo layout)
 */

import { fileURLToPath, pathToFileURL } from "node:url"
import fs from "node:fs"

export function resolveProviderPath(): string {
  const override = process.env.GITLAB_DUO_AGENTIC_PROVIDER_PATH
  if (override) return override

  const pluginFilePath = fileURLToPath(import.meta.url)
  const realPluginPath = fs.realpathSync(pluginFilePath)
  const providerUrl = new URL("../provider", pathToFileURL(realPluginPath))
  const providerPath = providerUrl.pathname

  if (fs.existsSync(providerPath)) return providerPath

  const message =
    `Provider path not found at "${providerPath}". ` +
    "Set GITLAB_DUO_AGENTIC_PROVIDER_PATH to the provider directory."
  console.error(message)
  throw new Error(message)
}
