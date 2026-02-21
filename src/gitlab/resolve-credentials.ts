import { envInstanceUrl, normalizeInstanceUrl } from "../utils/url"
import type { GitLabClientOptions } from "./client"

/**
 * Resolve GitLab credentials from an options bag and environment variables.
 *
 * Token resolution order:
 *   1. `options.apiKey` (string)
 *   2. `options.token` (string)
 *   3. `GITLAB_TOKEN` env var
 *   4. `GITLAB_OAUTH_TOKEN` env var
 *   5. empty string (unauthenticated fallback)
 *
 * Instance URL resolution order:
 *   1. `options.instanceUrl`
 *   2. `GITLAB_INSTANCE_URL` / `GITLAB_URL` / `GITLAB_BASE_URL` env vars
 *   3. https://gitlab.com
 */
export function resolveCredentials(options: Record<string, unknown> = {}): GitLabClientOptions {
  const instanceUrl = normalizeInstanceUrl(options.instanceUrl ?? envInstanceUrl())
  const token = firstNonEmptyString(options.apiKey, options.token) ?? envToken() ?? ""

  return { instanceUrl, token }
}

function envToken(): string | undefined {
  return process.env.GITLAB_TOKEN ?? process.env.GITLAB_OAUTH_TOKEN
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === "string" && v.trim().length > 0) return v.trim()
  }
  return undefined
}
