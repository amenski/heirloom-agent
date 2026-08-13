# Hooks Spec

**Status:** current · verified 2026-08-13 · covers `src/hooks/`, `src/agent.ts`, `src/cli.tsx`, `src/ui/App.tsx`, `src/exec-runner.ts`, `src/orchestrator/index.ts`, `src/compaction/compactor.ts`, `src/config/loader.ts`

> Verified against: §1 `src/hooks/config.ts` + `src/config/loader.ts` (schema,
> merge, matcher rules, fail-fast regex) · §2-4 `src/hooks/runner.ts`
> (dispatcher, spawn, exit codes, payload, redaction) · §5 `src/agent.ts`
> (PreToolUse / PermissionRequest / PostToolUse / PostToolUseFailure /
> PostToolBatch / PreCompact / PostCompact ordering) · §6
> `src/hooks/trust.ts` + `src/ui/views/HookTrustPrompt.tsx` (TOFU, headless
> skip) · §7 `src/hooks/runner.ts` (`fireNotificationHooks`) wired at the
> notify boundaries in `src/cli.tsx` and `src/exec-runner.ts` ·
> SessionStart/UserPromptSubmit/MessageDisplay/Stop/SessionEnd in
> `src/ui/App.tsx` and `src/exec-runner.ts` · SubagentStart/SubagentStop in
> `src/orchestrator/index.ts`.

Lifecycle hooks: user-configured shell commands fired on agent events. The
contract adapts Claude Code's event/exit-code model and Gemini's simpler
matcher syntax to heirloom's loop (feature-plans.md §4). Hooks are an
**opt-in, untrusted execution surface** — the trust model (§6) and the
security-spec T15 threat entry ship with the code.

## 1. Config schema

`hooks` key in settings.json (project > global merge, same as permissions):

```jsonc
"hooks": {
  "PreToolUse": [
    { "matcher": "run_bash|edit*", "command": "hook-scripts/guard.sh" }
  ],
  "UserPromptSubmit": [ { "command": "hook-scripts/log-prompt.sh" } ],
  "Notification": [ { "command": "hook-scripts/notify.sh" } ]
}
```

- Each event key holds an array of `{ matcher?, command }`; entries run
  **sequentially, in config order**.
- `command` is a single shell string, spawned via `/bin/sh -c` with cwd =
  project root.
- **Matchers** (tool events only): omitted or `"*"` = all tools; a string
  matching `^[A-Za-z0-9_|,]+$` = exact-name list (`run_bash|edit`);
  anything else = unanchored JS regex. An invalid regex is a **config
  error** (fail fast, naming the entry).
- `disableAllHooks: true` — master switch; nothing runs, not even trusted
  hooks.

## 2. Events

| Event | Tier | Blockable? | stdout semantics |
|---|---|---|---|
| `SessionStart` | 1 | no | debug log |
| `UserPromptSubmit` | 1 | **yes** (block = message not sent, user notified) | context (appended to the prompt) |
| `PreToolUse` | 1 | **yes** (deny = call blocked) | debug log |
| `PermissionRequest` | 1 | **yes** (deny = as if user answered no) | debug log |
| `PostToolUse` | 2 | no | appended to the tool result |
| `PostToolUseFailure` | 2 | no | appended to the failure result |
| `PostToolBatch` | 2 | no | debug log |
| `PreCompact` | 2 | no | appended to the compaction prompt |
| `PostCompact` | 2 | no | debug log |
| `MessageDisplay` | 2 | no | ignored (TUI signal only) |
| `Notification` | 3 | no | ignored |
| `Stop` | 3 | no | ignored |
| `SubagentStart` / `SubagentStop` | 3 | no | ignored |
| `SessionEnd` | 3 | no | ignored |

Wiring points (the dispatch map an implementer splices into the loop):

- `SessionStart` — once at session startup, after the trust check, before
  the first turn.
- `UserPromptSubmit` — before a **top-level** submitted message enters the
  agent. Mid-turn steered injections skip this hook (documented — they are
  already-typed user input arriving at a decision point, not a fresh
  submission).
- `PreToolUse` / `PermissionRequest` — around permission resolution, see
  §5 ordering.
- `PostToolUse` / `PostToolUseFailure` / `PostToolBatch` — after a tool
  result is produced (per call, then per batch; batches exist since the
  2026-08-13 mixed-batch work).
- `PreCompact` / `PostCompact` — immediately before/after the compactor
  runs.
- `MessageDisplay` — TUI-only, when an assistant message renders.
- `Notification` — the existing notify boundaries (turn completion,
  job completion — same payload builder as notify-spec.md, plus
  `hook_event_name`).
