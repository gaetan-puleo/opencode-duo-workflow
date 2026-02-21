/**
 * Maps Duo workflow tool names to OpenCode tool names and args.
 * Ported from old provider/src/application/tool_mapping.ts
 */

export type MappedToolCall = {
  toolName: string
  args: Record<string, unknown>
}

/**
 * Translate a Duo workflow tool name + args into one or more OpenCode-native
 * tool calls. Returns an array when a single Duo tool expands to multiple
 * OpenCode calls (e.g. read_files → N × read).
 */
export function mapDuoToolRequest(
  toolName: string,
  args: Record<string, unknown>,
): MappedToolCall | MappedToolCall[] {
  switch (toolName) {
    case "list_dir": {
      const directory = asString(args.directory) ?? "."
      return { toolName: "read", args: { filePath: directory } }
    }
    case "read_file": {
      const filePath = asString(args.file_path) ?? asString(args.filepath) ?? asString(args.filePath) ?? asString(args.path)
      if (!filePath) return { toolName, args }
      const mapped: Record<string, unknown> = { filePath }
      if (typeof args.offset === "number") mapped.offset = args.offset
      if (typeof args.limit === "number") mapped.limit = args.limit
      return { toolName: "read", args: mapped }
    }
    case "read_files": {
      const filePaths = asStringArray(args.file_paths)
      if (filePaths.length === 0) return { toolName, args }
      return filePaths.map((fp) => ({ toolName: "read", args: { filePath: fp } }))
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
      const searchDir = asString(args.search_directory)
      const caseInsensitive = Boolean(args.case_insensitive)
      const normalizedPattern = caseInsensitive && !pattern.startsWith("(?i)") ? `(?i)${pattern}` : pattern
      const mapped: Record<string, unknown> = { pattern: normalizedPattern }
      if (searchDir) mapped.path = searchDir
      return { toolName: "grep", args: mapped }
    }
    case "mkdir": {
      const directory = asString(args.directory_path)
      if (!directory) return { toolName, args }
      return { toolName: "bash", args: { command: `mkdir -p ${shellQuote(directory)}`, description: "Create directory", workdir: "." } }
    }
    case "shell_command": {
      const command = asString(args.command)
      if (!command) return { toolName, args }
      return { toolName: "bash", args: { command, description: "Run shell command", workdir: "." } }
    }
    case "run_command": {
      const program = asString(args.program)
      if (program) {
        const parts = [shellQuote(program)]
        if (Array.isArray(args.flags)) parts.push(...args.flags.map((f) => shellQuote(String(f))))
        if (Array.isArray(args.arguments)) parts.push(...args.arguments.map((a) => shellQuote(String(a))))
        return { toolName: "bash", args: { command: parts.join(" "), description: "Run command", workdir: "." } }
      }
      const command = asString(args.command)
      if (!command) return { toolName, args }
      return { toolName: "bash", args: { command, description: "Run command", workdir: "." } }
    }
    case "run_git_command": {
      const command = asString(args.command)
      if (!command) return { toolName, args }
      const rawArgs = args.args
      const extraArgs = Array.isArray(rawArgs)
        ? rawArgs.map((v) => shellQuote(String(v))).join(" ")
        : asString(rawArgs)
      const gitCmd = extraArgs ? `git ${shellQuote(command)} ${extraArgs}` : `git ${shellQuote(command)}`
      return { toolName: "bash", args: { command: gitCmd, description: "Run git command", workdir: "." } }
    }
    case "gitlab_api_request": {
      const method = asString(args.method) ?? "GET"
      const apiPath = asString(args.path)
      if (!apiPath) return { toolName, args }
      const body = asString(args.body)
      const curlParts = [
        "curl", "-s", "-X", method,
        "-H", "'Authorization: Bearer $GITLAB_TOKEN'",
        "-H", "'Content-Type: application/json'",
      ]
      if (body) {
        curlParts.push("-d", shellQuote(body))
      }
      curlParts.push(shellQuote(`$GITLAB_INSTANCE_URL/api/v4/${apiPath}`))
      return {
        toolName: "bash",
        args: { command: curlParts.join(" "), description: `GitLab API: ${method} ${apiPath}`, workdir: "." },
      }
    }
    default:
      return { toolName, args }
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === "string")
}

function shellQuote(s: string): string {
  if (/^[a-zA-Z0-9_\-./=:@]+$/.test(s)) return s
  return `'${s.replace(/'/g, "'\\''")}'`
}
