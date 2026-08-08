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

---

_Part of the [subsystems deep dive](../subsystems.md)._
