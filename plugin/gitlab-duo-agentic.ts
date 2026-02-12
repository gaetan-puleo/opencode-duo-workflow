/**
 * OpenCode plugin entry point for GitLab Duo Agentic.
 *
 * This file is the module that OpenCode discovers and loads — it composes
 * the config hook, chat-params hook, and tool definitions from their
 * respective modules.
 */

import type { Plugin } from "@opencode-ai/plugin"
import { configHook } from "./config"
import { createReadTools } from "./tools"

export const GitLabDuoAgenticPlugin: Plugin = async () => {
  return {
    config: configHook,
    "chat.params": async (input, output) => {
      output.options ??= {}
      output.options.opencodeSessionId = input.sessionID
      // Pass agent info to the provider — input.agent is Agent.Info at runtime
      // (the plugin type declares it as string, but the full object is passed)
      const agent = input.agent as Record<string, unknown>
      if (typeof agent === "object" && agent !== null) {
        output.options.agentName = agent.name
        output.options.agentPrompt = agent.prompt
      }
      return output
    },
    tool: createReadTools(),
  }
}
