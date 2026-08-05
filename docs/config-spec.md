# Config Specification

**Note:** this spec's guidance is current; only the example model IDs (e.g.
`anthropic/claude-sonnet-4`) are stale. `src/providers/models.json` is authoritative.

Heirloom config is **JSON**, loaded and merged by `src/config/loader.ts`. Two
files are read and deep-merged (project wins over global):

- **Global:** `~/.heirloom/settings.json` (or `$HEIRLOOM_HOME/settings.json`)
- **Project:** `./.heirloom/settings.json` (in the current working directory)

There is no YAML config file. `config.yaml`, `~/.heirloom/config.yaml`, and a
`providers:` registry map are **not** read by the loader; the only YAML file
heirloom reads is the credentials store (see §Credentials).

## Schema

Every field is optional. Keys the loader recognizes (`KNOWN_KEYS` in
`src/config/loader.ts`); anything else emits a `config: unknown field "<key>"`
warning and is ignored.

```jsonc
{
  // Default model. Top-level "model" wins over env.MODEL.
  "model": "deepseek-v4-pro",

  // Provider name (heirloom extension). Selects a built-in preset:
  // deepseek | openai | openrouter | groq | ollama. When absent, the
  // provider is inferred from env.BASE_URL / present env keys, defaulting
  // to "deepseek" (src/cli.tsx detectProvider).
  "provider": "deepseek",

  // Model/API env block. These map onto the provider at launch.
  "env": {
    "MODEL": "deepseek-v4-pro",          // used only if top-level "model" unset
    "API_KEY": "sk-...",                  // works, but discouraged — see Credentials
    "BASE_URL": "https://api.deepseek.com",// see note under Providers below
    "TEMPERATURE": "0.2",                 // string "0".."2"
    "THINKING_ENABLED": "true",
    "REASONING_EFFORT": "high"            // "high" | "max"
    // arbitrary extra string keys are preserved, but none of DEBUG_LOG_ENABLED
    // / TELEMETRY_ENABLED are consumed (see No Telemetry, and Deprecated Keys)
  },

  // Thinking / reasoning (top-level; higher priority than the env.* strings)
  "thinkingEnabled": true,
  "reasoningEffort": "high",              // "high" | "max"
  "temperature": 0.2,                      // number, 0..2

  // Permission rules — the CURRENT (rule-based) shape. Evaluated in order,
  // last match wins. See permission-spec.md and §Permissions below.
  "permissions": {
    "defaultMode": "askAll",              // "askAll" | "allowAll"
    "rules": [
      { "tool": "read_file",     "pattern": "./**",     "action": "allow" },
      { "tool": "write_to_file", "pattern": "./**",     "action": "allow" },
      { "tool": "run_bash",      "pattern": "git *",    "action": "allow" },
      { "tool": "run_bash",      "pattern": "rm *",     "action": "deny"  },
      { "tool": "run_bash",      "pattern": "*",        "action": "ask"   }
    ]
  },

  // MCP servers for external tool discovery
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "env": { "SOME_VAR": "value" }
    }
  },

  // When true, only allowlisted MCP server commands may be spawned (default false)
  "strictMcpConfig": false,

  // Theme (heirloom extension)
  "theme": {
    "mode": "dark",                        // "dark" | "light" | "auto"
    "name": "some-preset",                 // optional named preset
    "overrides": {}                        // optional token overrides
  },

  // Per-skill enable/disable. Absent = enabled (the default). A skill set
  // false here is not loaded or indexed; others are unaffected.
  "enabledSkills": { "some-skill": false },

  // Misc extensions
  "keybindings": {},                       // object, passed through as-is
  "compaction": { "auto": true, "threshold": 0.7 },  // auto: gate automatic compaction (default true)
  "contextWindow": 128000,                 // fallback context window
  "workflow": { "gitStatus": true, "gitPollInterval": 30000 },
  "notify": "/path/to/notify-script"
  // debugLogEnabled — deprecated no-op, see Deprecated Keys
}
```

## Permissions

The **current** shape is `permissions.rules` (an array of
`{ tool, pattern, action }`) plus an optional `defaultMode`
(`"askAll"` | `"allowAll"`). The `pattern` string is interpreted by the loader:

| Pattern form | Interpreted as |
|--------------|----------------|
| ends with `:*` | prefix match on the text before `:*` |
| contains `*` or `?` | glob |
| empty string `""` | matches any input |
| otherwise | exact match |

`action` must be one of `allow` / `ask` / `deny`.

