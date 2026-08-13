# CLI Specification

**Status:** current · verified 2026-08-13 · covers `src/cli-args.ts`, `src/cli.tsx`, `src/exec-runner.ts`, `src/ui/core/slash-commands.ts`, `src/ui/App.tsx`, `src/ui/keybindings.ts`, `src/ui/HelpOverlay.tsx`

## 1. Invocation

```
heirloom [flags]                        # interactive TUI (the normal case)
heirloom -p "<prompt>" [flags]          # headless: run one task, print, exit
heirloom auth                           # interactive provider setup wizard
heirloom auth list                      # show configured providers + key sources
heirloom auth logout <provider>         # remove a credential
heirloom auth <provider>                # set <provider>'s key (masked prompt)
heirloom auth <provider> --api-key <key># non-interactive; -k alias
echo <key> | heirloom auth <provider>   # piped: key read from stdin
heirloom doctor                         # print environment / config diagnostics
```

`doctor` and `auth` are the only real subcommands — special-cased in
`src/cli.tsx` `main()` before argument parsing. Everything else is parsed by
yargs (`src/cli-args.ts`) as flags plus an optional positional `prompt`; a
non-flag word that is not `auth`/`doctor` is treated as a positional prompt,
not rejected as an unknown command.

### Key entry

- **Masked interactive input.** On a TTY the key prompt reads in raw mode and
  echoes `*` per character — the key is never shown in plaintext. Enter
  submits, Ctrl+C cancels (nothing is written).
- **Non-interactive `--api-key` (alias `-k`)** — for scripts and CI.
- **Piped stdin** — when stdin is not a TTY, `heirloom auth <provider>`
  reads one line from stdin as the key.

The API key belongs in `~/.heirloom/credentials.yaml` (0600) or an env var.
`env.API_KEY` in settings.json works but is discouraged (settings.json is
meant to be shareable). See config-spec.md §Credentials.

### Running it

- Dev: `npm start -- <args>` runs the CLI through `tsx`.
- Built binary: `npm run build && npm link` puts `heirloom` on `PATH`.

## 2. Flags

| Flag | Effect |
|------|--------|
| `[prompt]` | Positional prompt. With `-p`, the headless prompt; without, prefills the first TUI turn. |
| `-p`, `--print` | Print the response and exit, non-interactively. **Requires** a non-empty positional prompt. |
| `-r`, `--resume [id]` | Resume a specific session by its ID; with no ID, open the session picker. |
| `-c`, `--continue` | Continue the most recent session for the current project directory. |
| `--model <provider/model>` | Override the configured model (split on the first `/`). |
| `--mode <slug>` | Start in the given mode. Headless (`-p`): unknown slug rejected with a clean error (`src/exec-runner.ts`). Interactive: unknown slug silently falls back to the default `code` mode. |
| `-d`, `--debug` | Write redacted request/response JSONL. |
| `-h`, `--help` | Show help and the epilog, exit 0. |
| `-v`, `--version` | Print the current version (from `package.json` via `src/version.ts`), exit 0. |

There is **no** `--session` or `--approve` flag.

### Flag validation (`.check()` in `src/cli-args.ts`)

- `-p` without a non-empty positional prompt → error.
- `-c` together with `-r` → error.
- `-r <id>` failing the session-ID check → `Invalid session ID`.

**Session-ID format.** `generateId()` (`src/sessions/store.ts`) takes
`toISOString()`, strips `:` and `.`, slices to 15 chars, and appends
`-<4hex>` — the real shape is `YYYY-MM-DDThhmm-<4hex>`, e.g.
`2026-07-30T2358-15a3`. `-r` validates against exactly this pattern
(`/^\d{4}-\d{2}-\d{2}T\d{4}-[0-9a-f]{4}$/`), and session files are stored as
`<id>.jsonl`, so the filename *is* the ID. Legacy UUID IDs are intentionally
not accepted.

## 3. Headless mode (`-p`)

Runs one task non-interactively: streams output to stdout, exits when the
agent completes. Errors go to stderr so stdout stays pipeable.

- **Permissions fail closed.** There is no user to ask, so any tool call that
  resolves to `ask` is denied (permission-spec.md §Headless Interaction).
  Headless runs need explicit `allow` rules.
- If no provider key is resolvable, the run fails (see Exit Codes).
- **Clean error output.** Failures (missing key, unknown provider, unknown
  `--mode`, provider API errors) print a single concise `Error: <message>`
  line to stderr — a provider API error is reduced to its status code and
  message, not the full error object. The complete error (stack, request
  body, headers) is emitted only with `--debug` (`src/exec-runner.ts`).
