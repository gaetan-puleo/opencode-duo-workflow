/**
 * Maps Duo workflow tool names to OpenCode tool calls and builds the MCP tool
 * list sent to the workflow service.
 */

import type { LanguageModelV2CallOptions } from "@ai-sdk/provider"
import type { AIContextItem } from "./types"
import { asString, asStringArray } from "./prompt_utils"

// ---------------------------------------------------------------------------
// Shell quoting
// ---------------------------------------------------------------------------

function shellQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

// ---------------------------------------------------------------------------
// Duo → OpenCode tool mapping
// ---------------------------------------------------------------------------

/**
 * Translate a Duo workflow tool name + args into an OpenCode-native tool call.
 * For example `read_file` becomes the OpenCode `read` tool, `list_dir` becomes
 * a `bash` call with `ls -la`, etc.
 */
export function mapDuoToolRequest(
  toolName: string,
  args: Record<string, unknown>,
): { toolName: string; args: Record<string, unknown> } {
  switch (toolName) {
    case "list_dir": {
      const directory = asString(args.directory) ?? "."
      return {
        toolName: "bash",
        args: {
          command: `ls -la ${shellQuote(directory)}`,
          description: "List directory contents",
          workdir: ".",
        },
      }
    }
    case "read_file": {
      const filePath =
        asString(args.file_path) ?? asString(args.filepath) ?? asString(args.filePath) ?? asString(args.path)
      if (!filePath) return { toolName, args }
      const mappedArgs: Record<string, unknown> = { filePath }
      if (typeof args.offset === "number") mappedArgs.offset = args.offset
      if (typeof args.limit === "number") mappedArgs.limit = args.limit
      return { toolName: "read", args: mappedArgs }
    }
    case "read_files": {
      const filePaths = asStringArray(args.file_paths)
      if (filePaths.length === 0) return { toolName, args }
      return { toolName: "read_files", args: { file_paths: filePaths } }
    }
    case "create_file_with_contents": {
      const filePath = asString(args.file_path)
      const content = asString(args.contents)
      if (!filePath || content === undefined) return { toolName, args }
      return { toolName: "write", args: { filePath, content } }
    }
    case "edit_file": {
      const filePath = asString(args.file_path)
      const oldString = asString(args.old_str)
      const newString = asString(args.new_str)
      if (!filePath || oldString === undefined || newString === undefined) return { toolName, args }
      return { toolName: "edit", args: { filePath, oldString, newString } }
    }
    case "find_files": {
      const pattern = asString(args.name_pattern)
      if (!pattern) return { toolName, args }
      return { toolName: "glob", args: { pattern } }
    }
    case "grep": {
      const pattern = asString(args.pattern)
      if (!pattern) return { toolName, args }
      const searchDirectory = asString(args.search_directory)
      const caseInsensitive = Boolean(args.case_insensitive)
      const normalizedPattern = caseInsensitive && !pattern.startsWith("(?i)") ? `(?i)${pattern}` : pattern
      const mappedArgs: Record<string, unknown> = { pattern: normalizedPattern }
      if (searchDirectory) mappedArgs.path = searchDirectory
      return { toolName: "grep", args: mappedArgs }
    }
    case "mkdir": {
      const directory = asString(args.directory_path)
      if (!directory) return { toolName, args }
      return {
        toolName: "bash",
        args: {
          command: `mkdir -p ${shellQuote(directory)}`,
          description: "Create directory",
          workdir: ".",
        },
      }
    }
    case "shell_command": {
      const command = asString(args.command)
      if (!command) return { toolName, args }
      return {
        toolName: "bash",
        args: { command, description: "Run shell command", workdir: "." },
      }
    }
    case "run_command": {
      const program = asString(args.program)
      if (program) {
        const parts = [program]
        const flags = args.flags
        if (Array.isArray(flags)) parts.push(...flags.map((f) => String(f)))
        const cmdArgs = args.arguments
        if (Array.isArray(cmdArgs)) parts.push(...cmdArgs.map((a) => String(a)))
        return {
          toolName: "bash",
          args: { command: parts.join(" "), description: "Run command", workdir: "." },
        }
      }
      const command = asString(args.command)
      if (!command) return { toolName, args }
      return {
        toolName: "bash",
        args: { command, description: "Run command", workdir: "." },
      }
    }
    case "run_git_command": {
      const command = asString(args.command)
      if (!command) return { toolName, args }
      const extraArgs = asString(args.args)
      const gitCommand = ["git", command, extraArgs].filter(Boolean).join(" ")
      return {
        toolName: "bash",
        args: { command: gitCommand, description: "Run git command", workdir: "." },
      }
    }
    default:
      return { toolName, args }
  }
}

// ---------------------------------------------------------------------------
// Hardcoded tool schemas sent to the Duo workflow service
// ---------------------------------------------------------------------------

