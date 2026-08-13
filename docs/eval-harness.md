# Eval Harness (golden tasks)

**Status:** current · verified 2026-08-13 · covers `scripts/eval.ts`, `fixtures/` · ⚠️ see §4 — the runner is not currently runnable as written

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
  after), spawns `tsx <entry> -p "<prompt>"` with a 120 s timeout per case,
  then runs the case's `assert(workdir)`.
- Results print as a per-task table plus a summary line; exit 0 iff every
  case passed.
- `package.json` script: `npm run eval` (runs `tsx scripts/eval.ts`).

## 4. Known breakage (flagged 2026-08-13)

The runner as committed points at **deleted/renamed surfaces**:

- `HEIRLOOM_SRC` is `src/index.ts` — the entry point is now `src/cli.tsx`.
- The spawn passes `--approve edits` — no `--approve` flag exists
  (cli-spec.md §2). Headless runs fail closed, so the fixtures would need
  explicit `allow` rules (or a fixture-level `defaultMode: allowAll`)
  instead.

Fixing = point `HEIRLOOM_SRC` at `src/cli.tsx` and replace the flag with a
per-fixture `.heirloom/settings.json` carrying the permissions the task
needs. Not done as part of the docs pass (behavior change, not coverage).

## 5. Running

```
npm run eval
```

Requires a configured provider + API key (headless mode, `-p`); no TTY
needed.
