# UI Redesign Spec — hand-rolled terminal renderer

**Note:** this spec's guidance is current; only the example model IDs (e.g.
`gpt-4o`, `deepseek-chat`) are stale. `src/providers/models.json` is authoritative.

**Decision (2026-07-29):** drop readline; own the terminal. No dependencies
(no Ink/blessed). This is the biggest UI investment in the project and the
point where heirloom stops fighting readline and starts owning rendering the
way opencode-class CLIs do.

## Why

Every UI defect this session traces to readline's model — one editable line,
readline owns the terminal while active:

- double-echoed input on submit
- header/output collisions, reprinting chrome every turn
- spinner artifacts, raw-mode toggled on/off around agent runs
- no sane home for a status bar (the cursor-dance in handoff-status-bar.md)

Fixing these individually means stacking ANSI hacks on a foundation that
can't express "stable input at the bottom, output streaming above."

## Target experience

```
  …conversation output scrolls here normally…

  Hello! How can I help?                      ← streamed output
                                              ← blank separator
▌ › fix the parser bug_                       ← editable input, always at bottom
chat | deepseek/deepseek-chat | ~/prg_proj/heirloom-agent | ctx 12% | $0.0042
```

- **Output region:** normal terminal scrollback above. Streaming text appears
  there without disturbing the input.
- **Pinned bottom region:** the input line(s) + a one-line status bar,
  repainted in place. While the agent is busy, the input line is replaced by
  the spinner line (`⠋ thinking… (esc to abort)`); the status bar stays.
- **Status bar sections** (dedicated, in order):
  `mode | provider/model | cwd | ctx % | cost`
  - cwd: `$HOME` → `~`; longer than ~30 chars → last 2–3 segments with `…/`.
  - ctx %: cumulative session tokens ÷ active model contextWindow. Yellow at
    ≥80%, red at ≥95% (colorEnabled only).
  - cost: running USD total from the pricing table (below); section omitted
    entirely when the model has no pricing entry.
- **Non-TTY / piped:** the renderer and editor are NOT used at all. A plain
  line-based stdin loop (no ANSI, no bar, no spinner) — current piped
  behavior preserved byte-for-byte where tests depend on it.

## Architecture

Three new modules under `src/tui/`, consumed by `src/index.ts`:

```
src/tui/keys.ts      — decode stdin bytes → Key events        (pure, testable)
src/tui/editor.ts    — line-editor state machine              (pure, testable)
src/tui/terminal.ts  — renderer: regions, repaint, raw mode   (thin I/O shell)
```

### keys.ts — input decoding (pure)

`decodeKeys(buf: Buffer): Key[]` — stateless byte→event decoder (feed it
chunks; it may hold a partial escape sequence internally via a small
carry-over, exposed as a class if needed).

Key = `{ name: string; ctrl: boolean; alt: boolean; shift: boolean; seq: string }`.
Must handle: printable chars (incl. UTF-8 multibyte), enter (`\r`),
backspace (0x7f and 0x08), tab, shift+tab (`ESC [ Z`), arrows
(`ESC [ A/B/C/D`), home/end (`ESC [ H/F`, `ESC [ 1~/4~`), delete
(`ESC [ 3~`), ctrl+a/e/k/u/w/l/c/d, alt+b/f, escape alone (disambiguated by
timeout OR by "ESC followed by nothing else in the same chunk" — document
the chosen rule), bracketed paste (`ESC [ 200~ … ESC [ 201~` → single
`paste` event with the payload).

### editor.ts — line editor (pure state machine)

```ts
interface EditorState { text: string; cursor: number; history: string[]; historyIndex: number; pending: string /*saved draft during history nav*/ }
type EditorAction = { type: "none" | "submit" | "abort" | "cycle-approval" | "complete" | "eof" }
function handleKey(state: EditorState, key: Key): { state: EditorState; action: EditorAction }
```

- Editing: insert at cursor, backspace/delete, left/right, home/end (ctrl+a/e),
  word-left/right (alt+b/f), kill-to-end (ctrl+k), kill-line (ctrl+u),
  kill-word-back (ctrl+w), paste inserts payload verbatim (newlines → spaces
  for v1).
- History: up/down navigate; typing after recall edits a copy; the in-progress
  draft is preserved (`pending`) when navigating away and restored on
  down-past-newest. Submitted lines append to history (skip empty/dupes).
- Completion: tab → action `complete`; index.ts calls the existing sync
  `completer(text)` and either applies the single hit or asks the renderer to
  print candidates above. The editor itself knows nothing about completion
  sources.
- Keybindings from config (abort=esc, cycle-approval=shift+tab) map to
  actions here — the editor emits semantic actions, never runs handlers.
- NO I/O in this module. 100% unit-testable: `handleKey` in → state out.

### terminal.ts — renderer (the only module that writes ANSI)

```ts
class Terminal {
  start(): void                      // raw mode on, hide nothing, paint bottom region
  stop(): void                       // raw mode off, clear bottom region, cursor to col 0
  writeAbove(text: string): void     // output region: clear bottom, write, repaint bottom
  setInput(prompt: string, text: string, cursor: number): void   // repaint input line(s)
  setBusy(line: string | null): void // spinner line replaces input line while non-null
  setStatus(line: string): void      // repaint status bar line
  onKey(cb: (k: Key) => void): void  // wires stdin through keys.ts
  onResize(cb: () => void): void     // SIGWINCH → resize event
}
```

