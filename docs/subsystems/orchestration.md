## 7. Orchestration — `new_task` sub-agents

**Status:** current · verified 2026-08-15 · covers `src/orchestrator/index.ts`, decision H (feature-plans.md §10), agent definitions (feature-plans.md §F4)

### What `new_task` is

The `new_task` tool (workflow group, exposed by the `orchestrator` mode to
every other mode) spawns a sub-agent to handle a discrete, isolated task: a
fresh `runAgent` loop with its own message history, its own todo store, and
a tool set derived from the requested mode. When the sub-agent finishes, the
parent receives only a text summary — no raw file diffs, no tool outputs.
This is the delegation primitive: implementation work, research, or analysis
delegated to a specialized mode, recursively up to `maxDepth`.

### Inheritance semantics

A sub-agent inherits from its parent — deliberately, by construction:

- **Mode & tools.** The requested mode's tool groups (`registry.getByMode`)
  plus `new_task` itself, so delegation nests. The system prompt carries the
  mode's role definition. Unknown mode slugs fail with `UNKNOWN_MODE`.
- **Provider.** Resolved at spawn time via the `provider()` factory
  (`OrchestratorOptions.provider`), so a sub-agent always runs on the
  provider/model the parent session is *currently* on — mid-session
  `/model` switches included (provider-spec.md).
- **Permissions.** The parent's `PermissionEngine` is passed straight
  through at every depth: the same allow/deny rules govern sub-agent calls.
  Enforcement exists — a sub-agent is not a sandbox escape hatch.
- **askUser.** The interactive prompt bridge is re-pointable per turn
  (`setAskUser`): a sub-agent's ask-tier calls surface to the same prompt
  flow as the parent's, labeled with which sub-agent is asking
  (permission-spec.md). Headless (no bridge), ask-tier resolves to
  `headless-deny` — auto-denied, never auto-allowed.
- **Abort.** `getSignal()` forwards the top-level Esc/Ctrl+C signal, so a
  user can abort an in-flight sub-agent instead of waiting for it to finish.
- **Not inherited.** Message history (fresh context per task), todo state
  (fresh store, below), and session writes (restricted view, below).

### Recursion limits

- **`maxDepth` 3** — `new_task` at depth ≥ 3 returns `MAX_DEPTH` without
  spawning. Depth 0, 1, 2 spawn.
- **`maxSubTurns` 10** — each sub-agent's `runAgent` caps at 10 turns, the
  same ceiling as any other run.

Both are `OrchestratorOptions` fields with those defaults; enforcement
happens at the handler boundary (`createHandler`), so a nested spawn checks
its own depth before doing any work.

### Agent definitions (feature-plans.md §F4, shipped 2026-08-15)

Frontmatter agent definitions let a delegation name a *persona* instead of
just a mode. `.heirloom/agents/<name>.md` (project dir) and
`~/.heirloom/agents/<name>.md` (global, `HEIRLOOM_HOME`-aware) are scanned by
`src/agents/index.ts` (`AgentLoader`) at startup — project wins per name,
exactly like modes. A def carries:

| Field | Required | Meaning |
|-------|----------|---------|
| `name` | yes | The identity `new_task`'s `agent` parameter resolves |
| `description` | yes | One-line prompt index entry |
| `mode` | yes | The sub-agent's toolset (mode-spec.md) |
| `model` | no | `provider/model` override, validated against the model catalog at startup (unknown → warning, def still loads; the sub-run then falls back to the parent's model) |
| `instructions` | no | Prepended to the sub-agent's system prompt (before the role definition) |

Unknown frontmatter fields warn and are ignored; a file missing
`name`/`description`/`mode` is skipped with a warning. The frontmatter parser
is the same tiny YAML subset the modes/skills loaders use.

**`new_task`'s `agent?: string` parameter.** With it, the sub-run uses the
def's mode (toolset), model (a provider created from the `provider/model`
override via the spawn-time factory; unconfigured/unknown → a clean
`SUBTASK_PROVIDER` tool error), and instructions. Without it, behavior is
byte-identical to pre-F4: the call's `mode`, the parent's model. An unknown
agent name returns `UNKNOWN_AGENT` listing the available names. The tool def
is rebuilt at `register()` time so its description lists the loaded names.

