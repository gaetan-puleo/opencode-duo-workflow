/**
 * Custom tool definitions — previously registered read_file / read_files
 * tools with OpenCode.
 *
 * These have been removed as part of the migration to native OpenCode tools.
 * OpenCode's built-in `read` tool is now forwarded directly to the Duo
 * Workflow Service as an MCP tool, and typed DWS actions (runReadFile,
 * runReadFiles) are mapped to the native `read` tool in action_handler.ts.
 *
 * This file is kept as a placeholder; it can be removed entirely or
 * re-used for future custom tool definitions.
 */
