# Handoff — finish the AI SDK + Ink migration

**For:** subagent (Sonnet). The user did the bulk of this migration already.
Your job: review what's there, fix the concrete defects below, get it running
and correct in a real terminal. Do NOT rearchitect — the structure is good.

**State:** deps added (`ai`, `@ai-sdk/openai`, `@ai-sdk/anthropic`, `ink`,
`react`, `ink-spinner`, `ink-text-input`). Old hand-rolled providers
(`openai-compatible.ts`, `deepseek.ts`, `retry.ts`) and all of `src/tui/`
are deleted. New: `src/providers/aisdk.ts`, `src/ui/App.tsx`,
`src/ui/types.ts`. `src/index.ts` mounts `<App>` on the TTY path (line ~1075)
and keeps a plain readline loop on the non-TTY path (line ~639). `tsc` is
currently clean.

## Defects to fix (verified by reading the code)

### aisdk.ts

1. **Usage double-count (this is the `ctx 128%` bug).** `case "finish"`
   (line ~153) emits `event.totalUsage` (CUMULATIVE across all steps). But
   `runAgent` in src/agent.ts loops once per tool round, and each round's
   `streamText` fires its own `finish`, so `sessionInput += input` in the
   onUsage callback re-adds the cumulative total every round → balloons past
   the context window. **Fix:** emit PER-STEP usage. Use `event.usage`
   (the step's own tokens) instead of `event.totalUsage`. Confirm against the
   installed `ai@^7` types which field is per-step vs cumulative on the
   `finish` fullStream part — pick the per-step one. Verify a multi-tool-round
   turn ends with ctx% in the single digits for a short session, not >100%.

2. **Tool-result `toolName: ""`** (mapMessages, line ~46). Empty toolName on
   tool-result messages is rejected by some providers/AI-SDK validation.
   Thread the real tool name through: build a map of toolCallId→toolName from
   the assistant tool-calls earlier in the same `messages` array, and use it
   when mapping the `tool` role message. (Our `Message` tool role has
   `toolCallId`; find its matching call.)

3. **`require("@ai-sdk/anthropic")`** in ESM (line ~68). Replace with a
   top-level `import { createAnthropic } from "@ai-sdk/anthropic"` and select
   it in `createAIInstance`. (Keeps it working under tsx AND the tsup build.)

### App.tsx

4. **Stale-closure bugs in `useInput`/`runAgentTurn`.** `firstToken` and
   `activeLine` are read inside the `onText` callback and the `finally` block
   but captured from render scope — `useCallback(..., [ctx, activeLine,
   firstToken])` means the streaming callbacks close over stale values. Symptom:
   the spinner may not clear on first token, or the last partial line may be
   dropped/duplicated. **Fix:** back `activeLine` and `firstToken` with refs
   (like the existing `inputRef` pattern) and read/write the refs inside
   callbacks; keep the state only for rendering. The `onText` line-buffering
   (split on `\n`, push complete lines, keep remainder in `activeLine`) is the
   right idea — just make it ref-safe.

5. **History-down off-by-one** (`handleHistoryDown`, line ~180). The
   `historyIdx > 1` / `=== 1` / else branches skip index handling and can strand
   the newest entry or the empty draft. Simplify to a clean decrement:
   idx→idx-1, and at idx 0 going down restores the empty input (draft). Mirror
   `handleHistoryUp`. Preserve the in-progress draft when navigating up from -1
   (save current inputText, restore on return to -1) — currently the draft is
   lost.

6. **`activeLine` shown only when `!busy`** (line ~365) but during streaming
   `busy` is false after first token, so this mostly works — however when a
   tool starts mid-stream, `onToolStart` pushes `activeLine` then clears it;
   verify no partial line is both pushed AND left in activeLine (double
   render). Trace it; fix if it double-prints.

7. **Cursor highlight via raw `\x1b[7m`** inside `<Text>` (line ~377). Ink may
   escape or mismanage this. Prefer Ink's `inverse` prop on a `<Text>` segment
   for the character under the cursor: split into before / cursor-char /
   after `<Text>` spans, middle one `inverse`. If cursor is at end, render a
   trailing inverse space.

### Cleanup

8. **Delete `src/_test.tsx`** — it's a stray scratch file (`const x = <div>…`,
   which isn't even valid Ink — Ink has no `div`). Remove it.

9. **Non-TTY parity:** confirm the piped path (index.ts ~639) still prints the
   grouped `/model` listing, `/help`, etc. plain and ANSI-free, unchanged from
   before. Ink must ONLY mount when `process.stdout.isTTY && process.stdin.isTTY`.

## Verify (run these; report output)

1. `npx tsc --noEmit` clean.
2. **Providers, headless** — this is the key correctness gate for the usage fix.
   With a real key in env (`DEEPSEEK_API_KEY` — ask the coordinator to confirm
   it's set; if absent, say so and skip live calls but still do the type/logic
   review):
   `printf 'say hi in one short sentence\n/exit\n' | DEEPSEEK_API_KEY=$DEEPSEEK_API_KEY npx tsx src/index.ts`
   — but note this uses the TTY-less path (readline). Also drive one real turn
   and confirm the final status bar shows a SANE ctx% (single digits) and a
   nonzero, non-cumulative-looking token count.
3. **Piped regression:** `printf '/model\n/help\n/exit\n' | DEEPSEEK_API_KEY=sk-dummy npx tsx src/index.ts 2>&1 | cat -v | head -30`
   — grouped listing, `/help`, no ANSI, no Ink artifacts.
4. **Ink real-terminal** — the gate that's been missing all session. Use the
   pty harness pattern at `/private/tmp/claude-502/-Users-amanuel-Documents-prg-proj-heirloom-agent/b2ef6f70-86de-4e57-892f-02de6dbd1d0e/scratchpad/pty_drive.py`
   (or a copy) to drive a 90x24 pty: send `/model`, `/help`, then a chat line
   (it'll error without a key, that's fine), reconstruct the screen, and
   confirm: banner scrolls into scrollback, output flows top-down (NO giant
   gap), status bar renders once at the bottom, no per-word line breaks, no
   duplicated input/status lines in scrollback. Include the reconstruction.

## Rules

- Fix within the existing structure. Touch: src/providers/aisdk.ts,
  src/ui/App.tsx, src/ui/types.ts, src/index.ts (only where wiring these
  fixes requires), delete src/_test.tsx. Do NOT touch permissions/, modes/,
  checkpoints/, config/, tools/, sessions/, compaction/, agent.ts (the
  Provider boundary must hold — if you think agent.ts needs changing, STOP
  and flag it).
- Do NOT run or fix the test suite (per user: functionality over tests now).
- Do NOT commit or push. Never git add anything (esp. todo.md/screenshots).
  No Co-Authored-By.

## Report

Root cause + fix for each numbered defect, the headless usage/ctx% result
(actual numbers proving 128% is gone), the piped regression output, and the
pty screen reconstruction. Flag anything you found beyond this list.
