# Config Specification

**Status:** current · verified 2026-08-13 · covers `src/config/loader.ts`, `src/config/credentials.ts`, `src/ui/core/refresh-rates.ts`

## 1. Overview

Heirloom config is **JSON**, loaded and merged by `src/config/loader.ts`.
Two files are read and deep-merged (project wins over global):

- **Global:** `~/.heirloom/settings.json` (or `$HEIRLOOM_HOME/settings.json`)
- **Project:** `./.heirloom/settings.json` (in the current working directory)

There is no YAML config file. `config.yaml`, `~/.heirloom/config.yaml`, and a
`providers:` registry map are **not** read by the loader; the only YAML file
heirloom reads is the credentials store (see §8).

Every field is optional. Keys the loader recognizes (`KNOWN_KEYS` in
`src/config/loader.ts:205`); anything else emits a
`config: unknown field "<key>"` warning and is ignored. Config **errors**
are fatal — `main()` exits 1 (`src/cli.tsx`).

## 2. Schema

```jsonc
{
  // Default model. Top-level "model" wins over env.MODEL.
  "model": "deepseek-v4-pro",

  // Provider name. Selects a built-in preset: deepseek | openai | openrouter
  // | groq | ollama. When absent, inferred from env.BASE_URL / present env
  // keys, defaulting to "deepseek" (src/cli.tsx detectProvider).
  "provider": "deepseek",

  // Model/API env block. Maps onto the provider at launch.
  "env": {
    "MODEL": "deepseek-v4-pro",           // used only if top-level "model" unset
    "API_KEY": "sk-...",                  // works, but discouraged — see §8
    "BASE_URL": "https://api.deepseek.com",// override for the preset base URL
    "TEMPERATURE": "0.2",                 // string "0".."2"
    "THINKING_ENABLED": "true",
    "REASONING_EFFORT": "high"            // "high" | "max"
  },

  // Thinking / reasoning (top-level; higher priority than env.* strings)
  "thinkingEnabled": true,
  "reasoningEffort": "high",              // "high" | "max"
  "temperature": 0.2,                     // number, 0..2

  // Repaint cadence (heirloom extension): "fast" | "balanced" | "slow"
  "refresh": "balanced",

  // Permission rules (rule-based shape). See §3 and permission-spec.md.
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

  // When true, only allowlisted MCP server commands may be spawned
  // (default false). Allowlist: npx, node, python3, python, uvx, uv, bun,
  // deno, go, java (src/mcp/connector.ts).
  "strictMcpConfig": false,

  // Theme (heirloom extension)
  "theme": {
    "mode": "dark",                        // "dark" | "light" | "auto"
    "overrides": {}                        // optional token overrides
  },

  // Per-skill enable/disable. Absent = enabled (the default).
  "enabledSkills": { "some-skill": false },

  // Misc extensions
  "keybindings": { "overrides": {}, "disabled": [] },
  "compaction": { "auto": true, "threshold": 0.7 },  // auto gates automatic compaction (default true)
  "contextWindow": 128000,                 // fallback context window
  "workflow": { "gitStatus": true, "gitPollInterval": 30000 },
  "statusline": { "providers": [] },       // see §6
  "favoriteModels": ["deepseek/deepseek-v4-pro"],
  "recentModels": [{ "id": "openai/gpt-5.6-sol", "at": 1786602502208 }],
  "notify": "/path/to/notify-script"       // see notify-spec.md
}
```

## 3. Permissions

The **current** shape is `permissions.rules` (an array of
`{ tool, pattern, action }`) plus an optional `defaultMode`
(`"askAll"` | `"allowAll"`). The `pattern` string is interpreted by the
loader:

| Pattern form | Interpreted as |
|--------------|----------------|
| ends with `:*` | prefix match on the text before `:*` |
| contains `*` or `?` | glob |
| empty string `""` | matches any input |
| otherwise | exact match |

`action` must be one of `allow` / `ask` / `deny`. Full resolution semantics:
permission-spec.md.

### Legacy shape (migrated with a warning)

The **old** shape used top-level `allow` / `deny` / `ask` arrays of *scope*
strings (`scan`, `read-out-cwd`, `write-in-cwd`, `mcp`, …). The loader still
accepts it, but `migrateLegacyPermissions` (`src/config/loader.ts`)
translates it to `rules` in memory and emits:

```
permissions: migrated N legacy scope(s) to rule-based permissions —
review .heirloom/settings.json and re-approve as needed
```

