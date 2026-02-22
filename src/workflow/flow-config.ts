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

const BRIDGE_WHEN_TO_USE = [
  "Bridge tools — when to use:",
  "",
  "Todo (__todo_read__, __todo_write__):",
  "- Use for planning and tracking when the task has 3+ steps, multiple files, or multiple user requirements.",
  "- Keep exactly one todo in_progress at a time.",
  "- Mark tasks completed immediately after finishing each step.",
  "- Update the todo list when scope changes or new requirements appear.",
  "- Skip for trivial one-step requests.",
  "",
  "Web fetch (__webfetch__):",
  "- Use only when external URL content is needed and repo/local context is insufficient.",
  "- Prefer targeted URLs and the minimum needed format.",
  "- Do not use for local files or codebase exploration.",
  "",
  "Question (__question__):",
  "- Use only when blocked by missing user input that materially changes the implementation.",
  "- Complete all non-blocked work first, then ask.",
  "- Ask exactly one targeted question unless multiple answers are strictly required together.",
  "- If a safe low-risk default exists, proceed without asking and state the assumption.",
  "- Must ask for: credentials/secrets, destructive/irreversible actions, production/billing/security impact, ambiguity where different answers produce different implementations.",
  "- Do not ask for: permission-style prompts (\"Should I proceed?\"), trivial preferences, questions answerable from repo/docs/context.",
  "",
  "Skill (__skill__):",
  "- Use when the task clearly matches an available skill and specialized instructions are needed.",
  "- Load the matching skill once, then follow its workflow.",
  "- Do not use if no available skill clearly matches.",
].join("\n")

const BRIDGE_HOW_TO_USE = [
  "Bridge tools — how to use:",
  "",
  "All bridge tools are called via run_command with a single command string.",
  "",
  "Read todos:",
  "  __todo_read__",
  "Write/update todos:",
  "  __todo_write__ {\"todos\":[{\"content\":\"...\",\"status\":\"pending|in_progress|completed|cancelled\",\"priority\":\"high|medium|low\"}]}",
  "Fetch web content:",
  "  __webfetch__ {\"url\":\"https://example.com\",\"format\":\"markdown\",\"timeout\":30}",
  "Ask user question(s):",
  "  __question__ {\"questions\":[{\"question\":\"...\",\"header\":\"...\",\"options\":[{\"label\":\"Option A\",\"description\":\"...\"}],\"multiple\":false}]}",
  "Load a skill:",
  "  __skill__ {\"name\":\"skill-name\"}",
].join("\n")

const BRIDGE_FORMATTING_RULES = [
  "Bridge tools — formatting and validation:",
  "",
  "Payloads:",
  "- Use strict JSON with double quotes in all payloads.",
  "- If validation fails, correct the JSON and retry.",
  "- Do not use regular shell commands for bridge operations.",
  "",
  "Question formatting:",
  "- Provide 2-5 concrete options.",
  "- Labels: 1-5 words, concise.",
  "- Header: max 30 chars.",
  "- Put recommended option first; append \"(Recommended)\" to its label.",
  "- Set multiple=true only when selecting more than one is valid.",
  "- Custom free-text is enabled by default; do not add generic \"Other\" options.",
].join("\n")

export function buildFlowConfig(systemPrompt: string): Record<string, unknown> {
  const bridgedPrompt = [
    systemPrompt.trim(),
    BRIDGE_WHEN_TO_USE,
    BRIDGE_HOW_TO_USE,
    BRIDGE_FORMATTING_RULES,
  ].filter(Boolean).join("\n\n")

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
          system: bridgedPrompt,
        },
      },
    ],
  }
}