### Legacy shape (migrated with a warning)

The **old** shape used top-level `allow` / `deny` / `ask` arrays of *scope*
strings (`scan`, `read-out-cwd`, `write-in-cwd`, `mcp`, …). The loader still
accepts it, but `migrateLegacyPermissions` (`src/config/loader.ts`) translates
it to `rules` in memory and emits:

```
permissions: migrated N legacy scope(s) to rule-based permissions —
review .heirloom/settings.json and re-approve as needed
```

That warning fires on **every launch** until the file is rewritten to the
`rules` shape. New configs should use `rules` directly. (The scope `network`
has no rule equivalent and is dropped with its own warning; unrecognized scopes
are dropped with a warning.)

## `strictMcpConfig`

Optional boolean, default `false`. When enabled, a local MCP server is launched
only if its `command` passes the launcher allowlist; otherwise it is marked
failed (visible via `/mcp`) and never spawned. A hardening measure — MCP
servers run as untrusted child processes.

## `statusline`

Optional. Config-authored provider plugins whose output is appended to the
status line below the prompt input, refreshed on an interval. Deepcode-compatible
schema (heirloom extension).

```jsonc
{
  "statusline": {
    "enabled": true,        // default: true when providers[] is non-empty
    "refreshMs": 2000,      // default 2000; clamped to a minimum of 500
    "separator": " · ",     // default " · "
    "providers": [
      { "type": "command", "id": "git", "command": "git branch --show-current",
        "color": "cyan", "timeoutMs": 1500, "cwd": "." },
      { "type": "module", "id": "x", "path": "./.deepcode/plugins/x.mjs",
        "color": "yellow" }
    ]
  }
}
```

**Provider types**

- `command` — runs `command` through the shell on each refresh. The **first
  stdout line** becomes the segment text. `timeoutMs` (default `1500`) bounds
  each run; on timeout, non-zero exit, or empty output the segment is dropped.
  `cwd` (default the process cwd) is resolved relative to the process cwd.
- `module` — imports the local JS/MJS module at `path` (resolved relative to the
  process cwd) and calls its **default export** (may be async). Its return value
  is stringified into the segment. A non-callable export or a throwing module
  drops the segment.

**Shared fields**: `id` (required, string) and `color` (optional Ink color
string). Named colors `cyan`, `green`, `blue`, `magenta`, `white`, `gray` render
via ansi256; `red`/`yellow` use the theme's error/warning slots.

**Behavior & safety**

- `enabled` defaults to `true` when at least one provider is configured, `false`
  otherwise. Set it explicitly to force-disable.
- The refresh loop runs **outside** the React render; segments are pushed into
  the UI as they arrive. A provider that throws, times out, or blocks never
  crashes or stalls the render — it only yields an empty (dropped) segment.
- Provider output is **sanitized** before rendering: ANSI escapes and control
  characters are stripped, whitespace collapsed, and length capped (120 chars).
- Providers are user-config-authored (same trust boundary as `settings.json`).
  Only enable `command`/`module` providers you would run yourself.

## Providers and base URL

Provider selection is by **name** (`provider` field), resolving to a built-in
preset in `src/providers/presets.ts` (`deepseek`, `openai`, `openrouter`,
`groq`, `ollama`). Each preset carries its own `baseUrl` and `keyEnv`.

**Overriding the base URL.** Set `env.BASE_URL` in `settings.json` to point a
built-in provider at a proxy, gateway, or self-hosted endpoint. The value is
read at launch (`src/cli.tsx`, and `src/exec-runner.ts` for headless) and passed
to `createProvider` as `options.baseUrl`, which now applies it over the preset's
hardcoded `baseUrl` for **built-in presets** (`src/providers/presets.ts:149-160`)
— honored on both the TUI and exec paths. `env.API_KEY` is likewise honored for
built-in providers (`options.apiKey`, `src/providers/presets.ts:139`).

`setConfigProviders()` also exists in `presets.ts` to register additional
providers with a custom `baseUrl`/`apiKeyEnv`; it is not wired to a config key
today (the `providers` field is not recognized by the loader — it warns
`config: unknown field "providers"`), so `env.BASE_URL` on a built-in preset is
the supported way to override the endpoint.

Model references (`--model`, the `model` field) use `provider/model-id`, split on
the **first** slash only, so model IDs may themselves contain slashes
(`openrouter/anthropic/claude-sonnet-4` → provider `openrouter`, model
`anthropic/claude-sonnet-4`).

## Credentials

