import { WORKFLOW_DEFINITION, WORKFLOW_TOKEN_EXPIRY_BUFFER_MS } from "../constants"
import { type GitLabClientOptions, post } from "../gitlab/client"
import type { WorkflowDirectAccessResponse } from "./types"

type CachedToken = {
  value: WorkflowDirectAccessResponse
  expiresAt: number
}

export class WorkflowTokenService {
  #client: GitLabClientOptions
  #cache = new Map<string, CachedToken>()

  constructor(client: GitLabClientOptions) {
    this.#client = client
  }

  clear(): void {
    this.#cache.clear()
  }

  async get(rootNamespaceId?: string): Promise<WorkflowDirectAccessResponse | null> {
    const key = rootNamespaceId ?? ""
    const cached = this.#cache.get(key)
    if (cached && cached.expiresAt > Date.now()) return cached.value

    try {
      const value = await post<WorkflowDirectAccessResponse>(
        this.#client,
        "ai/duo_workflows/direct_access",
        rootNamespaceId
          ? {
              workflow_definition: WORKFLOW_DEFINITION,
              root_namespace_id: rootNamespaceId,
            }
          : {
              workflow_definition: WORKFLOW_DEFINITION,
            },
      )

      const expiresAt = readExpiry(value)
      this.#cache.set(key, { value, expiresAt })
      return value
    } catch {
      // Direct-access endpoint unavailable or unauthorized.
      // Return null so the caller can proceed without extended metadata.
      return null
    }
  }
}

function readExpiry(value: WorkflowDirectAccessResponse): number {
  const workflowExpiry = typeof value.duo_workflow_service?.token_expires_at === "number"
    ? value.duo_workflow_service.token_expires_at * 1000
    : Number.POSITIVE_INFINITY

  const railsExpiry = typeof value.gitlab_rails?.token_expires_at === "string"
    ? Date.parse(value.gitlab_rails.token_expires_at)
    : Number.POSITIVE_INFINITY

  const expiry = Math.min(workflowExpiry, railsExpiry)
  if (!Number.isFinite(expiry)) return Date.now() + 5 * 60 * 1000

  return Math.max(Date.now() + 1_000, expiry - WORKFLOW_TOKEN_EXPIRY_BUFFER_MS)
}
