import type { ProviderV2 } from "@ai-sdk/provider"
import type { GitLabDuoAgenticProviderOptions } from "./agentic/types"
import { GitLabDuoAgenticLanguageModel } from "./agentic/model"
import { GitLabAgenticRuntime } from "./agentic/runtime"
import { createRequire } from "module"

const REQUIRED_MODULES = [
  "isomorphic-ws",
  "uuid",
  "zod",
  "neverthrow",
  "proxy-agent",
]

function assertDependencies(): void {
  const require = createRequire(import.meta.url)
  const missing: string[] = []

  for (const name of REQUIRED_MODULES) {
    try {
      require.resolve(name)
    } catch {
      missing.push(name)
    }
  }

  if (missing.length > 0) {
    const message =
      "Missing provider dependencies: " +
      missing.join(", ") +
      ". Run `bun install` in the provider directory."
    console.error(message)
    throw new Error(message)
  }
}

function assertInstanceUrl(value: string): void {
  try {
    new URL(value)
  } catch {
    const message = `Invalid instanceUrl: "${value}"`
    console.error(message)
    throw new Error(message)
  }
}

export function createGitLabDuoAgentic(
  options: GitLabDuoAgenticProviderOptions,
): ProviderV2 {
  assertDependencies()
  assertInstanceUrl(options.instanceUrl)
  const sharedRuntime = new GitLabAgenticRuntime(options)
  return {
    languageModel(modelId: string) {
      return new GitLabDuoAgenticLanguageModel(modelId, options, sharedRuntime)
    },
    textEmbeddingModel() {
      throw new Error("GitLab Duo Agentic does not support text embedding models")
    },
    imageModel() {
      throw new Error("GitLab Duo Agentic does not support image models")
    },
  }
}
