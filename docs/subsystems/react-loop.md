## 3. ReAct Implementation — The Right Variant

**Status:** current · verified 2026-08-13 · covers `src/agent.ts`, `src/selfreflection/`, `src/tools/todo.ts`

### Standard ReAct

```
Thought: I need to read the auth module first.
Action: read_file("src/auth/index.ts")
Observation: [file contents]
Thought: The issue is in the token validation function.
Action: edit("src/auth/index.ts", old_string, new_string)
Observation: Edit applied successfully.
Thought: Let me verify by running the tests.
Action: run_bash("npm test -- src/auth")
Observation: 12 tests passing, 0 failing.
```

### Why standard ReAct falls short

1. **No backtracking** — no structured way to undo a wrong edit.
2. **No planning** — dives into implementation without a plan.
3. **No reflection** — doesn't verify actions achieved the goal.

### Decision: ReAct + Plan + Reflect

```
Phase 1: PLAN
  Thought: Refactor auth. Plan:
    1. Understand current auth implementation
    2. Design JWT-based replacement
    3. Implement JWT utilities
    4. Update middleware
    5. Migrate tests
    6. Verify everything passes
  Action: update_todo_list([...6 items...])

Phase 2: EXECUTE (ReAct loop per todo item)
  Action: read_file("src/auth/index.ts")
  Action: search("authenticate|login|session")
  [LLM processes results, marks the step complete]

Phase 3: VERIFY
  Action: run_bash("npm test")
  Observation: All tests pass.
  [Final summary to the user]
```

Backtracking is provided by shadow-Git checkpoints (`/undo`) rather than a
loop construct.

### Reflection loop rules

After every tool action, the agent asks itself:
1. Did the tool succeed? If not → try a different approach (max 1 retry)
2. Did the tool produce expected output? If not → investigate why
3. Does the output change the plan? If yes → update the todo list

This is Aider's self-reflection pattern, formalized (implementation:
`src/selfreflection/`).

### Who owns the loop

The loop shape (ReAct + Plan + Reflect) is core engine code, not user
configuration. Users shape *behavior* — through modes, custom instructions,
skills, and permissions — never by swapping loop implementations. No
shipping agent (opencode, Aider, RooCode, Claude Code) exposes loop choice;
the loop is the product, and a pluggable loop is an abstraction with one
implementation.

Planning intensity is at the model's discretion, not a config knob:
`update_todo_list` (tool-spec.md) is always available, and the system prompt
says to plan multi-step tasks and skip planning for trivial ones. Fallback
if model discretion proves unreliable: a `planning: always | auto | off`
mode field — deferred until observed need.

### Todo list mechanics (shipped)

The current list reaches the model every sub-turn: the loop re-reads the
store at the request-build site (`src/agent.ts`) and prepends a
`# Current todo list` block to the volatile prefix; the tool result also
returns the full list, so the model sees state after every update. The TUI
renders the list as a live checklist panel above the input
(`src/ui/TodoPanel.tsx`), cleared at each turn start. Sub-agents spawned via
`new_task` run with their own isolated store — the orchestrator threads a
fresh `TodoStore` through each per-call tool context (no shared global
pointer is mutated) and wires the sub-run's `getTodos` to it — so a
sub-agent's plan updates never clobber the parent's panel, and the
sub-agent's own context gets its own plan.

### Error taxonomy

Tool errors are plain strings with informal prefixes (tool-spec.md §7);
there is no formal enum. `TYPE_ERROR` and `TEST_FAILURE` are not tool error
codes — they are *content classifications* the diagnostics/reflection
machinery applies to `run_bash` output (compilation failures, failing test
runs), fed back to the model as a system note rather than a tool error.

---

_Part of the [subsystems deep dive](../subsystems.md)._
