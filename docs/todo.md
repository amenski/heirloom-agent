# Heirloom ⇐ deepcode-cli feature parity — TODO

Source reference: deepcode-cli `packages/cli` (github.com/lessweb/deepcode-cli), full source
cached locally at `/private/tmp/claude-502/-Users-amanuel-Documents-prg-proj-heirloom-agent/5b843ff9-bd04-4aa0-bc24-d97cba5cd07b/scratchpad/deepcode/` (63 files, `src_*` filename = original path with `/` → `_`).

Already completed (see git log / this session): config system (`.deepcode/settings.json`),
scope-based permissions engine, provider layer rewrite, theming, keybindings, command palette,
status line, exec mode, `loading-text.ts`, `clipboard.ts`, Ctrl+V image paste with full
multimodal support (Message.imageUrls → aisdk.ts → AI SDK file/image parts), reasoning/thinking
stream plumbing (aisdk.ts reasoning-delta → agent.ts onReasoning → App.tsx collapsed one-liner).

Each task below is independent unless noted. Work top to bottom; check off acceptance criteria
before marking done. Typecheck (`npx tsc --noEmit`) and test (`npm test`) must stay clean after
every task.

---

## 1. AskUserQuestion tool + UI [DONE]

Reference: `src_ui_core_ask-user-question.ts`, `src_ui_views_AskUserQuestionPrompt.tsx`.

Already done this session:
- `src/tools/types.ts`: added `AskQuestionOption`, `AskQuestionItem`, `ToolContext.askQuestion`.
- `src/tools/ask_user_question.ts`: new tool `ask_user_question`, registered in `src/tools/index.ts`
  with `setAskQuestion()` setter.

Completed this session:
- `src/cli.tsx` already imported `setAskQuestion` (was wired but never called). `App.tsx` now
  imports `setAskQuestion` and calls it before/after each agent turn with the bridging callback.
- `src/ui/App.tsx`: added `askQuestionPrompt` state parallel to `askPrompt`, wired lifecycle in
  `runAgentTurn` (set before, clear in finally), added early return in `useInput`, rendered
  `AskUserQuestionPrompt` gated on state.
- `src/ui/views/AskUserQuestionPrompt.tsx`: new view with single-select (radio `●`/`○`), multi-select
  (`[x]`/`[ ]` checkboxes), Space toggle, Enter confirm, digit keys 1-9 direct select/digit for
  single-select, always-appended "Other" option with focused text field (border color changes),
  Esc cancels whole prompt (resolves `null`).

**Acceptance criteria:**
- A test tool call to `ask_user_question` with 2 single-select questions pauses the turn, renders
  the prompt view, and resolves with `{"question text": "chosen label"}` after the user picks
  answers for both.
- Choosing "Other" and typing free text returns that exact text as the answer.
- A `multiSelect: true` question lets the user toggle 2+ checkboxes before advancing; the answer
  string contains all selected labels.
- Pressing Esc at any point returns `null` to the tool handler, which then returns
  `formatAskUserQuestionDecline()` as the tool's output content (not an error).
- `npx tsc --noEmit` and `npm test` pass.

---

## 2. Plan mode (Shift+Tab toggle + PlanImplementationPrompt) [DONE]

Completed:
- `src/ui/core/slash-commands.ts`: added `plan` to `SlashCommandKind` and `/plan` to `BUILTIN_SLASH_COMMANDS`.
- `src/ui/views/PromptInput.tsx`: Shift+Tab calls `onTogglePlanMode()`; `/plan` slash selection also triggers toggle.
- `src/ui/App.tsx`: `planMode` boolean state; toggle function; yellow/dim banner above PromptInput when active.
- `src/prompt.ts`: `PromptContext.planMode` flag → when true, injects "You are in planning mode. Do NOT execute any tool calls... Your reply must end with <proposed_plan>...</proposed_plan>".
- `src/agent.ts`: `AgentOptions.planMode` piped to `buildSystemPrompt`.
- `src/cli.tsx` & `src/ui/types.ts`: `planMode` threaded through `runAgentTurnCore` → `runAgentTurnBridge` → `runAgent`.
- `src/ui/App.tsx`: after turn completes, scans `result.newMessages` for `<proposed_plan>...</proposed_plan>`, renders `PlanImplementationPrompt` if found.
- `src/ui/views/PlanImplementationPrompt.tsx`: new view, 3 choices with arrow-key navigation, CJK heuristic for follow-up prompt language.
- `npx tsc --noEmit` and `npm test` pass.