That warning fires on **every launch** until the file is rewritten to the
`rules` shape. New configs should use `rules` directly. (The scope `network`
has no rule equivalent and is dropped with its own warning; unrecognized
scopes are dropped with a warning.) Migration never writes to disk.

## 4. `refresh` (repaint cadence)

`"fast" | "balanced" | "slow"` (default `balanced`). Controls TUI repaint
throttling (`src/ui/core/refresh-rates.ts`); invalid values warn and fall
back to the default rather than erroring. Precedence:
settings.json `refresh` > `HEIRLOOM_REFRESH` env > `balanced`.
Use `slow` on high-latency links.

## 5. `favoriteModels` / `recentModels`

- `favoriteModels` — array of `provider/model` IDs, pinned in the model
  dropdown.
- `recentModels` — array of `{ id, at }` entries (epoch ms), maintained by
  the model dropdown (`src/ui/components/ModelsDropdown/settings.ts`); the
  loader validates the shape and warns on malformed entries.

## 6. `statusline`

Config-authored provider plugins appended to the status line below the
prompt input, refreshed on an interval.

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
  stdout line** becomes the segment text. `timeoutMs` (default `1500`)
  bounds each run; on timeout, non-zero exit, or empty output the segment is
  dropped. `cwd` (default the process cwd) is resolved relative to the
  process cwd.
- `module` — imports the local JS/MJS module at `path` (resolved relative to
  the process cwd) and calls its **default export** (may be async). Its
  return value is stringified into the segment. A non-callable export or a
  throwing module drops the segment.

**Shared fields**: `id` (required, string) and `color` (optional Ink color
string). Named colors `cyan`, `green`, `blue`, `magenta`, `white`, `gray`
render via ansi256; `red`/`yellow` use the theme's error/warning slots.

**Behavior & safety**

- The refresh loop runs **outside** the React render; segments are pushed
  into the UI as they arrive. A provider that throws, times out, or blocks
  never crashes or stalls the render — it only yields an empty (dropped)
  segment.
- Provider output is **sanitized** before rendering: ANSI escapes and
  control characters are stripped, whitespace collapsed, and length capped
  (120 chars).
- Providers are user-config-authored (same trust boundary as
  `settings.json`). Only enable `command`/`module` providers you would run
  yourself.

## 7. Providers and base URL

Provider selection is by **name** (`provider` field), resolving to a
built-in preset in `src/providers/presets.ts` (`deepseek`, `openai`,
`openrouter`, `groq`, `ollama`). Each preset carries its own `baseUrl` and
`keyEnv`; catalog details: provider-spec.md.

**Overriding the base URL.** Set `env.BASE_URL` in `settings.json` to point
a built-in provider at a proxy, gateway, or self-hosted endpoint. The value
is read at launch (`src/cli.tsx`, and `src/exec-runner.ts` for headless) and
passed to `createProvider` as `options.baseUrl`, which applies it over the
preset's hardcoded `baseUrl` for **built-in presets**
(`src/providers/presets.ts`) — honored on both the TUI and exec paths.
`env.API_KEY` is likewise honored for built-in providers
(`options.apiKey`).

`setConfigProviders()` also exists in `presets.ts` to register additional
providers with a custom `baseUrl`/`apiKeyEnv`; it is not wired to a config
key today (a `providers` field is not recognized by the loader — it warns
`config: unknown field "providers"`), so `env.BASE_URL` on a built-in preset
is the supported way to override the endpoint.

Model references (`--model`, the `model` field) use `provider/model-id`,
split on the **first** slash only, so model IDs may themselves contain
slashes (`openrouter/anthropic/claude-sonnet-4.6` → provider `openrouter`,
model `anthropic/claude-sonnet-4.6`).

## 8. Credentials

API keys are resolved by `createProvider` (`src/providers/presets.ts`), in
order:

1. `options.apiKey` — sourced from `env.API_KEY` in `settings.json` when
   set.
2. The provider's env var (`DEEPSEEK_API_KEY`, `OPENAI_API_KEY`,
   `OPENROUTER_API_KEY`, `GROQ_API_KEY`).
3. `~/.heirloom/credentials.yaml` via `getCredential(name)`.

The **canonical, recommended** store is `~/.heirloom/credentials.yaml` — a
flat `provider: key` YAML map at mode `0600` (auto-chmoded if looser,
`src/config/credentials.ts`), written by `heirloom auth`:

```yaml
# ~/.heirloom/credentials.yaml  (managed by `heirloom auth`)
deepseek: sk-...
openrouter: sk-or-...
```