- The notify hook fires from this completion boundary
  (`src/exec-runner.ts`, notify-spec.md).

## 4. Exit codes

| Code | Meaning |
|------|---------|
| 0 | Clean exit / headless task completed (`stopReason: "done"`) / `--help`/`--version` / `auth`/`doctor` success |
| 1 | Fatal error (bad config, provider failure, flag validation failure, non-TTY launch of the interactive UI, headless stop other than "done") |
| 130 | Headless run interrupted by SIGINT |

## 5. Slash commands

Typed at the prompt inside the TUI. Three surfaces:

1. **Autocomplete menu** — `BUILTIN_SLASH_COMMANDS`
   (`src/ui/core/slash-commands.ts`): `/skills`, `/model`, `/mode`,
   `/effort`, `/theme`, `/new`, `/resume`, `/continue`, `/undo`, `/mcp`,
   `/permissions`, `/plan`, `/raw`, `/clear`, `/compact`, `/doctor`,
   `/help`, `/exit`.
2. **Text dispatcher** — `handleSlashCore` (`src/cli.tsx:926`): `/help`,
   `/cost`, `/context`, `/doctor`, `/skills`, `/skill <name>`, `/clear`,
   `/compact`, `/modes`, `/mode [slug]`, `/model [provider/model]`,
   `/effort [value]`.
3. **TUI handlers** (`src/ui/App.tsx` `handleSlashCommand`): `/theme`,
   `/new`, `/resume`, `/continue`, `/sessions` (alias for the session
   list), `/undo`, `/mcp`, `/permissions`, `/plan`, `/raw`, `/exit`.

**Routed but not in the autocomplete menu:** `/cost`, `/context`, `/modes`,
`/skill <name>`, `/sessions`.

The in-app help screen (`src/ui/HelpOverlay.tsx`) lists the commands above
(including `/sessions`, `/skill`, `/cost`); it no longer advertises
`/checkpoint`, `/checkpoints`, or `/restore` — those were removed.

Unknown `/command` → `Unknown: <cmd>\nType /help.`, never sent to the LLM.
Input not starting with `/` is always a user message.

## 6. Posture & display toggles

| Key/command | Effect |
|-------------|--------|
| Shift+Tab | Cycle approval posture: `normal → autoApprove → plan` (`src/ui/App.tsx` `cyclePosture`) |
| `/plan` | Toggle plan mode directly (the same posture Shift+Tab cycles to) |
| `/raw` | Cycle display mode: `lite → normal → raw-scrollback` |
| Ctrl+E | Stream an AI explanation of a pending permission prompt |

Posture semantics (permission-spec.md): `normal` asks per policy;
`autoApprove` bypasses ordinary rule-derived asks but **never**
unresolved/guarded tiers; `plan` is read-only and requires a
`<proposed_plan>` block before implementing.

## 7. Keybindings

`DEFAULT_BINDINGS` (`src/ui/keybindings.ts:90`); user overrides via
settings.json `keybindings: { overrides, disabled }` with combos like
`ctrl+shift+t` (modifiers: `ctrl+`, `meta+/cmd+`, `shift+`, `alt+/option+`).

| Action | Default keys |
|--------|--------------|
| Cursor move | ← → ; Home / End |
| Cursor by word | Ctrl+←/→ (also Alt+←/→) |
| Delete char | Backspace / Delete |
| Delete word | Ctrl+Backspace / Ctrl+Delete |
| Clear line | Ctrl+U |
| History | ↑ / ↓ (also Ctrl+P / Ctrl+N); Ctrl+R search |
| Complete | Tab; Shift+Tab partial |
| Submit | Enter |
| Abort (interrupt turn) | Esc |
| Open mode picker | Ctrl+O |
| Cancel | Ctrl+C |
| Quit | `/exit`, Ctrl+D twice |

Note: `Ctrl+M` can never be a binding in a terminal (0x0D is the Enter
byte), and Ctrl+Shift+P arrives as 0x10 (shift is not encoded) — both are
documented in `src/ui/keybindings.ts`; user-supplied keybindings can bind
those actions to chords that do encode.

## 8. Output conventions

- Assistant text streams to stdout (interactive) or stdout-only final reply
  (headless).
- Errors and warnings go to **stderr**, so `-p` stdout stays pipeable.
- The interactive UI is an Ink TUI and requires a TTY; launching the
  interactive path without a TTY prints `heirloom requires an interactive
  terminal (TTY)...` and exits 1. (`-p` headless mode does not need a TTY.)
