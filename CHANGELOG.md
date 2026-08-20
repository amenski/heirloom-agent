# Changelog

All notable changes to Heirloom are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.2] — 2026-08-20

The release that makes an interrupted coding session resumable without losing
its context. It also extends `workspace-write` to explicitly trusted sibling
repositories, so a project can safely work across a deliberate multi-root set.

2 commits since 0.3.1.

### Added

- **`--add-dir <path>`** — repeatable startup flag for explicitly trusted
  writable directories. These roots merge with global `sandbox.writeRoots` and
  apply consistently to the permission engine, macOS Seatbelt, foreground
  Bash, background jobs, and headless runs. Sandboxed commands may use an
  added root as their cwd; direct file tools still cannot access `.git`.
- The prompt's Git environment context now names dirty paths and distinguishes
  files already dirty at startup from files changed during the current session.

### Fixed

- **Interrupted turns now persist their completed transcript.** After Esc,
  `/continue` retains the user's request plus completed tool calls and results,
  rather than inferring work only from a dirty tree. Partial stream text is
  never persisted.
- External file-write approvals now create exact-path rules for session and
  always approvals; another external path still asks. Search and glob guards
  remain absolute.

## [0.3.1] — 2026-08-18

The release that **simplifies modes and unifies the write boundary**. New
sessions no longer land in Code: they start in a read-only *General* chat mode
on a cheap model, with implementation work one explicit `/mode code` away. The
specialist modes (architect/ask/debug/orchestrator) are hidden from the picker
but stay reachable by slug, and Code absorbs the `workflow` group so delegation
is an automatic capability. Under `workspace-write`, the write boundary is now
a single shared set — Seatbelt, the permission engine, and the file tools all
resolve the same realpath'd write roots, and an out-of-workspace file write
becomes a guarded ask instead of a hard deny.

1 commit since 0.3.0.

### Added

- **`general` mode, the new default.** A session with no explicit `--mode` or
  `/mode` starts in read-only chat on `deepseek/deepseek-v4-flash` with
  `reasoningEffort: low`. A resumed session's last mode wins over the default;
  an explicit `--mode` wins over both. Headless (`-x`) runs resolve the same
  default instead of falling back to the every-tool registry.
- **`sandbox.writeRoots`** (global-only): extra directories writable under
  `workspace-write`, beyond the workspace root and the temp/npm carve-outs.
  Resolved once into a shared write-set (`resolveWriteRoots`) that the Seatbelt
  profile, permission engine, and profile evaluator all consult — a path one
  layer allows for a write, the others do too. The key is read from the user's
  global `settings.json` only: a project value is ignored with a warning
  (regardless of trust state), and a global grant survives the untrusted-
  project strip.
- **Mode `model`, `reasoningEffort`, and `hidden` fields.** A mode can declare
  its own model/effort defaults, applied when the user hasn't chosen
  explicitly, and hide itself from the picker and `/modes` listing while
  remaining loadable by slug.
- **`provider/model` references in `--model` and `settings.model`** (e.g.
  `--model anthropic/claude-…`); a bare name stays relative to the
  configured/detected provider.
- **`reasoningEffort: "low"`** is now accepted alongside `"high"`/`"max"`.
- **Timing diagnostics** in the debug log: a `prompt_assembly` row per turn and
  a `request` row per provider call (total, time-to-first-event,
  time-to-first-text, cache reads).

### Changed

- The default mode is now **`general`** (read-only chat) instead of `code`;
  implementation work starts with `/mode code` or `--mode code`.
- **Code mode gains the `workflow` group** — direct `new_task` delegation
  without switching to the orchestrator.
- **architect, ask, debug, and orchestrator are hidden** from the mode picker
  and `/modes` listing; they remain usable as compatibility aliases by slug.
- **Out-of-workspace file writes become a guarded ask** under
  `workspace-write` instead of a hard deny; in-set writes resolve silently. The
  boundary follows the profile level, not `sandbox.enabled`.
- Session meta now records whether the model and effort were explicit
  (`modelExplicit`, `effortExplicit`), so a resumed session restores the origin
  of a choice instead of collapsing it into a mode default.
- `/mode` help text and completion list the current mode set (`general`,
  `code`).

### Fixed

- Headless runs now apply the active mode's tool gating (default `general`,
  read-only) instead of every tool registered; an unknown `--mode` still exits
  1 with the "unknown mode" message.

## [0.3.0] — 2026-08-17

The release where **project-supplied content became untrusted by default**. Before
this, cloning a repo and running heirloom inside it could execute attacker-chosen
code before you typed anything. Everything a repo can declare — hooks, skills,
settings, agent definitions — now passes a trust gate first.

64 commits since 0.2.1.

### Security

- **Fixed arbitrary code execution via project `settings.json`.** A cloned repo's
  `.heirloom/settings.json` was deep-merged with no trust check, and several keys
  execute at startup: `statusline.providers[].command` reached
  `execFile($SHELL, ["-c", …])`, `mcpServers[].command` was spawned, `notify` was
  spawned. Execution-capable keys are now gated behind trust-on-first-use.
- **Fixed a prototype-pollution bypass of that gate.** Detection read raw key names,
  so a payload nested under a top-level `"__proto__"` key was invisible to the gate
  while still resolving through the merged object — no prompt, no strip, full
  execution. Parsed JSON is now sanitized recursively, and detection derives from
  resolved values rather than key names.
