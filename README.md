# opencode-gitlab-duo-agentic

OpenCode plugin for GitLab Duo Agentic. It registers the provider, discovers models from the GitLab API, and exposes file-reading tools.

## Setup

1. Export your GitLab token:

```bash
export GITLAB_TOKEN=glpat-...
```

2. Add the plugin to `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-gitlab-duo-agentic"]
}
```

3. Run `opencode`. The provider, models, and tools are registered automatically.

`GITLAB_INSTANCE_URL` defaults to `https://gitlab.com`. Set it only for self-managed GitLab.

## Provider options

Override defaults in `opencode.json` under `provider.gitlab-duo-agentic.options`.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `instanceUrl` | string | `GITLAB_INSTANCE_URL` or `https://gitlab.com` | GitLab instance URL |
| `apiKey` | string | `GITLAB_TOKEN` | Personal access token |
| `sendSystemContext` | boolean | `true` | Send system context to Duo |
| `enableMcp` | boolean | `true` | Enable MCP tools |
| `systemRules` | string | `""` | Inline system rules |
| `systemRulesPath` | string | `""` | Path to a system rules file |

## Model discovery

Models are discovered in this order:

1. Local cache (TTL: 24h)
2. Live fetch from GitLab GraphQL API
3. Stale cache (if live fetch fails)
4. `models.json` on disk
5. Default `duo-agentic` model

Cache is stored in `~/.cache/opencode/` (or `XDG_CACHE_HOME`). Override TTL with `GITLAB_DUO_MODELS_CACHE_TTL` (seconds).

## Development

```bash
npm install
npm run build
npm run typecheck
npm run pack:check
```
