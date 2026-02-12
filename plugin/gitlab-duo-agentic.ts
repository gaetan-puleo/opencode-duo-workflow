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
      return output
    },
    tool: createReadTools(),
  }
}
