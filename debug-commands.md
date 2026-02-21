# Debug commands

Run these commands from the repo root:

```bash
# Verify package exports
bun -e "import('./dist/index.js').then(m=>console.log('exports', Object.keys(m))).catch(e=>{console.error(e); process.exit(1);})"

# Build package output
npm run build

# Check installed OpenCode plugins
ls -a ~/.config/opencode/plugins

# List available models for the provider
opencode models gitlab-duo-agentic --print-logs --log-level DEBUG

# Run a quick test prompt
opencode run --print-logs --log-level DEBUG -m gitlab-duo-agentic/duo-agentic "hello"
```

## Tool call formats (SHOULD use)

The Duo workflow parser will simulate tool calls from model text when it matches these formats.
Use one of the following when emitting tool calls in responses:

```tool_call
{"tool":"read_file","args":{"file_path":"README.md"}}
```

```tool_call
{"tool_calls":[{"tool":"list_dir","args":{"directory":"."}}]}
```

Raw JSON is also accepted if the payload starts with `"tool"` or `"tool_calls"` at the top level:

```json
{"tool":"read_files","args":{"file_paths":["README.md","package.json"]}}
```
