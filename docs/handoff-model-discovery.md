# Handoff — Model & Mode Discovery (/model listing + arg completion)

**Note:** historical snapshot. Model IDs below (e.g. `gpt-4o`, `deepseek-chat`,
`llama-4-scout`) are retired — see `src/providers/models.json` for current IDs.

**For:** subagent (Sonnet). **File:** `src/index.ts` ONLY (plus a test if feasible).
Surgical. Found by driving the CLI: `/model` gives no way to discover what's available.

## Problem
- Bare `/model` prints only `Current: deepseek/deepseek-chat` + `Usage: /model <provider/model>`.
  It expects the user to already know the provider/model string. No discovery.
- `/model <tab>` completes nothing (the `completer` has no case for `/model` args).
- `/mode <tab>` slug completion is also missing (only the command NAME completes).

There's an in-repo precedent to copy: the `/modes` command (case `"/modes"` in the
slash handler) lists all modes via `modeLoader.listAll()`. Do the same for models.

## Data sources (already exist in src/providers/presets.ts)
- `getKnownProviderNames(): string[]` — all provider names (built-in + config).
- `getPreset(name)?.defaultModel` — the default model for a built-in provider.
- `getProviderModels(name)` — config-defined models map (may be undefined).
- `BUILTIN_PRESETS` — has `defaultModel` per provider.
Import what's needed (some are already imported: `getPreset`, `getKnownProviderNames`,
`getProviderModels` — check the existing import from `./providers/presets.js`).

## Fix 1 — Bare `/model` lists available providers/models
In the `case "/model"` handler, when `modelArg` is empty, in addition to the
`Current:` line, print a list of selectable providers and their models. Shape it
like `/modes` output. Example:
```
Current: deepseek/deepseek-chat

Available:
  deepseek/deepseek-chat        (default)   ctx 128k
  deepseek/deepseek-reasoner
  openai/gpt-4o
  openrouter/anthropic/claude-sonnet-4
  groq/llama-4-scout
  ollama/llama3.2
Usage: /model <provider/model>
```
- Iterate `getKnownProviderNames()`. For each provider, list its `defaultModel`
  (mark `(default)`), plus any `getProviderModels(name)` keys if present.
- Mark the currently-active `providerName`/`activeModel` (e.g. a `›` or `*` prefix,
  or reuse the existing color hierarchy if `colorEnabled`).
- Context window (`ctx 128k`) is nice-to-have from `getPreset(name)?.capabilities.contextWindow`
  or the models map — include if easy, skip if it complicates.
- **Non-TTY/NO_COLOR:** plain text, no ANSI — same guard as the rest of the file.

## Fix 2 — `/model <tab>` argument completion
In `completer(line)` (~line 166), add a branch BEFORE the generic slash-name case:
if the line matches `^/model\s+(\S*)$`, complete against all `provider/model`
strings (built from the same enumeration as Fix 1). Return hits filtered by the
partial. Follow the existing completer return-shape convention (`[hits, line]`)
— study the `@file` branch for how the replacement substring is computed.

## Fix 3 — `/mode <tab>` slug completion (small, same pattern)
If the line matches `^/mode\s+(\S*)$`, complete against the mode slugs. The slugs
come from `modeLoader.listAll()` — but `completer` is a sync function and
`listAll()` may be async. If so, either (a) capture the slug list once at startup
into a variable the completer closes over, or (b) skip Fix 3 and note it. Do NOT
make `completer` async (readline requires sync/callback). Prefer (a) if a mode
list is already available synchronously; otherwise note the limitation.

## Constraints
- Match existing style; reuse `ansi.*` and `colorEnabled`. Touch only the render/
  completer/handler paths. Don't change provider-layer files.
- Don't break the existing `/model <provider/model>` switch behavior.

## Verify (run, report output)
1. `npx tsc --noEmit` clean.
2. `npm test` — 137 baseline, all green.
3. Piped sanity: `printf '/model\n/exit\n' | DEEPSEEK_API_KEY=sk-dummy npx tsx
   src/index.ts 2>&1 | head -20` — confirm the Available list prints, ANSI-free
   when piped.
Report diff (stat + hunks), gates, piped output, and whether Fix 3 landed or was
deferred (with reason). Do NOT commit. Only touch src/index.ts (+ test if added).
