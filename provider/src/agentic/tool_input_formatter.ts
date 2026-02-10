import type { ToolInputDisplay } from "./types"

export class ToolInputFormatter {
  async formatToolInput(toolName: string, args: Record<string, unknown>): Promise<ToolInputDisplay> {
    return {
      tool: "generic",
      name: toolName,
      args,
    }
  }
}
