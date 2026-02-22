/**
 * Maps Duo workflow tool names to OpenCode tool names and args.
 * Ported from old provider/src/application/tool_mapping.ts
 */

export type MappedToolCall = {
  toolName: string
  args: Record<string, unknown>
}

type TodoItem = {
  content: string
  status: "pending" | "in_progress" | "completed" | "cancelled"
  priority: "high" | "medium" | "low"
}

const TODO_WRITE_PROGRAM = "__todo_write__"
const TODO_READ_PROGRAM = "__todo_read__"
const WEBFETCH_PROGRAM = "__webfetch__"
const QUESTION_PROGRAM = "__question__"
const SKILL_PROGRAM = "__skill__"
const TODO_STATUSES = new Set<TodoItem["status"]>(["pending", "in_progress", "completed", "cancelled"])
const TODO_PRIORITIES = new Set<TodoItem["priority"]>(["high", "medium", "low"])
const WEBFETCH_FORMATS = new Set(["text", "markdown", "html"])

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
      const bridged = mapBridgeCommand(command)
      if (bridged) return bridged
      return { toolName: "bash", args: { command, description: "Run shell command", workdir: "." } }
    }
    case "run_command": {
      const command = asString(args.command)
      if (command) {
        const bridged = mapBridgeCommand(command)
        if (bridged) return bridged
      }

      const program = asString(args.program)
      if (program === TODO_READ_PROGRAM) {
        return { toolName: "todoread", args: {} }
      }

      if (program === TODO_WRITE_PROGRAM) {
        return mapTodoWriteCall(args.arguments)
      }

      if (program === WEBFETCH_PROGRAM) {
        return mapWebfetchCall(args.arguments)
      }

      if (program === QUESTION_PROGRAM) {
        return mapQuestionCall(args.arguments)
      }

      if (program === SKILL_PROGRAM) {
        return mapSkillCall(args.arguments)
      }

      if (program) {
        const parts = [shellQuote(program)]
        if (Array.isArray(args.flags)) parts.push(...args.flags.map((f) => shellQuote(String(f))))
        if (Array.isArray(args.arguments)) parts.push(...args.arguments.map((a) => shellQuote(String(a))))
        return { toolName: "bash", args: { command: parts.join(" "), description: "Run command", workdir: "." } }
      }
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

function mapBridgeCommand(command: string): MappedToolCall | null {
  const normalized = command.trim()
  if (normalized === TODO_READ_PROGRAM) {
    return { toolName: "todoread", args: {} }
  }

  if (normalized.startsWith(`${TODO_READ_PROGRAM} `)) {
    return invalidTool("todoread", `${TODO_READ_PROGRAM} does not accept a payload`)
  }

  if (normalized === TODO_WRITE_PROGRAM) {
    return invalidTool("todowrite", `${TODO_WRITE_PROGRAM} expects JSON payload after command prefix`)
  }

  if (normalized === WEBFETCH_PROGRAM) {
    return invalidTool("webfetch", `${WEBFETCH_PROGRAM} expects JSON payload after command prefix`)
  }

  if (normalized === QUESTION_PROGRAM) {
    return invalidTool("question", `${QUESTION_PROGRAM} expects JSON payload after command prefix`)
  }

  if (normalized === SKILL_PROGRAM) {
    return invalidTool("skill", `${SKILL_PROGRAM} expects JSON payload after command prefix`)
  }

  if (normalized.startsWith(`${TODO_WRITE_PROGRAM} `)) {
    const payload = normalized.slice(TODO_WRITE_PROGRAM.length).trim()
    if (!payload) {
      return invalidTool("todowrite", `${TODO_WRITE_PROGRAM} expects JSON payload after command prefix`)
    }
    return mapTodoWritePayload(payload)
  }

  if (normalized.startsWith(`${WEBFETCH_PROGRAM} `)) {
    const payload = normalized.slice(WEBFETCH_PROGRAM.length).trim()
    if (!payload) {
      return invalidTool("webfetch", `${WEBFETCH_PROGRAM} expects JSON payload after command prefix`)
    }
    return mapWebfetchPayload(payload)
  }

  if (normalized.startsWith(`${QUESTION_PROGRAM} `)) {
    const payload = normalized.slice(QUESTION_PROGRAM.length).trim()
    if (!payload) {
      return invalidTool("question", `${QUESTION_PROGRAM} expects JSON payload after command prefix`)
    }
    return mapQuestionPayload(payload)
  }

  if (normalized.startsWith(`${SKILL_PROGRAM} `)) {
    const payload = normalized.slice(SKILL_PROGRAM.length).trim()
    if (!payload) {
      return invalidTool("skill", `${SKILL_PROGRAM} expects JSON payload after command prefix`)
    }
    return mapSkillPayload(payload)
  }

  return null
}

function mapTodoWriteCall(rawArguments: unknown): MappedToolCall {
  const payloadResult = parsePayloadFromArguments(rawArguments, TODO_WRITE_PROGRAM)
  if ("error" in payloadResult) return invalidTool("todowrite", payloadResult.error)

  return mapTodoWritePayload(payloadResult.payload)
}

function mapWebfetchCall(rawArguments: unknown): MappedToolCall {
  const payloadResult = parsePayloadFromArguments(rawArguments, WEBFETCH_PROGRAM)
  if ("error" in payloadResult) return invalidTool("webfetch", payloadResult.error)

  return mapWebfetchPayload(payloadResult.payload)
}

function mapQuestionCall(rawArguments: unknown): MappedToolCall {
  const payloadResult = parsePayloadFromArguments(rawArguments, QUESTION_PROGRAM)
  if ("error" in payloadResult) return invalidTool("question", payloadResult.error)

  return mapQuestionPayload(payloadResult.payload)
}

function mapSkillCall(rawArguments: unknown): MappedToolCall {
  const payloadResult = parsePayloadFromArguments(rawArguments, SKILL_PROGRAM)
  if ("error" in payloadResult) return invalidTool("skill", payloadResult.error)

  return mapSkillPayload(payloadResult.payload)
}

function mapTodoWritePayload(rawPayload: string): MappedToolCall {
  const payloadResult = parseTodoPayload(rawPayload)
  if ("error" in payloadResult) return invalidTool("todowrite", payloadResult.error)

  const todosResult = parseTodos(payloadResult.payload)
  if ("error" in todosResult) return invalidTool("todowrite", todosResult.error)

  return {
    toolName: "todowrite",
    args: {
      todos: todosResult.todos,
    },
  }
}

function mapWebfetchPayload(rawPayload: string): MappedToolCall {
  const payloadResult = parseWebfetchPayload(rawPayload)
  if ("error" in payloadResult) return invalidTool("webfetch", payloadResult.error)

  return {
    toolName: "webfetch",
    args: payloadResult.args,
  }
}

function mapQuestionPayload(rawPayload: string): MappedToolCall {
  const payloadResult = parseQuestionPayload(rawPayload)
  if ("error" in payloadResult) return invalidTool("question", payloadResult.error)

  return {
    toolName: "question",
    args: payloadResult.args,
  }
}

function mapSkillPayload(rawPayload: string): MappedToolCall {
  const payloadResult = parseSkillPayload(rawPayload)
  if ("error" in payloadResult) return invalidTool("skill", payloadResult.error)

  return {
    toolName: "skill",
    args: payloadResult.args,
  }
}

function parsePayloadFromArguments(rawArguments: unknown, program: string): { payload: string } | { error: string } {
  if (!Array.isArray(rawArguments) || rawArguments.length === 0) {
    return {
      error: `${program} expects JSON payload in arguments[0]`,
    }
  }

  const rawPayload = rawArguments[0]
  if (typeof rawPayload !== "string") {
    return {
      error: `${program} expects arguments[0] to be a JSON string`,
    }
  }

  return { payload: rawPayload }
}

function parseTodoPayload(rawPayload: string): { payload: Record<string, unknown> } | { error: string } {
  return parseObjectPayload(rawPayload, TODO_WRITE_PROGRAM)
}

function parseObjectPayload(rawPayload: string, program: string): { payload: Record<string, unknown> } | { error: string } {
  const normalized = unwrapWrappingQuotes(rawPayload)

  try {
    const parsed = JSON.parse(normalized)
    if (!isRecord(parsed)) {
      return {
        error: `${program} payload must be a JSON object`,
      }
    }
    return { payload: parsed }
  } catch {
    return {
      error: `${program} payload is not valid JSON`,
    }
  }
}

function parseWebfetchPayload(rawPayload: string): { args: Record<string, unknown> } | { error: string } {
  const payloadResult = parseObjectPayload(rawPayload, WEBFETCH_PROGRAM)
  if ("error" in payloadResult) return payloadResult

  const url = asString(payloadResult.payload.url)
  if (!url) {
    return {
      error: `${WEBFETCH_PROGRAM} payload must include a url string`,
    }
  }

  const args: Record<string, unknown> = { url }
  const format = asString(payloadResult.payload.format)
  if (format !== undefined) {
    if (!WEBFETCH_FORMATS.has(format)) {
      return {
        error: `${WEBFETCH_PROGRAM} format must be one of: text, markdown, html`,
      }
    }
    args.format = format
  }

  const timeout = payloadResult.payload.timeout
  if (timeout !== undefined) {
    if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) {
      return {
        error: `${WEBFETCH_PROGRAM} timeout must be a positive number`,
      }
    }
    args.timeout = timeout
  }

  return { args }
}

