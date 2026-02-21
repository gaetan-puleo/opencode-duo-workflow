import type { LanguageModelV2, ProviderV2 } from "@ai-sdk/provider"
import { NoSuchModelError } from "@ai-sdk/provider"
import { resolveCredentials } from "../gitlab/resolve-credentials"
import { DuoWorkflowModel } from "./duo-workflow-model"

type DuoWorkflowProvider = ProviderV2 & {
  agenticChat(modelId: string, options?: unknown): LanguageModelV2
}

export function createFallbackProvider(input: Record<string, unknown> = {}): DuoWorkflowProvider {
  const client = resolveCredentials(input)

  return {
    languageModel(modelId: string) {
      return new DuoWorkflowModel(modelId, client)
    },
    agenticChat(modelId: string, _options?: unknown) {
      return new DuoWorkflowModel(modelId, client)
    },
    textEmbeddingModel(modelId: string) {
      throw new NoSuchModelError({ modelId, modelType: "textEmbeddingModel" })
    },
    imageModel(modelId: string) {
      throw new NoSuchModelError({ modelId, modelType: "imageModel" })
    },
  }
}
