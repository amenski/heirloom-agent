# Mode Specification

A mode is a YAML-defined persona that gates tool access, file restrictions,
model selection, and behavioral instructions.

## Schema

```yaml
# Required
slug: string             # Unique identifier, kebab-case (e.g., "code", "my-reviewer")
name: string             # Display name (e.g., "Code", "PR Reviewer")
roleDefinition: string   # Identity/expertise placed at start of system prompt

# Optional
description: string      # Short summary for mode selector
whenToUse: string        # Guidance for orchestrator auto-selection
groups: string[]         # Allowed tool groups: read, edit, command, mcp, workflow
fileRegex: string        # Restrict file modifications to matching paths
customInstructions: string  # Additional rules appended to system prompt
model: string            # Sticky model (provider/model-id), e.g., "anthropic/claude-sonnet-4-6"
```

## Tool Groups

| Group | Tools | Purpose |
|-------|-------|---------|
| `read` | read_file, list_files, glob, search | Information gathering |
| `edit` | edit, apply_diff, apply_patch, search_replace, edit_file, write_to_file | Code modification |
| `command` | run_bash | Shell execution |
| `mcp` | use_mcp_tool, access_mcp_resource | External tool servers |
| `workflow` | switch_mode, new_task, ask_followup_question, attempt_completion | Meta-tools |

## Always-Available Tools

These tools bypass mode gates — they're always accessible:
- `ask_followup_question` — ask the user for clarification
- `attempt_completion` — signal task completion
- `switch_mode` — change to another mode
- `new_task` — delegate to a sub-agent

## Built-in Modes

### code
```yaml
slug: code
name: Code
roleDefinition: "You are a senior software engineer. Write clean, well-typed,
  well-tested code. Prefer small, focused functions. Add appropriate error handling."
groups: [read, edit, command]
```

### ask
```yaml
slug: ask
name: Ask
roleDefinition: "You are a knowledgeable technical assistant. Answer questions
  about the codebase accurately and concisely. Do not modify any files."
groups: [read]
```

### architect
```yaml
slug: architect
name: Architect
roleDefinition: "You are a systems architect. Analyze requirements, design
  solutions, and produce clear specifications. Think before coding."
groups: [read, edit]
fileRegex: "\\.(md|yaml|yml|json|txt)$"
customInstructions: "Only write to documentation and configuration files.
  For implementation, delegate to the Code mode via new_task."
```

### debug
```yaml
slug: debug
name: Debug
roleDefinition: "You are a systematic debugger. Form hypotheses, gather evidence,
  isolate root causes. Never guess — verify every assumption."
groups: [read, edit, command]
```

### orchestrator
```yaml
slug: orchestrator
name: Orchestrator
roleDefinition: "You are a task orchestrator. Break complex requests into
  subtasks, delegate each to the appropriate mode, and synthesize results."
groups: [workflow]
```

## Configuration Precedence

1. Project `.heirloom/modes/<slug>.yaml` (highest)
2. Global `~/.heirloom/modes/<slug>.yaml`
3. Built-in defaults (lowest)

Project overrides global. Global overrides built-in.

## Custom Modes

Users define custom modes by creating YAML files. Example:

```yaml
# ~/.heirloom/modes/reviewer.yaml
slug: reviewer
name: PR Reviewer
roleDefinition: "You are a thorough code reviewer. Check for bugs, style
  violations, security issues, and performance problems."
groups: [read]
customInstructions: "Always reference line numbers. Suggest concrete fixes,
  not vague advice. Prioritize bugs over style."
```
