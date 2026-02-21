import type { WorkflowToolsConfig } from "./session"

/**
 * Module-level store for tools configuration.
 * 
 * This bridges the plugin hooks (which have SDK access to fetch tool
 * definitions) and the DuoWorkflowModel (which needs to pass config
 * to WorkflowSessions). The plugin sets the config during initialization,
 * and the model reads it when creating new sessions.
 */
let stored: WorkflowToolsConfig | undefined

export function setToolsConfig(config: WorkflowToolsConfig): void {
  stored = config
}

export function getToolsConfig(): WorkflowToolsConfig | undefined {
  return stored
}