function parseQuestionPayload(rawPayload: string): { args: Record<string, unknown> } | { error: string } {
  const payloadResult = parseObjectPayload(rawPayload, QUESTION_PROGRAM)
  if ("error" in payloadResult) return payloadResult

  const rawQuestions = payloadResult.payload.questions
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
    return {
      error: `${QUESTION_PROGRAM} payload must include a non-empty questions array`,
    }
  }

  const questions: Record<string, unknown>[] = []
  for (let i = 0; i < rawQuestions.length; i += 1) {
    const rawQuestion = rawQuestions[i]
    if (!isRecord(rawQuestion)) {
      return {
        error: `${QUESTION_PROGRAM} questions[${i}] must be an object`,
      }
    }

    const question = asString(rawQuestion.question)
    if (!question) {
      return {
        error: `${QUESTION_PROGRAM} questions[${i}].question must be a string`,
      }
    }

    const header = asString(rawQuestion.header)
    if (!header) {
      return {
        error: `${QUESTION_PROGRAM} questions[${i}].header must be a string`,
      }
    }

    const rawOptions = rawQuestion.options
    if (!Array.isArray(rawOptions) || rawOptions.length === 0) {
      return {
        error: `${QUESTION_PROGRAM} questions[${i}].options must be a non-empty array`,
      }
    }

    const options: Record<string, unknown>[] = []
    for (let j = 0; j < rawOptions.length; j += 1) {
      const rawOption = rawOptions[j]
      if (!isRecord(rawOption)) {
        return {
          error: `${QUESTION_PROGRAM} questions[${i}].options[${j}] must be an object`,
        }
      }

      const label = asString(rawOption.label)
      if (!label) {
        return {
          error: `${QUESTION_PROGRAM} questions[${i}].options[${j}].label must be a string`,
        }
      }

      const description = asString(rawOption.description)
      if (!description) {
        return {
          error: `${QUESTION_PROGRAM} questions[${i}].options[${j}].description must be a string`,
        }
      }

      options.push({ label, description })
    }

    const mappedQuestion: Record<string, unknown> = { question, header, options }
    if (rawQuestion.multiple !== undefined) {
      if (typeof rawQuestion.multiple !== "boolean") {
        return {
          error: `${QUESTION_PROGRAM} questions[${i}].multiple must be a boolean`,
        }
      }
      mappedQuestion.multiple = rawQuestion.multiple
    }

    questions.push(mappedQuestion)
  }

  return {
    args: {
      questions,
    },
  }
}

