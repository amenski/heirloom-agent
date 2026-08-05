# Handoff — UI Restructure (per-turn chrome)

**Note:** historical snapshot. Model IDs below (e.g. `deepseek-chat`) are
retired — see `src/providers/models.json` for current IDs.

**For:** subagent (Sonnet). **File:** `src/index.ts` ONLY. Small, surgical.
Follow-up to the Track 1 prompt header (commit 8099611). The pieces render but
the per-turn structure is wrong.

## Problems (observed in a real run)
1. The full status-line + hints + tip block reprints before EVERY turn — noise.
2. There's a blank gap between the header and the prompt, so the metadata floats
   detached from the input it describes.
3. After a turn's response (and after slash-command output like `/model`), the
   header block collides with it — no clear turn boundary.

## Target behavior (decided)
**Compact status line hugging the prompt; hints + tip shown ONCE at startup.**

- **Startup banner (print ONCE, replacing the current greeting line ~682):**
  the existing greeting, then the hint bar (`shift+tab approve · esc abort ·
  /help`), then the tip (`● Tip /help for commands`), then a blank line.
- **Per turn (before each `rl.question`):** print ONLY the compact status line
  — `mode · model · provider` (the existing colored one) — with **NO trailing
  blank line**, so the very next line is the `▌ › ` prompt. Status line hugs
  the prompt.
- A blank line should separate the PREVIOUS turn's output from the next status
  line (so turns are visually distinct), but the status line and its prompt
  stay glued together.

Desired flow:
```
heirloom — type /exit to quit, /help for help
shift+tab approve · esc abort · /help
● Tip /help for commands

chat · deepseek-chat · DeepSeek
▌ › hello
Hello! … [2.7k in / 0.0k out]

chat · deepseek-chat · DeepSeek
▌ › _
```

## Implementation
- Split `renderPromptHeader()` (~658-681):
  - Move the **hints block + tip** into a one-time startup print (near the
    greeting ~682). Drop the `shownTip` gate — it's now unconditional-once.
  - Keep a `renderStatusLine()` that prints ONLY the `mode · model · provider`
    line, no trailing blank. Call it before each `rl.question` (replace the
    `renderPromptHeader()` call at ~929).
  - Emit ONE blank line before the status line (turn separator) — but place it
    so command output / responses are cleanly separated from the next turn.
    Simplest: print `"\n"` then the status line, then the prompt on the next line.
- **Non-TTY / NO_COLOR:** unchanged — when `!colorEnabled`, print nothing
  decorative (no banner, no status line); the plain `heirloom > ` prompt only.
  Verify piped output stays ANSI-free (the existing guard already does this;
  don't regress it).
- Match existing style. Don't touch anything outside the render path.

## Verify
1. `npx tsc --noEmit` clean.
2. `npm test` — 137 baseline, all green (no new tests needed for a layout change,
   but don't break existing ones).
3. Piped sanity: `printf '/help\n/exit\n' | DEEPSEEK_API_KEY=sk-dummy npx tsx
   src/index.ts 2>&1 | cat -v | head` — no ANSI, no repeated header blocks.
Report the diff (stat + hunks), gate results, and the piped output. Do NOT commit.
