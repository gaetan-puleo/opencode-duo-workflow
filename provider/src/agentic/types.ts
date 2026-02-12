export type GitLabDuoAgenticProviderOptions = {
  instanceUrl: string
  apiKey: string
  sendSystemContext?: boolean
  enableMcp?: boolean
  systemRules?: string
}

export type AIContextItem = {
  category: string
  content?: string | null
  id?: string
  metadata?: Record<string, unknown>
}

export type WorkflowType = "chat" | "software_development" | "search_and_replace"

export type DuoWorkflowEvent = {
  checkpoint: string
  errors: string[]
  workflowGoal: string
  workflowStatus: string
}

type PlainTextResponse = {
  response: string
  error: string
}

type HttpResponse = {
  status: number
  headers: Record<string, string>
  response: string
  error: string
}

export type ToolResponseType = "plain" | "http"

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
    args: string | Record<string, unknown>
  }
  runReadFile?: {
    filepath: string
    offset?: number
    limit?: number
  }
  runReadFiles?: {
    filepaths: string[]
  }
  runWriteFile?: {
    filepath: string
    contents: string
  }
  runEditFile?: {
    filepath: string
    oldString: string
    newString: string
  }
  findFiles?: {
    name_pattern: string
  }
  listDirectory?: {
    directory: string
  }
  grep?: {
    pattern: string
    search_directory?: string
    case_insensitive?: boolean
  }
  mkdir?: {
    directory_path: string
  }
  runShellCommand?: {
    command: string
  }
  runCommand?: {
    program: string
    flags?: string[]
    arguments?: string[]
  }
  runGitCommand?: {
    command: string
    arguments?: string
    repository_url?: string
  }
  runHTTPRequest?: {
    method: string
    path: string
    body?: string
  }
}
