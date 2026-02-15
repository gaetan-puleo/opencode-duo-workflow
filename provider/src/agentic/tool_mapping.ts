/**
 * Builds the MCP tool list sent to the Duo Workflow Service and provides
 * a tool-context descriptor for the model.
 *
 * After the migration to native OpenCode tools, this module no longer
 * performs any Duo→OpenCode name mapping.  All tools from OpenCode
 * (read, write, edit, bash, glob, grep, task, webfetch, websearch,
 * codesearch, todowrite, question, skill, patch, lsp, …) are forwarded
 * as-is.  The action_handler takes care of translating DWS typed actions
 * back into OpenCode-native tool calls.
 */

import type { LanguageModelV2CallOptions } from "@ai-sdk/provider"
import type { AIContextItem } from "./types"

// ---------------------------------------------------------------------------
// Tool names we never forward to DWS (internal-only).
// ---------------------------------------------------------------------------

const EXCLUDED_TOOL_NAMES = new Set(["invalid"])

// ---------------------------------------------------------------------------
// MCP tool list construction
// ---------------------------------------------------------------------------

/**
 * Build the full MCP tool list to send to the Duo Workflow Service.
 * Forwards every tool from OpenCode's `options.tools` (except internal ones)
 * so that DWS can call them back via `runMCPTool`.
 */
export function buildMcpTools(
  options: LanguageModelV2CallOptions,
): Array<{ name: string; description?: string; schema?: unknown; isApproved?: boolean }> {
  const tools: Array<{ name: string; description?: string; schema?: unknown; isApproved?: boolean }> = []

  if (options.tools) {
    for (const t of options.tools) {
      if (t.type !== "function") continue
      if (EXCLUDED_TOOL_NAMES.has(t.name)) continue

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

// ---------------------------------------------------------------------------
// Tool context descriptor
// ---------------------------------------------------------------------------

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
    id: "available_tools",
    metadata: {
      title: "Available Tools",
      enabled: true,
      subType: "tools",
      icon: "tool",
      secondaryText: `${tools.length} tools`,
      subTypeLabel: "Tooling",
    },
  }
}
