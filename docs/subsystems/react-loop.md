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

### Who Owns the Loop

The loop shape (ReAct + Plan + Reflect) is core engine code, not user
configuration. Users shape *behavior* — through modes, custom instructions,
skills, and permissions — never by swapping loop implementations. No shipping
agent (opencode, Aider, RooCode, Claude Code) exposes loop choice; the loop
is the product, and a pluggable loop is an abstraction with one implementation.

Planning intensity is at the model's discretion, not a config knob:
`update_todo_list` (tool-spec.md) is always available, and the system prompt
says to plan multi-step tasks and skip planning for trivial ones. Fallback if
model discretion proves unreliable: a `planning: always | auto | off` mode
field — deferred until observed need.

### Todo List Mechanics (shipped)

The current list reaches the model every sub-turn: the loop re-reads the
store at the request-build site (agent.ts) and prepends a `# Current todo
list` block to the volatile prefix; the tool result also returns the full
list, so the model sees state after every update. The TUI renders the list as
a live checklist panel above the input (TodoPanel.tsx), cleared at each turn
start. Sub-agents spawned via `new_task` run with their own isolated store —
the orchestrator threads a fresh `TodoStore` through each per-call tool
context (no shared global pointer is mutated) and wires the sub-run's
`getTodos` to it — so a sub-agent's plan updates never clobber the parent's
panel, and the sub-agent's own context gets its own plan.

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

---

_Part of the [subsystems deep dive](../subsystems.md)._
