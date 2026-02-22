import type { McpToolDefinition } from "./types"

/** Tools that are executable client-side via the plugin. */
const SUPPORTED_TOOLS = new Set([
  "bash",
  "read",
  "edit",
  "write",
  "glob",
  "grep",
  "webfetch",
  "question",
  "skill",
  "todowrite",
  "todoread",
])

type ToolListItem = {
  id: string
  description: string
  parameters: unknown
}

/**
 * Fetch OpenCode tool definitions from the SDK and convert them to McpToolDefinition format.
 * Only includes tools the plugin can actually execute client-side.
 */
export async function fetchOpencodeTools(
  client: { tool: { list(params: { provider: string; model: string }, opts?: unknown): Promise<{ data?: ToolListItem[] }> } },
  provider: string,
  model: string,
): Promise<McpToolDefinition[]> {
  try {
    const response = await client.tool.list({ provider, model })
    const tools = response.data ?? []

    return tools
      .filter((t) => SUPPORTED_TOOLS.has(t.id))
      .map((t) => ({
        name: t.id,
        description: t.description,
        inputSchema: typeof t.parameters === "string" ? t.parameters : JSON.stringify(t.parameters),
      }))
  } catch {
    // If SDK call fails (e.g. experimental endpoint not available), return empty
    return []
  }
}

/**
 * Fallback: build hardcoded tool definitions when the SDK is unavailable.
 * These match OpenCode's built-in tool schemas.
 */
export function buildFallbackTools(): McpToolDefinition[] {
  return [
    {
      name: "bash",
      description: "Execute a shell command. Use the `command` parameter for the command to run, `description` for a short summary, optional `timeout` in milliseconds, and optional `workdir` to set the working directory.",
      inputSchema: JSON.stringify({
        type: "object",
        properties: {
          command: { type: "string", description: "The command to execute" },
          description: { type: "string", description: "Clear, concise description of what this command does in 5-10 words" },
          timeout: { type: "number", description: "Optional timeout in milliseconds" },
          workdir: { type: "string", description: "The working directory to run the command in" },
        },
        required: ["command", "description"],
      }),
    },
    {
      name: "read",
      description: "Read a file or directory from the local filesystem. Returns content with line numbers prefixed. Supports offset and limit for pagination. Can read images and PDFs as attachments.",
      inputSchema: JSON.stringify({
        type: "object",
        properties: {
          filePath: { type: "string", description: "The absolute path to the file or directory to read" },
          offset: { type: "number", description: "The line number to start reading from (1-indexed)" },
          limit: { type: "number", description: "The maximum number of lines to read (defaults to 2000)" },
        },
        required: ["filePath"],
      }),
    },
    {
      name: "edit",
      description: "Performs exact string replacements in files. The oldString must match the file contents exactly. Provide surrounding context to make the match unique.",
      inputSchema: JSON.stringify({
        type: "object",
        properties: {
          filePath: { type: "string", description: "The absolute path to the file to modify" },
          oldString: { type: "string", description: "The text to replace" },
          newString: { type: "string", description: "The text to replace it with" },
          replaceAll: { type: "boolean", description: "Replace all occurrences (default false)" },
        },
        required: ["filePath", "oldString", "newString"],
      }),
    },
    {
      name: "write",
      description: "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Parent directories are created automatically.",
      inputSchema: JSON.stringify({
        type: "object",
        properties: {
          filePath: { type: "string", description: "The absolute path to the file to write" },
          content: { type: "string", description: "The content to write to the file" },
        },
        required: ["filePath", "content"],
      }),
    },
    {
      name: "glob",
      description: "Fast file pattern matching. Supports glob patterns like '**/*.js' or 'src/**/*.ts'. Returns matching file paths sorted by modification time.",
      inputSchema: JSON.stringify({
        type: "object",
        properties: {
          pattern: { type: "string", description: "The glob pattern to match files against" },
          path: { type: "string", description: "The directory to search in" },
        },
        required: ["pattern"],
      }),
    },
    {
      name: "grep",
      description: "Fast content search using regular expressions. Returns file paths and line numbers with matches. Supports filtering files by pattern with the include parameter.",
      inputSchema: JSON.stringify({
        type: "object",
        properties: {
          pattern: { type: "string", description: "The regex pattern to search for in file contents" },
          path: { type: "string", description: "The directory to search in" },
          include: { type: "string", description: "File pattern to include in the search (e.g. '*.js', '*.{ts,tsx}')" },
        },
        required: ["pattern"],
      }),
    },
    {
      name: "webfetch",
      description: "Fetches content from a specified URL and returns it as markdown, text, or HTML.",
      inputSchema: JSON.stringify({
        type: "object",
        properties: {
          url: { type: "string", description: "The URL to fetch content from" },
          format: {
            type: "string",
            enum: ["text", "markdown", "html"],
            description: "The format to return the content in (defaults to markdown)",
          },
          timeout: { type: "number", description: "Optional timeout in seconds (max 120)" },
        },
        required: ["url"],
      }),
    },
    {
      name: "question",
      description: "Ask the user clarifying questions and receive structured answers.",
      inputSchema: JSON.stringify({
        type: "object",
        properties: {
          questions: {
            type: "array",
            description: "Questions to ask",
            items: {
              type: "object",
              properties: {
                question: { type: "string", description: "Complete question" },
                header: { type: "string", description: "Very short label (max 30 chars)" },
                options: {
                  type: "array",
                  description: "Available choices",
                  items: {
                    type: "object",
                    properties: {
                      label: { type: "string", description: "Display text (1-5 words, concise)" },
                      description: { type: "string", description: "Explanation of choice" },
                    },
                    required: ["label", "description"],
                  },
                },
                multiple: { type: "boolean", description: "Allow selecting multiple choices" },
              },
              required: ["question", "header", "options"],
            },
          },
        },
        required: ["questions"],
      }),
    },
    {
      name: "skill",
      description: "Load a specialized skill by name.",
      inputSchema: JSON.stringify({
        type: "object",
        properties: {
          name: { type: "string", description: "The skill name from available_skills" },
        },
        required: ["name"],
      }),
    },
    {
      name: "todowrite",
      description: "Create and update the structured todo list for the current session.",
      inputSchema: JSON.stringify({
        type: "object",
        properties: {
          todos: {
            type: "array",
            description: "The updated todo list",
            items: {
              type: "object",
              properties: {
                content: { type: "string", description: "Brief description of the task" },
                status: {
                  type: "string",
                  enum: ["pending", "in_progress", "completed", "cancelled"],
                  description: "Current status of the task",
                },
                priority: {
                  type: "string",
                  enum: ["high", "medium", "low"],
                  description: "Priority level of the task",
                },
              },
              required: ["content", "status", "priority"],
            },
          },
        },
        required: ["todos"],
      }),
    },
    {
      name: "todoread",
      description: "Read the current session todo list.",
      inputSchema: JSON.stringify({
        type: "object",
        properties: {},
      }),
    },
  ]
}
