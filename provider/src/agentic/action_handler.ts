/**
 * Maps raw WorkflowAction messages from the WebSocket into normalised
 * tool-request objects that use **OpenCode-native** tool names and argument
 * shapes.
 *
 * After the migration away from tool_mapping.ts, this module is the single
 * place where DWS typed actions (runReadFile, runEditFile, …) are translated
 * into OpenCode tool calls (read, edit, bash, …).
 *
 * When DWS sends a `runMCPTool` action the tool name and arguments are
 * passed through as-is — they already use OpenCode-native names because
 * that is what we registered via `buildMcpTools()`.
 */

import type { WorkflowAction, ToolResponseType } from "./types"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function shellQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ToolRequestAction = {
  requestId: string
  toolName: string
  args: Record<string, unknown>
  responseType?: ToolResponseType
}

// ---------------------------------------------------------------------------
// Main mapper
// ---------------------------------------------------------------------------

/**
 * Inspect a WorkflowAction and, if it represents a tool invocation, return
 * one or more normalised descriptors using OpenCode-native tool names and
 * argument shapes.
 *
 * Returns `null` for actions that are not tool requests (e.g. checkpoint
 * updates — those are handled separately).
 *
 * Returns an **array** when a single DWS action expands into multiple
 * OpenCode tool calls (e.g. `runReadFiles` → N × `read`).
 */
export function mapWorkflowActionToToolRequest(
  action: WorkflowAction,
): ToolRequestAction | ToolRequestAction[] | null {
  const requestId = action.requestID
  if (!requestId) return null

  // ----- MCP tool (pass-through — already OpenCode-native) ----------------
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

  // ----- Typed actions → OpenCode-native tools ----------------------------

  if (action.runReadFile) {
    const args: Record<string, unknown> = { filePath: action.runReadFile.filepath }
    if (typeof action.runReadFile.offset === "number") args.offset = action.runReadFile.offset
    if (typeof action.runReadFile.limit === "number") args.limit = action.runReadFile.limit
    return { requestId, toolName: "read", args }
  }

  if (action.runReadFiles) {
    const filePaths = action.runReadFiles.filepaths ?? []
    if (filePaths.length === 0) return null
    return filePaths.map((fp, i) => ({
      requestId: `${requestId}#${i}`,
      toolName: "read",
      args: { filePath: fp } as Record<string, unknown>,
    }))
  }

  if (action.runWriteFile) {
    return {
      requestId,
      toolName: "write",
      args: {
        filePath: action.runWriteFile.filepath,
        content: action.runWriteFile.contents,
      },
    }
  }

  if (action.runEditFile) {
    return {
      requestId,
      toolName: "edit",
      args: {
        filePath: action.runEditFile.filepath,
        oldString: action.runEditFile.oldString,
        newString: action.runEditFile.newString,
      },
    }
  }

  if (action.findFiles) {
    return {
      requestId,
      toolName: "glob",
      args: { pattern: action.findFiles.name_pattern },
    }
  }

  if (action.listDirectory) {
    const directory = action.listDirectory.directory ?? "."
    return {
      requestId,
      toolName: "bash",
      args: {
        command: `ls -la ${shellQuote(directory)}`,
        description: "List directory contents",
        workdir: ".",
      },
    }
  }

  if (action.grep) {
    const pattern = action.grep.pattern
    const caseInsensitive = Boolean(action.grep.case_insensitive)
    const normalizedPattern = caseInsensitive && !pattern.startsWith("(?i)") ? `(?i)${pattern}` : pattern
    const args: Record<string, unknown> = { pattern: normalizedPattern }
    if (action.grep.search_directory) args.path = action.grep.search_directory
    return { requestId, toolName: "grep", args }
  }

  if (action.mkdir) {
    const directory = action.mkdir.directory_path
    return {
      requestId,
      toolName: "bash",
      args: {
        command: `mkdir -p ${shellQuote(directory)}`,
        description: "Create directory",
        workdir: ".",
      },
    }
  }

  if (action.runShellCommand) {
    return {
      requestId,
      toolName: "bash",
      args: {
        command: action.runShellCommand.command,
        description: "Run shell command",
        workdir: ".",
      },
    }
  }

  if (action.runCommand) {
    const parts = [action.runCommand.program]
    if (action.runCommand.flags) parts.push(...action.runCommand.flags.map((f) => shellQuote(f)))
    if (action.runCommand.arguments) parts.push(...action.runCommand.arguments.map((a) => shellQuote(a)))
    return {
      requestId,
      toolName: "bash",
      args: {
        command: parts.join(" "),
        description: "Run command",
        workdir: ".",
      },
    }
  }

  if (action.runGitCommand) {
    const gitParts = ["git", shellQuote(action.runGitCommand.command)]
    if (action.runGitCommand.arguments) gitParts.push(shellQuote(action.runGitCommand.arguments))
    return {
      requestId,
      toolName: "bash",
      args: {
        command: gitParts.filter(Boolean).join(" "),
        description: "Run git command",
        workdir: ".",
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
