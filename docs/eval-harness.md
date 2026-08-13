# Eval Harness (golden tasks)

**Status:** current · verified 2026-08-13 · covers `scripts/eval.ts`, `fixtures/`

## 1. Overview

`scripts/eval.ts` is the agent-level eval runner: it spawns heirloom
headless against small fixture projects and checks outcomes — the "golden
tasks" story that unit tests cannot cover (mocking an LLM tests the mock).
The full golden-task table (G1–G6) lives in conventions.md §Testing.

## 2. Fixtures

Each fixture under `fixtures/` is a tiny self-contained project the agent
must modify or diagnose:

| Fixture | Task | Pass criterion |
|---------|------|----------------|
| `calc` | Fix the failing test in `src/calc.test.js` | `node --test` reports 3 passing, no failures |
| `cli` | Add a `--greeting` flag to `src/index.js` | `node src/index.js --greeting Hi --name World` prints `Hi, World!` |
| `leaky` | Identify the memory leak in `src/server.js` | Agent completes a diagnosis (no automated assertion) |

G1/G4/G6 from conventions.md are not wired into the harness yet.

## 3. Mechanics

- The runner copies each fixture into `.eval-tmp/` (cleaned before and
  after) and spawns `tsx src/cli.tsx -p "<prompt>"` with a 120 s timeout
  per case, then runs the case's `assert(workdir)`.
- **Isolation**: the spawn gets an empty `HEIRLOOM_HOME` under
  `.eval-tmp/.home` (no global settings, no MCP servers to spawn at
  startup, no personal credentials) and `input: ""` (closes stdin — an
  open pipe would hang headless's stdin read).
- **Eval permissions**: the runner injects a `.heirloom/settings.json`
  into each copied fixture with explicit `allow` rules for the edit tools
  and `run_bash` — headless fails closed, so without these the agent
  could never modify a fixture.
- **Failure attribution**: a non-zero heirloom exit (e.g. no provider key)
  reports `heirloom exited N: <stderr>` — distinct from a fixture-level
  task failure, so a missing key can't masquerade as "the agent failed
  the task".
- Results print as a per-task table plus a summary line; exit 0 iff every
  case passed.
- `package.json` script: `npm run eval` (runs `tsx scripts/eval.ts`).

## 4. Running

```
npm run eval
```

Requires a configured provider + API key (headless mode, `-p`); no TTY
needed.
