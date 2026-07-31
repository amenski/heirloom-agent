# CLI Specification

How heirloom is invoked and what the user can type. This documents the command
surface that actually ships, verified against `src/cli-args.ts` (flags,
validation, epilog), `src/cli.tsx` (subcommand dispatch, slash routing), and
`src/ui/core/slash-commands.ts` + `src/ui/App.tsx` (the TUI command registry and
handlers).

---

## Invocation

```
heirloom [flags]                        # interactive TUI (the normal case)
heirloom -p "<prompt>" [flags]          # launch the TUI and submit one prompt
heirloom -x -p "<prompt>" [flags]       # headless: run one task, print, exit
heirloom auth                           # interactive provider setup wizard
heirloom auth list                      # show configured providers + key sources
heirloom auth logout <provider>         # remove a credential
heirloom auth <provider>                # set <provider>'s key (masked prompt)
heirloom auth <provider> --api-key <key># non-interactive; -k alias
echo <key> | heirloom auth <provider>   # piped: key read from stdin
heirloom doctor                         # print environment / config diagnostics
```

`doctor` and `auth` are the only real subcommands — they are special-cased in
`src/cli.tsx` (`main()`, lines 45 and 50) *before* argument parsing. Everything
else on the command line is parsed by yargs as flags plus an optional positional
`query`. A non-flag word that is not `auth`/`doctor` (e.g. `heirloom frobnicate`)
is therefore treated as a positional prompt, not rejected as an unknown command.

`auth` is the guided path for connecting LLM APIs: pass a preset provider name
(`deepseek`, `openai`, `openrouter`, `groq`, `ollama`) and enter the key, and it
writes `~/.heirloom/credentials.yaml` (mode `0600`). See config-spec.md for the
credential store and precedence.

**The API key belongs in `~/.heirloom/credentials.yaml` (0600) or an env var.**
A key may also be placed at `env.API_KEY` inside `settings.json` (it is read and
works — `src/cli.tsx:87,112`), but that is discouraged: settings.json is meant to
be shareable/committable. See config-spec.md §Credentials.

### Key entry

- **Masked interactive input.** On a TTY the key prompt reads in raw mode and
  echoes `*` per character — the key is never shown in plaintext. Enter submits,
  Ctrl+C cancels (nothing is written).
- **Non-interactive `--api-key` (alias `-k`).** `heirloom auth <provider>
  --api-key <key>` writes the credential with no prompt — for scripts and CI.
- **Piped stdin.** When stdin is not a TTY, `heirloom auth <provider>` reads one
  line from stdin as the key (`echo <key> | heirloom auth <provider>`).

After a successful save, the credentials file path and a `Run \`heirloom\` to
start.` hint are printed.

### Running it

- Dev: `npm start -- <args>` runs the CLI through `tsx`.
- Built binary: `npm run build && npm link` puts `heirloom` on `PATH`, after
  which the examples above work verbatim (`heirloom` in place of `npm start --`).

## Flags

Real flag surface (`src/cli-args.ts`; `--help`/`-h` and `--version`/`-v` are
added by yargs):

| Flag | Effect |
|------|--------|
| `-p`, `--prompt <text>` | Submit a prompt on launch. With `-x`, the headless prompt; without, prefills the first TUI turn. |
| `-x`, `--exec` | Run one prompt non-interactively, then exit. **Requires** a non-empty `--prompt`. |
| `-r`, `--resume [id]` | Resume a specific session by its ID. Use with no ID (`-r`) to open the session picker. |
| `-l`, `--last` | Resume the most recent session for the current project directory. |
| `--model <provider/model>` | Override the configured model (split on the first `/`). |
| `--mode <slug>` | Start in the given mode. On the headless (`-x`) path an unknown slug is validated and rejected with a clean error (`src/exec-runner.ts`). On the interactive path an unknown slug is not rejected — it silently falls back to the default `code` mode. |
| `--debug` | Write redacted request/response JSONL. |
| `-h`, `--help` | Show help and the epilog, exit 0. |
| `-v`, `--version` | Print version (`1.0.0`), exit 0. |

There is **no** `-c`/`--continue`, `--session`, `--print`, or `--approve` flag.
A positional `query` (a bare prompt with no `-p`) is also accepted.

### Flag validation (`.check()` in `src/cli-args.ts`)

- `-p` together with a positional prompt → error (use one or the other).
- `-x` without a non-empty `-p` → error.
- `-p ""` (empty/whitespace) → error.
- `-r <id>` with `-p` → error (resume-with-picker is interactive).
- `-l` together with `-r` → error.
- `-r <id>` where `<id>` fails the session-ID check → `Invalid session ID`.