---

## 3. SessionList view (`/resume`, `/continue`, `--resume` picker) [DONE]

Completed:
- `src/sessions/store.ts`: added `deleteSession(id)` and `getSummary(id)` methods.
- `src/ui/views/SessionList.tsx`: new view — live-filterable by typing, scrollable with arrow keys,
  Enter to select/resume, Ctrl+R inline rename (persists via `appendState`), Delete/Backspace
  (when search empty) confirm-delete, Esc clears search then closes.
- `src/ui/App.tsx`: `showSessionList` state, intercepts `/resume`/`/continue` in `handleSlashCommand`,
  renders `SessionList` component gated on state, `showResumeOnStart` effect for bare `--resume` flag.
- `src/cli.tsx`: `resumeSession` callback in appCtx (loads session via `loadEffective`, sets
  `conversationHistory` and `sessionId`), `showResumeOnStart: true` when `--resume` bare flag.
- `src/ui/types.ts`: added `resumeSession` and `showResumeOnStart` to `AppContext`.
- `npx tsc --noEmit` and `npm test` pass (121 tests).

Reference: `src_ui_views_SessionList.tsx` (report §6). Wire to `src/sessions/store.ts`
(`SessionStore` — check its current API for listing/renaming/deleting sessions before assuming
method names).

- [ ] New view `src/ui/views/SessionList.tsx`:
      - Live-filterable list: typing any non-nav character appends to a search buffer; filter
        sessions by substring match (case-insensitive) against summary/status/last-reply fields
        available on our `SessionStore` records.
      - Dynamic visible-row count from terminal rows (reuse `useTerminalInfo()`/`TerminalProvider`
        already in `src/ui/contexts.tsx`), with scroll offset.
      - Inline rename mode (Ctrl+R): full cursor-editable text field for the session summary;
        Enter commits (persist via `SessionStore`), Esc cancels.
      - Inline delete confirm (Delete/Backspace when search is empty): Enter confirms delete
        (persist via `SessionStore`), Esc cancels.
      - Esc semantics: clears search text first if present, else closes the view entirely.
- [ ] Wire `/resume` and `/continue` (when no active session) slash commands to open this view.
- [ ] Wire `--resume [sessionId]` CLI flag (see `src/cli-args.ts`) — bare flag opens the picker at
      startup, `--resume <id>` loads that session directly without showing the picker.
- [ ] On selecting a session, load its message history into `shared.conversationHistory` (see
      `runAgentTurnBridge` in `cli.tsx`) and close the view.

**Acceptance criteria:**
- `/resume` with 3+ existing sessions shows a scrollable, searchable list; typing narrows results.
- Selecting a session resumes it — the next prompt sent has that session's prior history as
  context (verify by checking `shared.conversationHistory` is populated, or via an integration
  test against `SessionStore`).
- Ctrl+R renames a session; the new name persists across `SessionStore` reload.
- Delete removes the session from `SessionStore` after confirmation.
- `heirloom --resume <valid-uuid>` skips the picker and loads directly;
  `heirloom --resume <invalid-id>` errors clearly before entering the TUI.
- `npx tsc --noEmit` and `npm test` pass.

---

## 4. UndoSelector view (`/undo`) + checkpoint restore wiring [DONE]

Completed:
- `src/checkpoints/index.ts`: added `restoreFrom(hash)` for restoring from a specific commit.
- `src/cli.tsx`: `runAgentTurnBridge` now saves checkpoints before each turn with `[convLen:N]`
  marker in commit message; `restoreCheckpoint` callback in appCtx handles code restore and
  conversationHistory truncation.
- `src/ui/views/UndoSelector.tsx`: two-phase view — pick checkpoint, then choose restore mode
  (code+conversation or conversation only).
- `src/ui/App.tsx`: `showUndoSelector` state, intercepts `/undo`, renders UndoSelector, sets
  `promptDraft` after restore.
- `npx tsc --noEmit` and `npm test` pass.

Reference: `src_ui_views_UndoSelector.tsx` (report §6). Wire to `src/checkpoints/index.ts`
(`CheckpointManager` — confirm current restore method signatures before assuming).

