# Handoff Spec — Terminal UI Refresh + Model-Declared Effort

**For:** implementing subagent (Sonnet).
**Author:** planning agent. **Do not** deviate from scope without flagging.
**Reference image:** `Screenshot 2026-07-29 at 08.43.26.png` in repo root — match the
*information architecture and color hierarchy*, **not** the exact box.

## Prime directives

- **Option B, not A.** Keep the existing `readline` + `rl.question(getPrompt())`
  input loop. Do **not** build a custom box-drawing composer, placeholder-inside-input,
  or manual cursor-math input buffer. We are *framing* readline, not replacing it.
- **Surgical.** Track 1 touches `src/index.ts` only. Track 2 touches the provider/config
  layer. Do not refactor unrelated code, do not reformat, match existing style.
- **Two independent tracks.** Ship Track 1 first (self-contained, low risk). Track 2
  can follow or run in parallel — the seams barely overlap.
- **Verify gates after each track:** `npx tsc --noEmit` clean AND `npm test` all green.
  Report the numbers. Do not commit (owner runs `/commit`).

---

## Current state (real symbols — verified 2026-07-29)

`src/index.ts`:
- `providerName` — `let` at line ~316 (reassigned by `/model` at ~789).
- `activeModel: string | undefined` — line ~329 (reassigned by `/model` at ~790).
- `activeMode: ModeConfig | undefined` — line ~496 (reassigned by `/mode` at ~734).
- `permissions.approvalMode` — `manual|edits|all`, cycled by Shift+Tab (~667) and `/approve`.
- `getPrompt(): string` — line ~637. Currently returns `heirloom [<mode>[ ⚡<approval>]] > `
  (or `heirloom > ` when no mode). This is the **only** input prompt string.
- `rl.question(getPrompt())` — line ~888, the input read.
- Shift+Tab redraw at ~672: `process.stdout.write(\`\r${getPrompt()}${(rl as any).line}\`)`.
- `onKeypress` (~660) is attached only during agent runs; safe to ignore for Track 1
  except the Shift+Tab redraw line.

`src/providers/types.ts`:
- `ModelCapabilities { supportsTools: boolean; contextWindow: number }` — line 3.
- `Provider.streamChat(messages, tools, options?)` where
  `options?: { temperature?: number; maxTokens?: number; signal?: AbortSignal }` — line ~20.

`src/providers/openai-compatible.ts`:
- Request body built at ~78–90 (`max_tokens`, `temperature`). This is where an effort
  field would be injected.

`src/providers/presets.ts`:
- `ProviderPreset { api, baseUrl, keyEnv, defaultModel, capabilities: ModelCapabilities }`.
- `BUILTIN_PRESETS` — one preset per provider; `capabilities` currently only
  `supportsTools` + `contextWindow`. **No `displayName`, no `effort` anywhere yet.**

---

## TRACK 1 — UI refresh (src/index.ts only). SHIP FIRST.

### Target rendering

Before each input, render a header; the prompt line itself carries a left accent rail.
Approximate layout (colors below):

```
  Build · deepseek-chat · DeepSeek          ← status line (effort segment appears only when model has one; Track 2)
  shift+tab approve · esc abort · /help     ← hint bar (REAL keys only)

▌ › _                                        ← the readline input line (this is getPrompt())

  ● Tip  shift+enter to add newlines         ← tip line (first turn only)
```

### Color hierarchy (from screenshot)

| Element | Style |
|---|---|
| mode name (`Build`/`code`) | blue + bold |
| model display name | bright/white |
| provider name | dim gray |
| effort value | orange + bold (Track 2; omitted until then) |
| `·` separators | dim |
| hint keys (`shift+tab`, `esc`, `/help`) | bright |
| hint labels (`approve`, `abort`) | dim |
| accent rail `▌` and `›` | blue |
| tip `●` + `Tip` | orange; tip body dim |

### Requirements

1. **`renderPromptHeader()`** — new function that `console.log`s the status line and hint bar.
   Call it immediately before `rl.question(getPrompt())` at ~888.
   - Status line fields: mode = `activeMode?.name ?? "chat"`; model = display name
     (Track 2) or fall back to `activeModel ?? getPreset(providerName)?.defaultModel`;
     provider = a human label for `providerName` (e.g. `deepseek` → `DeepSeek`); effort =
     **only if** the active model declares one (Track 2) — until then, omit the segment.
   - Hint bar: **advertise only keys that actually work today** — `shift+tab approve`,
     `esc abort`, `/help`. Do **NOT** invent `tab agents` or `ctrl+p commands` from the
     screenshot; those features don't exist. (If `tab` completion via the existing
     `completer` is worth surfacing, `tab complete` is acceptable — it's real.)

2. **Rework `getPrompt()`** — return the accent-rail input line, e.g. `▌ › ` (colored),
   **single line only** (readline needs the cursor on one line; backspace/history must
   stay correct). Keep the `heirloom > ` fallback when `!activeMode` but styled the same.
   Mode/approval/model info moves to the header — do **not** keep the old
   `heirloom [mode ⚡approval]` inside the prompt line (it now lives in the status line).

3. **ANSI color helper** — check for an existing one first (look in `src/debug/`,
   `src/index.ts` top). Reuse if present; otherwise add a tiny local helper
   (dim/bright/blue/orange/bold). **Must honor `NO_COLOR` env and non-TTY** — see #5.

4. **Shift+Tab redraw (~672)** — after cycling approval mode, the approval state now lives
   in the **status line**, not the prompt. Repaint approach: simplest correct behavior is
   to re-render the header + input line. If full header repaint is fiddly, at minimum keep
   the input line redraw working and update the status line on the next turn — but prefer
   repainting the status line so the approval change is visible immediately. Document
   whichever you choose in a code comment.

