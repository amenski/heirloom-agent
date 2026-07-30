# Improvement Roadmap

Status: **planning doc, not a spec, nothing implemented.** A review of several
`lessweb/deepcode-cli` PRs for ideas worth bringing into Heirloom, adapted to
its architecture and ethos. **We are not doing all of this** — the table below
sorts each idea into **do-now / roadmap / reject**. Detailed per-PR analysis
follows; once an item is picked up and built, its behavior moves into the
matching subsystem spec (e.g. [session-spec.md](./session-spec.md),
[permission-spec.md](./permission-spec.md)).

PRs reviewed: [#266](https://github.com/lessweb/deepcode-cli/pull/266) ·
[#263](https://github.com/lessweb/deepcode-cli/pull/263) ·
[#225](https://github.com/lessweb/deepcode-cli/pull/225) ·
[#216](https://github.com/lessweb/deepcode-cli/pull/216) ·
[#132](https://github.com/lessweb/deepcode-cli/pull/132)

---

## TL;DR — the borrow list, ranked

Recurring theme: these PRs are worth mining for **ideas**, rarely for **code** —
several put keys in config or data in SQLite/plaintext in ways that cut against
Heirloom's stated ethos, and a few duplicate things Heirloom already does
better. Pick the small, high-value, on-ethos wins first; park the big
architectural swings on the roadmap; drop the rest.

### ✅ Do now — small, high-value, on-ethos

| Item | Source | Effort | Why now |
|---|---|---|---|
| **`/theme` command** (live preview, Esc-revert, persist) | #132 | S–M | Heirloom has all the theming infra but **no runtime switch**. Clearest feature gap. |
| **Fix `detectSystemTheme` stub** (real `COLORFGBG`/macOS detection) | #132 | S | Current `mode:"auto"` is silently "always dark" — a **real bug**. Ships with tests. |
| **Permission audit trail** (JSONL sidecar) | #266 | S | Records every allow/deny/ask + reason. The core of "permission saving." |
| **Masked key input + `--api-key`/piped stdin** for `auth` | #225 | S | Key is typed in **plaintext** today; wizard can't be scripted. |
| **`strictMcpConfig`** MCP command allowlist | #263 | S | ~30 lines; real, cheap MCP hardening. |
| **Token-usage log + in-memory metrics** | #266, #263 | S | Per-turn usage + accept/reject counts in the exit summary. |
| **Extra theme presets** (dracula, monokai, github, ansi) | #132 | S | Pure data, re-expressed in Heirloom's richer theme shape. |
| **Gutter/prompt contrast fix** (route accents through theme slots) | local | S | Hardcoded `#229ac3` washes out on light terminals. See [theme-spec.md](./theme-spec.md). |
| **Long→short flag map** for destructive rules | local | S | Closes `rm --recursive --force /` gap. See [security-destructive-matching.md](./security-destructive-matching.md). |
| **`docs_search` tool** (keyless official APIs; no provider, no scraper, no backend) | local | M | Out-of-box search for coding queries; general web via MCP. Binding spec: [web-search-spec.md](./web-search-spec.md). |

> **Local (non-borrow) findings** also tracked in their own docs, with priorities:
> the two rows above are the do-now items; the input-stutter fix
> ([input-stall-diagnosis.md](./input-stall-diagnosis.md), move committed output
> to Ink `<Static>`) is a medium roadmap item; an OS sandbox
> ([security-destructive-matching.md](./security-destructive-matching.md)) is the
> large, model-changing one.

### 🗺️ Roadmap — valuable but bigger / needs its own decision

| Item | Source | Effort | Why later |
|---|---|---|---|
| **PermissionProfile ACL model** (path/network/git sandbox) | #263 | L | A *parallel* permission architecture to the current rule engine — needs its own design doc + a reconcile-or-migrate decision. |
| **Hierarchical project rules** (`.heirloom/rules/**`) | #266 | M | Additive to `instructions.md`/`AGENTS.md`; nice, not urgent. |
| **Auto error-fix loop + `<error_analysis>`** | #266 | M | Must first audit overlap with existing `errorrecovery/` + `selfreflection/`. |
| **Lifecycle hooks** (shell on events) | #263 | M | Powerful but another untrusted-exec surface — opt-in + security-spec first. |
| **`/usage` balance command** (generalized adapter method) | #216 | M | Only worth it provider-agnostic (`getBalance()` on the adapter), else DeepSeek-only special-case. |
| **React exit-summary view** | #132 | S–M | Robustness fix (survives scroll); orthogonal to everything else. |
| **SQLite log backend** | #266 | L | Only if JSONL logs prove they need cross-session SQL. Off-ethos (opaque binary sessions). |

### ❌ Reject — importing would be a downgrade or off-ethos

| Item | Source | Why not |
|---|---|---|
| PR's `ThemeTokens` model / `resolver.ts` | #132 | Heirloom's theme model is **strictly richer** and already integrated. |
| `buildLoginSettings` writing the key into `settings.json` | #225 | Heirloom keeps keys out of config (`credentials.yaml`, chmod 600). Take the ergonomics, not this. |
| Wholesale cherry-pick of #263 | #263 | Branch has a **literal unresolved Git merge-conflict marker** in `permissions.ts`. Reimplement ideas, don't lift. |
| `job-queue.ts`, `skill-parser.ts` | #263 | Out of scope for these goals (background exec / skill-frontmatter tied to PermissionProfile). |
| Vendored `cli.js` blob, Python skill templates, prompt-text | #266/#263 | Noise / go through Heirloom's own system-prompt change protocol. |

---

## Where the ideas came from

PR #266 in `deepcode-cli` bundles a lot of unrelated things (a 105k-line
vendored `cli.js` blob, a set of Python "skill" templates). Ignore those. The
genuinely reusable core is five concepts, all in
`packages/core/src/common/session-log.ts` and the `session.ts` diff:

| # | Concept | Summary |
|---|---------|---------|
| 1 | **Structured session log** | Per-session store of typed events (`agentMessage`, `toolCall`, `permission`, `system`), queryable. |
| 2 | **Permission audit trail** | Every allow/deny/ask decision recorded with tool, scopes, decision, reason — plus a history query. |
| 3 | **Token-budget audit** | Per-turn token rows (`turn`, `total`, `max`, `remaining`); "budget left" query. |
| 4 | **Auto error-fix loop** | On tool failure, inject a "don't move on — fix it" reminder; retry ≤3× then escalate. Bash output gets a grepped `<error_analysis>` header. |
| 5 | **Hierarchical project rules** | `.deepcode/rules/**/*.md` recursively loaded, injected as scoped rule sections. |

The PR's original design persists all of this to a **SQLite database** (`sql.js`,
pure-WASM) with tables `session_logs`, `token_budget`, `permission_audit`,
`checkpoints`, 30s auto-save, and 7-day auto-cleanup.

---

## What Heirloom already has (gap analysis)

| PR concept | Heirloom today | Actual gap |
|---|---|---|
| Session log | Append-only **JSONL** per session — `SessionStore`, `~/.heirloom/sessions/<slug>/<id>.jsonl`, records typed `meta \| message \| state \| compaction` (`src/sessions/store.ts`). | Not the *store* — the **queryability** and the *event types* (permission, token). |
| Permission saving | Approved rules **persist** to `.deepcode/settings.json` via atomic write (`engine.ts: approveAlways → persist`). | No **audit trail**: denies, one-time allows, and the *reason* a decision was made are never recorded. |
| Token budget | `estimateTokens` / `shouldCompact` drive compaction (`src/compaction/budget.ts`). | Usage is **never recorded** per turn; no history, no "remaining" surfaced. |
| Auto error-fix | `src/errorrecovery/` + `src/selfreflection/` already exist. | Possible **overlap** — must audit before porting, or we duplicate. |
| Project rules | Single `.heirloom/instructions.md` / `AGENTS.md`. | No **directory of scoped rules**. Additive. |

Net: the two things you specifically asked for — **session-log saving** and
**permission saving** — are *partly* already present. The new value is the
**audit trails** (permission decisions + token usage) and, optionally,
**queryability**.

---

## The gating decision: SQLite vs. JSONL

Everything downstream depends on this. Heirloom's README promises "no magic,
every layer independently readable and replaceable" and "sessions are plaintext
files under `~/.heirloom/`." Adopting SQLite pushes against that.

### Path A — Keep JSONL, add typed sidecar logs  ← **recommended**

- New event types written to the existing session JSONL (or sibling
  `permission-audit.jsonl` / `token-usage.jsonl` files).
- Everything stays grep-able plaintext.
- "Query" = read the file + filter in JS. Fine at single-user, few-hundred-turn
  scale.
- **No new dependency**, on-ethos, low risk.
- Adopt the PR's **table schemas as the data model** — the columns are
  well-designed — just serialize each row as one JSON line instead of a SQL row.

### Path B — Adopt `sql.js` (as the PR does)

- Real SQL: `json_extract`, indices, computed `remaining` column, cross-session
  queries.
- **Costs:** a WASM dependency; session data becomes an opaque binary `.db`
  (breaks the plaintext promise in `security-spec.md`); a save / WAL / lifecycle
  layer with a `process.on("exit")` flush; 7-day auto-deletion of history.
- Higher risk, off-ethos. Buys queryability that single-user scale may never
  need.

**Recommendation: Path A.** Take the PR's data model, not its storage engine.
Revisit Path B only if #1–#3 prove a real need for cross-session SQL. The rest
of this plan assumes Path A.

---

## Proposed data model (Path A serialization)

One JSON object per line. Reuse the existing `SessionRecord` envelope
(`{ type, at, ... }`) so these ride in the session JSONL, or split into sidecar
files keyed by session id — decide per phase.

**Permission decision**
```jsonc
{ "type": "permission", "at": "<iso>",
  "toolCallId": "…", "tool": "run_bash",
  "subject": "rm -rf build",          // the literal command / path matched
  "decision": "deny",                 // "allow" | "deny" | "ask-once" | "session" | "always"
  "winningRule": { "tool": "…", "kind": "exact", "pattern": "…", "origin": "…" },
  "reason": "user denied at prompt" }
```

**Token usage (per turn)**
```jsonc
{ "type": "token", "at": "<iso>",
  "turnTokens": 4210, "totalUsed": 88123, "budgetMax": 200000 }
// remaining is derived (budgetMax - totalUsed), not stored
```

---

## Phased plan (each phase independently shippable + verifiable)

### Phase 1 — Permission audit trail  *(highest value, smallest surface)*
- Emit a `permission` record at every decision point in
  `src/permissions/engine.ts` (`resolve` + the `approveForSession` /
  `approveAlways` / deny / one-time paths).
- Add a read-side query (`queryPermissionHistory(sessionId)`) and a
  `/permissions history` view in the TUI.
- **Verify:** deny, always-allow, session-allow, and one-time each produce one
  correct row with the right `decision` and `winningRule`.

### Phase 2 — Token-usage log
- After each turn in `src/agent.ts`, record `{ turnTokens, totalUsed,
  budgetMax }` (reuse `estimateTokens`).
- Surface "remaining" in the status bar and/or a query.
- **Verify:** rows accumulate per turn; remaining math agrees with the value
  compaction already computes.

### Phase 3 — Hierarchical project rules
- Loader for `.heirloom/rules/**/*.md`, recursively, scoped by subdirectory
  (mirror the PR's `loadProjectRules`), injected alongside the existing
  `instructions.md` / `AGENTS.md`.
- **Verify:** a nested rule file (`rules/api/naming.md`) appears as a scoped
  section in the system prompt.

### Phase 4 — Auto error-fix + `<error_analysis>`
- **First** audit `src/errorrecovery/` and `src/selfreflection/` for overlap —
  enhance, don't duplicate.
- Then: on a failed tool result, inject a bounded fix-reminder (≤3 retries);
  have the bash tool prepend a grepped `<error_analysis>` block on non-zero
  exit.
- **Verify:** a failing bash command triggers exactly one fix-retry cycle, not
  an infinite loop; escalates after the cap.

### Phase 5 — SQLite (optional, deferred)
- Only if #1–#3 demonstrate a real need for cross-session SQL queries. Adopt
  `sql.js` with the PR's four-table schema. Treat as a separate, opt-in storage
  backend behind the same read/write API, so JSONL stays the default.

---

## Sequencing & caveats

- **Separate workstream** from the in-flight README / CI / LICENSE changes
  currently uncommitted in the tree.
- `src/ui/App.tsx` is mid-refactor (permission-prompt model). Phase 1 touches
  permission code — land after App.tsx settles to avoid collisions.
- Your explicit ask was **session-log saving + permission saving** → **Phases 1
  and 2 are the core.** Phases 3–5 are optional follow-ons.
- Each phase, once built, updates its owning spec
  ([session-spec.md](./session-spec.md) / [permission-spec.md](./permission-spec.md))
  per the repo's one-spec-per-subsystem convention.

---

## PR #263 additions

#263 is titled "structured telemetry metrics, strict MCP config mode, and
PermissionDecision types," but the diff carries **more than the title admits**.
Ignoring the shared noise (blob + Python skills + the duplicate `session-log.ts`),
here's everything genuinely new, sorted by whether it's worth taking.

### ⚠ First, a health warning on the PR itself

`packages/core/src/common/permissions.ts` in this PR contains a **literal
unresolved Git merge-conflict marker** (`>>>>>>> ea93ba2 (…)`) left in the
source. So #263 is not a clean, mergeable branch — treat it as a **grab-bag of
ideas to reimplement**, never as something to cherry-pick wholesale.

### New modules and how they map to Heirloom

| Module (in #263) | What it is | Verdict for Heirloom |
|---|---|---|
| **`permission-profile.ts`** (+335) | A structured, ACL-style permission model (Codex "PermissionProfile"): `unrestricted \| legacy \| managed`, path-level `read/write/deny` entries with glob matching, plus network + git sub-permissions and preset profiles (`STRICT_SANDBOX`, `DEFAULT_DEV`). Self-contained glob engine, no deps. | **Strongest idea in the PR.** But it's a *parallel* permission system to Heirloom's existing rule engine (`src/permissions/engine.ts`), not a drop-in. Adopting it is a **permission-model redesign**, not an add-on — big decision, own workstream. See below. |
| **`telemetry.ts` metrics** (+87) | In-memory per-session counters: permission accept/reject counts, and `ToolUsageMetrics` (cost USD, API duration, lines added/removed, tool calls). Get/reset API. | **Cheap and useful.** Pure in-memory, no deps, no storage. Pairs naturally with Phase 2 (token log) — surface in an exit summary / status line. Heirloom already has `src/ui/exit-summary.ts` to extend. |
| **`strictMcpConfig`** (mcp-manager +29, settings +32) | A `--strict-mcp-config`-style flag: when on, MCP servers may only launch from an allowlisted command (`npx`, `node`, `python3`, `uvx`, `bun`, `deno`, `go`, `java`); anything else is blocked with a descriptive error. | **Take it — small, real security win.** Heirloom has `src/mcp/` and treats MCP tools as untrusted (per security-spec). A command allowlist is a clean, low-risk hardening. ~30 lines + a settings key. |
| **`hooks.ts`** (+76) | A lifecycle-hook dispatcher: user-configured shell commands fired on events (`beforeWrite`, `afterWrite`, `beforeCommand`, `onError`, `onSessionStart`, `onCompact`, …) with `{placeholder}` substitution. | **Attractive but security-sensitive.** This runs arbitrary shell on agent events — powerful (formatters, notifiers) but it's another untrusted-execution surface. Only behind explicit opt-in config, and document it in security-spec. Defer past the core phases. |
| **`compact.ts`** (+245) | A runtime content-compressor: smart JSON tool-result truncation (shrinks only the `output` field), binary detection, plain-text capping, plus lossy message-history summarization. | **Partial overlap** with Heirloom's `src/compaction/` + tool-result truncation in `src/tools/`. Mine it for the *smart-JSON-truncation* idea specifically; don't wholesale-import a second compaction path. |
| **`skill-parser.ts`** (+313) | Extended `SKILL.md` frontmatter parser: `agent.dependencies`, `agent.interface` (default prompt, brand color, screenshots), `agent.policy` (required permissions, allowed/denied paths → a PermissionProfile). Uses `gray-matter`. | **Only relevant if** the PermissionProfile model is adopted (its payoff is `skillPolicyToProfile`). Heirloom already parses Agent Skills (`src/skills/`); this is a superset tied to the profile system. Defer with it. |
| **`job-queue.ts`** (+361) | A generic child-process job queue: 3-phase spawn protocol, exponential-backoff retry, timeout, concurrency cap, event callbacks. | **Out of scope for the session-log goal.** Solves background/parallel task execution, unrelated to logging or permission saving. Note it exists; don't pull it in for this workstream. |
| **`AGENTIC_BEHAVIOR_PROMPT` / `TOOL_CHAINING_PROMPT`** (prompt.ts) | System-prompt text: the plan→execute→verify→auto-fix discipline, and a tool-chaining efficiency pattern. | **Compare, don't copy.** Heirloom has its own `src/prompt.ts` + `docs/system-prompt.md` with a change protocol. If any of this is wanted, it goes through that protocol, not a paste. |

### What this changes about the plan

- **Take now, cheap & on-goal:** `strictMcpConfig` (allowlist) and the
  **telemetry counters** (accept/reject + tool-usage). Both are small, dep-free,
  and reinforce Phases 1–2. Fold them in as **Phase 2.5**.
- **Big separate decision — PermissionProfile.** `permission-profile.ts` is the
  most valuable idea here, but it's an *alternative* permission architecture
  (path-level ACL + sandbox profiles) sitting beside Heirloom's rule-engine +
  approval-posture model. Choosing it means reconciling two models (or
  migrating). That deserves its **own design doc and its own decision**, not a
  bolt-on. Flagged, not scheduled.
- **Defer, security-sensitive:** `hooks.ts` (arbitrary shell on events) — only
  behind explicit opt-in, documented in security-spec.
- **Mine, don't import:** `compact.ts` (smart-JSON truncation idea only).
- **Out of scope here:** `job-queue.ts`, `skill-parser.ts` (unless
  PermissionProfile is adopted), prompt-text changes.

### Revised phase ordering (incorporating #263)

1. Permission audit trail *(#266)*
2. Token-usage log *(#266)*
2. **2.5 — `strictMcpConfig` allowlist + in-memory telemetry counters** *(#263, cheap wins)*
3. Hierarchical project rules *(#266)*
4. Auto error-fix + `<error_analysis>` *(#266)*
5. *(separate doc)* PermissionProfile ACL model — decide vs. current rule engine *(#263)*
6. *(deferred)* Lifecycle hooks *(#263)*; SQLite backend *(#266, optional)*

---

## PR #225 — login command

Unrelated to session logging. A small (515-line), **clean** PR — no vendored
blob, no merge markers — adding a `deepcode login` command that saves an API key
(and a ready-to-use default config) to `~/.deepcode/settings.json`.

### This is mostly overlap, not gap

Heirloom **already has** an auth flow: `auth` (interactive wizard), `auth list`,
`auth logout <provider>` in `src/auth/wizard.ts`, saving keys to
`~/.heirloom/credentials.yaml` (chmod 600). So #225 is not a missing feature —
but it does three things better than Heirloom's current wizard:

| #225 idea | Heirloom today | Take it? |
|---|---|---|
| **Non-interactive `--api-key` flag + piped-stdin fallback** | `authWizard` is interactive-only (`rl.question`); can't script or pipe a key. | **Yes** — real win for CI / headless / scripting. Small. |
| **Hidden, masked key input** (raw-mode `*`, Backspace / Ctrl+U / Ctrl+C aware, non-TTY fallback) | Key is typed in **plaintext** via `rl.question` — visible on screen and in scrollback. | **Yes** — genuine secret-handling improvement. `readHiddenLine` is a clean, dep-free reference. |
| **Seed a ready-to-use default config on login** (`buildLoginSettings` merges defaults, preserves existing fields) | `auth` writes only the credential; a brand-new user still has an empty `settings.json`. | **Partial** — take the *seed-defaults* idea, **not** the mechanism (see conflict below). |

### ⚠ Ethos conflict — do NOT copy the storage mechanism

#225 writes the API key **into `settings.json`** as `env.API_KEY`. Heirloom
deliberately does the opposite — the README states **"Keys never go in config —
env vars or the `auth`-managed credentials file"**, and keys live in
`credentials.yaml` (chmod 600), separate from config. Copying `buildLoginSettings`
verbatim would put a secret into a non-secret, potentially-committed file.

**So:** adopt the *ergonomics* (`--api-key`, piped stdin, masked input, "you're
ready to go" confirmation), keep Heirloom's *separation* (key → `credentials.yaml`;
optionally seed a minimal `settings.json` with **model/baseURL only, never the
key**).

### Not copy-pasteable

`login.ts` imports `writeStdout`/`writeStderrLine` from a pre-existing
`../utils/stdio-helpers` and uses their core `readSettings`/`writeSettings`/
`getUserSettingsPath`. It's a **pattern to reimplement** against Heirloom's
`src/config/credentials.ts` + `src/config/loader.ts`, not a file to lift.

### Proposed (small, self-contained — not part of the phase sequence above)

- **Enhance `src/auth/wizard.ts`:** add masked input (port `readHiddenLine`), a
  non-interactive `--api-key` / piped-stdin path, and a post-save "run
  `heirloom` to start" confirmation.
- **Optionally** seed a minimal project/global `settings.json` (model + baseURL
  for the chosen provider) on first login — **key stays in `credentials.yaml`.**
- **Verify:** `heirloom auth --api-key sk-… ` (no TTY) writes the credential;
  interactive entry is masked; existing config fields are preserved; the key
  never lands in `settings.json`.

---

## PR #216 — /usage command

Unrelated to logging/auth. Small (122-line), **clean** PR: a `/usage` slash
command that queries `GET api.deepseek.com/user/balance` and renders the credit
balance / availability in a bordered Ink view (`Esc` to close), gated on
`baseURL.includes("api.deepseek.com")`.

### The UI pattern fits Heirloom perfectly; the data does not

- **Pattern — reusable as-is.** The bordered-view + `useInput(Esc→close)` +
  slash-command-registry approach is exactly how Heirloom already does `/mcp`
  (`src/ui/views/McpStatusList.tsx`, `showMcpStatus` routing in `App.tsx`,
  `slash-commands.ts`). Adding a `/usage` view is low-friction structurally.
- **Data — provider-specific.** The `GET /user/balance` endpoint and the
  `balance_infos` (`total/granted/topped_up`) shape are **proprietary to
  DeepSeek**. Heirloom is provider-agnostic (Anthropic, OpenAI, DeepSeek,
  OpenRouter, Groq, Ollama). Most of those have **no balance endpoint**, or a
  completely different one (e.g. OpenRouter has `GET /credits`; Anthropic/OpenAI
  expose usage via dashboards/other APIs; Ollama is local — no balance at all).

### Verdict

**Take it only if generalized, or scope it honestly.** Two options:

1. **Provider-agnostic `/usage`** — add an optional `getBalance()` to the
   provider adapter contract (`src/providers/`), implement it for the providers
   that have an endpoint (DeepSeek `/user/balance`, OpenRouter `/credits`, …),
   and have `/usage` show "not supported for <provider>" otherwise. This is the
   on-ethos version but a bigger job (touches the adapter contract).
2. **DeepSeek-only `/usage`** — port it nearly verbatim, gated on the DeepSeek
   base URL, and clearly a single-provider convenience. Cheap, but adds a
   provider-specific special-case to a codebase that otherwise keeps providers
   behind a uniform adapter.

**Recommendation:** if wanted, do **option 1** (adapter method) — it's the small
extra cost that keeps Heirloom's provider-agnostic promise intact. Low priority
relative to the logging/permission work; it's a convenience, not a capability
gap.

---

## PR #132 — theme system

Large (3968-line) PR adding a full theme system: `ThemeTokens` (13 semantic
tokens), a `resolveTheme` resolver (preset / overrides / tokens), 8 presets
(light, dark, github-light/dark, monokai, dracula, ansi-light/dark), a `/theme`
dropdown with live preview, a `ThemeableStatic` component, a system light/dark
detector (with 318 lines of tests), and a React-rendered exit summary.

### Key finding: Heirloom's theme *model* is already ahead — the *machinery* is what's missing

Heirloom already has a wired-up theme system in `src/ui/theme.ts`:
- **A richer token model than the PR** — ~20 semantic slots **plus** a full
  `SyntaxColors` set (19 syntax colors) **plus** a `statusBar` sub-palette,
  versus the PR's 13 flat tokens.
- `resolveTheme(config)` with `mode: dark | light | auto` + shallow overrides —
  already used in `cli.tsx`.
- A `ThemeContextValue` class + `useTheme` context consumed across ~10 UI
  components (`StatusBar`, `MarkdownText`, `OutputArea`, `SyntaxHighlighter`, …).
- A `theme` config key already parsed by the loader (`theme.mode` / `name` /
  `overrides`).

So **do NOT adopt the PR's `ThemeTokens` model or `resolver.ts`** — that would be
a *downgrade* and a large, invasive rewrite of already-working code. The value is
in four things Heirloom is **missing**:

| #132 piece | Heirloom today | Take it? |
|---|---|---|
| **`/theme` command — live preview + `Esc` reverts** | **No `/theme` command at all** (slash set is clear/continue/exit/help/mcp/model/new/plan/raw/resume/skills/undo). Theme is only set via config file. | **Yes — the headline win.** A `/theme` picker (mirroring the existing `/model` dropdown + `/mcp` view patterns) that previews live and persists to settings on confirm. |
| **More presets** (github-light/dark, monokai, dracula, ansi ×2) | Only `dark`, `light`, `high-contrast`. | **Yes, cheap** — but *re-express them in Heirloom's richer `ThemeDefinition` shape*, don't import the PR's thinner token objects. Pure data. |
| **Real system light/dark detection** (`detect-system-theme.ts`, 204 lines + 318 test lines: parses macOS `AppleInterfaceStyle`, terminal `COLORFGBG`, env hints) | `detectSystemTheme()` in `theme.ts` is a **weak stub** — the `matchMedia` branch never fires in a terminal, and it just checks whether `~/.config/dconf/user` exists, else returns `"dark"`. `mode: "auto"` is effectively "always dark." | **Yes — real bug fix.** Port the detector (especially `COLORFGBG` + macOS `defaults read`) so `auto` actually works. Comes with a ready test suite to adapt. |
| **`ThemeableStatic`** — re-mount Ink `<Static>` on theme change so scrollback recolors | Uses raw Ink `<Static>` in `OutputArea.tsx`; a live theme switch would leave already-printed lines in the old palette. | **Only needed if** live-preview `/theme` is added — it's what makes preview actually repaint history. Take it together with the `/theme` command. |
| **React-rendered exit summary** (`ExitSummaryView` replacing `process.stdout.write`) | `src/ui/exit-summary.ts` writes directly to stdout. | **Optional / independent.** A nice robustness fix (survives terminal scroll) but orthogonal to theming — evaluate separately. |

### Verdict

**The one to actually build here is the `/theme` command** — Heirloom has all
the theming infrastructure and zero user-facing way to switch at runtime. Bundle
it with: (a) the extra presets re-expressed in `ThemeDefinition` shape, (b) the
real system-theme detector (fixes the broken `auto` mode), and (c)
`ThemeableStatic` so live preview repaints scrollback.

Explicitly **reject** the PR's token model / `resolver.ts` — Heirloom's is
strictly richer and already integrated. This is the clearest "borrow the
*feature*, keep our *architecture*" case of all the PRs reviewed.

### Rough phasing (independent of the logging phases)

1. Extra presets in `BUILTIN_THEMES` (data only) → *verify:* each resolves and
   renders.
2. Replace the `detectSystemTheme` stub with a real detector + tests → *verify:*
   `mode:"auto"` picks light on a light terminal (`COLORFGBG`/macOS).
3. `/theme` dropdown (reuse `/model` + `/mcp` patterns) with live preview + Esc
   revert + persist-on-confirm; add `ThemeableStatic` → *verify:* preview
   recolors history, Esc restores prior theme, confirm writes `theme` to
   settings.
