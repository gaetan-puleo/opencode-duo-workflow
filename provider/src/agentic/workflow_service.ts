import type { WorkflowType } from "./types"
import { buildApiUrl, buildAuthHeaders } from "./gitlab_utils"

export type GenerateTokenResponse = {
  gitlab_rails: {
    base_url: string
    token: string
    token_expires_at: string
  }
  duo_workflow_executor: {
    executor_binary_url: string
    executor_binary_urls: Record<string, string>
    version: string
  }
  duo_workflow_service: {
    base_url: string
    token: string
    secure: boolean
    token_expires_at: number
    headers: Record<string, string>
  }
  workflow_metadata?: {
    is_team_member: boolean | null
    extended_logging: boolean
  }
}

export class WorkflowCreateError extends Error {
  readonly status: number
  readonly body: string

  constructor(status: number, body: string) {
    super(`Failed to create workflow: ${status} ${body}`)
    this.status = status
    this.body = body
  }
}

export async function createWorkflow(
  instanceUrl: string,
  apiKey: string,
  goal: string,
  workflowDefinition: WorkflowType,
  containerParams?: { projectId?: string; namespaceId?: string },
): Promise<string> {
  const url = buildApiUrl(instanceUrl, "/api/v4/ai/duo_workflows/workflows")
  const response = await fetch(url.toString(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...buildAuthHeaders(apiKey),
    },
    body: JSON.stringify({
      project_id: containerParams?.projectId,
      namespace_id: containerParams?.namespaceId,
      goal,
      workflow_definition: workflowDefinition,
      environment: "ide",
      allow_agent_to_request_user: true,
    }),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new WorkflowCreateError(response.status, text)
  }

  const data = (await response.json()) as { id?: number; message?: string; error?: string }
  if (!data.id) {
    throw new Error(`Workflow creation failed: ${data.error || data.message || "unknown"}`)
  }
  return data.id.toString()
}

export async function getWorkflowToken(
  instanceUrl: string,
  apiKey: string,
  workflowDefinition: WorkflowType,
): Promise<GenerateTokenResponse> {
  const url = buildApiUrl(instanceUrl, "/api/v4/ai/duo_workflows/direct_access")
  const response = await fetch(url.toString(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...buildAuthHeaders(apiKey),
    },
    body: JSON.stringify({ workflow_definition: workflowDefinition }),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Failed to fetch workflow token: ${response.status} ${text}`)
  }

  return (await response.json()) as GenerateTokenResponse
}
