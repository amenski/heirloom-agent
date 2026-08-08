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

**Write policy (who decides what's durable):**
- At session end, the compactor's structured summary (§2) is the source:
  each `decisions[]` entry is a candidate memory fact; `files[]` and
  `errors_resolved[]` go to `sessions.md` only.
- The LLM proposes, a filter disposes: skip facts derivable from the repo
  (code structure, git history, anything in docs/) and facts that only
  mattered to this one conversation.
- The user saying "remember X" bypasses the filter — written immediately.

**Injection cap:** memory injected at session start is budgeted at 1,024
tokens, filled index-first then top-relevance facts until full (same
budget-fill mechanism as RepoMap, §4f). Facts beyond the cap remain
reachable via explicit search over the memory directory.

**Future:** Add LanceDB for semantic search when memory exceeds ~50 files.
Start with grep over markdown — it's fast enough for hundreds of files.

---

---

_Part of the [subsystems deep dive](../subsystems.md)._
