# Deep Dive: Memory, Context, ReAct, Compaction, Token Optimization

> Design decisions that carry through every phase. Get these wrong and you
> rewrite the agent loop later; get them right and each phase slots in cleanly.

This doc is an index. Each numbered section below lives in its own file under
`docs/subsystems/`. **Section numbers are stable**: other specs cite these as
"subsystems.md §1", "§3", "§6" and so on, so keep the numbering and the `##
N. Title` headings intact when editing — renumbering breaks those references.

| § | Area | What's in it |
|---|------|--------------|
| [§1](./subsystems/memory-architecture.md) | Memory Architecture | The four memory tiers, what persists where, per-project layout |
| [§2](./subsystems/context-management.md) | Context Management | Compaction strategy and fidelity checks, the `keepBoundary` invariant, when to compact, pruning old tool outputs |
| [§3](./subsystems/react-loop.md) | ReAct Implementation | Which ReAct variant the agent loop uses and why; the error-code taxonomy |
| [§4](./subsystems/token-optimization.md) | Token Optimization | Prompt-caching-friendly prefixes, test-by-deletion, per-turn token costs |
| [§5](./subsystems/session-lifecycle.md) | Session Lifecycle | Turn boundaries, resume, what a session owns |
| [§6](./subsystems/failure-modes.md) | Failure Modes & Robustness | Retry policy, stale-file detection, loop detection, degradation rules |
| §7 | Future Phases | Deferred concerns — kept below, it's a short table |

---

## 7. What We Haven't Covered (Future Phases)

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
