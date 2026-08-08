## 2. Context Management — Beyond Token Counting

### Problem
Naive context management: "count chars/4, compact when over threshold." This
loses important information and keeps irrelevant noise.

### The Token Budget Model

```
┌──────────────────────────────────────────────────┐
│  Context Window (e.g., 128K tokens)              │
│                                                  │
│  ┌──────────────┐  ┌──────────────────────────┐ │
│  │ Immutable    │  │ Conversation (70%)       │ │
│  │ Prefix (15%) │  │                          │ │
│  │              │  │ System prompt            │ │
│  │ System       │  │ Mode definition          │ │
│  │ prompt       │  │ RepoMap context          │ │
│  │ Tool defs    │  │ Skill context            │ │
│  │ Mode defs    │  │ Conversation history     │ │
│  │              │  │ Tool outputs             │ │
│  └──────────────┘  └──────────────────────────┘ │
│                         ┌──────────┐ ┌────────┐ │
│                         │ Output   │ │Safety  │ │
│                         │ Reserve  │ │Buffer  │ │
│                         │ (20%)    │ │(10%)   │ │
│                         └──────────┘ └────────┘ │
└──────────────────────────────────────────────────┘
```

### What to Keep During Compaction

Not all messages are equal. The compaction strategy should be tiered:

| Tier | Content | Strategy | Example |
|------|---------|----------|---------|
| T0 | System prompt, mode, tool defs | **Never compact** | "You are a senior engineer..." |
| T1 | User's original task | **Compress, never delete** | "Refactor the auth module to use JWT" |
| T2 | Key decisions | **Extract to decision log** | "Chose RS256 over HS256 for key rotation" |
| T3 | File changes | **Extract to change log** | "Created src/auth/jwt.ts (120 lines)" |
| T4 | Errors + fixes | **Extract to error log** | "Type error at line 42 → added type guard" |
| T5 | Tool outputs (old) | **Prune, keep 1-sentence summary** | "read_file: 2000 lines truncated" |
| T6 | Tool outputs (recent) | **Keep verbatim** | Last 3 turns of tool output |
| T7 | Recent conversation | **Keep verbatim** | Last 3 user/assistant exchanges |

### Structured Compaction Output

Don't produce prose — produce structured data the LLM can parse:

```yaml
compacted:
  task: "Refactor auth module to use JWT"
  progress: |
    - Phase 1 complete: token generation and validation
    - Phase 2 in progress: middleware integration
  decisions:
    - id: d1
      what: "Use RS256 asymmetric signing"
      why: "Enables key rotation without shared secrets"
      context: "Discussed at turn 5"
  files:
    - path: src/auth/jwt.ts
      action: created
      summary: "JWT sign/verify with RS256, 120 lines"
    - path: src/auth/middleware.ts
      action: modified
      summary: "Added JWT validation, removed session check"
  errors_resolved:
    - error: "Type 'string' is not assignable to 'KeyLike'"
      fix: "Added type assertion for private key import"
      turn: 8
  pending: []
```

This structured format means the LLM doesn't have to re-derive what happened
— it can read the decision log, check which files changed, and resume.

### Fidelity Check — Don't Trust the Summary

A summary that silently drops an unresolved error or a changed file is worse
than no compaction. After generating the summary, verify it mechanically (no
LLM call):

1. Every file path in the messages being compacted (T3 records) appears in `files[]`.
2. Every todo item not marked complete appears in `pending[]`.
3. `task` is non-empty and derived from T1.

On failure: regenerate once, naming the misses. On second failure: defer
compaction and keep the messages verbatim — a deferred compaction is
recoverable, a lossy one is not. Backstop: sessions are append-only
(session-spec.md), so compaction can only ever degrade the model's recall,
never destroy the transcript.

### When to Compact

Not just "over X%." Use a smarter trigger:

1. **Soft threshold (70%):** Prepare summary in background, don't interrupt
2. **Hard threshold (85%):** Compact before next LLM call
3. **Error-driven:** Context overflow error → emergency compact
4. **User-driven:** `/compact` command

### Keep-Boundary Invariant (`keepBoundary`, compactor.ts)

Compaction keeps the last 4 messages verbatim — but the boundary must **never
land between an assistant `tool_calls` message and its `tool` results**. A kept
tail starting with a `tool` message is a hard 400 on strict providers
(`Messages with role 'tool' must be a response to a preceding message with
'tool_calls'` — observed from DeepSeek), and it corrupts the in-memory history,
so the session cannot recover without a restart.

`keepBoundary(messages)` widens the keep count past any leading `tool`
messages. It is **exported and shared** by auto-compaction and the `/compact`
handler in cli.tsx: the manual path originally re-derived its own
`Math.min(4, …)` slice and reintroduced the bug on a path the compactor's own
tests didn't cover. Any new code choosing a compaction boundary must call
`keepBoundary` rather than slicing directly.

`/compact` must also **preserve the system message** it slices off before
summarizing — dropping it strips the agent's rules for the remainder of the
session (the auto path reinserts the stable preamble for the same reason).

### Pruning Old Tool Outputs

Tool outputs are the #1 source of token bloat. Strategy:

- Keep last 3 turns' tool outputs verbatim
- For turns 4-10: replace with 1-line summary ("read_file src/auth.ts → 500 lines")
- For turns >10: drop entirely, assume decision log covers it
- Exception: user explicitly said "remember this output" → move to T2

---

---

_Part of the [subsystems deep dive](../subsystems.md)._
