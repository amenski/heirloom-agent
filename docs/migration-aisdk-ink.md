# Migration — Vercel AI SDK (providers) + Ink (UI)

**Decision (2026-07-29):** stop hand-rolling the two subsystems that caused
every UI/usage bug this session. Replace `src/providers/*` streaming with the
Vercel AI SDK and `src/tui/*` with Ink. KEEP the genuinely novel, working
parts: permission engine, modes, checkpoints, config, tools, sessions,
compaction, skills, memory.

## Why these two, and nothing else

Every bug this session lived in exactly two places:
- **Renderer** (`src/tui/`): streaming one-word-per-line, screen-height gap,
  spinner/bar leaking into scrollback, cursor math, duplicate input line.
- **Usage/provider parsing**: "0 output tokens", now **ctx 128%** — root cause
  confirmed: DeepSeek reports `prompt_tokens` CUMULATIVELY per request, and
  `runAgent`'s multi-iteration tool loop calls `onUsage` each iteration, so
  `sessionInput += input` re-adds the growing prompt every tool round and
  balloons past the context window. This is provider-usage semantics, exactly
  what the AI SDK normalizes.

Both are solved, battle-tested library problems. The permission engine,
mode-gating, shadow-git checkpoints, and config-only provider model are the
project's actual learning surface and stay hand-rolled.

## Current seams (verified) — what the replacements must satisfy

**Provider contract** (`src/providers/types.ts`):
```ts
interface Provider {
  readonly name: string;
  streamChat(messages, tools, {temperature?, maxTokens?, signal?}):
    AsyncGenerator<StreamEvent>;
}
type StreamEvent =
  | { type: "text_delta"; content: string }
  | { type: "tool_call_start"; id; name }
  | { type: "tool_call_delta"; id; arguments }   // JSON string, accumulated
  | { type: "usage"; inputTokens; outputTokens }
  | { type: "done"; finishReason };
```
`runAgent` (src/agent.ts) is the ONLY consumer. It accumulates tool-call
argument deltas itself, loops per tool round, and fires callbacks
(onText/onToolStart/onUsage/askUser...). This interface is the migration
boundary — keep it byte-identical so `agent.ts` needs zero changes.

**UI contract**: `src/index.ts` drives the Terminal via
setInput/setBusy/setStatus/writeAbove/onKey and an editor state machine.
Ink replaces all of it; index.ts's REPL becomes an Ink render tree.

## Part A — Providers → AI SDK (do FIRST, it's lower-risk and testable)

Keep `Provider`/`StreamEvent` EXACTLY as-is. Rewrite the implementations
behind them so nothing upstream changes.

1. Add deps: `ai`, `@ai-sdk/openai` (DeepSeek/Groq/OpenAI/OpenRouter all speak
   OpenAI-compatible → `createOpenAI({baseURL, apiKey})`), `@ai-sdk/anthropic`
   for native Anthropic. Ollama uses `createOpenAI` at the local baseURL.
2. New `src/providers/aisdk.ts`: `createAISDKProvider(preset, model)` returns a
   `Provider` whose `streamChat` calls the AI SDK `streamText({model, messages,
   tools, abortSignal})` and maps its `fullStream` parts to our `StreamEvent`s:
   - `text-delta` → `text_delta`
   - `tool-call` (streaming) → `tool_call_start` + `tool_call_delta`
   - `finish` → carries `usage` (promptTokens/completionTokens) → emit ONE
     `usage` per step with PER-STEP tokens (AI SDK gives per-step + total;
     use per-step so the loop sum is correct and 128% can't recur).
   - map `finishReason` → `done`.
3. Message/tool translation: our `Message`/`ToolDef` (src/types.ts) → AI SDK
   `CoreMessage`/`tool()` shapes. Keep it in aisdk.ts; don't leak AI SDK types
   past the Provider boundary.
4. Delete `openai-compatible.ts`, `deepseek.ts`, `retry.ts` (AI SDK has ret/
   backoff via `maxRetries`). `presets.ts` stays (models map, pricing,
   contextWindow) but `createProvider` now returns `createAISDKProvider(...)`.
   `registry.ts` adapter registration collapses to picking openai vs anthropic
   AI SDK factory.
5. **Fixes for free:** correct per-step usage (kills ctx 128% and 0-output),
   unified streaming, provider retries.

**Verify A (before touching UI):** a tiny script driving `runAgent` with a real
DEEPSEEK_API_KEY through the new provider — assert text streams, a tool round
fires, and `onUsage` totals are sane (single-digit-% of context for a short
turn). `tsc` clean. This proves the swap without any UI in the way.

## Part B — UI → Ink (after A is green)

1. Add deps: `ink`, `react`, `@types/react`. (Ink is ESM; project is already
   ESM/tsx.)
2. New `src/ui/App.tsx`:
   - `<Static>` for committed scrollback (Ink renders it once and never
     repaints — this is the correct primitive for "output that scrolls up",
     and structurally cannot have the gap/duplicate/one-word bugs).
   - A bottom `<Box>` for the input (`ink-text-input` or a small controlled
     input) + a status `<Box>` (mode | provider/model | cwd | ctx% | cost).
   - Spinner via `ink-spinner` while a turn runs; replaces the input row.
   - Permission prompt: a conditional `<Box>` with a y/n/a controlled input,
     resolving the same `askUser` promise `tuiAskUser` uses today.
3. `src/index.ts`: the TTY path renders `<App/>` and wires submit → the SAME
   `runAgentTurn` logic (extract it from the closure into a handler the App
   calls). Streamed `onText` pushes lines into the `<Static>` items via state;
   status recomputed from the same `buildStatusBar` inputs (sessionInput/
   Output, pricing, contextWindow).
4. Non-TTY path UNCHANGED — keep the plain stdin-lines loop; Ink only mounts
   when `process.stdout.isTTY && process.stdin.isTTY`. Piped output stays
   ANSI-free.
5. Delete `src/tui/` entirely (terminal.ts, editor.ts, keys.ts + tests).

**Verify B:** real-terminal drive (the actual gate that's been missing): a
streamed multi-sentence reply renders as flowing paragraphs, no gap, status
bar pinned, spinner clean, a tool-approval prompt works, esc aborts, resize
reflows. Piped `/help`/`/model`/`/exit` stay plain.

## Ordering & safety

- Part A first, fully verified, THEN Part B — never both at once (that's how
  we lost track of which layer broke).
- Each part is one focused subagent (fixes by Sonnet, per project rule).
- Don't touch: permissions/, modes/, checkpoints/, config/, tools/, sessions/,
  compaction/, skills/, memory/, orchestrator/, mcp/. If a change seems to
  need them, STOP and flag — the boundaries above should make that unnecessary.
- No commits by agents; no git add of todo.md/screenshots; no Co-Authored-By.

## What dies, what lives

DELETE: src/tui/*, src/providers/openai-compatible.ts, deepseek.ts, retry.ts,
and the hand-rolled usage accumulation quirk.
KEEP (untouched): permission engine + approval overlay + guarded patterns,
mode loader/gating, shadow-git checkpoints, config/credentials/presets model,
tool registry, session JSONL + compaction, skills, memory, orchestrator, MCP.
KEEP (adapted): src/agent.ts (unchanged — the Provider boundary holds),
presets.ts (models/pricing/context), index.ts (REPL → Ink mount + piped loop).
