# Config Specification

Heirloom config lives at `~/.heirloom/config.yaml`. Project-level overrides
at `.heirloom/config.yaml`.

## Schema

```yaml
# Required: none (all fields optional)

# Default provider/model (used when mode doesn't specify one)
provider: deepseek             # Key into the providers map below
model: deepseek-chat           # Model ID for that provider

# Provider registry. Built-ins (deepseek, openai, anthropic) ship with the
# defaults shown; entries here add providers or override built-ins.
# Adding any OpenAI-compatible service is config-only — zero code.
providers:
  deepseek:                    # built-in, shown for reference
    api: openai-compatible     # which adapter implements the wire format
    baseUrl: https://api.deepseek.com
    apiKeyEnv: DEEPSEEK_API_KEY
    models:
      deepseek-chat: { contextWindow: 128000 }
      deepseek-reasoner: { contextWindow: 128000 }
  ollama:                      # example: local models, no key, zero code
    api: openai-compatible
    baseUrl: http://localhost:11434/v1
    apiKeyEnv: null
    models:
      qwen2.5-coder: { contextWindow: 32768 }

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

# Fallback context window, used only when the active model has no
# contextWindow in its provider entry (a warning is printed)
contextWindow: 128000

# MCP servers for external tool discovery
mcp:
  playwright:
    type: local
    command: ["npx", "-y", "@playwright/mcp"]
    enabled: false
```

## Provider Entries

| Field | Meaning |
|-------|---------|
| `api` | Adapter implementing the wire format: `openai-compatible` \| `anthropic` (provider-spec.md). Unknown value → config error at startup. |
| `baseUrl` | Endpoint root. Required for `openai-compatible`; native adapters have defaults. |
| `apiKeyEnv` | **Name** of the env var holding the key. `null` for keyless endpoints (local models). Literal keys are never allowed in config — YAML gets committed by accident, env vars don't. Missing env var → clear error on first use, naming the variable. |
| `models` | Known models with per-model settings. `contextWindow` here is what compaction budgets read (subsystems.md §2) — the global fallback exists only for models missing an entry. |

Model references everywhere else (mode `model:` field, `--model` flag) use
`provider/model-id`, split on the **first** slash only — model IDs may
themselves contain slashes: `openrouter/anthropic/claude-sonnet-4.5` parses
as provider `openrouter`, model `anthropic/claude-sonnet-4.5`.

## Credentials

API keys never live in `config.yaml` (it should be shareable/committable).
Two sources, in precedence order:

1. **Env var** named by the provider's `apiKeyEnv` — wins when set.
2. **`~/.heirloom/credentials.yaml`** — a flat `provider: key` map, file
   mode `0600`, written by `heirloom auth` (cli-spec.md). Never read from a
   project directory.

```yaml
# ~/.heirloom/credentials.yaml  (managed by `heirloom auth`)
openrouter: sk-or-...
deepseek: sk-...
```

## Adding a Provider

**The normal way — `heirloom auth`** (cli-spec.md): pick a preset
(DeepSeek, OpenRouter, Groq, Together, Ollama, OpenAI, Anthropic, or
custom), paste the key, done. Presets carry the `baseUrl` and default
models, so nothing is typed but the key; "custom" additionally asks for a
baseUrl and writes the provider entry into `~/.heirloom/config.yaml`.

**The manual way** (escape hatch, and what `auth` does under the hood):
edit `~/.heirloom/config.yaml` yourself —

```yaml
providers:
  openrouter:
    api: openai-compatible          # OpenRouter speaks the OpenAI format → zero code
    baseUrl: https://openrouter.ai/api/v1
    apiKeyEnv: OPENROUTER_API_KEY   # or run `heirloom auth` / add to credentials.yaml
    models:
      anthropic/claude-sonnet-4.5: { contextWindow: 200000 }
```

Then set it as default (`provider: openrouter` at the top of the file) or
use it ad hoc: `--model openrouter/anthropic/claude-sonnet-4.5`. A provider
speaking a wire format heirloom lacks is the only case requiring code — one
adapter file (provider-spec.md).

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
