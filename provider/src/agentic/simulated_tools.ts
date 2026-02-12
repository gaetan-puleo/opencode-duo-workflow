/**
 * Simulated tool calls for tools that DWS doesn't natively support.
 *
 * DWS handles file ops, shell commands, git, etc. via native WebSocket actions.
 * For tools like todowrite/todoread/task, we teach the DWS agent to output
 * <tool name="NAME">JSON_ARGS</tool> tags in its text, then parse and emit
 * them as real tool calls to OpenCode.
 */

import crypto from "node:crypto"

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const SIMULATED_TOOL_NAMES = new Set(["todowrite", "todoread", "task"])

const TOOL_SCHEMAS: Record<string, string> = {
  todowrite: [
    "todowrite: Manage a structured task list. Args:",
    '  { "todos": [{ "id": "unique-id", "content": "task description",',
    '    "status": "pending" | "in_progress" | "completed" | "cancelled",',
    '    "priority": "low" | "medium" | "high" }] }',
    "  Pass the FULL todo list each time (not just changes).",
  ].join("\n"),
  todoread: [
    "todoread: Read the current todo list. Args: {}",
  ].join("\n"),
  task: [
    "task: Launch a sub-agent for complex tasks. Args:",
    '  { "description": "short 3-5 word label",',
    '    "prompt": "detailed task description for the agent",',
    '    "subagent_type": "general" | "explore" | "code-research" }',
  ].join("\n"),
}

// ---------------------------------------------------------------------------
// Prompt for DWS
// ---------------------------------------------------------------------------

/**
 * Returns an instruction block that teaches the DWS agent how to use
 * simulated tools via <tool> tags in its text output.
 */
export function buildSimulatedToolPrompt(): string {
  const toolDescs = [...SIMULATED_TOOL_NAMES]
    .map((name) => TOOL_SCHEMAS[name] ?? `${name}: (no schema)`)
    .join("\n\n")

  return [
    "You have access to the following additional tools that must be invoked using XML-style tags in your text output.",
    "To call a tool, write:",
    "",
    '<tool name="TOOL_NAME">JSON_ARGUMENTS</tool>',
    "",
    "Rules:",
    "- The JSON inside the tag must be valid JSON matching the tool's schema.",
    "- You may include normal text before and after tool tags.",
    "- You may emit multiple tool tags in a single response.",
    "- Do NOT wrap tool tags in markdown code fences.",
    "",
    "Available simulated tools:",
    "",
    toolDescs,
  ].join("\n")
}

// ---------------------------------------------------------------------------
// <tool> tag parsing
// ---------------------------------------------------------------------------

type SimulatedToolCall = { name: string; args: Record<string, unknown> }

const TOOL_TAG_REGEX = /<tool\s+name="([^"]+)">\s*([\s\S]*?)\s*<\/tool>/gi

/**
 * Extract all simulated tool calls from accumulated text.
 * Only extracts tools whose name is in SIMULATED_TOOL_NAMES.
 */
export function extractSimulatedToolCalls(text: string): SimulatedToolCall[] {
  if (!text) return []

  const calls: SimulatedToolCall[] = []
  let match: RegExpExecArray | null
  TOOL_TAG_REGEX.lastIndex = 0

  while ((match = TOOL_TAG_REGEX.exec(text)) !== null) {
    const name = (match[1] ?? "").trim()
    const rawArgs = (match[2] ?? "").trim() || "{}"

    if (!SIMULATED_TOOL_NAMES.has(name)) continue

    let args: Record<string, unknown>
    try {
      args = JSON.parse(rawArgs)
      if (typeof args !== "object" || args === null || Array.isArray(args)) {
        continue
      }
    } catch {
      continue
    }

    calls.push({ name, args })
  }

  return calls
}

// ---------------------------------------------------------------------------
// ID helpers
// ---------------------------------------------------------------------------

const SIM_TOOL_PREFIX = "sim-tool:"

export function generateSimulatedToolCallId(): string {
  return `${SIM_TOOL_PREFIX}${crypto.randomUUID()}`
}

export function isSimulatedToolCallId(id: string): boolean {
  return id.startsWith(SIM_TOOL_PREFIX)
}
