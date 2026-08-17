# Security hardening — project-supplied config

Work items for closing the remaining ungated project-config channels.
One task per section. Mark `[x]` when done **and verified**.

Context: a cloned repo's `.heirloom/` is attacker-controlled. Heirloom already
gates project **hooks** (`src/hooks/trust.ts`), **skills** (`src/skills/trust.ts`),
and — as of `8f3a343` + `30fdd67` — **execution-capable settings**
(`src/config/settings-trust.ts`, gating `statusline` / `mcpServers` / `notify` /
`env` / `strictMcpConfig`).

Prior art to follow, in order of relevance:
- `src/config/settings-trust.ts` — the TOFU store these tasks extend
- `src/config/loader.ts` — `EXECUTION_CAPABLE_KEYS`, `resolveProjectExecutionKeys`,
  `loadJsonFile` sanitization, `deepMerge` hardening
- `src/cli.tsx` (interactive enforcement) / `src/exec-runner.ts` (headless)

---

## Task 1 — gate `permissions` / `permissionProfile` / `sandbox`

**Status:** `[x]` — done and verified
**Severity:** High — privilege escalation

A project `.heirloom/settings.json` can currently set permission rules, the
permission profile, and sandbox config with **no consent**. Worse, two consumers
read the *unstripped* config even for keys that are gated today:

- `src/cli.tsx:253` — `configResult.config.permissions`
- `src/exec-runner.ts:175` — `configResult.config.permissions`
- `src/exec-runner.ts:110-113` — `sandbox.enabled` + `permissionProfile.level`
- `src/exec-runner.ts:183-184` — `new ProfileEvaluator(configResult.config.permissionProfile, ...)`

A hostile repo can therefore grant itself allow-rules, drop the sandbox, or set
an `unrestricted` profile — defeating the controls that make every *other* gate
meaningful.

**Decision (user, this session): gate them UNCONDITIONALLY.** Any project-supplied
value for these three keys requires consent. Do **not** build "only prompt when
widening" logic — it was considered and explicitly rejected.

Do:
- Add `permissions`, `permissionProfile`, `sandbox` to `EXECUTION_CAPABLE_KEYS`.
- Extend `resolveProjectExecutionKeys` so detection stays **authoritative**
  (derived from resolved values, never raw key names — see `30fdd67` for why).
- Extend `stripExecutionKeys`. Critical: stripping must fall back to the
  **secure** direction. Verify what an absent `permissions` / `permissionProfile` /
  `sandbox` actually resolves to at each consumer — if absent means "no
  restrictions", stripping would *worsen* security. Establish this before writing
  the strip, and state the finding in the task report.
- Fix the consumers above to read the **effective** (post-strip) config. Audit
  every other `configResult.config.*` read in both entry points for the same bug.
- Update the exact-set assertion in `src/config/settings-trust.test.ts`.

**Verify:** hostile project sets `permissionProfile.level: "unrestricted"` +
`sandbox.enabled: false` + a broad allow rule → untrusted run must not apply any
of them; trusted run applies them. Prove via the resolved config *and* through a
consumer (e.g. that `ProfileEvaluator` never sees the hostile profile).

**Resolution notes:**
- `EXECUTION_CAPABLE_KEYS` (loader.ts), `resolveProjectExecutionKeys`, and
  `stripExecutionKeys` (settings-trust.ts) done as described in the doc
  comments there. Strip-fallback direction: `permissions` → plain `delete`
  (absent resolves to `defaultMode: "askAll"`, the strictest state);
  `permissionProfile`/`sandbox` → forced to `{ level: "strict-sandbox" }` /
  `{ enabled: true }` respectively, NOT deleted, because absent resolves to
  the *least* restrictive state for both (`"unrestricted"` / Seatbelt off) —
  a plain delete would have handed the untrusted run exactly the state the
  attacker asked for.
- `src/exec-runner.ts` consumers fixed to read `effectiveConfig` (the
  post-strip binding already used elsewhere in that file).
