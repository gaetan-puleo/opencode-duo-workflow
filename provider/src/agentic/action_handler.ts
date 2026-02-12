/**
 * Maps raw WorkflowAction messages from the WebSocket into normalised
 * tool-request objects.  This replaces the large if/else chain that was
 * previously inside GitLabAgenticRuntime.#bindStream.
 */

import type { WorkflowAction, ToolResponseType } from "./types"

type ToolRequestAction = {
  requestId: string
  toolName: string
  args: Record<string, unknown>
  responseType?: ToolResponseType
}

/**
 * Inspect a WorkflowAction and, if it represents a tool invocation, return
 * a normalised descriptor.  Returns `null` for actions that are not tool
 * requests (e.g. checkpoint updates — those are handled separately).
 */
export function mapWorkflowActionToToolRequest(action: WorkflowAction): ToolRequestAction | null {
  const requestId = action.requestID
  if (!requestId) return null

  if (action.runMCPTool) {
    const rawArgs = action.runMCPTool.args
    let parsedArgs: Record<string, unknown>
    if (typeof rawArgs === "string") {
      try {
        parsedArgs = JSON.parse(rawArgs) as Record<string, unknown>
      } catch {
        parsedArgs = {}
      }
    } else {
      parsedArgs = rawArgs ?? {}
    }
    return { requestId, toolName: action.runMCPTool.name, args: parsedArgs }
  }

  if (action.runReadFile) {
    return {
      requestId,
      toolName: "read_file",
      args: {
        file_path: action.runReadFile.filepath,
        offset: action.runReadFile.offset,
        limit: action.runReadFile.limit,
      },
    }
  }

  if (action.runReadFiles) {
    return {
      requestId,
      toolName: "read_files",
      args: { file_paths: action.runReadFiles.filepaths ?? [] },
    }
  }

  if (action.runWriteFile) {
    return {
      requestId,
      toolName: "create_file_with_contents",
      args: {
        file_path: action.runWriteFile.filepath,
        contents: action.runWriteFile.contents,
      },
    }
  }

  if (action.runEditFile) {
    return {
      requestId,
      toolName: "edit_file",
      args: {
        file_path: action.runEditFile.filepath,
        old_str: action.runEditFile.oldString,
        new_str: action.runEditFile.newString,
      },
    }
  }

  if (action.findFiles) {
    return {
      requestId,
      toolName: "find_files",
      args: { name_pattern: action.findFiles.name_pattern },
    }
  }

  if (action.listDirectory) {
    return {
      requestId,
      toolName: "list_dir",
      args: { directory: action.listDirectory.directory },
    }
  }

  if (action.grep) {
    const args: Record<string, unknown> = { pattern: action.grep.pattern }
    if (action.grep.search_directory) args.search_directory = action.grep.search_directory
    if (action.grep.case_insensitive !== undefined) args.case_insensitive = action.grep.case_insensitive
    return { requestId, toolName: "grep", args }
  }

  if (action.mkdir) {
    return {
      requestId,
      toolName: "mkdir",
      args: { directory_path: action.mkdir.directory_path },
    }
  }

  if (action.runShellCommand) {
    return {
      requestId,
      toolName: "shell_command",
      args: { command: action.runShellCommand.command },
    }
  }

  if (action.runCommand) {
    const parts = [action.runCommand.program]
    if (action.runCommand.flags) parts.push(...action.runCommand.flags)
    if (action.runCommand.arguments) parts.push(...action.runCommand.arguments)
    return {
      requestId,
      toolName: "shell_command",
      args: { command: parts.join(" ") },
    }
  }

  if (action.runGitCommand) {
    return {
      requestId,
      toolName: "run_git_command",
      args: {
        repository_url: action.runGitCommand.repository_url ?? "",
        command: action.runGitCommand.command,
        args: action.runGitCommand.arguments,
      },
    }
  }

  if (action.runHTTPRequest) {
    return {
      requestId,
      toolName: "gitlab_api_request",
      args: {
        method: action.runHTTPRequest.method,
        path: action.runHTTPRequest.path,
        body: action.runHTTPRequest.body,
      },
      responseType: "http",
    }
  }

  return null
}