API keys are resolved by `createProvider` (`src/providers/presets.ts`) and the
launch key-presence gate (`src/cli.tsx`). For a built-in provider, the key is
taken from, in order:

1. `options.apiKey` — sourced from `env.API_KEY` in `settings.json` when set.
2. The provider's env var (`DEEPSEEK_API_KEY`, `OPENAI_API_KEY`,
   `OPENROUTER_API_KEY`, `GROQ_API_KEY`).
3. `~/.heirloom/credentials.yaml` via `getCredential(name)`.

The **canonical, recommended** store is `~/.heirloom/credentials.yaml` — a flat
`provider: key` YAML map at mode `0600`, written by `heirloom auth`
(`src/config/credentials.ts`).

```yaml
# ~/.heirloom/credentials.yaml  (managed by `heirloom auth`)
deepseek: sk-...
openrouter: sk-or-...
```

`env.API_KEY` inside `settings.json` **works** but is **discouraged**:
settings.json is meant to be shareable/committable, and a key there can leak
into version control. Prefer the credentials file or an env var. (Note the split
homes: config lives under `~/.heirloom`, credentials and sessions under
`~/.heirloom`.)

## Web Search

Heirloom ships the built-in `docs_search` tool for developer-documentation
sources. For **general** web search, add a search MCP server under `mcpServers`;
it is gated by the existing `mcp__*` permission rules. Heirloom ships and
endorses none.

```jsonc
{
  "mcpServers": {
    "websearch": { "command": "npx", "args": ["-y", "<search-mcp-server-of-your-choice>"] }
  }
}
```

## `enabledSkills`

Optional `{ "<skill-name>": boolean }` map. A skill whose name maps to `false`
is **not loaded or indexed** by the skill loader (`src/skills/index.ts`) — it
never appears in the skill index and cannot be invoked via `load_skill`. A skill
that is absent from the map, or mapped to `true`, is enabled — **absent means
enabled** (the default). Disabling one skill leaves all others unaffected.

## `compaction`

- `compaction.threshold` (number, default `0.7`) — the context-window fraction
  at which auto-compaction triggers.
- `compaction.auto` (boolean, default `true`) — gates **automatic** compaction.
  When `false`, the agent never auto-compacts mid-conversation regardless of
  `threshold`. Explicit compaction paths are unaffected: the manual `/compact`
  command and the resume-time compaction offer still summarize on demand.

## `workflow`

Heirloom extension controlling the git-status poller behind the status bar.

- `workflow.gitStatus` (boolean, default `true`) — enables the poller. When
  `false`, no git status is shown and no git commands are run on an interval.
- `workflow.gitPollInterval` (number ms, default `30000`) — poll interval. `0`
  (or negative) means **on-demand only**: the poller refreshes once at startup
  and then never again on a timer.

## No Telemetry

Heirloom collects **no telemetry** and phones home for nothing. This is a
deliberate guarantee, not a default that a config key can flip. There is no
telemetry subsystem in the codebase and no config key enables one — the former
`telemetryEnabled` key (and the `env.TELEMETRY_ENABLED` string) were never
consumed and have been removed; `telemetryEnabled` now warns as an unknown
field. If you set it, nothing happens because there is nothing to enable.

## Deprecated Keys

| Key | Status | Replacement |
|-----|--------|-------------|
| `webSearchTool` (script path) | Parsed but ignored; emits a warning | Add a search MCP server under `mcpServers` |
| `debugLogEnabled` (boolean) | Parsed but ignored; emits a warning | Use the `--debug` CLI flag |
| `workflow.gitCommands` (boolean) | Parsed but ignored; emits a warning | None — no git-command subsystem consumes it |
| `workflow.detectBuildTools` (boolean) | Parsed but ignored; emits a warning | None — no build-tool detection subsystem consumes it |
| `telemetryEnabled` (boolean) | **Removed** — now an unknown-field warning | None — Heirloom has no telemetry (see No Telemetry) |

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `HEIRLOOM_HOME` | Override the config home (default `~/.heirloom`); the loader reads `settings.json` from here |
| `DEEPSEEK_API_KEY` | DeepSeek API key |
| `OPENAI_API_KEY` | OpenAI API key |
| `OPENROUTER_API_KEY` | OpenRouter API key |
| `GROQ_API_KEY` | Groq API key |

> Note: `HEIRLOOM_HOME` is **not** honored by the config loader or the
> credentials/session stores (those use `~/.heirloom` unconditionally). It is
> read only by the mode loader (`src/modes/loader.ts`) for locating mode files.