- `src/cli.tsx` audit finding: **no code change was needed at lines
  253/260-261/411-414.** Unlike exec-runner.ts, cli.tsx's TOFU gate
  (`main()`, ~L174-193) does not use a separate `effectiveConfig` binding —
  on decline it reassigns the `configResult` variable itself
  (`configResult = { ...configResult, config: stripExecutionKeys(...) }`).
  Every read this task named is textually *after* that reassignment in the
  same linear `main()` execution, so once `permissions`/`permissionProfile`/
  `sandbox` were added to `EXECUTION_CAPABLE_KEYS`, those four reads started
  seeing the stripped config automatically, as a side effect — confirmed by
  running the exact gate logic against a hostile settings.json in both
  directions (see report). Full audit of every other
  `configResult.config.*` read in both entry points found no other instance
  of this bug — all remaining raw reads are of keys never in
  `EXECUTION_CAPABLE_KEYS` (`provider`, `model`, `hooks`, `disableAllHooks`,
  `commands`, `contextWindow`, `compaction`, `theme`, `keybindings`,
  `workflow`, `refresh`, `enabledSkills`, `showCost`), which is correct —
  only the eight gated keys need the post-strip config.
- Fixed 5 pre-existing tests broken by the new gating (fixtures wrote
  `permissions`/`permissionProfile` into a project settings.json without
  calling `trustSettings()` first, which the new gate now correctly strips):
  `src/config/settings-trust.test.ts` (one fixture used `permissions` as an
  example *non*-execution key — updated), `src/exec-runner.test.ts` tests
  (a) and (f), and both tests in `src/exec-runner.subagent.test.ts` (shared
  `beforeEach` fixture) — each given an explicit `trustSettings()` call,
  matching the pattern already used elsewhere in the same files.
- `npx vitest run`: 119 files / 1660 passed / 1 skipped (was 1651+1 baseline
  — 9 new tests added, all green). `npx tsc --noEmit`: clean.
- `~/.heirloom/skill-trust.json`: still exactly 25 entries — confirmed after
  all exploit/test runs.

---

## Task 2 — audit `.heirloom/agents/*.md`

**Status:** `[x]` — investigated, no gate recommended (see evidence below)
**Severity:** Unknown — investigate before deciding

`src/agents/index.ts:201` loads project agent definitions with no trust check.
Earlier analysis concluded this is prompt-injection risk (text to the model), not
code execution — but that was a **shallow** check and must not be treated as
cleared.

Do **not** implement a gate yet. Investigate and report:
- Full frontmatter schema of an agent definition. Can it carry tool grants,
  permission overrides, model/provider selection, or anything that resolves to a
  path, command, or network destination?
- Does anything in a loaded `AgentDef` reach a subprocess, a file write, or a
  fetch — directly or via the orchestrator?
- Do sub-agents inherit the parent's permission engine, or can a definition
  influence their own?

If it is genuinely text-only, say so plainly with evidence and recommend no gate.
If any field reaches an executable sink, stop and report — do not design the fix
in the same pass.

**Investigation findings:**

Frontmatter schema (`src/agents/index.ts` — `KNOWN_FIELDS`) is exactly 5
fields: `name`, `description`, `mode` (string, required), `model` (optional
"provider/model" string), `instructions` (optional string). No `tools`,
`permissions`, `path`, `command`, or `url` field exists or is read.

- **`mode`** is the interesting field: it's passed unvalidated to
  `ModeLoader.load(modeSlug)` (`orchestrator/index.ts:264`), which can load a
  **project-supplied** `.heirloom/modes/<slug>.yaml` defining a `groups`
  list (`orchestrator/index.ts:272`, `tools/registry.ts` `getByMode`) that
  controls which tools are exposed as callable to the sub-agent's LLM. In
  principle a hostile repo could define a custom mode combining all 5 tool
  groups (`read`, `edit`, `command`, `mcp`, `workflow` — the full set, a
  superset of any single built-in mode). **This does not bypass
  authorization**, though: every tool call — regardless of which mode/group
  exposed it — passes through `authorize()` (`agent.ts:466`/`515`), which
  consults the same `permissions`/`permissionProfile` objects the parent
  session constructed once at startup (now correctly TOFU-gated per Task 1).
  `orchestrator/index.ts`'s `createHandler` never constructs a new
  `PermissionEngine`/`ProfileEvaluator` for a sub-agent — confirmed no
  production code path does (`grep` for `new PermissionEngine`/
  `new ProfileEvaluator` outside test files returns nothing in
  `orchestrator/` or `agents/`) — so mode/groups only changes the *menu* the
  LLM sees, never what a call actually resolves to. Also: `.heirloom/agents/`
  and `.heirloom/modes/` are both already inside the attacker-controlled
  project tree in this threat model, so a hostile agent def referencing a
  hostile mode file isn't reaching anything it doesn't already own.