const DUO_MCP_TOOLS: Array<{ name: string; description: string; schema: unknown }> = [
  {
    name: "list_dir",
    description: "List directory contents relative to the repository root.",
    schema: {
      type: "object",
      properties: {
        directory: { type: "string", description: "Directory path relative to repo root." },
      },
      required: ["directory"],
    },
  },
  {
    name: "read_file",
    description: "Read the contents of a file.",
    schema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "The file path to read." },
      },
      required: ["file_path"],
    },
  },
  {
    name: "read_files",
    description: "Read multiple files.",
    schema: {
      type: "object",
      properties: {
        file_paths: {
          type: "array",
          items: { type: "string" },
          description: "List of file paths to read.",
        },
      },
      required: ["file_paths"],
    },
  },
  {
    name: "create_file_with_contents",
    description: "Create a file and write contents.",
    schema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "The file path to write." },
        contents: { type: "string", description: "Contents to write." },
      },
      required: ["file_path", "contents"],
    },
  },
  {
    name: "find_files",
    description: "Find files by name pattern.",
    schema: {
      type: "object",
      properties: {
        name_pattern: { type: "string", description: "Pattern to search for." },
      },
      required: ["name_pattern"],
    },
  },
  {
    name: "mkdir",
    description: "Create a directory.",
    schema: {
      type: "object",
      properties: {
        directory_path: { type: "string", description: "Directory to create." },
      },
      required: ["directory_path"],
    },
  },
  {
    name: "edit_file",
    description: "Edit a file by replacing a string.",
    schema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Path of the file to edit." },
        old_str: { type: "string", description: "String to replace." },
        new_str: { type: "string", description: "Replacement string." },
      },
      required: ["file_path", "old_str", "new_str"],
    },
  },
  {
    name: "grep",
    description: "Search for a pattern in files.",
    schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Search pattern." },
        search_directory: { type: "string", description: "Directory to search." },
        case_insensitive: { type: "boolean", description: "Case insensitive search." },
      },
      required: ["pattern"],
    },
  },
  {
    name: "shell_command",
    description: "Execute a shell command.",
    schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Command to execute." },
      },
      required: ["command"],
    },
  },
  {
    name: "run_git_command",
    description: "Run a git command in the repo.",
    schema: {
      type: "object",
      properties: {
        repository_url: { type: "string", description: "Git remote URL." },
        command: { type: "string", description: "Git command (status, log, diff, ...)." },
        args: { type: "string", description: "Arguments for the git command." },
      },
      required: ["repository_url", "command"],
    },
  },

]

// ---------------------------------------------------------------------------
// Tool name sets for filtering
// ---------------------------------------------------------------------------

/** Names of tools built into the provider — should not be forwarded from OpenCode. */
const BUILTIN_TOOL_NAMES = new Set(DUO_MCP_TOOLS.map((t) => t.name))

/** OpenCode built-in tool names already covered by DUO_MCP_TOOLS. */
const OPENCODE_BUILTIN_TOOL_NAMES = new Set([
  "bash",
  "edit",
  "write",
  "read",
  "grep",
  "glob",
  "patch",
  "skill",
  "webfetch",
  "websearch",
  "question",
  "lsp",
  "read_file",
  "read_files",
])

// ---------------------------------------------------------------------------
// MCP tool list construction
// ---------------------------------------------------------------------------

/**
 * Build the full MCP tool list to send to the Duo workflow service.
 * Starts with the hardcoded Duo tools and appends any extra tools from
 * OpenCode (e.g. user-installed MCP servers) that are not already covered.
 */
export function buildMcpTools(
  options: LanguageModelV2CallOptions,
): Array<{ name: string; description?: string; schema?: unknown; isApproved?: boolean }> {
  const tools: Array<{ name: string; description?: string; schema?: unknown; isApproved?: boolean }> =
    DUO_MCP_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      schema: t.schema,
      isApproved: false,
    }))

  if (options.tools) {
    for (const t of options.tools) {
      if (t.type !== "function") continue
      if (BUILTIN_TOOL_NAMES.has(t.name)) continue
      if (OPENCODE_BUILTIN_TOOL_NAMES.has(t.name)) continue

      tools.push({
        name: t.name,
        description: t.description,
        schema: t.inputSchema,
        isApproved: false,
      })
    }
  }

  return tools
}

/**
 * Build a context item that describes the available tools so the model
 * knows which tool-call simulation formats to use.
 */
export function buildToolContext(
  tools: Array<{ name: string; description?: string }>,
): AIContextItem | null {
  if (tools.length === 0) return null

  const content = `<tools>\n${tools
    .map((t) => {
      const desc = t.description?.trim()
      return desc ? `- ${t.name}: ${desc}` : `- ${t.name}`
    })
    .join("\n")}\n</tools>\n<rules>\n- MUST use the tool-call simulation formats when requesting tools.\n</rules>`

  return {
    category: "tool_information",
    content,
    id: "opencode_tools",
    metadata: {
      title: "OpenCode Tools",
      enabled: true,
      subType: "tools",
      icon: "tool",
      secondaryText: `${tools.length} tools`,
      subTypeLabel: "Tooling",
    },
  }
}
