import { tool, type Hooks, type PluginInput } from "@opencode-ai/plugin"
import { applyRuntimeConfig } from "./config"

export async function createPluginHooks(input: PluginInput): Promise<Hooks> {

  return {
    tool: {
      todoread: tool({
        description: "Use this tool to read your todo list",
        args: {},
        async execute(_args, ctx) {
          await ctx.ask({
            permission: "todoread",
            patterns: ["*"],
            always: ["*"],
            metadata: {},
          })

          const response = await input.client.session.todo({
            path: { id: ctx.sessionID },
            throwOnError: true,
          })
          const payload = response.data ?? []
          return JSON.stringify(payload, null, 2)
        },
      }),
    },
    config: async (config) => applyRuntimeConfig(config, input.directory),
    "chat.message": async ({ sessionID }, { parts }) => {
      const text = parts
        .filter((p) => p.type === "text" && !("synthetic" in p && p.synthetic))
        .map((p) => ("text" in p ? (p as { text: string }).text : ""))
        .join(" ")
        .trim()
      if (!text) return
      const title = text.length > 100 ? text.slice(0, 97) + "..." : text
      const url = new URL(`/session/${encodeURIComponent(sessionID)}`, input.serverUrl)
      await fetch(url, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title }),
      }).catch(() => {})
    },
    "chat.params": async (context, output) => {
      if (!isGitLabProvider(context.model)) return
      if (isUtilityAgent(context.agent)) return
      output.options = {
        ...output.options,
        workflowSessionID: context.sessionID,
      }
    },
    "chat.headers": async (context, output) => {
      if (!isGitLabProvider(context.model)) return
      if (isUtilityAgent(context.agent)) return
      output.headers = {
        ...output.headers,
        "x-opencode-session": context.sessionID,
      }
    },
  }
}

const UTILITY_AGENTS = new Set(["title", "compaction"])

function isUtilityAgent(agent: string | { name: string }): boolean {
  const name = typeof agent === "string" ? agent : agent.name
  return UTILITY_AGENTS.has(name)
}

function isGitLabProvider(model: { providerID: string; api?: { npm?: string } }): boolean {
  if (model.api?.npm === "opencode-gitlab-duo-agentic") return true
  if (model.providerID === "gitlab" && model.api?.npm !== "@gitlab/gitlab-ai-provider") return true
  return model.providerID.toLowerCase().includes("gitlab-duo")
}
