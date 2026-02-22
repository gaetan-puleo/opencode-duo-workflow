/**
 * Builds a chat-partial V1 flow config that:
 * 1) overrides server tool discovery with a strict allowlist
 * 2) overrides system_static prompt content with the provided prompt string
 */
const TOOL_ALLOWLIST = [
  "read_file",
  "read_files",
  "create_file_with_contents",
  "edit_file",
  "list_dir",
  "find_files",
  "grep",
  "mkdir",
  "run_command",
] as const

export function buildFlowConfig(systemPrompt: string): Record<string, unknown> {
  return {
    version: "v1",
    environment: "chat-partial",
    components: [
      {
        // Keep "chat" for behavior parity with GitLab Duo CLI flow metadata.
        name: "chat",
        type: "AgentComponent",
        prompt_id: "chat/agent",
        toolset: [...TOOL_ALLOWLIST],
      },
    ],
    prompts: [
      {
        name: "chat",
        prompt_id: "chat/agent",
        unit_primitives: ["duo_chat"],
        prompt_template: {
          system: systemPrompt,
        },
      },
    ],
  }
}
