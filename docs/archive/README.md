# Archive — historical records

**Status:** archive index · created 2026-08-13

## What this folder is

Historical records of the project: superseded designs, completed task briefs
(the `handoff-*` pattern), resolved trackers, and release notes. Everything
here describes the project **as it was**; none of it describes current
behavior. The live documentation set is indexed in [docs/README.md](../README.md).

## Rules

- Nothing in `docs/archive/` is required reading.
- No current doc may link into `docs/archive/` — historical context belongs
  in changelog/design-decisions sections of live specs.
- Archived files never receive a `current` status line.
- Resurrecting an idea from the archive requires re-verifying it against the
  code and adding a `current` status line before it re-enters the live set.

## Contents

| File | Why archived | See instead |
|------|--------------|-------------|
| `ui-redesign-spec.md` | Superseded by the Ink migration that won; targets the deleted `src/tui/` renderer | [architecture.md](../architecture.md), [cli-spec.md](../cli-spec.md) |
| `migration-aisdk-ink.md` | Migration plan, completed | [architecture.md](../architecture.md) §Providers |
| `handoff-aisdk-ink-finish.md` | Task brief, completed | [architecture.md](../architecture.md) |
| `handoff-model-discovery.md` | Task brief, completed | [cli-spec.md](../cli-spec.md), [provider-spec.md](../provider-spec.md) |
| `handoff-model-fixes.md` | Task brief, completed | [provider-spec.md](../provider-spec.md) |
| `handoff-security-fixes.md` | Task brief, completed; D1–D4 verified fixed | [security-spec.md](../security-spec.md) |
| `handoff-status-bar.md` | Task brief, completed | [cli-spec.md](../cli-spec.md) |
| `handoff-ui-refresh.md` | Task brief, completed; references a deleted screenshot | [cli-spec.md](../cli-spec.md), [theme-spec.md](../theme-spec.md) |
| `handoff-ui-restructure.md` | Task brief, completed | [cli-spec.md](../cli-spec.md) |
| `todo.md` | Deferred-work tracker; every item marked done | [docs/README.md](../README.md) |
| `REDESIGN.md` | Plan whose Phase 2+ was abandoned; contains a false claim (`credentials.json` — the real store is `credentials.yaml`) | [config-spec.md](../config-spec.md), [permission-spec.md](../permission-spec.md) |
| `FOLLOWUPS.md` | Bug-investigation tracker, resolved; the one open item was folded into root `todo.md` | [troubleshooting.md](../troubleshooting.md) |
| `releases/v0.1.0.md` | Release notes for the v0.1.0 tag | root `README.md` |

## Caveat

Archived files are **records, not truth**. They may contain dead links,
retired model IDs (e.g. `gpt-4o`, `deepseek-chat`), references to deleted
source files (`src/tui/`, `src/index.ts`), and known-false claims (e.g.
`REDESIGN.md`'s `credentials.json`). Treat them as history, not reference.