**Session-ID format.** `-r <id>` accepts the IDs the session store actually
generates. `generateId()` (`src/sessions/store.ts:95`) takes `toISOString()`,
strips `:` and `.`, slices to 15 chars, and appends `-<4hex>` — so the real
shape is `YYYY-MM-DDThhmm-<4hex>`, e.g. `2026-07-30T2358-15a3`. The `-r`
validator (`isValidSessionId`, `src/cli-args.ts:11`) matches exactly this
pattern (`/^\d{4}-\d{2}-\d{2}T\d{4}-[0-9a-f]{4}$/`), and session files are stored
as `<id>.jsonl`, so the filename *is* the ID. Resume-by-ID works. (Legacy UUID
IDs are intentionally not accepted — the app has never generated them.)

## Headless Mode (`-x -p`)

Runs one task non-interactively: streams output to stdout, exits when the agent
completes. `-x` requires `-p`. Errors go to stderr so stdout stays pipeable.

- **Permissions fail closed.** There is no user to ask, so any tool call that
  resolves to `ask` is denied (permission-spec.md). Headless runs need explicit
  `allow` rules.
- If no provider key is resolvable, the run fails (see Exit Codes).
- **Clean error output.** Failures (missing key, unknown provider, unknown
  `--mode`, provider API errors) print a single concise `Error: <message>` line
  to stderr — a provider API error is reduced to its status code and message,
  not the full error object. The complete error (stack, request body, headers)
  is emitted only when `--debug` is passed (`src/exec-runner.ts`).

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Clean exit / headless task completed / `--help`/`--version` / `auth`/`doctor` success |
| 1 | Fatal error (bad config, provider failure, flag validation failure, non-TTY launch of the interactive UI) |

---

## Slash Commands

Typed at the prompt inside the TUI. The registry lives in
`src/ui/core/slash-commands.ts` (`BUILTIN_SLASH_COMMANDS` — what the `/`
autocomplete menu offers); routing is split between `src/ui/App.tsx`
(`handleSlashCommand`) and `src/cli.tsx` (`handleSlashCore`).

### Registered and routed (appear in the `/` menu and work)

| Command | Behavior | Handler |
|---------|----------|---------|
| `/help` | Show help / command list | `handleSlashCore` (typed) / HelpOverlay (palette) |
| `/exit` | Quit (also Ctrl+D twice) | App `handleExit` |
| `/clear` | Clear conversation history | `handleSlashCore` |
| `/model` | Open the model / thinking / effort selector | App (dropdown) |
| `/theme` | Switch color theme with live preview | App (dropdown) |
| `/new` | Start a fresh conversation: drops the model-visible history and wipes the scrollback (`/clear` plus a transcript clear), prints `[started a fresh conversation]` | App |
| `/resume` | Pick a previous session to continue | App (session list) |
| `/continue` | Continue the active session (or pick one if empty) | App (session list) |
| `/undo` | Restore code and/or conversation to a previous point | App (undo selector) |
| `/mcp` | Show MCP server status and available tools | App (MCP status) |
| `/permissions` | Show this session's permission-decision history | App (history view) |
| `/plan` | Toggle the plan posture on/off — the same posture Shift+Tab cycles to; prints `[plan mode on]` / `[plan mode off]` | App |
| `/raw` | Cycle display mode (`lite` → `normal` → `raw-scrollback`) | App (raw-mode cycle) |
| `/skills` | List available skills | `handleSlashCore` |

### Routed but not in the autocomplete registry

These work when typed but do not appear in the `/` menu: `/sessions` (an alias
for the session list, handled in App alongside `/resume` and `/continue`), and,
handled in `handleSlashCore`, `/mode <slug>`, `/modes`, `/skill <name>`,
`/cost`, `/effort`.

Unknown `/command` → `Unknown: <cmd>\nType /help.`, never sent to the LLM. Input
not starting with `/` is always a user message.

The in-app help screen (`src/ui/HelpOverlay.tsx`) lists the commands above,
including `/permissions` and `/raw`. It no longer advertises `/checkpoint`,
`/checkpoints`, `/restore`, or `/compact` — those were removed from the help and
command palette.

---

## Interrupt Semantics & Keybindings

From the epilog in `src/cli-args.ts` and the TUI input handlers.

| Key | When | Effect |
|-----|------|--------|
| Enter | Composing a prompt | Send the prompt |
| Shift+Enter | Composing | Insert a newline |
| Esc | Agent streaming or running tools | Interrupt the current model turn; the partial turn is not persisted |
| Shift+Tab | Idle prompt | Toggle the approval posture (askAll ↔ allowAll) |
| Home / End | Composing | Move within the current line |
| Alt+Left / Alt+Right | Composing | Move by word |
| Ctrl+W | Composing | Delete the previous word |
| `/` | Idle prompt | Open the commands menu |
| Ctrl+D (twice) | Idle prompt | Quit |

---

## Output Conventions

- Assistant text streams to stdout.
- Errors and warnings go to **stderr**, so `-x` stdout stays pipeable.
- The interactive UI is an Ink TUI and requires a TTY; launching the interactive
  path without a TTY prints `heirloom requires an interactive terminal (TTY)...`
  and exits 1. (`-x` headless mode does not need a TTY.)
