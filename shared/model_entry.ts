/**
 * Shared model entry builder used by both the plugin and the fetch-models script.
 * Defines the shape OpenCode expects in config.provider[id].models.
 */

export type ModelDefinition = {
  name: string
  release_date: string
  attachment: boolean
  reasoning: boolean
  temperature: boolean
  tool_call: boolean
  limit: { context: number; output: number }
  modalities: { input: string[]; output: string[] }
  options: Record<string, unknown>
}

export function buildModelEntry(name: string): ModelDefinition {
  return {
    name,
    release_date: "",
    attachment: false,
    reasoning: false,
    temperature: true,
    tool_call: true,
    limit: { context: 0, output: 0 },
    modalities: { input: ["text"], output: ["text"] },
    options: {},
  }
}