- `Stop` — on `/exit`; `SessionEnd` — immediately after, before teardown.
- `SubagentStart` / `SubagentStop` — around orchestrator sub-agent spawns.

## 3. Payload contract

One JSON object on **stdin**, one line:

```jsonc
{
  "hook_event_name": "PreToolUse",
  "session_id": "2026-08-13T…",
  "cwd": "/path/to/project",
  "permission_mode": "autoApprove",
  "tool_name": "run_bash",        // tool events only
  "tool_input": { … }             // tool events only
}
```

- `tool_input` and every other string pass through the existing session
  secret redactor (`src/sessions/redact.ts`) before stdin is written —
  hooks never see plaintext secrets.
- Env for hook scripts: `PATH`, `HOME`, `TERM` only. Session context
  travels in the JSON, not the environment.
- stdout is captured (cap 64 KB, truncation note beyond); stderr is
  forwarded to the debug log only.

## 4. Exit codes & stdout JSON

| Exit | Meaning |
|---|---|
| 0 | pass. stdout → the semantics in §2's table; a final JSON object on stdout may carry a decision (below). |
| 2 | **block** (on blockable events). PreToolUse/PermissionRequest → deny; UserPromptSubmit → message not sent. |
| other nonzero | non-blocking error, logged. |
| timeout (30 s default, SIGKILL) | never blocks; logged. |

Exit-0 stdout JSON (only on blockable events; malformed JSON = ignored):

```jsonc
{ "decision": "allow" | "deny" }
```

- `deny` on PreToolUse routes through the permission engine as a
  **deny-by-rule** decision — audit row recorded, `PERMISSION_DENIED`
  fed to the model — so hook denials are indistinguishable from policy
  denials in the audit trail.
- `deny` on PermissionRequest is recorded as `ask-denied` (as if the user
  answered no).
- `allow` is **advisory only** (decision G, locked): a hook can never
  upgrade a rule-derived `ask`; it can only deny or stay silent.
- `updatedInput` rewriting is **not shipped** in phase 1 — letting a hook
  rewrite the user's prompt is a spoofing vector; the phase-1 surface is
  deny-only power.

## 5. Ordering with the permission engine

```
call → rules.resolve(call)
        ├─ deny → DONE (no hooks fire)
        ├─ allow → PreToolUse hooks → deny ⇒ deny-by-rule audit + PERMISSION_DENIED
        │                                pass ⇒ execute → PostToolUse hooks
        └─ ask  → PermissionRequest hooks → deny ⇒ ask-denied audit
                  └─ pass → user prompt → approved ⇒ PreToolUse hooks → execute
```

Hooks only ever see calls that survived rule resolution, and they can only
narrow what survives. The deny-absolute invariant is untouched: hook
`allow` never bypasses layer-1 denies because the hook never sees them.

## 6. Trust model (TOFU)

- **Global settings hooks** (the user's own `~/.heirloom`) are trusted
  implicitly.
- **Project-declared hooks** (project `.heirloom/settings.json`): at
  startup, hash each `event|command` pair and compare against
  `~/.heirloom/hooks-trust.json` (mirrors skill-trust.json). Unseen pairs →
  one ask-tier confirmation listing event + command (y = trust forever,
  n = skip this session). **Headless: untrusted hooks are skipped with a
  stderr warning** (fail closed, like skills).
- `disableAllHooks` overrides everything.

## 7. Relationship to notify.ts

`Notification` is not a second notification system: it fires at the same
completion boundaries `fireNotify` already covers, using the same payload
builder with `hook_event_name: "Notification"` added. If hooks are
configured, they fire alongside the notify script — never instead of it.

## 8. Verification plan

Per-event tests with a fake dispatcher + script fixtures: exit-2 blocks
PreToolUse and feeds PERMISSION_DENIED + audit row; UserPromptSubmit exit-2
blocks the send; PermissionRequest deny = ask-denied; PostToolUse stdout
reaches the tool result; PreCompact stdout reaches the compaction prompt;
Notification fires at turn/job completion; disableAllHooks silences all;
TOFU prompts exactly once per unseen project hook; headless skips +
warns; invalid matcher regex fails config fast; redaction verified on a
secret-bearing tool_input.

## 9. Out of scope (phase 2)

Non-command handler types (HTTP, MCP-tool, prompt, agent), managed-policy
layers, matcher `if` permission filters, `updatedInput` rewriting,
`Subagent*` payload details beyond spawn boundaries.