- **`model`** ("provider/model") is passed to `this.options.provider(modelId)`
  → `createProvider(name, options)` (`providers/presets.ts:103`), which
  throws `Unknown provider` for anything not already in
  `configProviders`(user's own settings.json) or `BUILTIN_PRESETS`  — an
  agent file cannot invent a new provider or host. `baseUrl`/`apiKey` are
  only forwarded from the parent's *own* startup-resolved values when the
  selected provider matches the parent's startup provider
  (`cli.tsx`/`exec-runner.ts`'s provider-factory closures); switching
  provider via `model` gets that provider's own independent key/host
  resolution, never a hostile override. No credential exfiltration or
  traffic redirection path found.
- **`instructions`** is spliced directly into the system prompt
  (`prompt.ts:88` — `sections.push(ctx.agentInstructions)`). Confirmed
  text-only — no parsing, no interpolation into a shell command, path, or
  URL anywhere downstream.
- **`name`**/**`description`** are used only as a `Map` key and as
  interpolated text in the `new_task` tool schema's description
  (`orchestrator/index.ts:179-180`) shown to the LLM — text-only.
- **`sourcePath`** (derived from the filesystem path, not attacker content)
  is stored on `AgentDef` but never read by any consumer — dead field today.

**Verdict: genuinely text-only for the purposes this task asks about** — no
field reaches a subprocess, file write, or network fetch, and sub-agents
strictly inherit the parent's single permission engine/profile instance with
no way for a definition to construct or influence its own. **No gate
recommended** for agent definitions themselves.

**Adjacent, lower-priority observation (not a Task 2 finding, flagged for
awareness only):** the `mode` field lets a hostile repo's agent definition
select a hostile repo's own custom mode file, which can request the union of
all 5 tool groups (something no single built-in mode does). Since every call
is still authorized against the gated permission engine, this does not
escalate privilege — but it does maximize the *menu* of tools the LLM is
invited to call, which is a wider prompt-injection/attack surface than a
built-in mode would offer for a task that didn't need it. Not recommending
action here since it doesn't reach an executable sink un-gated; noting it in
case a future review wants to cap custom-mode `groups` for agent-spawned
sub-runs specifically.

---

## Task 3 — decide `webSearch` gating (analysis only)

**Status:** `[x]` — recommendation delivered (see below), no code
**Severity:** Low — pre-existing

`webSearch.searxngUrl` lets a project control the **host** every `web_search`
query is sent to (`src/tools/web-search-searxng.ts:66`), exfiltrating queries and
controlling results fed back to the model. Pre-existing (landed in `b45a986` /
`e40837f`), opt-in, and orthogonal to the trust commits — a prior review put it
below the reporting bar.

`env.BASE_URL` is already gated for the *same* traffic-redirect reason, so there
is a consistency argument for adding `webSearch`.

Note `src/tools/web-search.ts:318` calls `loadConfig()` fresh per invocation. A
previous review confirmed this does **not** re-open the gated keys (it reads only
`webSearch.searxngUrl` and `webSearch.enrich`) — but that per-call pattern would
silently bypass the gate for any key added to it later. Flag this as a structural
hazard.

Deliverable: a short written recommendation, no code.

**Recommendation:**

Gate `webSearch.searxngUrl` the same way as `env.BASE_URL` — add it to
`EXECUTION_CAPABLE_KEYS`, strip it on an untrusted project settings file
(fallback: absent → the Bing path, which is the existing default and the
strictest available option, so a plain `delete` is correct here, same
direction as `permissions`/`strictMcpConfig`). Reasoning:

1. **Identical mechanism to an already-gated key.** `env.BASE_URL` is gated
   specifically because a project can redirect a class of outbound traffic
   (LLM provider calls) to a host it controls. `webSearch.searxngUrl` is the
   same primitive applied to a different traffic class (search queries) —
   same exfiltration shape (the query text leaves to an attacker-chosen
   host) and the same result-injection risk (the attacker's SearXNG instance
   controls what comes back and is fed to the model as "search results").
   There's no principled reason one is gated and the other isn't; leaving it
   ungated is an inconsistency in the trust model, not a considered
   exception.
2. **Low severity does not mean zero severity, and the fix is cheap.** This
   task's own severity label ("Low — pre-existing") is about urgency, not
   about whether the gate is justified. The mechanism now exists
   (`EXECUTION_CAPABLE_KEYS`/`stripExecutionKeys`/TOFU prompt) and Task 1
   just proved it generalizes cleanly to new keys — adding one more entry is
   a small, well-understood change, not a new subsystem.
3. **`webSearch.enrich` should NOT be gated.** It only toggles whether result
   pages are fetched for extra content — no host selection, no traffic
   redirection. Gating it would be scope creep with no security benefit.

**Structural hazard (flag only, not this task's fix):** `web-search.ts:318`'s
`resolveSearxngUrl()`/`resolveEnrich()` call `loadConfig()` fresh per
invocation and read directly off `.config.webSearch` — bypassing whatever
`effectiveConfig`/strip step the entry point (`cli.tsx`/`exec-runner.ts`)
already did once at startup. Today this is safe only because `webSearch` is
not in `EXECUTION_CAPABLE_KEYS` yet — there is nothing to bypass. The moment
`webSearch.searxngUrl` (or any future key) is added to the gated set, this
per-call `loadConfig()` pattern will silently re-read the raw, unstripped
value on every single search, regardless of the startup trust decision —
a full bypass of the gate for that one tool, undetectable by a
`configResult.config.*` audit like the one Task 1 did (there's no
`configResult` in this file to grep for). **Any future PR that adds
`webSearch` to `EXECUTION_CAPABLE_KEYS` must also change
`resolveSearxngUrl`/`resolveEnrich` to read from a passed-in effective
config (e.g. threaded through `ToolContext`, matching how other gated values
already reach tool handlers) instead of calling `loadConfig()` directly.**
This is a general pattern hazard worth a comment at the `loadConfig()` call
site now, even before `webSearch` is gated, so the next person adding a key
here doesn't reintroduce the same bypass.

---

## Ground rules for all tasks

- **Test isolation:** set *and* restore **both** `HEIRLOOM_HOME` and `HOME` in
  `beforeEach`/`afterEach`. `resolveHome()` prefers `HEIRLOOM_HOME`; a past bug
  leaked ~1786 junk entries into the user's real store because a test set only
  `HOME`. Do not repeat it.
- **Never touch the user's real `~/.heirloom/`.** Confirm at the end:
  `skill-trust.json` still has exactly **25** entries.
- **Baseline:** `npx vitest run` → 119 files / 1651 passed / 1 skipped.
  `npx tsc --noEmit` clean. Report new numbers.
- **Reproduce before believing.** `8f3a343` shipped a gate that was bypassable on
  the first attempt, and its own canary evidence did not hold up. Prove each fix
  with an actual exploit attempt in both directions (blocked untrusted / works
  trusted), not with tests alone.
- **`JSON.stringify({__proto__: ...}) does not reproduce prototype pollution** —
  object literals invoke the setter instead of creating an own property. Write
  literal JSON text in fixtures. See the helper comment in
  `src/config/settings-trust.test.ts`.
- **Do not commit. Do not push.** The user reviews before publishing.
- **Do not implement folder-level trust** — still an open design question.
