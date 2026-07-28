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
- Phase 1-2: manual verification against acceptance criteria
- Phase 3+: add unit tests for permissions, tool registry, edit strategies
- No test framework decided yet — lightweight (Node test runner or Vitest)

## Tool design
- Every tool returns `ToolOutput`, never throws.
- Tool schemas (JSON Schema for LLM) live alongside the handler.
- Prefer explicit parameters over flexible ones (e.g., `path: string` not `args: string`).