`env.API_KEY` inside `settings.json` **works** but is **discouraged**:
settings.json is meant to be shareable/committable, and a key there can leak
into version control. Prefer the credentials file or an env var.

## 9. Web search

Heirloom ships the built-in `web_search` tool — keyless, Bing-backed,
guarded-tier (always asks; see web-search-spec.md). For search via an
external provider, add a search MCP server under `mcpServers`; it is gated
by the existing `mcp__*` permission rules. Heirloom ships and endorses
none:

```jsonc
{
  "mcpServers": {
    "websearch": { "command": "npx", "args": ["-y", "<search-mcp-server-of-your-choice>"] }
  }
}
```

## 10. `enabledSkills`

Optional `{ "<skill-name>": boolean }` map. A skill whose name maps to
`false` is **not loaded or indexed** by the skill loader
(`src/skills/index.ts`) — it never appears in the skill index and cannot be
invoked via `load_skill`. **Absent means enabled** (the default). Disabling
one skill leaves all others unaffected.

## 11. `compaction`

- `compaction.threshold` (number, default `0.7`) — the context-window
  fraction at which auto-compaction triggers.
- `compaction.auto` (boolean, default `true`) — gates **automatic**
  compaction. When `false`, the agent never auto-compacts mid-conversation
  regardless of `threshold`. Explicit compaction paths are unaffected: the
  manual `/compact` command and the resume-time compaction offer still
  summarize on demand.

## 12. `workflow`

Controls the git-status poller behind the status bar.

- `workflow.gitStatus` (boolean, default `true`) — enables the poller. When
  `false`, no git status is shown and no git commands are run on an
  interval.
- `workflow.gitPollInterval` (number ms, default `30000`) — poll interval.
  `0` (or negative) means **on-demand only**: the poller refreshes once at
  startup and then never again on a timer.

## 13. No telemetry

Heirloom collects **no telemetry** and phones home for nothing. This is a
deliberate guarantee, not a default that a config key can flip. There is no
telemetry subsystem in the codebase and no config key enables one — the
former `telemetryEnabled` key (and the `env.TELEMETRY_ENABLED` string) were
never consumed and have been removed; `telemetryEnabled` now warns as an
unknown field. If you set it, nothing happens because there is nothing to
enable.

## 14. Deprecated keys

| Key | Status | Replacement |
|-----|--------|-------------|
| `webSearchTool` (script path) | Parsed but ignored; emits a warning | Use the built-in `web_search` tool, or a search MCP server under `mcpServers` |
| `debugLogEnabled` (boolean) | Parsed but ignored; emits a warning | Use the `--debug` CLI flag |
| `workflow.gitCommands` (boolean) | Parsed but ignored; emits a warning | None — no git-command subsystem consumes it |
| `workflow.detectBuildTools` (boolean) | Parsed but ignored; emits a warning | None — no build-tool detection subsystem consumes it |
| `telemetryEnabled` (boolean) | **Removed** — now an unknown-field warning | None — Heirloom has no telemetry (see §13) |

## 15. Environment variables

| Variable | Purpose |
|----------|---------|
| `HEIRLOOM_HOME` | Override the config home (default `~/.heirloom`) — **partially honored**, see below |
| `HEIRLOOM_REFRESH` | Repaint cadence: `fast \| balanced \| slow` (lower priority than settings.json `refresh`) |
| `HEIRLOOM_PROFILE` | `"1"` enables the event-loop stall watchdog (troubleshooting.md) |
| `HEIRLOOM_HIGH_CONTRAST` | `"1"` enables high-contrast rendering |
| `NO_COLOR`, `CI`, `TERM`, `COLORTERM` | Color/terminal capability gating |
| `DEEPSEEK_API_KEY` | DeepSeek API key |
| `OPENAI_API_KEY` | OpenAI API key |
| `OPENROUTER_API_KEY` | OpenRouter API key |
| `GROQ_API_KEY` | Groq API key |
| `ANTHROPIC_API_KEY`, `TOGETHER_API_KEY` | Detected for provider inference; no bundled presets |

### HEIRLOOM_HOME support

`resolveHome()` (`src/config/loader.ts`) is the single source of truth:
`HEIRLOOM_HOME` if set, else `~/.heirloom`. Every subsystem routes through
it — config, modes, theme dropdown, prompt history, stall watchdog,
credentials, sessions, checkpoints, and memory. A full install under a
custom home is portable: `HEIRLOOM_HOME=/tmp/hh heirloom` keeps everything
(config, credentials, sessions, checkpoints, memory) under `/tmp/hh`.
