# Tool Specification

The exact contract for every tool: parameters, output shape, truncation
limits, and error codes. This is the Phase 2 blueprint — each tool's
implementation and its LLM-facing JSON Schema description must match this doc.

Design principle (SWE-agent's ACI): tools are designed for LLM consumption.
Every output answers "what happened and what can I do next" — truncations say
what was cut and how to get more; errors say what failed and suggest the fix.

---

## Common Contract

- Every handler returns `ToolOutput { content, error? }`. **Never throws**
  (conventions.md). Provider/infra exceptions are the agent loop's problem.
- `error` format: first line `CODE: message`, optional second line
  `Hint: <suggested next action>`. Codes come from the taxonomy in
  subsystems.md §3, plus `COUNT_MISMATCH` (added here).
- All `path` parameters are **absolute**. A relative path → `PARSE_ERROR`
  with hint "use an absolute path".
- Handlers receive `ToolContext` (workingDir, sessionId, askUser, signal).
  `signal` aborts long operations; an aborted tool returns
  `COMMAND_FAILED: aborted by user`.
- An empty result (no matches, no files) is **content, not an error** — the
  LLM should read "nothing found" as information, not as a failure to retry.

### Truncation Limits

| Tool | Limit | Overflow behavior |
|------|-------|-------------------|
| `read_file` | 500 lines/call, 2,000 chars/line | Footer: `[showing lines 1–500 of 1842 — call again with offset=501]` |
| `list_files` | 200 entries | Footer with total count |
| `glob` | 100 paths | Footer with total count |
| `search` | 50 matches, 250 chars/line | Footer: `[50 of 312 matches — narrow the pattern or add fileTypes]` |
| `run_bash` | last 200 lines of output | Header notes how many lines were dropped |

---

## Read Group

### `read_file(path, offset?, limit?)`
- Returns numbered lines (`N\tcontent`), 1-based. Numbering lets edit tools
  target lines precisely.
- `offset` (default 1) and `limit` (default 500) page through large files.
- Binary file → `[binary file: 48,213 bytes]` as content.
- Errors: `FILE_NOT_FOUND` (also for directories, with hint "path is a
  directory — use list_files").

### `list_files(path, recursive?)`
- Directories get a trailing `/`; sorted directories-first, then alpha.
- Respects `.gitignore`; never descends into `.git/` or `node_modules/`.
- Errors: `FILE_NOT_FOUND`.

### `glob(pattern, path?)`
- Standard glob incl. `**`. `path` defaults to `workingDir`.
- Results sorted by mtime, newest first (recently touched files are usually
  what the task is about).

### `search(pattern, path?, fileTypes?)`
- Regex search. Uses `rg` when installed (respects .gitignore, skips binary);
  falls back to a JS directory walk with the same skip rules.
- Output: `path:line: matched text`, one per line.
- `fileTypes`: extension list (`["ts","md"]`).
- Invalid regex → `PARSE_ERROR` with the regex engine's message.

---

## Edit Group

All edit tools are **atomic per call**: on any error the file(s) are
untouched. Success output always includes the replacement/hunk count so the
LLM can sanity-check the effect.

### `edit(path, old_string, new_string)`
The default editing tool. `old_string` must match the file byte-for-byte
(whitespace included) and occur **exactly once**.
- 0 matches → `DIFF_NO_MATCH` + hint: "re-read the file — do not guess at
  whitespace; or use search to locate the text".
- \>1 matches → `COUNT_MISMATCH: found N occurrences` + hint: "add
  surrounding lines to make it unique, or use edit_file with expected count".
- Success: `Edited /abs/path (1 replacement)`.

### `edit_file(path, search, replace, expected_count)`
Like `edit` but replaces **all** occurrences iff the actual count equals
`expected_count`.
- Mismatch → `COUNT_MISMATCH: expected 3, found 5` (no partial application).

### `search_replace(path, search, replace)`
Replaces every occurrence, no count validation.
- Success: `Replaced 7 occurrences in /abs/path`.
- 0 occurrences → `DIFF_NO_MATCH`.

### `apply_diff(path, diff)`
Applies a unified diff to one file. Context lines must match exactly (no
fuzz in v1).
- Failure → `DIFF_NO_MATCH: hunk 2 of 3 — context line "const x = 1" not
  found near line 40` + hint to re-read the region. File untouched.

### `apply_patch(patch)`
Multi-file unified diff (`--- a/… / +++ b/…` headers). Supports file creation
(`/dev/null` source) and deletion.
- **Atomic across files**: all hunks are validated in memory before anything
  is written. Failure names the file and hunk; nothing is modified.
- Success: `Patched 3 files: src/a.ts (2 hunks), src/b.ts (1), src/c.ts (1)`.

### `write_to_file(path, content)`
Full-file write. Creates parent directories.
- Success: `Wrote /abs/path (120 lines)`.
- The read-before-overwrite rule is enforced by the system prompt, not the
  tool — the tool cannot know what the model has read. (Phase 6 diagnostics
  may add a warning for blind overwrites.)

---

## Command Group

### `run_bash(command, timeout?)`
- Runs `bash -c <command>` with cwd = `ToolContext.workingDir`.
- stdout and stderr merged in stream order; last 200 lines kept; final line
  is always `exit code: N`.
- `timeout` in ms, default 60,000, max 600,000. On timeout the process tree
  is killed → `TIMEOUT: exceeded 60s` + hint "run a narrower command or
  raise timeout".
- Non-zero exit → `error: COMMAND_FAILED: exit 1` — but `content` still
  carries the full output; a failing test run is information, not noise.
- `PERMISSION_DENIED` is produced by the permission engine *before* the
  handler runs, naming the rule that blocked it.

---

## Meta Tools (workflow)

Always available regardless of mode (mode-spec.md), except `new_task`.

| Tool | Signature | Behavior | Arrives |
|------|-----------|----------|---------|
| `update_todo_list` | `todos: [{content, status}]` | Replaces the whole plan; statuses `pending \| in_progress \| completed`; CLI renders as a checklist | Phase 8 |
| `ask_followup_question` | `question, suggestions?: string[]` | Blocks on user input via `ToolContext.askUser`; returns the answer as tool output | Phase 3 |
| `attempt_completion` | `summary` | Signals the task is done; ends the turn | Phase 3 |
| `switch_mode` | `slug, reason?` | Requests a mode change; user confirms; tool defs swap next turn | Phase 3 |
| `new_task` | `mode, message` | Spawns a sub-agent with isolated context; only its summary returns | Phase 9 |
| `load_skill` | `name` | Returns the skill's SKILL.md body as tool output; unknown name → `FILE_NOT_FOUND` listing available skills | Phase 9 |

`update_todo_list` replaces the whole list each call (idempotent, no
add/remove/reorder API surface). Exactly one item should be `in_progress` at
a time; the handler warns in its output when that's violated but does not
reject.

---

## Error Code → Tool Matrix

| Code | Produced by |
|------|-------------|
| `FILE_NOT_FOUND` | read_file, list_files, all edit tools |
| `DIFF_NO_MATCH` | edit, search_replace, apply_diff, apply_patch |
| `COUNT_MISMATCH` | edit (>1 match), edit_file |
| `COMMAND_FAILED` | run_bash, any aborted tool |
| `TIMEOUT` | run_bash |
| `PERMISSION_DENIED` | permission engine (any tool) |
| `PARSE_ERROR` | any tool (bad arguments, relative paths, invalid regex) |

`TYPE_ERROR` and `TEST_FAILURE` from the subsystems.md taxonomy are not tool
error codes — they're *content* classifications the reflection loop applies
to `run_bash` output (Phase 8).
