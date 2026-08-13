# Update Check

**Status:** current · verified 2026-08-13 · covers `src/common/update-check.ts`, `src/ui/views/UpdatePrompt.tsx`

## 1. Overview

On startup, heirloom checks whether a newer version of itself is on the npm
registry and offers an interactive install prompt. It is **inert for
private packages** — which this repo is — so in practice the feature is a
no-op here.

## 2. Behavior

- **Fire-and-forget check** at launch (`src/cli.tsx`):
  `checkForNpmUpdate(packageInfo)` runs `npm view <name> dist-tags.latest
  --json` with a 10 s timeout; any failure resolves to "no update"
  silently.
- **Prompt** (`promptForPendingUpdate`) renders the `UpdatePrompt` view
  when a newer version was recorded: options are **Install**
  (`npm install -g <name>@<version>`, then exit), **Ignore** (clear the
  pending entry), **Ignore this version** (remember it).
- **State file**: `~/.heirloom/update-check.json` —
  `{ ignoredVersions: string[], pending: { version, checkedAt } | null }`.

## 3. Private packages — the no-op guarantee

`checkForNpmUpdate` and `promptForPendingUpdate` both **return immediately
for `private: true` packages**, and the prompt path additionally clears any
stale pending entry. Reason (incident 2026-08-06): a private package is by
definition not on npm under its name, so any registry answer is about
*someone else's* package — the registry's `heirloom` is an unrelated
photo-backup tool. The code comment documents this incident in full.

## 4. Telemetry note

This npm-registry query is the **only automatic network contact** heirloom
makes, and it is inert while the package is private. Everything else
stands by the no-telemetry guarantee (config-spec.md §13).
