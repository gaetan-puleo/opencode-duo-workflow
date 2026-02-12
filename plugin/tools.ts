/**
 * Custom tool definitions registered with OpenCode.  These provide file-
 * reading capabilities that are permission-aware (they go through the
 * OpenCode permission system before touching the filesystem).
 */

import { tool, type ToolContext } from "@opencode-ai/plugin"
import path from "node:path"
import fs from "node:fs"

export function createReadTools() {
  return {
    read_file: tool({
      description: "Read the contents of a file. Paths are relative to the repository root.",
      args: {
        file_path: tool.schema.string().describe("The file path to read."),
      },
      async execute(args, ctx) {
        const { resolvedPath, displayPath } = resolveReadPath(args.file_path, ctx)

        await ctx.ask({
          permission: "read",
          patterns: [resolvedPath],
          always: ["*"],
          metadata: {},
        })

        try {
          return await fs.promises.readFile(resolvedPath, "utf8")
        } catch (error) {
          throw new Error(formatReadError(displayPath, error))
        }
      },
    }),

    read_files: tool({
      description: "Read the contents of multiple files. Paths are relative to the repository root.",
      args: {
        file_paths: tool.schema.array(tool.schema.string()).describe("The file paths to read."),
      },
      async execute(args, ctx) {
        const targets = (args.file_paths ?? []).map((filePath) => ({
          inputPath: filePath,
          ...resolveReadPath(filePath, ctx),
        }))

        await ctx.ask({
          permission: "read",
          patterns: targets.map((t) => t.resolvedPath),
          always: ["*"],
          metadata: {},
        })

        const results = await Promise.all(
          targets.map(async (target) => {
            try {
              const content = await fs.promises.readFile(target.resolvedPath, "utf8")
              return [target.inputPath, { content }] as const
            } catch (error) {
              return [target.inputPath, { error: formatReadError(target.displayPath, error) }] as const
            }
          }),
        )

        const output: Record<string, { content?: string; error?: string }> = {}
        for (const [pathKey, result] of results) {
          output[pathKey] = result
        }

        return JSON.stringify(output)
      },
    }),
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveReadPath(filePath: string, ctx: ToolContext): { resolvedPath: string; displayPath: string } {
  const displayPath = filePath
  const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(ctx.worktree, filePath)
  const worktreePath = path.resolve(ctx.worktree)

  if (resolvedPath !== worktreePath && !resolvedPath.startsWith(worktreePath + path.sep)) {
    throw new Error(`File is outside the repository: "${displayPath}"`)
  }

  return { resolvedPath, displayPath }
}

function formatReadError(filePath: string, error: unknown): string {
  const fsError = error as NodeJS.ErrnoException
  if (fsError?.code === "ENOENT") return `File not found: "${filePath}"`
  const message = error instanceof Error ? error.message : String(error)
  return `Error reading file: ${message}`
}