- [ ] New view `src/ui/views/UndoSelector.tsx`, two-phase:
      1. `message` phase: list past user-prompt checkpoints (from `CheckpointManager`), pick one.
      2. `mode` phase: choose "Restore code and conversation" vs "Restore conversation only" —
         only offer the code-restore option if the checkpoint has an associated code snapshot
         (check `CheckpointManager`'s API for how it tracks this, e.g. a `canRestoreCode`-style
         flag or the presence of a git stash/diff for that checkpoint).
- [ ] Restoring calls into `CheckpointManager` to (a) revert working-tree files to the checkpoint
      snapshot and/or (b) truncate `shared.conversationHistory` back to that point.
- [ ] After restore, put the restored user message text back into the prompt draft (so the user
      can edit and resubmit) — reuse the existing `promptDraft` mechanism already in `App.tsx`/
      `PromptInput.tsx` (see `appliedDraftNonceRef` pattern).
- [ ] Errors from either restore step (code vs conversation) are collected and shown without
      blocking the other from completing.
- [ ] Wire `/undo` slash command to open this view.

**Acceptance criteria:**
- `/undo` with 2+ prior checkpoints shows a selectable list of past user prompts.
- Choosing "Restore code and conversation" reverts tracked files to the checkpoint's git state
  (verify via `git status`/`git diff` in a test repo) and truncates history.
- Choosing "Restore conversation" only truncates history, leaves working-tree files untouched.
- The restored user message text appears back in the prompt input, editable.
- `npx tsc --noEmit` and `npm test` pass.

---

## 5. McpStatusList view (`/mcp`)

Reference: `src_ui_views_McpStatusList.tsx` (report §6). Wire to `src/mcp/connector.ts`
(`connectMCPServers`, per-server tool/prompt/resource snapshots already tracked in
`toolSnapshots`).

- [ ] New view `src/ui/views/McpStatusList.tsx`, two-level:
      - Server list: name, status icon (✓ connected / ✗ failed / ↻ reconnecting / ● starting,
        with animated "..." dots while starting/reconnecting), tool/prompt/resource counts.
      - Drill-down: selecting a server shows its registered tools (from `toolSnapshots` in
        `src/mcp/connector.ts` — may need to export a getter) — name + input schema summary.
      - Reconnect action, surfaced only for servers in `failed` status: re-calls
        `connectMCPServers({ [name]: config })` for just that one server.
- [ ] `src/mcp/connector.ts` needs a per-server status field (`connected` | `failed` |
      `reconnecting` | `starting`) if it doesn't already track one — check current state before
      adding.
- [ ] Wire `/mcp` slash command to open this view.

**Acceptance criteria:**
- `/mcp` with 1+ configured MCP servers (from `.deepcode/settings.json` `mcpServers`) shows each
  server's live status and tool count.
- Drilling into a connected server lists its tool names.
- Triggering reconnect on a deliberately-broken server config (e.g. bad command path) shows
  `reconnecting` then `failed` again, without crashing the app.
- `npx tsc --noEmit` and `npm test` pass.

---

## 6. Raw display modes (Lite / Normal / Raw scrollback) + RawModeContext

Reference: `src_ui_contexts_RawModeContext.tsx`, `src_ui_components_RawModeExitPrompt_index.tsx`,
`src_ui_components_RawModelDropdown_index.tsx` (report §11). Note: our App.tsx renders a flat
scrolling output buffer (`outputLines`/`activeLine`), not deepcode-cli's `SessionMessage[]`-driven
`<Static>` list — adapt accordingly rather than porting 1:1.

