# Heirloom — Follow-ups

Open items parked for later. Captured 2026-08-04, revised 2026-08-05.

## STILL BROKEN

### 0. The "Working…" freeze is NOT fixed
Three separate blocking/render bugs were found and fixed this session (spinner re-render,
git poll, JSON.parse instrumentation). All were real. **None of them resolved the reported
freeze** — it still happens: the UI stalls mid-chat, won't accept input, then catches up.

Do not assume the cause is known. What has been ruled OUT by measurement:
- `estimateTokens` (the `436b5d5` fix is intact and working)
- `mergeTableLines` — 0.17ms even at 12k lines
- spinner-driven re-renders — now confined to `<Spinner>` (13 sibling renders/sec → ≤3)
- the git-status poll — was 100-670ms every 30s, but the freeze has no 30s rhythm

Next step is measurement, not more code reading: attach a CPU profiler + event-loop
watchdog to a REAL session (`node:inspector` `Session` + `Profiler.start()`, a 20ms timer
measuring its own lateness, and on a >150ms stall dump the hottest self-time frames). That
names the blocking frame directly. Three code-reading diagnoses in a row were wrong.

Unmeasured suspects: stdout backpressure on large frames, the still-absent `<Static>`, or
something outside the UI entirely.

Addressed since (`76a1412`), so no longer a suspect: the full-transcript Ink render on
message appends. `OutputArea` kept one live element per committed line, so per-frame layout
cost scaled with session length. Now capped via `liveLineBudget` (400) — lines older than
that fold into a single element rather than being dropped. Measured 310ms → 118ms to render
4k lines. NOTE: the `maxLines` prop this doc previously recommended is the wrong tool — it
slices to the newest N and discards the rest, and with `<Static>` absent `outputLines` is
the only copy of the transcript, so it would lose scrollback permanently.

## Needs your eyes (cannot be verified without a TTY)

Still outstanding: `/skills`, `/effort`, `/model` (§1). Multi-line paste was confirmed
working in a live terminal 2026-08-05 — see Closed.

### 1. Confirm `/skills`, `/effort` and `/model` in a live terminal
The command layer is now covered by logic + Ink render tests, but these three need
a real terminal to confirm:
- `/skills` — border/header follow the active theme; each skill shows name-on-its-own-line
  with an indented description (the `594952c` layout fix).
- `/skills` → select a skill → the model should now actually **follow** it. Selecting used
  to only print the body locally; it now injects a `[skill: <name>]` user message into the
  conversation. Confirm the confirmation line appears and the model's behavior changes.
- `/effort` — should now open a real picker listing `low / high / max` on DeepSeek. After
  `/effort max`, a turn should still succeed (this also exercises the temperature-omission
  fix — DeepSeek rejects `temperature` while thinking mode is active).
- `/model` — switch to a different **provider**, then `/resume` that session and confirm the
  provider/model came back.
- `--debug` JSONL is the ground truth for the wire: confirm `reasoning` is present on the
  request and `temperature` is absent when an effort level is set.

## Deferred features (mentioned, never requested to build)

### 2. User-defined providers (`setConfigProviders` is dead code)
`setConfigProviders` (`src/providers/presets.ts:70`) is imported in `src/cli.tsx` but
**never called**, so the whole config-provider branch is unreachable: `getProviderModels`
always returns `undefined`, `createProvider`'s config branch never runs, and half of
`listKnownModels` never contributes entries. Making it real needs three things that don't
exist yet: a `providers` field in the config schema (`src/config/loader.ts`), a validator,
and the `setConfigProviders(...)` call. Only worth doing if you want to point Heirloom at a
provider that isn't one of the five built-in presets.

