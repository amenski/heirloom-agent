# TODO — deferred work

> **ARCHIVED - historical record (2026-08-13).** Describes a superseded design or
> a completed task brief. Nothing here describes current behavior. The live
> documentation set is indexed in [../README.md](../README.md).
> Why: Deferred-work tracker; every item marked done (conventions.md: trackers are ephemeral).

The prior items in this file (persistent input, message queue, status-bar revamp, output
formatting/gutter, bracketed-paste and Plan-mode bug fixes, dead `src/index.ts` removal) are all
**done and merged into the working tree** as of this session. What remains below is forward-looking.

---

## 1. Stable prompt prefix + provider prompt caching — ✅ DONE (2026-07-30)

Implemented: `buildSystemPrompt` split into `buildStablePreamble` (cached, byte-stable, skills
sorted) + `buildVolatileContext` (RepoMap/env/plan-mode); the stable preamble is the sole system
message at index 0 and is reused across turns (cache keyed on mode/skills/memory/workingDir refs);
volatile context is injected only into the per-turn `streamChat` request (never stored in history);
tool defs sorted by name; and cached tokens surfaced via `usage.inputTokenDetails.cacheReadTokens`
into the exit-summary "Cached Tokens" column. Verified against `ai@7` type defs and real DeepSeek
debug logs (non-zero `cacheReadTokens`). tsc clean, 143 tests pass. Original plan retained below for
reference.


**Motivation:** From "How ChatGPT Optimizes Its Agent Loop" (bytebytego), the one client-applicable
technique is **stable prompt prefixes to preserve the provider's KV/prompt cache** (their §2, with
§1 append-only history and §5 delta-tokenization as the server-side complements we get for free via
the AI SDK). We currently violate this in two ways:

1. **We never enable prompt caching.** No `cache_control` / `providerOptions` anywhere in
   `src/providers/`. So even the fixed ~1.5KB preamble (role, base rules, tool guide — see
   `src/prompt.ts` `getBaseRules()` / `getToolGuide()`) is re-billed at full input price every turn.
   DeepSeek (the configured provider) supports context caching; Anthropic supports explicit
   `cache_control` breakpoints; OpenAI caches automatically on stable prefixes.

2. **Volatile content is baked into the system-prompt prefix**, so even if caching were on, it would
   bust every turn. In `src/prompt.ts` `buildSystemPrompt()`:
   - **RepoMap** (lines ~57-62) is keyed on `ctx.conversation` (the latest user message), so the
     system prompt *content* changes every single turn.
   - **Plan-mode instruction** (lines ~35-41) appears/disappears when the user toggles posture.
   - **git status** (`getEnvironment()`, lines ~117-146) changes as the working tree changes.
   - Additionally, `src/agent.ts` (lines ~78-79) `shift()`s the old system message and `unshift()`s
     a freshly-built one every user turn — even when nothing in the stable part changed.

### Plan

- **Split `buildSystemPrompt` into two parts:**
  - `buildStablePreamble(ctx)` — role/persona, `getBaseRules()`, `getToolGuide()`, mode
    `customInstructions`, skills index, project instructions (AGENTS.md / .heirloom/instructions.md),
    memory. These change rarely (only on mode/skill/config change), so they form the cacheable
    prefix. Sort any list-derived content **deterministically** (skills, tool defs) so the bytes are
    stable across turns.
  - `buildVolatileContext(ctx)` — RepoMap, plan-mode instruction, environment/git block. Emit these
    as a **separate message placed AFTER the stable system message** (e.g. a second system message,
    or folded into the user turn), so they never mutate the cached prefix.
- **Enable prompt caching in `src/providers/aisdk.ts`:**
  - For the Anthropic path, add `providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } }`
    on the last content block of the stable system message (and optionally on the last stable history
    message) — cache breakpoints. Verify against the installed `@ai-sdk/anthropic` API shape via
    context7 before writing (the exact key has changed across versions).
  - For the OpenAI-compatible path (DeepSeek), caching is automatic on stable prefixes — the win
    comes purely from #2 above (stop mutating the prefix). Confirm DeepSeek returns
    `prompt_cache_hit_tokens` in usage and surface it (the exit-summary already has a "Cached Tokens"
    column that currently always shows 0 — wire it up from real usage).
- **Stop rebuilding the stable preamble every turn in `src/agent.ts`:** only rebuild it when the
  inputs that feed it actually changed (mode, skills, memory, project instructions). Keep the volatile
  context rebuilt per turn (cheap). Preserve current behavior: system prompt still at index 0.
- **Tool-definition ordering:** `registry.getAllDefs()` / `getByMode()` iterate a `Map` — insertion
  order is stable today, but make it explicit (sort by name) so tool schemas in the request are
  byte-stable across turns (schemas are part of what providers cache).

### Acceptance criteria

- On a multi-turn session against DeepSeek, `prompt_cache_hit_tokens` (or the provider's equivalent)
  is > 0 from the second turn onward, and the exit-summary "Cached Tokens" column reflects it.
- Toggling plan mode / posture no longer changes the cached system-prefix bytes (verify by logging
  the stable-preamble hash across turns — it stays constant while only the volatile message changes).
- No behavior regression: the model still receives the RepoMap, plan-mode instruction, and env/git
  info each turn (just repositioned); plan mode still produces `<proposed_plan>`; edits still work.
- `npx tsc --noEmit` and `npm test` pass; verify with a real multi-turn run, not just types.

### Not worth doing (from the same article)

Server-infra techniques with no client analog: persistent WebSockets, cache-aware GPU routing, KV
eviction/tiering, speculative decoding, prefill/decode fleet separation, newer-CPU routing, parallel
safety classifiers. **Deferred tool discovery** (their §3, BM25 tool search) is only worth it once
MCP servers push the tool count high — revisit if/when that happens; with ~10 built-in tools the
schema overhead is negligible.

---

## Suggested next step

Item 1 is done and verified in the working tree. Nothing else is queued — add new forward-looking
items here as they come up.

---

## Claude Code parity backlog (2026-08-10)

Ranked gap analysis against Claude Code's CLI, with code-verified current state, lives in
[docs/claude-code-parity.md](./claude-code-parity.md). Shortlist: **1)** `--output-format
json|stream-json` for headless automation, **2)** lifecycle hooks (generalize `notify.ts`),
**3)** file-based slash commands, **4)** flag parity batch (`--max-turns`, `--allowedTools`,
`--permission-mode`, `--name`/`/rename`, …), **5)** subagents (revive the orphaned
`src/orchestrator/`), **6)** git worktrees.
