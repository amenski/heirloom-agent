# Changelog

All notable changes to Heirloom are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] — unreleased

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

- The **MCP response path** and **tool-level input handling** have not been audited. A
  malicious MCP server's responses reach the model without passing the gates added in
  this release.
- The settings gate shipped in this cycle was bypassable on its first attempt and
  needed a follow-up fix. Treat "project config is no longer trusted by default" as
  the accurate claim — not "safe to run in untrusted repos".

## [0.2.1] — 2026-08-10

Earlier releases predate this changelog. See the git history for
`v0.1.0..v0.2.1`.

[Unreleased]: https://github.com/amenski/heirloom-agent/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/amenski/heirloom-agent/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/amenski/heirloom-agent/releases/tag/v0.2.1