5. **Non-TTY / NO_COLOR degradation (CRITICAL).** When `!process.stdout.isTTY` OR
   `process.env.NO_COLOR` is set: emit **no ANSI codes** and **no decorative header**
   (or a plain single-line version). The piped-stdin path and headless `-p` output must
   stay clean — we have tests/pipelines that feed stdin and grep output. Guard every
   render on TTY. (Verified failure mode: piping input already changes the prompt path;
   don't let color/box bytes leak into captured output.)

6. **Tip line** — show `● Tip shift+enter to add newlines` **only on the first prompt of
   a session** (a `let shownTip = false` gate), not every turn. Only meaningful if
   shift+enter multiline is actually supported; if it isn't wired, either wire nothing and
   change the tip to a real hint (e.g. `/help for commands`) or omit the tip. Do not
   advertise shift+enter multiline unless it works — verify before claiming it.

### Track 1 acceptance

- Interactive TTY run shows: status line (mode·model·provider), hint bar with real keys,
  accent-rail prompt, first-turn tip. Colors match the hierarchy.
- `/mode`, `/approve`, `/model`, Shift+Tab all update the status line correctly.
- Piped stdin (`printf '/help\n/exit\n' | npx tsx src/index.ts` with a dummy key) produces
  **clean, ANSI-free** output and `/help` still works (no leading-char loss).
- `NO_COLOR=1` run emits no escape codes.
- `npx tsc --noEmit` clean; `npm test` all green.

---

## TRACK 2 — Model-declared reasoning effort. FOLLOWS Track 1 (or parallel).

**Design principle (owner-directed):** effort is **not** a heirloom-invented enum. Each
model exposes its **own** effort vocabulary and its **own** wire field. Many models have
**no** effort knob — for those, the whole feature is absent (no field sent, no UI segment).

### Reality across providers (do not hardcode a single scale)

- OpenAI o-series / GPT-5: `reasoning_effort: "minimal"|"low"|"medium"|"high"` (top-level).
- Anthropic extended thinking: NOT an enum — `thinking:{type:"enabled",budget_tokens:N}`.
- DeepSeek: `deepseek-reasoner` reasons by default, no knob; `deepseek-chat` no reasoning.
- OpenRouter: proxies `reasoning:{effort}` or `reasoning:{max_tokens}` per underlying model.

### 1. Declare effort as a capability

Extend `ModelCapabilities` in `src/providers/types.ts`:

```ts
export interface ModelCapabilities {
  supportsTools: boolean;
  contextWindow: number;
  displayName?: string;              // e.g. "DeepSeek V4 Pro"; falls back to model id
  effort?: {
    values: string[];                // the MODEL's own vocabulary, e.g. ["minimal","low","medium","high"]
    default: string;                 // used when unset
  };                                 // ABSENT = this model has no effort knob
}
```

Populate per preset in `presets.ts`. Leave `deepseek`/`deepseek_reasoner`/`ollama` with
`effort` **undefined** (correct — no knob). Add `effort` + `displayName` where real
(e.g. an OpenAI GPT-5 preset if/when added). Do **not** fabricate effort for models that
lack it. `displayName` is optional polish; set where you can verify the marketing name.

### 2. Canonical option stays vocabulary-agnostic

Add `effort?: string` to the `options` param in `Provider.streamChat` (`types.ts:20`) and
its implementations. It carries a **raw value the model declared** — the canonical layer
does not interpret it.

### 3. Adapter owns wire translation

In `openai-compatible.ts` (~78) map `options.effort` → `reasoning_effort` in the request
body **only when present**. (Anthropic adapter, when it exists, would map named value →
`thinking.budget_tokens` via an adapter-internal table. DeepSeek: drop it — no-op.)
Never send an effort field the provider doesn't understand.

### 4. Session state + command

- Session-scoped `activeEffort: string | undefined` in `src/index.ts`, mirroring
  `approvalMode` policy: **not persisted**, resets on `/model` switch to the new model's
  `effort.default` (or `undefined` if the new model has no knob).
- `/effort <value>` command: valid only if active model has `effort` AND value ∈
  `effort.values`; else reject with the valid list. Bare `/effort` prints current + options.
- Thread `activeEffort` into the `streamChat` options where the agent calls the provider.

### 5. UI segment (closes the Track 1 loop)

`renderPromptHeader()` shows the effort segment (orange) **iff** the active model declares
`effort`. Model with no knob → no 4th segment, no placeholder. `/model` switch re-reads
capabilities: segment appears/disappears accordingly.

### Track 2 acceptance

- Model with `effort` (e.g. a GPT-5 preset): status line shows it; `/effort` cycles its
  own `values`; invalid value rejected with list; request body carries `reasoning_effort`.
- Model without (`deepseek-chat`): no effort segment; `/effort` says unsupported; no effort
  field in request body.
- `/model` switch resets/clears effort to the new model's default.
- `npx tsc --noEmit` clean; `npm test` green (add a unit test for the effort→body mapping
  and the capability-absent no-op).

---

## Out of scope (do not build)

- Custom box-drawing / TUI composer, placeholder-inside-input, manual input buffer (Option A).
- `tab agents` picker, `ctrl+p` command palette (screenshot shows them; they don't exist).
- Persisting effort or approval mode to disk.
- Any provider wire field for a model that doesn't support it.

## Deliverables

1. Track 1 diff (src/index.ts) + verification output (tsc, tests, one piped-stdin sanity run).
2. Track 2 diff + tests.
3. A short note on any decision you made under ambiguity (esp. Shift+Tab repaint approach,
   tip-line content if shift+enter isn't wired).
