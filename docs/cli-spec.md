# CLI Specification

How heirloom is invoked and what the user can type. This consolidates the
command surface that grew across architecture.md (Layer 7), session-spec.md,
and skill-spec.md — this doc is now the authority; the others defer to it.

---

## Invocation

```
heirloom [flags]               # interactive session (the normal case)
heirloom -p "<prompt>" [flags] # headless: run one task, print, exit
heirloom auth                       # interactive provider setup wizard
heirloom auth list                  # show configured providers + key sources
heirloom auth logout <name>         # remove a credential
heirloom auth <provider>            # set <provider>'s key (masked prompt)
heirloom auth <provider> --api-key <key>   # non-interactive; -k alias
echo <key> | heirloom auth <provider>      # piped: key read from stdin
```

`auth` is the guided path for connecting LLM APIs (opencode's `auth login`
pattern): choose a preset (DeepSeek, OpenRouter, Groq, Together, Ollama,
OpenAI, Anthropic) or "custom" (asks for a baseUrl), enter the key, and it
writes `~/.heirloom/credentials.yaml` (0600) plus, for custom endpoints, the
provider entry in config. Manual YAML editing (config-spec.md) remains the
escape hatch. Arrives Phase 3 with the config layer.

**The API key goes only to `~/.heirloom/credentials.yaml` (0600) — never into
any `settings.json`.** Keys are not config (repo ethos).

### Key entry

- **Masked interactive input.** On a TTY the key prompt reads in raw mode and
  echoes `*` per character — the key is never shown in plaintext. Backspace
  (and Ctrl+H) erase one character, Ctrl+U clears the line, Enter submits, and
  Ctrl+C cancels (nothing is written).
- **Non-interactive `--api-key` (alias `-k`).** `heirloom auth <provider>
  --api-key <key>` writes the credential with no prompt — for scripts and CI.
- **Piped stdin.** When stdin is not a TTY, `heirloom auth <provider>` reads
  one line from stdin as the key (`echo <key> | heirloom auth <provider>`),
  with no prompt echoed.

After a successful save, the credentials file path and a `Run \`heirloom\` to
start.` hint are printed. `auth` (wizard), `auth list`, and `auth logout`
behave as before.

- Today (Phase 1): `npm start` runs `tsx src/index.ts`.
- Target: a `bin` entry in package.json (`"heirloom": "dist/index.js"`) so
  `npm link` / global install provides the `heirloom` command. Add when the
  engine stabilizes — not before Phase 3.

## Flags

| Flag | Effect | Arrives |
|------|--------|---------|
| `-c`, `--continue` | Resume the most recent session for this cwd | with sessions |
| `--session <id>` | Resume a specific session | with sessions |
| `--mode <slug>` | Start in the given mode | Phase 3 |
| `--model <provider/model>` | Override config/mode model | Phase 3 |
| `-p`, `--print <prompt>` | Headless mode (below) | with golden-task harness |
| `--approve <edits\|all>` | Set approval mode (permission-spec.md); mainly for headless runs | Phase 3 |
| `--help`, `--version` | The obvious | Phase 2 |

Flags sit at the top of the config precedence chain (config-spec.md).

## Headless Mode (`-p`)

Runs one task non-interactively: streams output to stdout, exits when the
agent completes or hits `maxTurns`. Exists primarily so golden tasks
(conventions.md) can be scripted.

- **Permissions fail closed.** There is no user to ask, so any tool call
  that resolves to `ask` is **denied** with `PERMISSION_DENIED: headless
  session — rule resolved to ask`. Headless runs need explicit `allow` rules
  or `--approve <edits|all>` (deny rules still hold — permission-spec.md).
- `ask_followup_question` in headless → the question is printed and the run
  ends with exit code 2. An agent that needs to ask cannot finish headless.
- No session file is written unless `--session`/`-c` is also passed.

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Clean exit / headless task completed |
| 1 | Fatal error (provider failure after retries, bad config) |
| 2 | Headless task could not complete (needed user input, hit maxTurns) |

---

## Slash Commands

Typed at the prompt. Consolidated reference — phase column says when each
lands (matching todo.md):

| Command | Behavior | Phase |
|---------|----------|-------|
| `/help` | List commands | 1 |
| `/exit` | Quit (also Ctrl+D) | 1 |
| `/clear` | Clear conversation, keep session file | 1 |
| `/mode <slug>` | Switch mode; prompt shows `heirloom [code] >` | 3 |
| `/approve [manual\|edits\|all]` | Show or set approval mode; lists session rules (permission-spec.md) | 3 |
| `/compact` | Force compaction now | 4 |
| `/checkpoint` | Manual checkpoint | 5 |
| `/restore [files\|full]` | Restore last checkpoint | 5 |
| `/checkpoints` | List checkpoints | 5 |
| `/sessions` | List this project's sessions | with sessions |
| `/new` | Save current session, start fresh | with sessions |
| `/skills` | List available skills + source paths | 9 |
| `/skill <name>` | Force-load a skill | 9 |

Unknown `/command` → error + `/help` hint, never sent to the LLM. Input not
starting with `/` is always a user message — no ambiguity.

---

## Interrupt Semantics & Keybindings

Esc requires keypress events (`readline.emitKeypressEvents` + raw mode).
Raw keypress listening is enabled **only while the agent is running** — no
readline question is active then, so there's no conflict — and terminal
state is restored in a `finally`; a crash must never leave the terminal in
raw mode.

| Key | When | Effect |
|-----|------|--------|
| Esc | Agent is streaming or running tools | Abort the turn: fire `AbortSignal` → provider stream closes, running tool gets `signal`, partial turn is **not** persisted (session-spec: writes happen only on turn completion). Prompt returns. |
| Ctrl+C | Agent running | Same as Esc (fallback abort) |
| Ctrl+C | At an idle prompt | Print `(use /exit or Ctrl+D to quit)` — never exit on a single Ctrl+C |
| Ctrl+D | At an idle prompt | Exit cleanly (= `/exit`) |
| Shift+Tab | At an idle prompt | Cycle approval mode `manual → edits → all → manual` (permission-spec.md); prompt indicator updates immediately |

The abort path is why `ToolContext.signal` exists (tool-spec.md): an aborted
tool returns `COMMAND_FAILED: aborted by user` and the loop stops without
feeding results back to the LLM.

### Configurable bindings

Defaults above; rebindable via `keybindings:` in config (config-spec.md).
Actions: `abort`, `cycle-approval`, `cycle-mode` (cycles personas —
**unbound by default**: blind persona cycling swaps the toolset, which
should usually be deliberate; `/mode <slug>` is the primary path).
Reserved and rejected at config validation: `ctrl+c`, `ctrl+d`, `enter`,
and `ctrl+m` (indistinguishable from Enter in terminals).

---

## Output Conventions

- Assistant text streams token-by-token to stdout, verbatim.
- Tool calls render as one dim line each: `  [read_file] {"path":"src/agent.ts"}`
  (args truncated at 120 chars — already the Phase 1 behavior).
- Errors and warnings go to **stderr**, so `-p` output stays pipeable.
- No markdown rendering in the readline CLI; that's an Ink-TUI feature
  (architecture.md tradeoff 5).

## Layer Discipline

Everything in this doc is Layer 7. The agent loop must stay I/O-free
(architecture.md tradeoff 6): streaming display, tool-call rendering, and
interrupt handling reach the loop only as injected callbacks/signals, so a
future TUI or server frontend replaces this file's implementation without
touching `agent.ts`.