Repaint algorithm (the core invariant): the bottom region occupies the last
R rows (input rows + 1 status row). To write output: move to region top,
clear down (`ESC [ J`), write output text (it scrolls naturally), then
repaint region and restore cursor to the input position. Input longer than
one terminal row: compute wrapped row count from `process.stdout.columns`
and grow R accordingly; on resize, recompute and full-repaint.

- Raw mode is on for the ENTIRE session (start→stop), including while the
  agent runs — esc-to-abort becomes a plain key event, no more toggling.
- ctrl+c: first press clears current input (or aborts run); second press on
  empty input exits — match current behavior; ctrl+d on empty input = eof.
- All ANSI strictly inside this file. `colorEnabled`-style guard is
  irrelevant here because the Terminal is only constructed when
  `process.stdout.isTTY && process.stdin.isTTY` — otherwise index.ts uses
  the piped loop.

### index.ts integration

- TTY path: construct Terminal; the REPL becomes event-driven — key events →
  editor.handleKey → actions (`submit` runs the turn, `abort` cancels,
  `cycle-approval` cycles). All output that currently `console.log`s during
  a turn goes through `term.writeAbove(...)` — including streamed model
  deltas, tool-approval prompts, and slash-command output.
- Permission prompts: rendered via writeAbove (question) + a temporary
  editor prompt (`approve? [y/N] `) — reuse the same editor with a different
  prompt string and a one-shot submit handler. No nested readline.
- Piped path: everything readline currently does for `!isTTY` is replaced by
  a minimal `for await (const line of stdinLines())` loop. No Terminal, no
  editor, no ANSI.
- Startup banner prints once before `term.start()` so it lands in scrollback.
- Spinner: interval updates `term.setBusy("⠋ …")`; on completion
  `term.setBusy(null)` restores the input line.

## Pricing table + usage fix (prerequisite, foundation-independent)

Carried over from handoff-status-bar.md — these land BEFORE or WITH phase 3:

- `ModelCapabilities.pricing?: { inputPerM: number; outputPerM: number }`
  (USD per 1M tokens) in the presets models map: deepseek-chat 0.27/1.10,
  deepseek-reasoner 0.55/2.19, gpt-4o 2.50/10.00, openrouter
  anthropic/claude-sonnet-4 3.00/15.00, groq llama-4-scout 0.11/0.34,
  ollama no pricing.
- Fix output-tokens-always-0: the openai-compatible adapter must request
  `stream_options: {"include_usage": true}` (OpenAI-style) and read the
  final streamed usage chunk (DeepSeek sends one); parse
  prompt_tokens/completion_tokens into onUsage. Adapter test with a mocked
  stream carrying a trailing usage chunk.

## Phases (one subagent each, strictly ordered)

Each phase: tsc clean, `npm test` green (never lose a test), and its own
gates. No commits by agents. Never `git add` todo.md or screenshots.

**Phase 1 — keys.ts + editor.ts (pure logic + tests).**
New files only; zero changes to index.ts. Gates: unit tests covering every
key listed above, history semantics (draft preservation), paste event,
shift+tab decode (`ESC [ Z`), UTF-8 multibyte input. This phase can run in
parallel with unrelated work — it touches nothing existing.

**Phase 2 — terminal.ts renderer (+ mock-stream tests).**
Renderer writes to an injected `Writable` for tests: assert repaint
sequences for setInput/writeAbove/setStatus, wrapped-input row growth,
resize repaint. Manual gate: a tiny demo harness (scratch script, not
committed) driven under `script -q /dev/null` shows output scrolling above a
stable input+status region.

**Phase 3 — cut index.ts over; delete readline usage.**
The big one: REPL loop → event-driven, spinner/status/permission/slash
output through the renderer, piped path → plain stdin-lines loop, status bar
sections wired (incl. pricing + usage fix if not landed separately, ctx %).
Gates: full piped regression (`/help`, `/model`, `/mode`, a chat turn with
a dummy key failing gracefully, `/exit`) byte-sane and ANSI-free; faked-TTY
run shows the target experience; esc aborts a running turn; shift+tab
cycles approval; 137+ tests green.

**Phase 4 — polish.**
Persistent history file (`~/.heirloom/history`, capped), completion
candidate rendering above the input, bracketed-paste enable/disable
(`ESC [ ? 2004 h/l`) around start/stop, cursor-visibility hygiene on crash
(process exit handler calls term.stop()), any repaint-flicker fixes.

## Non-goals (v1)

- Multi-line input editing (shift+enter) — paste flattens to one line.
- Mouse support, scrolling within the TUI, alternate screen buffer (we
  deliberately keep native scrollback — no `ESC [ ? 1049 h`).
- Windows terminal quirks beyond what raw ANSI already gives.
- Themes/config for the status bar layout.

## Sequencing with in-flight work

1. handoff-model-fixes.md (running) lands first — logic fixes, all survive
   the redesign. Its /model listing code moves into writeAbove calls in
   phase 3 mechanically.
2. handoff-status-bar.md is SUPERSEDED by this spec except its pricing table
   and usage-parsing fix, which are folded in above. Do not implement its
   cursor-dance placement.
3. Phases 1→4 in order; phase 1 may start while model-fixes is still open
   (disjoint files), phases 2+ only after model-fixes lands.