### 3. Effort coverage beyond DeepSeek
Effort caps are declared **per-model** on `deepseek-v4-flash` / `deepseek-v4-pro` (verified:
low/high/max) and on Groq's two `openai/gpt-oss-*` models. Deliberately NOT on OpenAI:
its chat-completions API rejects `reasoning_effort` when function tools are present
("Function tools with reasoning_effort are not supported for gpt-5.6-sol in
/v1/chat/completions"), and Heirloom always sends tools. Revisit only with evidence from a
live call — per-provider flags are unsafe here, the failure mode is a hard 400.

### 4. Preset pricing/context values are estimates
The refreshed model entries (gpt-5.6 family, `llama-3.3-70b-versatile`, `llama-3.1-8b-instant`,
`gpt-oss-*`, `claude-sonnet-4.6`) carry plausible-shape pricing and context-window numbers that
were **not** verified against live price sheets. They only affect cost estimates and the
compaction threshold, not correctness. Worth a pass if cost display starts mattering.

### 5. Stale model IDs in docs
Several `docs/*.md` handoff/spec files still reference retired IDs (`gpt-4o`,
`anthropic/claude-sonnet-4`, `deepseek-chat`, `llama-4-scout`). They're historical
snapshots, not live reference docs, so they were left alone — clean up only if they start
misleading.

---

## Closed 2026-08-05

- **Paste arrived line by line — confirmed fixed in a live terminal.** `enableBracketedPaste()`
  existed but was never called, so the terminal sent a paste as bare bytes with no
  `\x1b[200~` framing; every embedded newline reached the handler as a plain Enter and
  submitted that line on its own. The parser and the `PromptInput` paste handler were
  already correct. Enabled in `attachInputWire` (the single process-lifetime attach point),
  restored on exit/SIGINT/SIGTERM. Two display fixes rode along: a large paste collapses in
  the prompt to `[pasted N chars]` (display only — spans tracked in `core/paste-spans.ts`,
  the buffer keeps the real text so submit/history/undo are untouched), and the transcript
  echo no longer flattens newlines with `.replace(/\n/g, " ")` (`core/echo-format.ts`; this
  was a pre-existing bug affecting Shift+Enter too, visible only once multi-line input could
  reach the buffer). `c8f0eb8`.
  Live-terminal check done 2026-08-05: paste lands as one message. Note that no test can
  cover this part — synthetic `\x1b[200~` bytes prove parsing, not that the terminal
  negotiates the mode.

## Closed 2026-08-04 (later session)

- **↑/↓ now recalls past prompts.** The machinery already existed —
  `useHistoryNavigation`, the arrow-key bindings, Ctrl+P/Ctrl+N — but `App.tsx` rendered
  `promptHistory={[]}`, a hardcoded empty array, so `navigateHistory` returned immediately
  and the arrows did nothing. App now keeps the submitted prompts in state (recorded in
  `submitFromInput`, so queued and slash submissions count too, with blank/immediate-dup
  filtering) and seeds it from a resumed session's user turns via
  `src/ui/core/prompt-history.ts` — which filters out app-injected `user` messages
  (compaction summaries, force-loaded skill bodies, error-reflection nudges) so Up never
  surfaces something the user didn't type. Covered by `prompt-history.test.ts` and
  `PromptInput.history.test.tsx`.
  Note for future UI tests: `useTerminalInput` holds ONE module-level stdin listener, so a
  component left mounted from a previous test keeps the wire and the next render's keys go
  nowhere — unmount and call `__resetInputWireForTests()` between tests.
- **`/model` is now an opencode-style searchable popup.** Type to fuzzy-filter across
  provider and model name (subsequence matching — "dsp" finds `deepseek-v4-pro`), results
  grouped under provider headings, context window shown per model, and providers with no
  resolvable API key dimmed and marked "no key" (via `getConfiguredProviders()` in
  `presets.ts` — returns BOOLEANS ONLY, the UI never handles a secret). Arrow keys step
  over group headings; Esc clears the search first, then closes. Matching/grouping/
  navigation logic is pure and unit-tested in `src/ui/core/model-picker.ts`.
  Two bugs found and fixed while building it: (1) the input handler gated on
  `input.length === 1`, which silently dropped fast typing and pastes that arrive as one
  multi-char chunk; (2) cursor anchoring in a `useEffect` keyed on `rows` (a fresh array
  every render) fought the arrow keys — now derived during render.

- **"Working…" freeze — THE actual cause: the spinner re-rendered the whole transcript.**
  `spinnerFrame` and `turnElapsed` were `useState` on `App`, so their 80ms and 1s ticks
  re-rendered App's entire subtree — including `OutputArea` and every committed line —
  12+ times a second. `OutputArea` is never passed `maxLines` (defaults to `0` = no cap),
  so every line stays a live Ink element and Ink re-lays-out all of them just to find
  nothing changed. Measured per spinner tick: 4ms @200 lines, 20ms @2k, 62ms @4k,
  **197ms @8k** — past the 80ms budget the ticks queue faster than they drain, the UI
  locks, and buffered keystrokes replay on catch-up ("freezes, won't take input, then
  catches up"). Explains why it hit "arbitrary chats": it scales with accumulated output,
  not with turns. Fix: both timers moved into `<Spinner>` as local state driven by
  `active`, so a tick re-renders only the spinner. Guarded by `src/ui/Spinner.test.tsx`,
  verified load-bearing (the old parent-owned-state shape produces 13 sibling re-renders
  per second and fails the guard). Follow-ups if it ever regresses: pass `maxLines` to cap
  the live region, and/or restore Ink's `<Static>` (removed for conflicting with the banner).
- **"Working…" freeze — a second, real but SMALLER sink (fixed first, kept).** Not a regression of the
  `estimateTokens` fix (`436b5d5`), which is intact. The git-status poll in `src/ui/App.tsx`
  ran three **`execSync`** git commands (`rev-parse`, `status --porcelain`, `rev-list
  ...@{upstream}`) on a 30s `setInterval`. execSync blocks the main thread for as long as
  git runs: measured **100–670ms** across the user's repos (kontashop = 668ms), scaling with
  worktree size — and `@{upstream}` can touch the network. Simulating the real 80ms spinner
  timer, the worst gap was **606ms before → 81ms after**. Fixed by switching to promisified
  `exec` with `Promise.all` for the two independent reads. Guarded by
  `src/ui/git-poll-nonblocking.test.ts`, verified to fail if `execSync` is reintroduced.
  (Checked and cleared: `prompt.ts`'s git `execSync` is inside the memoized stable preamble,
  so it runs once per session, not per turn.)

- **`/effort` was entirely dead** — no preset declared an `effort` capability, so the picker
  never rendered; and the value it would have sent went nowhere, because `reasoningEffort`
  was passed as a **top-level `streamText` option**, which AI SDK v7 discards silently
  (`prepareLanguageModelCallOptions` keeps a fixed whitelist). Same for the
  `body: { thinking }` hack, which an `as any` had hidden. Now sends the SDK's standardized
  `reasoning` option, maps DeepSeek's `max` → `xhigh`, and omits `temperature` when reasoning
  is active.
- **`/skill <name>` never reached the model** — it only printed to local scrollback. Now
  injects a deduped `user` message and persists it via `appendMessage` (mandatory: pre-turn
  history falls outside the `newMessages` persistence window).
- **`/model` didn't persist** — now calls `appendState`, validates the target provider before
  committing, rolls back on failure, and resets the memoized compactor. Resume now *consumes*
  the persisted provider/model (it was replayed into meta but every caller discarded it);
  an explicit `--model` / settings.json choice still wins.
- **Credential leak across providers** — the startup `env.API_KEY` / `env.BASE_URL` were
  passed as highest-priority to *every* `createProvider` call, so switching providers would
  have sent one provider's key to another's endpoint. Now scoped to the startup provider.
  This was a prerequisite for the cross-provider picker.
- **Model picker couldn't change provider** — now lists all `provider/model` pairs via the
  previously-unused `ctx.getModelEntries()`.
- **Three presets pointed at dead model IDs** — `llama-4-scout` never existed on Groq,
  `anthropic/claude-sonnet-4` was retired 2026-06-15, `gpt-4o` was stale.
- **`thinkingEnabled` was read and dropped** — now threaded through to the provider boundary.
- **JSON.parse sink** (old #1) — added an observation-only size diagnostic before the parse
  in `src/agent.ts`. Deliberately does **not** cap or reject: the `_raw` fallback is inert
  (`agent.test.ts`), so capping would turn slow-but-correct large writes into silent failures.
- **Folder-scope offer for writes** (old #2) — extended to the six real write/edit tools with
  distinct, risk-colored prompt copy. Policy: read approvals do **not** unlock a recursive
  write grant; a write offer needs two prior *write* approvals in that folder.
- **No pixel-level TUI tests** (old #3) — added `ink-testing-library` and widened the vitest
  glob to `*.test.{ts,tsx}` (it was `*.test.ts`, so no `.tsx` test would ever have run).
  `SkillList` and `ScopeChoicePrompt` now have render tests; the `SkillList` one was verified
  to fail against the pre-`594952c` wall-of-text version.
- **Dead code removed** — `ui/ModelSelector.tsx` (the `ModelEntry` type moved to
  `ui/types.ts`), `components/SkillsDropdown/`, and `SkillLoader.match()` + the `triggers`
  frontmatter field (keyword matching that `skill-spec.md` explicitly argues against).
- **Entrypoint guard bug, caught in review** — a `main()` guard comparing `import.meta.url` to
  `process.argv[1]` made the installed binary silently do nothing when invoked through the
  `npm i -g` symlink (`import.meta.url` is resolved, `argv[1]` is not). Now compares realpaths.