function parseSkillPayload(rawPayload: string): { args: Record<string, unknown> } | { error: string } {
  const payloadResult = parseObjectPayload(rawPayload, SKILL_PROGRAM)
  if ("error" in payloadResult) return payloadResult

  const name = asString(payloadResult.payload.name)?.trim()
  if (!name) {
    return {
      error: `${SKILL_PROGRAM} payload must include a name string`,
    }
  }

  return {
    args: {
      name,
    },
  }
}

function unwrapWrappingQuotes(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length < 2) return trimmed

  const first = trimmed[0]
  const last = trimmed[trimmed.length - 1]
  if (first === last && (first === "'" || first === "\"")) {
    return trimmed.slice(1, -1)
  }

  return trimmed
}

function parseTodos(payload: Record<string, unknown>): { todos: TodoItem[] } | { error: string } {
  const rawTodos = payload.todos
  if (!Array.isArray(rawTodos)) {
    return {
      error: `${TODO_WRITE_PROGRAM} payload must include a todos array`,
    }
  }

  const todos: TodoItem[] = []

  for (let index = 0; index < rawTodos.length; index += 1) {
    const rawTodo = rawTodos[index]
    if (!isRecord(rawTodo)) {
      return {
        error: `${TODO_WRITE_PROGRAM} todos[${index}] must be an object`,
      }
    }

    const content = asString(rawTodo.content)
    if (content === undefined) {
      return {
        error: `${TODO_WRITE_PROGRAM} todos[${index}].content must be a string`,
      }
    }

    const status = asString(rawTodo.status)
    if (!status || !TODO_STATUSES.has(status as TodoItem["status"])) {
      return {
        error: `${TODO_WRITE_PROGRAM} todos[${index}].status must be one of: pending, in_progress, completed, cancelled`,
      }
    }

    const priority = asString(rawTodo.priority)
    if (!priority || !TODO_PRIORITIES.has(priority as TodoItem["priority"])) {
      return {
        error: `${TODO_WRITE_PROGRAM} todos[${index}].priority must be one of: high, medium, low`,
      }
    }

    todos.push({
      content,
      status: status as TodoItem["status"],
      priority: priority as TodoItem["priority"],
    })
  }

  return { todos }
}

function invalidTool(tool: string, error: string): MappedToolCall {
  return {
    toolName: "invalid",
    args: {
      tool,
      error,
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === "string")
}

function shellQuote(s: string): string {
  if (/^[a-zA-Z0-9_\-./=:@]+$/.test(s)) return s
  return `'${s.replace(/'/g, "'\\''")}'`
}
