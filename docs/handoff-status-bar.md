# Handoff — Persistent status bar (mode · model · cwd · context % · cost)

**Note:** historical snapshot. Model IDs below (e.g. `gpt-4o`, `deepseek-chat`)
are retired — see `src/providers/models.json` for current IDs.

**For:** subagent (Sonnet). **Files:** `src/index.ts`, `src/providers/presets.ts`,
`src/providers/openai-compatible.ts` (usage parsing only) + tests.
**Depends on:** handoff-model-fixes.md landing first (presets get a `models`
map there; build on that shape, not the old single-`capabilities` one).

## Goal

Replace the current one-line `mode · model · provider` pre-prompt status line
with a sectioned status bar anchored to the input, Claude Code-style:

```
▌ › _
chat | deepseek/deepseek-chat | ~/prg_proj/heirloom-agent | ctx 12% | $0.0042
```

Dedicated sections, in order:
1. **mode** — active mode slug (e.g. `chat`, `code`, `architect`).
2. **model** — `provider/model`.
3. **cwd** — process.cwd() with $HOME abbreviated to `~`; if longer than
   ~30 chars, keep the last 2–3 path segments (`…/prg_proj/heirloom-agent`).
4. **context %** — cumulative session tokens (in + out across all turns) as a
   percentage of the active model's contextWindow, e.g. `ctx 12%`. Turn ≥80%
   yellow, ≥95% red (only when colorEnabled).
5. **cost** — running session cost in USD, e.g. `$0.0042` (4 decimal places,
   collapse to `$0.00` only if truly zero). Omit the section entirely when the
   model has no pricing entry (don't print $0 for unknown pricing).

## Placement mechanics (v1, keep simple)

A true always-pinned bar during streaming is out of scope. v1 behavior:
- When the prompt is (re)shown each turn: print the prompt, then the status
  bar on the line BELOW it, then move the cursor back up to the prompt line
  (ANSI: write `\n` + bar, then `\x1b[1A` + `\x1b[<col>G` — or use
  readline.cursorTo/moveCursor from node:readline). The user types on the
  prompt line with the bar visible beneath.
- On submit (Enter), the bar line gets overwritten/cleared before the turn's
  output starts (clear line below, then proceed). No stale bars left in
  scrollback between turns — scrollback shows: prompt+input, then output.
- If this cursor dance proves fragile with line-wrapped input, FALLBACK
  (acceptable): render the bar as the line directly ABOVE the prompt (replacing
  today's renderStatusLine call site) with the same sections. Note which
  variant shipped and why.
- Non-TTY / NO_COLOR: no bar at all (existing `colorEnabled` guard pattern);
  piped output must remain byte-identical plain text.

This REPLACES `renderStatusLine()`'s current content — don't show
mode/model twice.

## Cost: pricing table

Add per-model pricing to the preset models map (per 1M tokens, USD):

```ts
// in ModelCapabilities or alongside it:
pricing?: { inputPerM: number; outputPerM: number }
```

Seed values (verify none have obviously changed; these are the known list
prices):
- deepseek-chat: input 0.27, output 1.10
- deepseek-reasoner: input 0.55, output 2.19
- gpt-4o: input 2.50, output 10.00
- openrouter anthropic/claude-sonnet-4: input 3.00, output 15.00
- groq llama-4-scout: input 0.11, output 0.34
- ollama llama3.2: no pricing (local, free) — omit the field.

Session cost accumulates in the same place session token totals do (the
onUsage callback path in index.ts). Config-defined models without pricing →
cost section omitted.

## Fix the output-token usage bug (prerequisite for ctx% and cost)

Observed: every turn reports `0.0k out`. Diagnose in the openai-compatible
adapter's usage parsing: for STREAMING responses the `usage` object arrives
only on the final chunk and only when requested — for OpenAI-style APIs the
request must set `stream_options: {"include_usage": true}`; DeepSeek sends a
final usage chunk in the stream. Check what the adapter requests and what it
reads (completion_tokens vs output_tokens naming too). Fix so real
prompt_tokens/completion_tokens reach onUsage. Add/adjust an adapter test
with a mocked stream that carries a trailing usage chunk.

## Constraints

- Build on top of the handoff-model-fixes.md changes (already in the working
  tree). Don't undo anything from that batch.
- Touch only the named files + tests. Match existing style (`ansi.*`,
  `colorEnabled` guards).
- Do NOT commit, do NOT push, no Co-Authored-By. Never `git add` todo.md or
  screenshots.

## Verify (run, report output)

1. `npx tsc --noEmit` clean; `npm test` all green (report count; baseline may
   be >137 after the model-fixes batch — don't lose any).
2. Usage fix: adapter test proves completion tokens parsed from a mocked
   streamed usage chunk.
3. Piped: `printf '/help\n/exit\n' | DEEPSEEK_API_KEY=sk-dummy npx tsx src/index.ts 2>&1 | cat -v | head -15`
   — NO status bar, no ANSI codes when piped.
4. Faked TTY: `printf '/model\n/exit\n' | script -q /dev/null npx tsx src/index.ts`
   — bar renders with all sections, no cursor-artifact garbage, no duplicate
   bars stacking in scrollback.
5. Manual reasoning check: with contextWindow 128000 and 2600 tokens used,
   bar shows `ctx 2%`; with deepseek-chat pricing and 2600 in / 500 out,
   cost ≈ $0.0013.

Report: diff stat + key hunks, root cause of the 0-output-tokens bug, which
placement variant shipped (below-prompt or fallback-above) and why, gates,
and the faked-TTY output.
