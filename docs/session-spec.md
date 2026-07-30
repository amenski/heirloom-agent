# Session Storage Specification

Sessions persist the conversation to disk so work survives process exit and
can be resumed with `--continue`. This must land **before Phase 4** —
compaction and checkpoints both reference session state, and retrofitting
storage under them means rewriting both.

opencode persists every session automatically; Claude Code does the same.
Without this, heirloom is a calculator that forgets (see subsystems.md §1).

---

## Storage Layout

```
~/.heirloom/sessions/
└── <project-slug>/
    ├── 20260728T142301-ab3f.jsonl
    ├── 20260728T191045-c81d.jsonl
    └── ...
```

- **project-slug**: the absolute working directory with every non-alphanumeric
  character replaced by `-` (e.g. `/Users/x/proj` → `-Users-x-proj`). Slug
  collisions are tolerable because the true `cwd` is stored in the meta record.
- **One file per session.** Append-only JSONL: crash-safe (a torn last line is
  dropped on load), streams without parsing the whole file, and diffs cleanly.

## Session ID

`<UTC timestamp, compact ISO>-<4 hex chars>`, e.g. `20260728T142301-ab3f`.

- Sortable by creation time via plain string sort (makes "most recent" trivial).
- Human-readable in `ls` output — no opaque UUIDs.
- The filename **is** the ID.

---

## Record Types

Each line is one JSON object with a `type` field. Four types:

### `meta` — always the first line

```json
{"type":"meta","version":1,"id":"20260728T142301-ab3f",
 "cwd":"/Users/x/proj","createdAt":"2026-07-28T14:23:01Z",
 "provider":"deepseek","model":"deepseek-chat","mode":"code"}
```

`version` gates format migrations. A loader that sees a higher version than it
knows refuses with a clear error instead of misparsing.

### `message` — one canonical Message per line

```json
{"type":"message","at":"2026-07-28T14:23:05Z",
 "message":{"role":"user","content":"refactor auth to JWT"}}
```

The `message` field is exactly the canonical `Message` type from
`src/types.ts` — no session-specific message format. Messages are implicitly
indexed by their order of appearance (0-based), and `compaction` records
reference these indices.

### `state` — mid-session changes

```json
{"type":"state","at":"...","mode":"architect","model":"deepseek-reasoner"}
```

Appended when the user runs `/mode` or switches models. All fields optional;
on load, later records override earlier ones. Keeps `meta` immutable.

### `compaction` — summary marker (Phase 4)

```json
{"type":"compaction","at":"...","replacesThrough":12,
 "summary":{"task":"...","decisions":[...],"files":[...],"errors_resolved":[...]}}
```

`summary` is the structured compaction object from subsystems.md §2.
`replacesThrough` is the index of the last message the summary covers.
**History is never rewritten** — compaction appends a marker; the full
transcript stays on disk for rewind and audit.

### `permission` — audit trail entry

```json
{"type":"permission","at":"...","toolCallId":"call_1","tool":"run_bash",
 "subject":"rm -rf /","decision":"deny",
 "winningRule":{"tool":"run_bash","kind":"prefix","pattern":"rm -rf /","action":"deny","origin":"builtin-destructive"}}
```

One row per permission decision — `decision` is `"deny" | "once" | "session" |
"always"`. `subject` (the literal command/path the decision was made
against) is redacted through the same secret-pattern redactor as message
content. `winningRule` is the rule that produced the outcome, absent when
the decision came from a `defaultMode` fallthrough with no matching rule.
Written from two call sites (`SessionStore.appendPermission`): `agent.ts`
for auto-resolved outcomes (deny, or allow with no prompt needed), and
`App.tsx`'s `handlePermissionDecision` for a real prompted decision — never
both for the same call, since `agent.ts` only calls `askUser` when a prompt
is actually needed and stays silent on that path. Queried via
`SessionStore.queryPermissionHistory(sessionId)`; surfaced in the TUI via
`/permissions` (permission-spec.md).

Permission records are ignored by `load()`/`loadEffective()` — they don't
appear in the conversation and don't affect message indexing or compaction's
`replacesThrough` offsets.

---

## What Is Persisted vs. Rebuilt

| Item | Persisted? | Why |
|------|-----------|-----|
| user / assistant / tool messages | Yes | The conversation itself |
| System prompt | **No** | Rebuilt on load from current config + mode + memory. Persisting it would freeze stale modes/skills into resumed sessions. |
| Tool definitions | No | Derived from active mode |
| Active mode / model | Yes (`meta` + `state`) | Sticky across resume |
| Compaction summaries | Yes | Resume must not re-summarize |

Writes happen **after each message is complete** (user input accepted,
assistant turn done, tool result returned) — never mid-stream. A crash loses
at most the in-flight turn.

---

## Loading a Session

1. Read all lines; skip a torn final line (incomplete JSON) with a warning.
2. First line must be `meta` with a known `version`.
3. Fold `state` records into meta (last wins) → active mode/model.
4. Collect `message` records in order.
5. If any `compaction` records exist, take the **last** one; the effective
   conversation = `[summary rendered as a user message] + messages[replacesThrough+1..]`.
   Otherwise, effective conversation = all messages.
6. Prepend a freshly built system prompt (see system-prompt.md).
7. Print a one-line recap: `Resumed 20260728T142301-ab3f · 14 messages · mode: code`.

## Checkpoint Interplay (Phase 5)

Checkpoints live in the shadow Git repo, keyed by session ID. Each checkpoint
commit message records the message index at checkpoint time. `restore full`
truncates the effective conversation to that index — implemented by appending
a `state` record `{"truncateAt": N}`, never by deleting lines.

---

## CLI Surface

| Command | Behavior |
|---------|----------|
| `heirloom` | New session |
| `heirloom --continue` / `-c` | Resume the most recent session for this cwd |
| `heirloom --session <id>` | Resume a specific session |
| `/sessions` | List this project's sessions: id, first-user-message excerpt (60 chars), age, message count |
| `/new` | Save current, start fresh |

Session titles are the first user message truncated to 60 chars — no LLM call.
(Future: LLM-generated titles like opencode, at session end so it's free.)

Retention: keep everything. Sessions are small text files; pruning
(`/sessions prune`) is post-MVP.

---

## Design Decisions

1. **JSONL append-only vs. rewrite-on-save JSON.** Append is crash-safe and
   O(1) per message; rewriting a growing file on every turn is O(n²) over a
   session and can corrupt on crash. Decision: JSONL.

2. **System prompt rebuilt, not persisted.** A resumed session should get
   current modes, skills, and memory — not a snapshot from last week.
   Tradeoff: prompt changes between sessions can shift behavior mid-task.
   Acceptable; opencode does the same.

3. **Compaction as marker, not rewrite.** Preserves the audit trail, makes
   checkpoints' `restore full` possible, and keeps writes append-only.
   Cost: load-time reconstruction (~trivial).

4. **Per-project directories vs. one flat pool.** Listing "sessions for this
   repo" is the common query; the filesystem is the index. Matches memory
   architecture's per-project layout (subsystems.md §1).
