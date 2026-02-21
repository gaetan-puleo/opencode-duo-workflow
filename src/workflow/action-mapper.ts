/**
 * Maps raw WorkflowToolAction messages from the WebSocket into normalised
 * tool-request objects that can be forwarded to OpenCode via the session queue.
 *
 * Ported from the old provider/src/application/action_handler.ts — ensures
 * standalone WebSocket tool actions are routed through OpenCode's tool
 * execution and permission system instead of being executed locally.
 */

import type { WorkflowToolAction } from "./types"

export type MappedToolRequest = {
  requestId: string
  toolName: string
  args: Record<string, unknown>
}

/**
 * Inspect a WorkflowToolAction and return a normalised tool-request descriptor.
 * Returns `null` if the action has no requestID or no recognised tool payload.
 */
export function mapActionToToolRequest(action: WorkflowToolAction): MappedToolRequest | null {
  const requestId = action.requestID
  if (!requestId) return null

  if (action.runMCPTool) {
    let parsedArgs: Record<string, unknown>
    if (typeof action.runMCPTool.args === "string") {
      try {
        parsedArgs = JSON.parse(action.runMCPTool.args) as Record<string, unknown>
      } catch {
        parsedArgs = {}
      }
    } else {
      parsedArgs = {}
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
    return {
      requestId,
      toolName: "run_command",
      args: {
        program: action.runCommand.program,
        flags: action.runCommand.flags,
        arguments: action.runCommand.arguments,
      },
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
    }
  }

  return null
}
