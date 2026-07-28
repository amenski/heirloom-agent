# Skill Specification

Skills are instruction packages loaded on demand (progressive disclosure).
They live as `SKILL.md` files in skill directories.

## File Location

- `~/.heirloom/skills/<name>/SKILL.md` — global skills
- `.heirloom/skills/<name>/SKILL.md` — project skills

## Format

```markdown
---
name: my-skill
description: One sentence covering what this skill does and when to trigger it.
  Front-load concrete keywords the user might say.
mode: code            # Optional: only activate in this mode
---

# Skill Body

Instructions, examples, and references. This content is injected into the
system prompt when the skill is triggered by the user's request matching
the description.
```

## Frontmatter

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Lowercase, hyphen-separated, max 64 chars. Must match folder name. |
| `description` | Yes | What the skill does AND when to trigger. Written in third person. Front-load trigger keywords. |
| `mode` | No | Restrict to a specific mode (e.g., `code`, `architect`). |

## Progressive Disclosure

1. At startup, scan all skill directories and index by `name` + `description`.
2. On each user request, check if any skill's description semantically matches.
3. If a match is found, inject the skill's body into the system prompt.
4. If no match, the skill's content never touches the context window.

This keeps context small while making an unlimited number of skills available.

## Example: TypeScript skill

```markdown
---
name: typescript
description: Use when writing or reviewing TypeScript code. Triggers on
  "typescript", "ts", "type error", "interface", "generics".
---

# TypeScript

- Use strict mode (`strict: true` in tsconfig).
- Prefer interfaces over type aliases for object shapes.
- Use `import type` for type-only imports.
- Never use `any` — use `unknown` and narrow.
- Prefer `const` assertions over explicit literal types.
- Use template literal types for string patterns.
- Use `satisfies` for type-checking without widening.
```
