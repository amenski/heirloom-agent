# Claude Code Parity — Gap Analysis & Roadmap

Status (**2026-08-10**): research-backed comparison of Heirloom's surface against
Claude Code's current CLI, from the official docs (`docs.anthropic.com/en/docs/
claude-code/cli-reference` + `/headless`, fetched 2026-08-10; the hooks page
redirects to `code.claude.com/docs/en/hooks`). Every "Heirloom today" cell was
verified against the code in this tree, not memory. This doc **is not a
commitment to build everything** — each item carries a recommendation, and items
get promoted to `todo.md` / a spec only when picked up.

> **What this is.** The existing [improvement-roadmap.md](./improvement-roadmap.md)
> tracks ideas borrowed from *deepcode-cli PRs*. This doc is the same exercise
> against *Claude Code* — the reference implementation most users will compare
> Heirloom against. Overlap with the existing roadmap is called out where it
> exists (lifecycle hooks, background command output, orchestrator).

---

## TL;DR — the parity list, ranked

| # | Feature | Claude Code surface | Heirloom today | Effort | Why |
|---|---|---|---|---|---|
| 1 | **`--output-format json \| stream-json`** (+ `--verbose`, `--include-partial-messages`) | `claude -p "query" --output-format stream-json` | `-p` prints plain text only; `exec-runner.ts` wires **no** agent callbacks | S–M | The automation unlock. CI, scripts, dashboards can't consume Heirloom today. |
| 2 | **Lifecycle hooks** | `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `SessionStart/End`, `PreCompact`, `Notification`, `Stop`, `SubagentStop`; Setup `init`/`maintenance` matchers | `notify.ts` is a single completion-boundary shell hook | M | Most leverage per line; already flagged in improvement-roadmap (PR #263 hooks). Build on `notify.ts`. |
| 3 | **Custom slash commands from files** | `.claude/commands/*.md` (frontmatter: description, argument-hint, allowed-tools, model) | Builtin registry only (`src/ui/core/slash-commands.ts`); `ModeLoader`/`SkillLoader` already do file loading | S | Cheap, reuses existing loader patterns. |
| 4 | **Flag parity batch** | `--max-turns`, `--system-prompt-file`, `--append-system-prompt`, `--allowedTools`/`--disallowedTools`, `--permission-mode`, `--name`/`/rename`, `--fork-session`, `--bare`, `--settings` | `maxTurns` exists in `agent.ts` (default 100) but no flag; permissions via config+posture only; sessions have a renamable `title` but no flag/command | S each | Small, individually shippable. |
| 5 | **Subagents** (`--agents`, `new_task`) | `claude --agents '{"reviewer":{...}}'`; subagent frontmatter (name, description, tools, model) | `new_task` **wired 2026-08-11** — mounts in the TUI + headless registries, delegates to any mode's `runAgent` turn, inherits the parent's permission engine; no `--agents` config or custom frontmatter yet | M–L | Half built; remaining lift is `--agents`-style definitions (per-mode tool/model overrides) + the permission-inheritance design doc. |
| 6 | **Git worktrees** (`-w`) | `claude -w feature-auth` → isolated worktree at `<repo>/.claude/worktrees/<name>`; `#<n>`/PR URL support | No worktree support; `workflow.gitCommands` is deprecated/ignored (`loader.ts:789`) | L | Greenfield; separate workstream. |
| 7 | **Background bash at exit** | `claude -p` terminates background Bash ~5s after result, kills the process tree | Long `run_bash` calls tie up the turn (already on improvement-roadmap as "background/streaming command output") | M | Reuses the existing roadmap item; different framing (exit semantics + tree kill). |

Ranking note: **1 and 2 are the pair to build first** — 1 is pure surface on the
existing agent loop, 2 is the natural generalization of `notify.ts`. Both are
prerequisites for anything that wants to observe Heirloom from outside.

---

## 1. `--output-format json | stream-json` — *recommended first*

**Claude Code behavior (from `/headless` + `/cli-reference`):**

- `text` (default): plain text. `json`: one JSON object with `result`,
  `session_id`, `total_cost_usd`, and a per-model cost breakdown. `stream-json`:
  newline-delimited JSON events streamed as they happen.
- Stream events include: text deltas (with `--include-partial-messages` /
  `--verbose`), tool use/results, `system/init` (first event: model, tools, MCP
  servers, plugins, capabilities), `system/api_retry` (attempt, max_retries,
  retry_delay_ms, error_status, error category), and a final `result` message
  with the response text, cost, and session metadata.
- `--json-schema` (with `--output-format json`) validates the final answer
  against a schema and returns it in `structured_output`. Invalid schema →
  exit with error (v2.1.205+).
- Scripts branch on exit code; failures print the failure as the result on
  stdout, invalid flags → stderr.

**Heirloom today (code-verified):**

- `src/exec-runner.ts` runs the agent and writes only `lastReply` to stdout
  (`exec-runner.ts:165`). It passes **no** callbacks into `runAgent` — the
  `onText`/`onToolStart`/`onToolResult`/`onUsage`/`onMaxTurns` options exist in
  `src/agent.ts:97-105` and are used only by the interactive bridge
  (`cli.tsx` `runAgentTurnBridge`), never by headless mode.
- `runAgent` already has `maxTurns` (default 100, `agent.ts:114`) and the
  per-turn usage accounting (`onUsage` in the bridge) — the data for a `result`
  event with cost is all present in `shared.sessionInput/Output` + provider
  pricing (`getCostStr` in `cli.tsx`).

**Build sketch:** add an `outputFormat` option to `runExecMode`; wire the agent
callbacks in `exec-runner.ts`; serialize events as NDJSON. `system/init` first
(model, tools from `registry.getAllDefs()`, MCP status from `getMCPServerStatuses`),
then per-turn `assistant`/`tool_use`/`tool_result`/`usage` events, then `result`
with `total_cost_usd` (reuse `estimateTokens`-style pricing math). Exit code
semantics unchanged. `--json-schema` can ride along later (validate with a tiny
inline validator; no new dep needed for basic schemas).

**Verification:** `heirloom -p "..." --output-format json | jq .result` in CI;
`--output-format stream-json` feeds a live dashboard; `total_cost_usd` agrees
with the interactive `/cost` figure.

---

## 2. Lifecycle hooks — *recommended second*

**Claude Code behavior (from `/cli-reference`, `/headless`, and the hooks doc at
`code.claude.com/docs/en/hooks`):**

- Configured in settings under `hooks`: `{ "PreToolUse": [{ "matcher": "Edit|Write",
  "hooks": [{ "type": "command", "command": "lint.sh", "timeout": 10 }] }] }`.
- Events: `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Notification`,
  `Stop`, `SubagentStop`, `SessionStart`, `SessionEnd`, `PreCompact`. Setup
  matchers `init` / `maintenance` run via `claude --init`, `--init-only`, or
  `--maintenance`.
- Contract: hook process gets JSON on stdin (tool name, args, prompt, cwd, etc.)
  and may return JSON on stdout. `PreToolUse` can return `permissionDecision:
  allow|deny|ask`; `UserPromptSubmit` can return `additionalContext`. Exit code
  2 with a `HookExitError` JSON = deny + fail the run.
- Observability: with `--output-format stream-json --include-hook-events`, hooks
  emit `hook_started` / `hook_progress` / `hook_response` events (v2.1.169+ live
  streaming).
- Security posture: arbitrary user-config shell on agent events — same trust
  level as settings.json itself, never derived from model output.

**Heirloom today (code-verified):**

- `src/notify.ts` is already a minimal, security-conscious shell hook: spawns
  `shell:false` with an explicit argv, passes data via env vars, secret-redacts
  the body, fire-and-forget. It fires from exactly two boundaries — interactive
  completion (`cli.tsx`) and headless completion (`exec-runner.ts`).
- The existing roadmap (improvement-roadmap.md, PR #263 `hooks.ts`) already
  flagged lifecycle hooks as "highest-leverage of the remaining roadmap tier",
  with the same security caveat. This doc confirms the recommendation.

**Build sketch:** generalize `notify.ts` into a hook dispatcher (`src/hooks/`):
load `hooks` config, match events, spawn with the stdin-JSON contract (not env),
parse stdout JSON responses, honor `timeout`. Wire the events at the points
`notify.ts` already touches (turn boundaries) plus the new ones (pre/post tool
via `executeTool` wrapper or the permission engine, session start/end in
`cli.tsx`, pre-compact in the `Compactor`). Keep `notify` as a thin special case
or migrate it to a `SessionEnd`-style hook. Document in a `hooks-spec.md` +
`security-spec.md` section (untrusted-exec surface, opt-in only).

**Verification:** a `PreToolUse` hook that denies `rm` never lets the tool run; a
`UserPromptSubmit` hook injects `additionalContext` into the first message; a
`SessionEnd` hook sees the right env/stdin on clean exit and SIGTERM.

---

## 3. Custom slash commands from files

**Claude Code behavior:** `.claude/commands/*.md` — filename = command name,
frontmatter (`description`, `argument-hint`, `allowed-tools`, `model`,
`disable-model-invocation`, …) + body used as the prompt. `/` menu lists them
alongside builtins. `--disable-slash-commands` turns them off.

**Heirloom today:** builtin slash registry only (`src/ui/core/slash-commands.ts`
+ `src/cli.tsx` `handleSlashCore`). Loader infrastructure already exists:
`ModeLoader` (YAML files), `SkillLoader` (`.heirloom/skills/**`), and the rules
loader (`.heirloom/rules/**`) all follow the same discover-and-parse pattern.

**Build sketch:** `.heirloom/commands/*.md` loader (frontmatter parse = reuse the
skill frontmatter parser), merged into the `/` menu, routed like `/skill`
already routes (push a user message built from the command body). `--disable-slash-commands`
flag if wanted. Smallest of the six.

**Verification:** a `commands/review.md` appears in `/` menu and, when run,
submits its body as the prompt with `{arg}` substituted.

---

## 4. Flag parity batch (each is small; ship in any order)

| Flag | Claude Code semantics | Heirloom today | Work |
|---|---|---|---|
| `--max-turns <n>` | Cap agentic turns in print mode; exit error at limit | `maxTurns` exists in `runAgent` options (default 100, `agent.ts:114`); interactive bridge passes nothing | Plumb through `runExecMode` + `parseArguments`; reuse `onMaxTurns` (already in `agent.ts:105`) |
| `--system-prompt-file <f>` / `--append-system-prompt <t>` | Replace / append to the system prompt | `src/prompt.ts` builds the prompt internally; no override hook | Add an optional override injected at the stable-preamble boundary |
| `--allowedTools` / `--disallowedTools` | Allow/deny permission rules for the session | Permissions come from `settings.json` + posture cycle only | Map to existing `PermissionEngine` rules at startup (`cli.tsx` builds it at :172) |
| `--permission-mode <mode>` | Start in default/acceptEdits/plan/auto/dontAsk/bypassPermissions | Posture is a runtime cycle (Shift+Tab) with no CLI entry | Map to `shared.posture` initial value |
| `--name <n>` / `/rename` | Display name for the session, shown in `/resume` | `SessionStore` meta already has a renamable `title` (`sessions/store.ts:131-132`) | Add `-n` to session-create meta + a `/rename` slash command |
| `--fork-session` | Resume under a new session ID | Sessions are immutable JSONL files; `restoreCheckpoint` does the closest thing | Copy-or-hardlink the JSONL under a new ID |
| `--bare` | Skip auto-discovery (hooks, skills, plugins, MCP, CLAUDE.md) for fast scripts | No equivalent | Gate the `SkillLoader`/MCP connect/`buildRepoMap` startup steps |
| `--settings <file\|json>` | Per-invocation settings override | Config loads from fixed `settings.json` paths | Overlay a parsed JSON object in `loadConfig` |

Verification per flag is mechanical: flag → parsed → observable behavior change;
`cli-spec.md` table updated as each lands.

---

## 5. Subagents / `--agents` — the big one

**Claude Code behavior:** `--agents '{"reviewer":{"description":"…","prompt":"…"}}'`
defines agents inline (same fields as subagent frontmatter: name, description,
tools, model, …). In-session, an `Agent`/`Task` tool spawns a subagent with its
own system prompt + tool set; results come back as a tool result. Subagents can
nest; `--append-subagent-system-prompt` appends text to every subagent's prompt.
In `stream-json`, subagent messages carry `parent_tool_use_id` for transcript
reconstruction.

**Heirloom today (code-verified 2026-08-11):** `src/orchestrator/index.ts` has an `Orchestrator` class + a `new_task` tool def, now **wired** in both the TUI (`cli.tsx:181–189`) and headless `-p` (`exec-runner.ts:141–150`) registries. Sub-agents run a real `runAgent` turn in the requested mode's toolset, inheriting the parent's **live** permission engine (rules + approval posture — no escalation) and the parent's provider factory (follows mid-session `/model` switches). Enforcement today: depth cap 3, max 10 sub-agent turns; sub-agent tools = target mode's group tools + `new_task` (for recursion).

**Gap vs. Claude Code:** `--agents` inline definitions / subagent frontmatter (per-mode model, description, tool overrides) and the roadmap's design doc for permission inheritance + recursion limits.

**Recommendation:** partially built — `new_task` is usable now. The next slice (frontmatter-style agent definitions + the permission-inheritance design doc) should ride on the permission-model work; keep it behind the roadmap's design doc until that settles.

---

## 6. Git worktrees (`-w`)

**Claude Code behavior:** `claude -w [name]` starts in an isolated git worktree
at `<repo>/.claude/worktrees/<name>`; `-w #123` or `-w <PR URL>` fetches that PR
from origin and branches the worktree from it; `--tmux` pairs it with a tmux
pane.

**Heirloom today:** nothing. The `workflow.*` config subtree exists
(`gitStatus`, `gitPollInterval`, `gitCommands`, `detectBuildTools`) but
`gitCommands`/`gitStatus`/`detectBuildTools` are deprecated or ignored
(`loader.ts:789` warns on `gitCommands`); only `gitPollInterval` has a consumer.
Greenfield, and it touches session-store pathing (sessions are keyed per-cwd).

**Recommendation:** defer; the git integration story needs a decision on
`workflow.*` first (wire, deprecate, or repurpose), which is a separate
workstream.

---

## 7. Background bash at exit

**Claude Code behavior:** a Bash tool task that backgrounds a process (dev
server, watch build) gets a ~5s grace after the final result, then the process
tree is killed so `claude -p` always exits. SIGTERM kills the in-progress turn +
tree, runs `SessionEnd` hooks, exits 143.

**Heirloom today:** `run_bash` runs to completion inside the turn; a dev server
ties up the tool call (this is the improvement-roadmap "background/streaming
command output" item, unscheduled). No exit-grace or tree-kill semantics.

**Recommendation:** fold into the existing roadmap item when that workstream is
picked up; the exit-grace + tree-kill semantics are the headless-specific half
and pair naturally with #2 (`SessionEnd` hooks on SIGTERM).

---

## Sequencing recommendation

1. **#1 `--output-format`** — surface-only, unlocks CI/scripts, exercises the
   agent callbacks that #2 will also need.
2. **#2 hooks** — generalizes the already-shipped `notify`; needs `hooks-spec.md`
   + security-spec section.
3. **#4 flag batch** — pick the 2–3 that hurt most (`--max-turns`,
   `--allowedTools`, `--permission-mode` are the CI-relevant trio).
4. **#3 custom slash commands** — cheap, reuses loaders.
5. **#5 subagents, #6 worktrees** — separate design docs; #5 finishes the now-wired `Orchestrator` (`new_task` ships, `--agents`-style definitions + permission-inheritance doc remain).

## Open questions / verify during implementation

- Hooks: confirm the exact stdin/stdout JSON schema and matcher syntax from
  `code.claude.com/docs/en/hooks` (the page exceeds web_fetch's 2MB cap; read it
  in a browser or via a curl-to-file when implementing).
- `stream-json`: decide event-type names (mirror Claude Code's
  `system/init` / `result` / `assistant` / `tool_use`? or Heirloom's own? —
  mirroring eases drop-in CI parity, but the repo's ethos favors its own
  readable schema; recommendation: mirror the *shape*, own the *names*).
- `--json-schema`: scope to basic JSON Schema (object/array/string/number +
  required) without a new dependency, or add `ajv` — decide when implementing.
