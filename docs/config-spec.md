# Config Specification

Heirloom config lives at `~/.heirloom/config.yaml`. Project-level overrides
at `.heirloom/config.yaml`.

## Schema

```yaml
# Required: none (all fields optional)

# Default provider/model (used when mode doesn't specify one)
provider: deepseek             # Provider name matching an adapter
model: deepseek-chat           # Model ID for that provider

# Permission rules (evaluated in order, last match wins)
permissions:
  read_file: allow
  list_files: allow
  search: allow
  glob: allow
  write_file: ask
  edit: ask
  apply_diff: ask
  apply_patch: ask
  search_replace: ask
  edit_file: ask
  write_to_file: ask
  run_bash:
    "git *": allow
    "npm test": allow
    "npm run *": allow
    "ls *": allow
    "cat *": allow
    "rm *": deny
    "*": ask

# Compaction settings
compaction:
  auto: true                    # Auto-compact when context exceeds threshold
  threshold: 0.7                # Fraction of context window (0.0-1.0)

# Context window for the default model
contextWindow: 128000

# MCP servers for external tool discovery
mcp:
  playwright:
    type: local
    command: ["npx", "-y", "@playwright/mcp"]
    enabled: false
```

## Precedence

1. CLI flags (future: `--mode architect --model deepseek-chat`)
2. Environment variables (`HEIRLOOM_PROVIDER`, `HEIRLOOM_MODEL`)
3. Project config (`.heirloom/config.yaml`)
4. Global config (`~/.heirloom/config.yaml`)
5. Built-in defaults

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `DEEPSEEK_API_KEY` | DeepSeek API key |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `OPENAI_API_KEY` | OpenAI API key |
| `HEIRLOOM_HOME` | Override `~/.heirloom` directory (default: `~/.heirloom`) |
