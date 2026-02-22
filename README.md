# opencode-gitlab-duo-agentic-custom-tools

OpenCode plugin for GitLab Duo Agentic. Registers a provider that routes models through the Duo Agentic Workflow Service, enabling native tool calling via WebSocket sessions.

## Setup

Add the plugin to your `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-gitlab-duo-agentic-custom-tools"]
}
```

Run `opencode`. The provider and models are registered automatically.

For self-managed GitLab, set `GITLAB_INSTANCE_URL`.

## Authentication

Authentication is managed by `@gitlab/opencode-gitlab-auth`, which is natively integrated into OpenCode. Run `/connect`, select GitLab, and choose OAuth or Personal Access Token. No additional setup is required.
