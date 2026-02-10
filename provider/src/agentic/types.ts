export type ToolApprovalPolicy = "ask" | "auto" | "deny"

export type GitLabDuoAgenticProviderOptions = {
  instanceUrl: string
  apiKey: string
  toolApproval?: ToolApprovalPolicy
  sendSystemContext?: boolean
  enableMcp?: boolean
}

export type AIContextItem = {
  category: string
  content?: string | null
  id?: string
  metadata?: Record<string, unknown>
}

export type WorkflowType = "chat" | "software_development" | "search_and_replace"

export type WorkflowMetadata = {
  projectId?: string
  projectPath?: string
  namespaceId?: string
  rootNamespaceId?: string
  selectedModelIdentifier?: string
}

export type ToolApproval =
  | { userApproved: true; toolName: string; type: "approve_once" | "approve-for-session" }
  | { userApproved: false; message?: string }

export type RunWorkflowPayload = {
  goal: string
  type?: WorkflowType
  metadata: Partial<WorkflowMetadata>
  existingWorkflowId?: string
  preCreatedWorkflowId?: string
  additionalContext: AIContextItem[]
  toolApproval?: ToolApproval
  flowConfig?: string
  flowConfigSchemaVersion?: string
  workflowDefinition?: string
  agentPlatformFeatureSettingName?: string
}

export type DuoWorkflowEvent = {
  checkpoint: string
  errors: string[]
  workflowGoal: string
  workflowStatus: string
}

export type ToolInputDisplay =
  | { tool: "read_file"; filepath: string }
  | { tool: "read_files"; filepaths: string[] }
  | { tool: "edit_file"; filepath: string; diff: { old: FileWithContent; new: FileWithContent } }
  | { tool: "create_file_with_contents"; filepath: string; content: string }
  | { tool: "run_command"; command: string }
  | { tool: "shell_command"; command: string }
  | { tool: "list_dir"; directory: string }
  | { tool: "find_files"; pattern: string }
  | { tool: "grep"; pattern: string; directory?: string; caseInsensitive?: boolean }
  | { tool: "mkdir"; path: string }
  | { tool: "run_git_command"; command: string; commandArgs?: string }
  | { tool: "generic"; name: string; args: Record<string, unknown> }

export type FileWithContent = {
  filepath: string
  content: string
}

export type PlainTextResponse = {
  response: string
  error: string
}

export type HttpResponse = {
  status: number
  headers: Record<string, string>
  response: string
  error: string
}

export type ClientEvent = {
  actionResponse?: {
    requestID: string
    plainTextResponse?: PlainTextResponse
    httpResponse?: HttpResponse
  }
  startRequest?: {
    workflowID: string
    clientVersion: string
    workflowDefinition: string
    goal: string
    workflowMetadata: string
    additional_context: Array<{ category: string; content?: string | null; id?: string; metadata?: string }>
    clientCapabilities: string[]
    mcpTools: Array<{ name: string; description?: string; schema?: unknown; serverName?: string; isApproved?: boolean }>
    preapproved_tools: string[]
    flowConfig?: unknown
    flowConfigSchemaVersion?: string
    approval?: {
      approval?: Record<string, never>
      rejection?: { message?: string }
    }
  }
}

export type WorkflowAction = {
  requestID?: string
  newCheckpoint?: {
    checkpoint: string
    status: string
    goal: string
    errors: string[]
  }
  runMCPTool?: {
    name: string
    args: Record<string, unknown>
  }
}