- **Fixed privilege escalation via project permission config.** A repo could set
  `permissionProfile: { level: "unrestricted" }`, `sandbox: { enabled: false }`, and
  `permissions.defaultMode: "allowAll"`. These are now gated; when stripped they fall
  back to the *strictest* state, not the absent-default (which was the least
  restrictive, and exactly what an attacker would ask for).
- **Fixed search-traffic redirect.** `webSearch.searxngUrl` let a project control the
  host every `web_search` query was sent to. Gated; the tool now reads the effective
  post-strip config instead of re-reading the raw file per call.
- **Fixed truncated trust hashes.** Stored hashes were 16 chars while comparison used
  the full 64-char digest, so every previously-trusted skill reported as `changed` —
  a false tamper signal. Legacy hashes migrate in place on first check.
- Added macOS Seatbelt sandbox enforcement with cwd containment and workspace-write
  carve-outs for temp dirs and the npm cache.
- Added skill and MCP tool-definition trust prompts; SearXNG secret handling fixes;
  registry-host pre-commit hook and CI guard.
- **Fixed command injection in the `search` tool.** `search` built a shell string by
  interpolating the model-supplied pattern into `grep -rn "<pattern>" "<dir>"`, so a
  pattern containing `$(...)` executed. It sits in the `read` tool group — the
  low-friction tier users are most likely to auto-allow — and the model is steerable by
  repo content, web results, and MCP output, so reaching it did not require a hostile
  user. Now uses an argv array with no shell.
- **Fixed unsanitized tool and MCP output reaching the terminal.** MCP server responses,
  `search` results, `read_file` contents, and web-search titles/snippets were returned
  without stripping control characters, so a hostile file or server could emit OSC 52
  (clipboard write) or cursor-repositioning sequences — the latter matters most
  immediately before a permission prompt.
- **Fixed unconstrained directory arguments in `search` and `glob`.** Both took a
  directory from the model with no validation and carried an unconditional builtin
  allow, so a search of `~/.ssh` returned matching lines from private keys with no
  prompt — while `read_file` on the same file has always asked. The underlying cause
  was that neither argument was ever extracted into the permission subject, so no path
  rule could match them even in principle. Both now participate in rule matching, carry
  the same secret-path guards `read_file` has, and prompt when the directory resolves
  (via realpath, so symlinks cannot escape) outside the workspace.
- Fixed a test-isolation leak that wrote ~1786 junk entries into the real trust store.

### Added

- **Folder-level trust** — one prompt bulk-approves everything present in a tree.
  Deliberately a fast path, not a blanket grant: content changes and newly-added
  artifacts still re-prompt, preserving tamper detection.
- **Async sub-agents** — background tasks outlive the spawning turn, with live
  provider/model, a per-turn ask bridge, and interrupt propagation.
- **Agent definitions** in `.heirloom/agents/*.md`, with model overrides.
- **`update_todo_list`** planning tool with a live checklist panel; snapshots persist
  and restore on session resume.
- **`switch_mode` and `attempt_completion`** meta tools, never permission-prompted.
- **SearXNG search backend** with inline content enrichment.
- **PermissionProfile** — schema, validation, evaluation layer, always-denied `.git/`,
  network specificity.
- `@file` mentions in the prompt; `/mode` in the slash picker; Ctrl+O mode picker.
- `CLAUDE.md` (user + repo) read into the instructions chain.
- Inline Claude-Code-style sub-agent execution display in the transcript.

### Changed

- **`strictMcpConfig` now defaults to `true`.** MCP server commands are allowlisted by
  basename unless explicitly disabled. An unusual MCP command now needs
  `strictMcpConfig: false`.
- **A project `.heirloom/settings.json` setting an execution-capable key now prompts**
  on first use instead of applying silently.
- **The cost estimate is hidden** unless `showCost` is set.
- Context window is derived from the model, and request overhead is counted in the
  status-bar meter and `/context`.
- All config stores route through `HEIRLOOM_HOME`.
- Sub-agent todo lists are isolated from the parent's.

### Fixed

- MCP stdio tools now actually reach the model and the permission engine; JSON-RPC
  errors from stdio servers no longer crash the session.
- Transient network errors are handled instead of crashing.
- The skill-load banner no longer garbles stdin at startup.
- `switch_mode` and `attempt_completion` no longer trigger permission prompts.
- Status bar and hint bar legibility; mode and posture render as independent segments.
- `web_search` surfaces feed-format breaks instead of reporting "no results".

### Known limitations

- Two controls in this release needed follow-up fixes before they held: the settings
  gate was bypassable on its first attempt, and `search` shipped with a shell-string
  sink no one had classified as dangerous. Both are fixed here, but treat "project
  config is no longer trusted by default" as the accurate claim — not "safe to run in
  untrusted repos".

The MCP response path and tool-level input handling were audited before this tag; the
issues found are listed above. A sweep of all twelve subprocess spawn sites found no
further injection sinks.

## [0.2.1] — 2026-08-10

Earlier releases predate this changelog. See the git history for
`v0.1.0..v0.2.1`.

[Unreleased]: https://github.com/amenski/heirloom-agent/compare/v0.3.2...HEAD
[0.3.2]: https://github.com/amenski/heirloom-agent/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/amenski/heirloom-agent/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/amenski/heirloom-agent/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/amenski/heirloom-agent/releases/tag/v0.2.1
