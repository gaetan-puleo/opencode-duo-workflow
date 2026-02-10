import type { ProviderV2 } from "@ai-sdk/provider"
import type { GitLabDuoAgenticProviderOptions } from "./agentic/types"
import { GitLabDuoAgenticLanguageModel } from "./agentic/model"

export function createGitLabDuoAgentic(
  options: GitLabDuoAgenticProviderOptions,
): ProviderV2 {
  return {
    name: "gitlab-duo-agentic-unofficial",
    languageModel(modelId: string) {
      return new GitLabDuoAgenticLanguageModel(modelId, options)
    },
  }
}