**Security envelope unchanged.** The def selects persona/toolset/model only.
Permission inheritance (rules + approval posture + profile), `maxDepth`, and
`maxSubTurns` are untouched; the sub-run still writes tagged
`source: "subagent"` audit rows through the same audit-only store view.

**Prompt index.** Loaded defs' `name` + `description` lines join the stable
preamble as an "Available agents" section (one line per agent, sorted), so
the top-level agent knows the names `new_task` accepts. The CLI's `/skills`
slash command prints a one-line agent list; there is no separate view.

### Isolation model

- **Transcript.** Sub-agent messages never land in the parent session's
  JSONL. Enforced by the audit-only view below, which blocks every
  non-audit write; before decision H the same guarantee came from passing
  `sessionStore: undefined`.
- **TodoStore.** Each sub-agent gets a fresh `TodoStore` threaded through
  its per-call tool context (`update_todo_list` writes to it, the sub-run's
  `getTodos` reads it). The parent's checklist panel store (the module
  singleton) is never touched, and the sub-agent's own context sees its own
  plan. Unchanged by decision H — as is the snapshot persistence: the
  audit-only view blocks `appendTodo`, so sub-agent plans stay ephemeral.
- **Compaction.** Sub-agents compact in memory only. The audit-only view
  reports `getMessageCount` as 0, which keeps agent.ts's compaction-persist
  path (`persistedCount > 0` gate) dormant — a sub-agent can never write a
  compaction marker into the parent transcript. That matters because a
  marker's `replacesThrough` indexes the *sub-agent's* message list; a
  parent resume would mis-slice against it.

### Sub-agent audit rows (decision H)

Permission and token rows produced by a sub-agent are written into the
PARENT session's JSONL, tagged `source: "subagent"`:

```json
{"type":"permission","at":"...","tool":"run_bash","subject":"npm test",
 "decision":"headless-deny","reason":"resolved to ask with no interactive prompter (headless)",
 "source":"subagent"}
```

**Mechanics.** The orchestrator wraps the parent `SessionStore` in an
audit-only view (`subagentAuditStore`, `src/sessions/store.ts`) and hands
that view to the sub-agent as both its `AgentOptions.sessionStore` (so
agent.ts's token/permission write sites go through it) and its per-call
`ToolContext.sessionStore` (so tools — and nested `new_task` spawns — see
the same view). The view:

- **forwards** `appendPermission` and `appendToken`, stamping
  `source: "subagent"` on each row;
- **reports** `getMessageCount` as 0 (the compaction-persist gate above);
- **blocks everything else by construction** — `appendMessage`,
  `appendTodo`, `appendCompaction`, `appendState`, `append`, `create`,
  `load`, … are absent (undefined) on the view. A sub-agent cannot write
  anything but audit rows into the parent session, and the view needs no
  re-audit when `SessionStore` grows: new members default to blocked.

**Contract.**

- Parent-side rows stay untagged — no `source` field (session-spec.md §4).
- Nested sub-agents wrap the view again; the wrap is idempotent (same tag,
  same forwarding), so every depth writes identically tagged rows.
- When the parent itself has no store wired (headless run with no session
  persistence), there is nothing to audit into and sub-agents are
  audit-silent, exactly like the parent.
- Sub-agent token rows participate in the parent session's token totals
  (`queryTokenUsage`, and the index's last-token-row `totalUsed`/`budgetMax`
  until the parent's next turn) — intended: sub-agent cost is part of the
  session's true cost.
- Record types are unchanged except the optional `source` field; readers
  must tolerate both tagged and untagged rows.

**Why H (chosen over audit-silent).** Debuggability: `/permissions` and
`/cost` answer "what did my sub-agent do, and what did it cost?" from the
same JSONL as the parent's own rows, with the tag keeping the two
populations distinguishable. The rejected alternative — keep sub-agents
audit-silent (the pre-H stance) — preserved the strictest isolation but
left sub-agent activity invisible in the only place a session's full
history is reviewable.

---

_Part of the [subsystems deep dive](../subsystems.md)._