- [ ] New context `src/ui/contexts/RawModeContext.tsx` (or add to existing `src/ui/contexts.tsx`):
      `mode: "lite" | "normal" | "raw"`, default `"lite"`.
      - `lite`: current behavior (reasoning collapses to one-liner, per task #15/16 already done).
      - `normal`: reasoning renders in full instead of collapsing (skip the `flushReasoning()`
        truncation in `App.tsx`, print the full accumulated buffer instead).
      - `raw`: bypass the queued/flushed output pipeline — write each chunk directly to
        `process.stdout` as plain text (no ANSI dimming, no code-block buffering) so native
        terminal scrollback/copy works. Replaying prior history on mode entry is optional given
        our flat-buffer architecture — at minimum, new output must go straight to stdout.
- [ ] `/raw` slash command with args hint `lite | normal | raw-scrollback` cycles modes (reuse the
      generic `DropdownMenu` component already in `src/ui/components/DropdownMenu/`, following the
      same pattern as `ModelsDropdown`/`SkillsDropdown`).
- [ ] Ctrl+R (currently unbound in our `PromptInput.tsx`? verify — deepcode-cli uses it to open
      the raw-mode dropdown; check our keybindings.ts for conflicts first, since Ctrl+R also means
      "rename" in SessionList — scope Ctrl+R to whichever view is focused).
- [ ] Esc exits raw mode back to the previously active mode.

**Acceptance criteria:**
- `/raw normal` shows full (untruncated) reasoning text on the next turn instead of a collapsed
  summary line.
- `/raw raw-scrollback` writes subsequent output directly via `process.stdout.write`, bypassing
  the dimmed tool-call formatting — verify by capturing stdout in a test harness and checking for
  absence of ANSI dim codes.
- Esc from raw mode returns to `lite` (or whichever mode was active before).
- `npx tsc --noEmit` and `npm test` pass.

---

## 7. Exit summary (usage table) + resume hint

Reference: `src_ui_exit-summary.ts` (report §6).

- [ ] New module `src/ui/exit-summary.ts`:
      - `buildExitSummaryText(usagePerModel)`: renders a boxed Unicode usage table, one row per
        model used this session — columns: Reqs, Input Tokens, Output Tokens, Cached Tokens, all
        `toLocaleString("en-US")`-formatted and right-aligned, fixed ~98-col width matching
        deepcode-cli's box-drawing style.
      - Source the per-model usage data from wherever `shared.sessionInput`/`sessionOutput` are
        tracked in `cli.tsx` — may need to extend that tracking to be per-model (currently it
        looks like a single running total; check `runAgentTurnBridge`'s `onUsage` in `cli.tsx`
        around the `shared.sessionInput += input` line) since multiple models could be used in
        one session via `/model` switching.
      - `buildResumeHintText(sessionId)`: prints `"heirloom --resume <id>"` in an accent color.
- [ ] Wire into the exit flow (`handleExit`/`onExitShortcut` path in `App.tsx`) — print both boxes
      after the `/exit` echo, before disposing the session and calling Ink's `exit()`.

**Acceptance criteria:**
- Exiting a session that used one model shows a usage table with exactly one row and correct
  cumulative token counts (verify against `shared.sessionInput`/`sessionOutput`).
- Exiting a session where the user ran `/model` mid-session to switch models shows two rows, one
  per model, each with only that model's usage (not double-counted or merged).
- The resume hint always shows the correct current `sessionId`.
- `npx tsc --noEmit` and `npm test` pass.

---

## 8. ProcessStdoutView (Ctrl+O background process viewer)

Reference: `src_ui_views_ProcessStdoutView.tsx` (report §15). **Blocked on a prerequisite**: our
`src/tools/bash.ts` currently has no background/detached-process concept at all (confirmed via
`grep -n "background|detach|nohup|spawn" src/tools/bash.ts` returning nothing this session) — bash
tool calls run synchronously to completion. Do NOT attempt this task until background process
execution exists in `bash.ts`; scope that as a sub-step here rather than a separate assumed
feature.

- [ ] Design + implement background bash execution in `src/tools/bash.ts` (e.g. a `background:
      true` arg, or trailing `&` detection) that returns immediately with a PID and streams stdout
      into a bounded buffer (cap at 1MB per process, matching deepcode-cli) instead of blocking
      the tool call.
- [ ] Track running processes in `App.tsx` (a `runningProcesses: Map<pid, {command, startTime,
      buffer}>` ref, capped per-process).
- [ ] New view `src/ui/views/ProcessStdoutView.tsx`: Ctrl+O opens a scrollable panel tailing
      buffered stdout per running PID, with `── Process PID [cmd] ──` separators between multiple
      processes. Refresh on an interval (~150ms) while open.
- [ ] Arrow keys scroll 10 lines, PageUp/PageDown scroll a full page, clamped to valid range. Show
      a `"... (N lines above · ↑/↓ to scroll · M total lines) ..."` marker when scrolled.
- [ ] Optional (matches deepcode-cli but not essential): `+`/`-` adjust the active bash tool call's
      timeout live.

**Acceptance criteria:**
- A tool call that starts a long-running background command (e.g. a dev server) returns control
  immediately; Ctrl+O opens a live-updating view of its stdout.
- Scrolling up/down/page-up/page-down navigates correctly and clamps at the buffer's edges.
- Closing the view (Esc) returns to the normal prompt without killing the background process.
- `npx tsc --noEmit` and `npm test` pass.

---

## 9. Self-update checker (update-check.ts + UpdatePrompt)

Reference: `src_common_update-check.ts`, `src_ui_views_UpdatePrompt.tsx` (report §3). Skip the
Tencent Cloud npm mirror logic (China-market-specific, not relevant) — use the public npm registry
directly.

- [ ] New module `src/common/update-check.ts`:
      - Persist state at `~/.heirloom/update-check.json` (adjust path prefix to match our existing
        `~/.deepcode/` convention if that's the established dir — check `src/config/loader.ts`
        for the canonical home-config path constant before hardcoding a new one).
      - `checkForNpmUpdate(packageInfo)`: background check via `npm view heirloom dist-tags.latest
        --json` (spawn with a hard timeout + kill, cap output size), compares against installed
        version with a simple semver-like comparator, persists a `pending` entry if newer and not
        already in `ignoredVersions`. All failures swallowed silently — must never block startup.
      - `promptForPendingUpdate(packageInfo)`: called synchronously before the main TUI renders;
        if a pending update exists, mounts a small dedicated Ink app and awaits the user's choice.
- [ ] New view `src/ui/views/UpdatePrompt.tsx`: 3 choices — Install (`npm install -g
      heirloom@<version>` with `stdio: "inherit"`), Ignore once, Ignore this version (persists to
      `ignoredVersions`).
- [ ] Wire into `src/cli.tsx`'s `main()`: call `promptForPendingUpdate()` after arg parsing but
      before the TUI renders (see deepcode-cli's ordering — after version/help handling so those
      still work without a check). Fire `checkForNpmUpdate()` in the background after the app
      starts (fire-and-forget, not awaited).

**Acceptance criteria:**
- With a fake `ignoredVersions`/`pending` state file and a stubbed npm-view result, launching
  shows the `UpdatePrompt` before the main chat UI.
- "Ignore this version" persists that version to `~/.heirloom/update-check.json` and the prompt
  does not reappear for that version on next launch.
- "Install" spawns the correct `npm install -g heirloom@<version>` command (verify via a spied
  `spawn` call in a test, do not actually run a real install in CI).
- If the npm registry call fails/times out, startup proceeds normally with no error shown to the
  user.
- `npx tsc --noEmit` and `npm test` pass.

---

## 10. Hand-rolled terminal input parser (useTerminalInput, cursor.ts)

Reference: `src_ui_hooks_useTerminalInput.ts`, `src_ui_hooks_cursor.ts` (report §4.3-4.4). This is
the largest and riskiest task — it replaces/augments Ink's `useInput` in `PromptInput.tsx` with a
hand-written ANSI/VT parser. Do this LAST, after all other UI tasks are done, since it touches the
same input-handling code every other prompt view depends on.

- [ ] New module `src/ui/hooks/useTerminalInput.ts`: `parseTerminalInput(data: Buffer|string):
      InputKey` — recognizes upArrow/downArrow/home/end/pageUp/pageDown/return/escape/ctrl/shift/
      tab/backspace/delete/meta/focusIn/focusOut/paste, handling multiple escape-sequence variants
      per key (different terminals send different sequences for the same logical key).
- [ ] Bracketed paste detection/reassembly: `ESC[200~ ... ESC[201~`, buffering chunks in an array
      (not string concatenation) to avoid O(n²) cost on large pastes, correctly handling paste
      content split across multiple `data` events.
- [ ] `useTerminalInput(handler, {isActive})` hook: uses Ink's `useStdin()` for raw mode, listens
      to `stdin.on("data", ...)` directly instead of Ink's synthetic input dispatch.
- [ ] `src/ui/hooks/cursor.ts`: raw ANSI toggles (show/hide cursor, focus reporting, bracketed
      paste mode), `getPromptCursorPlacement()` accounting for East-Asian wide characters and
      combining marks, `usePromptTerminalCursor()` using Ink 7's `useCursor()`/`useBoxMetrics()` to
      place the real terminal cursor exactly on the simulated text cursor.
- [ ] Migrate `PromptInput.tsx`'s existing `useInput`-based key handling to use the new parser,
      preserving every existing keybinding (do not regress Ctrl+A/E/B/F/K/U/W/J, arrows, history
      nav, slash menu nav, Ctrl+V/X image handling, Ctrl+D exit, etc. — re-verify each against the
      current `useInput` callback before removing it).

**Acceptance criteria:**
- All existing `PromptInput.tsx` keybindings still work identically after migration (manual pass
  through every binding listed in the current `useInput` callback, or a scripted stdin-injection
  test if feasible with Ink's test renderer).
- Bracketed paste of a large multi-line block (>1000 chars) is captured as a single paste event,
  not character-by-character.
- Terminal cursor visually sits on the correct character within wrapped multi-line input text
  (manual verification in an actual terminal — this cannot be meaningfully unit-tested).
- `npx tsc --noEmit` and `npm test` pass; run the app manually and confirm no input regressions
  before considering this done (per this repo's UI-testing convention: type-checking and test
  suites verify code correctness, not feature correctness for terminal UI).

---

## 11. WelcomeScreen ascii-art + responsive layout polish

Reference: `src_ui_ascii-art.ts`, `src_ui_views_WelcomeScreen.tsx`, `src_ui_views_ThemedGradient.tsx`
(report §14). Lowest risk/priority — pure visual polish on an existing, working component.

- [ ] New module `src/ui/ascii-art.ts`: block-letter logo for "HEIRLOOM" (rebrand deepcode-cli's
      "DEEP CODE" Unicode box-character art — do not reuse their literal branding/name).
- [ ] `src/ui/views/ThemedGradient.tsx`: wraps `ink-gradient`'s `<Gradient>` (check if
      `ink-gradient`/`gradient-string` are already deps — they are not per current `package.json`,
      so add them, or skip the gradient wrapper and just use a solid theme-accent color like
      deepcode-cli's current flat-color placeholder actually does).
- [ ] Bordered info panel: title + version, Model / Thinking Enabled / Reasoning Effort / CWD rows
      (right-aligned values), CWD shown home-relative (`~/...`).
- [ ] Random tip line drawn from the union of all slash commands + a hardcoded shortcut-tips list
      (Enter, Shift+Enter, Ctrl+V, Ctrl+R, Esc, `/`, Ctrl+D twice), deduped against slash commands,
      picked once per mount (`useState(() => ...)`, stable until remount via `/new`).
- [ ] Responsive compact layout: if terminal width < ~112 cols, drop fixed panel width/height,
      tighten margins.

**Acceptance criteria:**
- `WelcomeScreen` renders the new ascii-art logo without layout overflow at 80-col width (test at
  both 80 and 160 col widths).
- The info panel shows live values for Model/Thinking/Effort/CWD matching the current session
  config.
- The tip line changes across app restarts (`/new`) but stays fixed within a single session.
- `npx tsc --noEmit` and `npm test` pass.

---

## 12. Verify hand-rolled markdown table renderer matches deepcode-cli

Reference: `src_ui_components_MessageView_markdown.ts` (report §10). Comparison/audit task, not a
full rewrite — only port what's genuinely missing.

- [ ] Compare `src/ui/MarkdownText.tsx`/`src/ui/SyntaxHighlighter.tsx` against deepcode-cli's
      table-rendering logic:
      - CJK/emoji-aware visual width calculation (not `.length`) for column sizing.
      - "Label column" heuristic: columns ≤12 chars keep natural width instead of being compressed.
      - Grow-to-fill (proportional slack distribution) vs compress-to-fit (proportional deficit
        budget) column sizing depending on available width vs `maxWidth`.
      - Per-cell word wrapping (`wrapCell`): break on last space past 1/3 width, else force-break
        mid-word.
      - Full Unicode box-drawing character set (`┌┬┐│├┼┤└┴┘`).
- [ ] Port only the pieces our renderer is missing — check current behavior first with a wide
      table containing CJK text and a narrow-column header before assuming a gap exists.

**Acceptance criteria:**
- A markdown table with a mix of CJK and ASCII text renders with correctly aligned column borders
  (CJK chars counted as width 2, not 1) — add a unit test asserting rendered line lengths match
  across rows.
- A table wider than the terminal compresses proportionally rather than truncating or overflowing
  the terminal width.
- `npx tsc --noEmit` and `npm test` pass.

---

## Suggested execution order

1 (finish in-progress) → 2 → 3 → 4 → 5 → 6 → 7 → 9 → 11 → 12 → 8 (needs bash.ts prerequisite) → 10 (last, highest blast-radius).
