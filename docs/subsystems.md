# Deep Dive: Memory, Context, ReAct, Compaction, Token Optimization

> Design decisions that carry through every phase. Get these wrong and you
> rewrite the agent loop later; get them right and each phase slots in cleanly.

---

## 1. Memory Architecture

### Problem
An agent that forgets everything between sessions is a calculator, not an
assistant. It should remember:
- Project conventions (this codebase uses X pattern, Y library)
- Past decisions (why we chose approach A over B)
- User preferences (prefers functional style, hates classes)
- Common pitfalls (this file is auto-generated, don't edit it)

### Options evaluated

| Approach | Pros | Cons | Used by |
|----------|------|------|---------|
| Vector DB (Chroma, LanceDB) | Semantic search, scales well | Complex, opaque, hard to debug | Cody, cursor |
| SQLite | Structured, queryable | Schema migrations, not human-readable | — |
| Markdown files (Obsidian) | Human-readable, portable, linkable | Manual search without embeddings | opencode |
| Hybrid: MD + embeddings | Best of both | Complexity, two sources of truth | — |

### Decision: Hybrid — Markdown files + optional embeddings

**Storage:** `~/.heirloom/memory/` (like opencode's `SecondBrain/AgentMemory/`)

```
~/.heirloom/memory/
├── MEMORY.md              # Index: one line per memory file
├── _global/
│   ├── user-prefs.md      # Preferences, style, conventions
│   └── tool-decisions.md  # Why we chose X over Y
├── <project-slug>/
│   ├── sessions.md        # Rolling session log, newest first
│   ├── decisions.md       # Key architectural decisions
│   ├── patterns.md        # "This project uses X pattern"
│   └── pitfalls.md        # "Don't edit this file, it's generated"
└── sessions/              # FROZEN: old cross-project session logs (read-only)
```

**File format** (one fact per file):
```markdown
---
name: canonical-types
description: Why heirloom uses a canonical type system over SDK types
type: decision
date: 2026-07-28
tags: [architecture, types, providers]
---

# Canonical Type System

We chose canonical types (Message, ToolDef, ToolCall) over SDK-native types
because it makes provider swapping a one-file change. Each adapter maps to/
from canonical types. The agent loop never touches an SDK import.
```

**Loading strategy:**
1. On session start: read `MEMORY.md` index, load relevant memory files
2. During conversation: search memory by tag/slug when user mentions related concepts
3. On session end: append session summary to `sessions.md`, update decision files

**Future:** Add LanceDB for semantic search when memory exceeds ~50 files.
Start with grep over markdown — it's fast enough for hundreds of files.

---

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

### When to Compact

Not just "over X%." Use a smarter trigger:

1. **Soft threshold (70%):** Prepare summary in background, don't interrupt
2. **Hard threshold (85%):** Compact before next LLM call
3. **Error-driven:** Context overflow error → emergency compact
4. **User-driven:** `/compact` command

### Pruning Old Tool Outputs

Tool outputs are the #1 source of token bloat. Strategy:

- Keep last 3 turns' tool outputs verbatim
- For turns 4-10: replace with 1-line summary ("read_file src/auth.ts → 500 lines")
- For turns >10: drop entirely, assume decision log covers it
- Exception: user explicitly said "remember this output" → move to T2

---

## 3. ReAct Implementation — The Right Variant

### Standard ReAct

```
Thought: I need to read the auth module first.
Action: read_file("src/auth/index.ts")
Observation: [file contents with 200 lines]
Thought: The issue is in the token validation function at line 42.
Action: edit("src/auth/index.ts", old_string, new_string)
Observation: Edit applied successfully.
Thought: Let me verify by running the tests.
Action: run_bash("npm test -- src/auth")
Observation: 12 tests passing, 0 failing.
Thought: The fix works. I'm done.
```

### Why Standard ReAct Falls Short

1. **No backtracking.** If the edit is wrong, the agent has no structured way to undo.
2. **No planning.** The agent dives into implementation without a plan.
3. **No reflection.** The agent doesn't verify if its actions achieved the goal.

### Decision: ReAct + Plan + Reflect

```
Phase 1: PLAN
  Thought: The user wants to refactor auth. Let me plan:
    1. Understand current auth implementation
    2. Design JWT-based replacement
    3. Implement JWT utilities
    4. Update middleware
    5. Migrate tests
    6. Verify everything passes
  Action: update_todo_list([...6 items...])

Phase 2: EXECUTE (ReAct loop for each todo item)
  For step 1:
    Action: read_file("src/auth/index.ts")
    Action: search("authenticate|login|session")
    Action: glob("src/auth/**/*.ts")
    [LLM processes results, marks step 1 complete]

  For step 3:
    Action: write_to_file("src/auth/jwt.ts", content)
    Action: run_bash("npx tsc --noEmit")
    Observation: Type error at line 42
    [REFLECT: Error detected]
    Thought: The import is wrong. Let me fix it.
    Action: edit("src/auth/jwt.ts", wrong_import, correct_import)
    Observation: Edit applied.
    [REFLECT: Now let me check]
    Action: run_bash("npx tsc --noEmit")
    Observation: No errors.

Phase 3: VERIFY
  Action: run_bash("npm test")
  Observation: All tests pass.
  Action: attempt_completion("Auth refactored to JWT. 3 files changed, all tests pass.")
```

### Reflection Loop Rules

After EVERY tool action, the agent asks itself:
1. Did the tool succeed? If not → try a different approach (max 1 retry)
2. Did the tool produce expected output? If not → investigate why
3. Does the output change the plan? If yes → update todo list

This is Aider's self-reflection pattern, formalized.

### Error Taxonomy for Structured Reflection

Instead of feeding raw error messages to the LLM, categorize errors:

| Error Code | Meaning | Suggested Response |
|-----------|---------|-------------------|
| `FILE_NOT_FOUND` | Path doesn't exist | Check spelling, run list_files for similar names |
| `DIFF_NO_MATCH` | Search string not in file | Show surrounding lines, suggest `search` to find correct string |
| `TYPE_ERROR` | TypeScript compilation failed | Show error location, suggest fix |
| `TEST_FAILURE` | Tests failed | Show failing test output |
| `COMMAND_FAILED` | Bash exited non-zero | Show exit code + stderr |
| `TIMEOUT` | Command exceeded time limit | Suggest simpler/more targeted command |
| `PERMISSION_DENIED` | Tool blocked by policy | Explain which rule blocked it |
| `PARSE_ERROR` | Tool arguments malformed | Show expected schema |

---

## 4. Token Optimization Strategies

### 4a. Immutable Prefix Caching

The system prompt, tool definitions, and mode definition don't change between
turns. Mark them as cacheable so the provider reuses computation.

**DeepSeek/OpenAI:** Not supported in the base API (only Anthropic has native
prompt caching). Workaround: keep prefix identical across turns so the
provider's internal cache hits.

**Anthropic:** Native prompt caching via `cache_control` breakpoints:
```typescript
messages: [
  { role: "user", content: [
    { type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }
  ]},
  // ... rest of conversation (not cached)
]
```

### 4b. Mode-Gated Tool Definitions

Don't send all 11 tools. Only send tools in the active mode's groups:

| Mode | Tools Sent | Tool Tokens Saved |
|------|-----------|-------------------|
| code | 9 tools (read + edit + command) | ~20% vs all |
| ask | 4 tools (read only) | ~65% vs all |
| architect | 5 tools (read + edit, docs only) | ~55% vs all |
| orchestrator | 1 tool (new_task) | ~90% vs all |

### 4c. Parallel Tool Execution

When the LLM issues multiple independent tool calls, execute them concurrently.
Already implemented in the agent loop (`Promise.all`).

### 4d. Concise System Prompt

Every token in the system prompt costs every turn. Optimize:
- Remove fluff ("You are a helpful AI assistant...")
- Remove rules the model already follows
- Use shorthand where the model understands it
- Test: remove a sentence, does quality drop? If not, keep it removed.

Aider's system prompt is remarkably terse — that's intentional.

### 4e. Tool Output Compression

Large tool outputs (1000+ lines) should be summarized before feeding back:
- `read_file`: Return first 500 lines + "file truncated at line 500"
- `search`: Return first 50 matches + "search truncated"
- `run_bash`: Return last 200 lines of output + exit code

The agent can always request more detail with a follow-up tool call.

### 4f. RepoMap Budgeting

Aider's binary search approach: given a fixed token budget (e.g., 1024 tokens
for repo context), include as many high-rank files as fit, then stop. Don't
exceed the budget.

---

## 5. Session Lifecycle

```
NEW SESSION
  │
  ├── Load config (~/.heirloom/config.yaml)
  ├── Load modes (~/.heirloom/modes/)
  ├── Load project memory (~/.heirloom/memory/<project-slug>/)
  │     └── Inject relevant memories into system prompt
  ├── Parse RepoMap (if enabled)
  │
  ▼
RUNNING
  │
  ├── User input → Plan (todo list)
  ├── Execute plan (ReAct + Reflect loop)
  ├── Compact when needed (structured YAML summary)
  ├── Checkpoint before file writes
  │
  ▼
END SESSION
  │
  ├── Final compaction (full structured summary)
  ├── Update memory files:
  │     ├── Append to sessions.md
  │     ├── Update decisions.md (new decisions)
  │     ├── Update patterns.md (new patterns observed)
  │     └── Update pitfalls.md (new pitfalls encountered)
  └── Save final checkpoint
```

### Resuming a Session

1. Load last session's structured compaction summary
2. Scan memory files for relevant context
3. Present summary to user: "Previous session: refactored auth module, 3/6 steps done"
4. User can continue or start fresh

---

## 6. What We Haven't Covered (Future Phases)

| Concern | Status | When |
|---------|--------|------|
| Multi-turn planning with backtracking | Deferred | Post-Phase 3 |
| Tool call dependency resolution (B must run after A) | Not needed yet | If parallel execution becomes common |
| Streaming tool execution (start executing before full args arrive) | Not needed | Only useful for very long tool calls |
| HITL (human-in-the-loop) for critical operations | Permission system covers this | Phase 3 |
| Agent-to-agent communication protocol | MCP already defines this | Phase 9 |
| Cross-session task continuation | Session resume handles this | Phase 4 |
| Cost tracking per session | Nice-to-have | Post-MVP |
| Model fallback chains (try X, if rate-limited try Y) | Post-Phase 1 if needed | Provider layer |
