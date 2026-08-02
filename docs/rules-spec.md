# Hierarchical project rules

Scoped, user-authored rule files that are recursively loaded from
`.heirloom/rules/**/*.md` and injected into the system prompt. Additive to the
existing single-file `.heirloom/instructions.md` / `AGENTS.md` mechanism — it
does not replace it.

Implemented by `loadProjectRules(projectDir)` in `src/prompt.ts`, called from
`buildStablePreamble` immediately after the project-instructions section (so
rules land in the cacheable prefix, before the skills index).

## Format

Each `*.md` file under `.heirloom/rules/` becomes one section:

```
### Rule: <scope>
<trimmed file content>
```

All sections are grouped under a single top-level header:

```
# Project Rules
```

If the rules directory is absent, empty, or yields no usable content, no block
is emitted (the loader returns `null`).

## Scoping

The `<scope>` is the file's path relative to the rules directory, with the
`.md` suffix removed and path separators normalized to `/`:

| File                              | Scope         |
| --------------------------------- | ------------- |
| `.heirloom/rules/style.md`        | `style`       |
| `.heirloom/rules/api/naming.md`   | `api/naming`  |
| `.heirloom/rules/db/schema.md`    | `db/schema`   |

## Ordering

Deterministic (byte-stable, required for prompt caching). Within every
directory:

1. Files before subdirectories.
2. Alphabetical (locale compare) within each group.
3. Directories recursed depth-first, in the same file-then-dir order.

## Caps

Total assembled rule content is capped at **20 KB** (`MAX_RULES_BYTES`). Once a
section would push the total over the cap, it and all remaining sections are
dropped and a truncation note is appended:

```
*(Project rules truncated: size cap reached.)*
```

## Trust model

Rule content is treated as **user-authored**, at the same trust level as
`.heirloom/instructions.md`. It carries no new attack surface beyond what the
existing instructions file already grants.

One hardening measure specific to the recursive loader: a `*.md` entry whose
real path (after resolving symlinks) falls **outside** `projectDir` is skipped,
so a symlink inside `.heirloom/rules/` cannot pull arbitrary files from
elsewhere on disk into the prompt. Empty and unreadable files (including
dangling symlinks) are silently skipped.

---

# Plan-mode research notes

A sibling of the rules loader for prior investigation notes. Markdown files are
recursively loaded from `.heirloom/research/**/*.md` and injected **only in plan
mode**, so planning is grounded in existing research.

Implemented by `loadProjectResearch(projectDir)` in `src/prompt.ts` (shares the
walk / symlink-escape / truncation logic with `loadProjectRules`), called from
`buildVolatileContext` when `planMode` is set — research therefore lands in the
per-turn volatile context (rebuilt each turn, kept out of the byte-stable
cached prefix), not the stable preamble.

## Format

Same mechanics as rules, different heading and header:

```
# Research Notes

### Note: <scope>
<trimmed file content>
```

`<scope>` is the path relative to `.heirloom/research/`, `.md` stripped,
separators normalized to `/` (e.g. `.heirloom/research/api/gateway.md` →
`api/gateway`). Ordering and trust model match the rules loader (files before
subdirectories, alphabetical, symlink-escape skip, user-authored content).

## Caps

Total assembled research content is capped at **8 KB** (`MAX_RESEARCH_BYTES`).
On overflow the same truncate-with-note behavior applies:

```
*(Research notes truncated: size cap reached.)*
```

## Why volatile, not stable

Research is a plan-mode-only aid: it must not pollute the cacheable stable
prefix (which is byte-stable per session and shared with normal conversation),
and notes edited on disk should appear on the next plan-mode turn without a
session restart. The volatile context is re-read from disk per turn at the
interactive bridge (`cli.tsx`), so new notes show up immediately.
