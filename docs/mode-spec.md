# Mode Specification

**Status:** current · verified 2026-08-13 · covers `src/modes/{loader.ts,builtin/*.yaml}`

## 1. Overview

A mode is a YAML-defined persona that gates tool access, restricts file
modifications, and adds behavioral instructions. Modes shape the system
prompt (role definition at the top, custom instructions after the base
rules — system-prompt.md) and the tool set offered to the model
(`src/cli.tsx` filters via `registry.getByMode(mode.groups)`).

## 2. Schema

`ModeConfig` (`src/modes/loader.ts:5`):

```yaml
# Required
slug: string             # Unique identifier, kebab-case (e.g. "code", "my-reviewer")
name: string             # Display name (e.g. "Code", "PR Reviewer")
roleDefinition: string   # Identity/expertise placed at the start of the system prompt

# Optional
description: string      # Short summary for the mode selector
groups: string[]         # Allowed tool groups: read, edit, command, mcp, workflow
fileRegex: string        # Restrict file modifications to matching paths
customInstructions: string  # Additional rules appended to the system prompt
model: string            # Sticky model (provider/model)
```

YAML is parsed by a small hand-rolled parser (`src/modes/loader.ts:16`):
top-level keys, `>`/`|` folded blocks, indented `- ` lists, `[a, b]` inline
arrays, quoted scalars.

## 3. Tool groups

`ToolGroup = "read" | "edit" | "command" | "mcp" | "workflow"`
(`src/tools/types.ts:40`).

| Group | Tools | Purpose |
|-------|-------|---------|
| `read` | read_file, list_files, glob, search, web_fetch, web_search | Information gathering |
| `edit` | edit, edit_file, search_replace, apply_diff, apply_patch, write_to_file | Code modification |
| `command` | run_bash, run_bash_background, check_job, kill_job | Shell execution |
| `mcp` | `mcp__<server>__<tool>` (dynamic, per connected server) | External tool servers |
| `workflow` | new_task | Sub-agent delegation |

## 4. Always-available tools

These bypass mode gates regardless of group:

- `ask_user_question` — structured clarification questions (all groups)
- `update_todo_list` — the task plan checklist (all groups; tool-spec.md)
- `load_skill` — skill content injection (`always: true` + read;
  skill-spec.md)
- `switch_mode` — persona-mode switch (all groups; auto-switch, no
  confirmation — tool-spec.md)
- `attempt_completion` — end-the-turn signal (all groups; tool-spec.md)

`new_task` is **not** always-available: it is `workflow`-group only, so only
the orchestrator mode can delegate.

## 5. Built-in modes

`src/modes/builtin/*.yaml`:

### code (default mode)
```yaml
slug: code
name: Code
groups: [read, edit, command]
```

### ask
```yaml
slug: ask
name: Ask
groups: [read]
```

### architect
```yaml
slug: architect
name: Architect
groups: [read, edit]
fileRegex: "\\.(md|yaml|yml|json|txt)$"
```

### debug
```yaml
slug: debug
name: Debug
groups: [read, edit, command]
```

### orchestrator
```yaml
slug: orchestrator
name: Orchestrator
groups: [workflow]
```

## 6. Resolution precedence

`ModeLoader.load(slug, projectDir?)` (`src/modes/loader.ts:74`) searches, in
order (first hit wins, results cached):

1. `./.heirloom/modes/<slug>.yaml` (project — only when projectDir is passed)
2. `$HEIRLOOM_HOME || ~/.heirloom/modes/<slug>.yaml` (global)
3. `src/modes/builtin/<slug>.yaml` (built-in defaults)

Project overrides global; global overrides built-in. `listAll()` enumerates
built-in slugs only.

## 7. Custom modes

```yaml
# ~/.heirloom/modes/reviewer.yaml
slug: reviewer
name: PR Reviewer
roleDefinition: "You are a thorough code reviewer. Check for bugs, style violations, security issues, and performance problems."
groups: [read]
customInstructions: "Always reference line numbers. Suggest concrete fixes, not vague advice. Prioritize bugs over style."
```

## 8. Switching modes

- `/mode <slug>` — text command (with completion).
- `/modes` or **Ctrl+O** — interactive picker (↑↓ navigate, Enter switch,
  Esc close). Ctrl+O lives in PromptInput like the ⇧Tab posture cycle —
  the idle input wire routes all keystrokes through it, so chords handled
  anywhere else would be dead (see keybindings.ts notes).
- The model itself can switch via the `switch_mode` tool (tool-spec.md).
- The status bar always shows the active mode (colored dot + name) right
  next to the approval-posture indicator; it refreshes immediately on any
  switch.

## 9. Verified against

`src/modes/loader.ts` (ModeConfig, load, listAll) · `src/modes/builtin/*.yaml`
(all five built-ins) · `src/tools/types.ts` (ToolGroup) · `src/cli.tsx`
(mode → tool-filter wiring, default mode)
