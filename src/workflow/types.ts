export const WORKFLOW_STATUS = {
  CREATED: "CREATED",
  RUNNING: "RUNNING",
  FINISHED: "FINISHED",
  FAILED: "FAILED",
  STOPPED: "STOPPED",
  INPUT_REQUIRED: "INPUT_REQUIRED",
  PLAN_APPROVAL_REQUIRED: "PLAN_APPROVAL_REQUIRED",
  TOOL_CALL_APPROVAL_REQUIRED: "TOOL_CALL_APPROVAL_REQUIRED",
} as const

export type WorkflowStatus = (typeof WORKFLOW_STATUS)[keyof typeof WORKFLOW_STATUS]

export type AdditionalContext = {
  category: string
  id?: string
  content?: string
  metadata?: string
}

export type McpToolDefinition = {
  name: string
  description: string
  inputSchema: string
}

export type StartWorkflowRequest = {
  clientVersion: string
  workflowID: string
  workflowDefinition: string
  goal: string
  workflowMetadata: string
  clientCapabilities: string[]
  mcpTools: McpToolDefinition[]
  additional_context: AdditionalContext[]
  preapproved_tools: string[]
  flowConfig?: Record<string, unknown>
  flowConfigSchemaVersion?: string
  approval?: {
    approval?: Record<string, never>
    rejection?: { message?: string }
  }
}

export type PlainTextResponse = {
  response: string
  error: string
}

export type HttpResponse = {
  headers: Record<string, string>
  statusCode: number
  body: string
  error: string
}

export type ClientEvent =
  | { startRequest: StartWorkflowRequest }
  | {
      actionResponse: {
        requestID: string
        plainTextResponse?: PlainTextResponse
        httpResponse?: HttpResponse
      }
    }
  | { heartbeat: { timestamp: number } }
  | { stopWorkflow: { reason: string } }

export type WorkflowCheckpointAction = {
  requestID?: string
  newCheckpoint: {
    status: string
    checkpoint: string
    goal: string
    errors?: string[]
  }
}

export type WorkflowToolAction = {
  requestID?: string
  runReadFile?: { filepath: string; limit?: number; offset?: number }
  runReadFiles?: { filepaths: string[] }
  runWriteFile?: { filepath: string; contents: string }
  runEditFile?: { filepath: string; oldString: string; newString: string }
  runShellCommand?: { command: string }
  runCommand?: { program: string; arguments?: string[]; flags?: string[] }
  runGitCommand?: { command: string; arguments?: string; repository_url?: string }
  runHTTPRequest?: { method: string; path: string; body?: string }
  listDirectory?: { directory: string }
  grep?: { search_directory?: string; pattern: string; case_insensitive?: boolean }
  findFiles?: { name_pattern: string }
  runMCPTool?: { name: string; args?: string }
  mkdir?: { directory_path: string }
}

export type WorkflowAction = WorkflowCheckpointAction | WorkflowToolAction

/** Type guard: true when the action carries a newCheckpoint payload. */
export function isCheckpointAction(action: WorkflowAction): action is WorkflowCheckpointAction {
  return "newCheckpoint" in action && action.newCheckpoint != null
}

/** Type guard: true when the action carries a runMCPTool payload. */
export function isMcpToolAction(action: WorkflowAction): action is WorkflowToolAction & { runMCPTool: { name: string; args?: string } } {
  return "runMCPTool" in action && action.runMCPTool != null
}

/** Terminal statuses — workflow is done, no more interaction possible. */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set<WorkflowStatus>([
  WORKFLOW_STATUS.FINISHED,
  WORKFLOW_STATUS.FAILED,
  WORKFLOW_STATUS.STOPPED,
])

export function isTerminal(status: string): boolean {
  return TERMINAL_STATUSES.has(status)
}

/** Turn boundary — user needs to provide input or approve a plan. */
const TURN_BOUNDARY_STATUSES: ReadonlySet<string> = new Set<WorkflowStatus>([
  WORKFLOW_STATUS.INPUT_REQUIRED,
  WORKFLOW_STATUS.PLAN_APPROVAL_REQUIRED,
])

export function isTurnBoundary(status: string): boolean {
  return TURN_BOUNDARY_STATUSES.has(status)
}

/** DWS is requesting tool approval — needs auto-approve + reconnect. */
export function isToolApproval(status: string): boolean {
  return status === WORKFLOW_STATUS.TOOL_CALL_APPROVAL_REQUIRED
}

/** True when the queue should close (terminal or turn boundary). */
export function isTurnComplete(status: string): boolean {
  return isTerminal(status) || isTurnBoundary(status)
}

export type ToolInfo = {
  name: string
  args: Record<string, unknown>
  tool_response?: unknown
}

export type UiChatLogEntry = {
  message_type: "user" | "agent" | "tool" | "request"
  content: string
  timestamp?: string
  correlation_id?: string | null
  tool_info?: ToolInfo | null
}

export type WorkflowCheckpointPayload = {
  channel_values?: {
    ui_chat_log?: UiChatLogEntry[]
  }
}

export type WorkflowCreateResponse = {
  id?: string | number
  message?: string
  error?: string
}

export type WorkflowDirectAccessResponse = {
  workflow_metadata?: {
    extended_logging?: boolean
  }
  duo_workflow_service?: {
    token_expires_at?: number
  }
  gitlab_rails?: {
    token_expires_at?: string
  }
}
