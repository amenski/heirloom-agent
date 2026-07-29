# Heirloom — Code Conventions

## TypeScript

### Module system
- ESM only (`"type": "module"` in package.json)
- All relative imports use `.js` extension: `import { foo } from "./bar.js"`
- `import type` for type-only imports

### Types
- Never use `any`. Use `unknown` and narrow.
- Canonical types in `src/types.ts` never import from any provider SDK.
- Provider-specific types stay inside `src/providers/<name>.ts`.
- Prefer interfaces for objects, `type` for unions and primitives.

### Naming
- Files: kebab-case (`tool-registry.ts`, `apply-diff.ts`)
- Types/interfaces: PascalCase (`ToolDef`, `Message`)
- Functions/variables: camelCase (`executeTool`, `pendingCalls`)
- Constants exported from modules: UPPER_SNAKE only if truly constant primitive values

### Functions
- Pure functions preferred. Side effects (I/O, stdout) at the edges.
- No default exports. Named exports only.
- Functions under 40 lines. If longer, extract.

### Error handling
- Never throw in tool handlers — return `ToolOutput` with `error` field.
- `try/catch` around any `JSON.parse` of LLM output.
- Provider errors: surface to agent loop, don't crash the CLI.

### Comments
- None by default. Code should be self-documenting.
- Only add comments for non-obvious design decisions (tradeoffs, gotchas).

### File structure
- One concept per file. If a file exceeds 200 lines, split it.
- `index.ts` files only re-export — no logic.

## Documentation Workflow

- `todo.md` is **untracked** working state (gitignored): checkmarks, audit
  findings, acceptance-criteria drafts, agent instructions. Append to it;
  never regenerate it wholesale.
- `docs/` is the committed record. When a phase completes, promote what
  matters: implementation decisions → the relevant spec (with a line in its
  changelog/design-decisions section), AC tables → test descriptions.
  Findings and checkmarks are ephemeral — they die with the todo.
- Nothing in `docs/` may require reading `todo.md` to understand.

## Git

### Commits
- `feat:` — new feature or phase
- `fix:` — bug fix
- `refactor:` — restructuring without behavior change
- `docs:` — documentation only
- `chore:` — tooling, config, deps

### Branches
- `main` — always working, always compiles
- Feature branches for multi-commit work

## Testing

### Framework
Vitest (decided 2026-07-28): ESM-native (matches `"type": "module"`),
zero-config TypeScript, watch mode. `npm test` runs `vitest run`.

### Unit tests (from Phase 2)
Highest-value targets, in priority order:
1. **Edit strategies** — each of the 6 tools against fixture files: clean
   match, no match, count mismatch, multi-file patch atomicity (tool-spec.md).
2. **Permission engine** — insertion order, last-match-wins, glob patterns.
3. **ToolRegistry** — mode gating returns exactly the allowed tool subset.
4. **Compaction budget** — threshold math, tier classification, fidelity check.
5. **Session loader** — torn last line, state-record folding, compaction
   reconstruction.

Provider adapters and the agent loop are covered by golden tasks, not unit
tests — mocking an LLM tests the mock.

### Golden tasks (agent-level evals)
Small end-to-end tasks under `fixtures/`, re-run after any prompt or loop
change (see system-prompt.md, "Changing the Prompt"). Manual for now; a
harness is post-MVP.

| # | Task | Verifies |
|---|------|----------|
| G1 | "What does src/agent.ts do?" in ask mode | read-only gating, no writes |
| G2 | Fix a planted failing test in `fixtures/calc` | ReAct edit + verify cycle |
| G3 | Add a `--json` flag to `fixtures/cli` | multi-step feature, edit-tool selection |
| G4 | Rename a function used across 3 files | apply_patch / cross-file edits |
| G5 | "Why does `fixtures/leaky` grow memory?" | search + read diagnosis, no edits |
| G6 | Task long enough to trigger compaction, then finish | compaction fidelity (Phase 4+) |

Pass = correct outcome **and** no out-of-scope file modified.

## Tool design
- Every tool returns `ToolOutput`, never throws.
- Tool schemas (JSON Schema for LLM) live alongside the handler.
- Prefer explicit parameters over flexible ones (e.g., `path: string` not `args: string`).
