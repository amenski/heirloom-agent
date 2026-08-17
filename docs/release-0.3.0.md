# 0.3.0 — release scope

**Status:** cut 2026-08-17 · `v0.3.0`
**Baseline:** `v0.2.1` → `HEAD` = **64 commits**, 192 files, ~23.8k insertions / 3.4k deletions

The headline: 0.2.1 was a capable agent; 0.3.0 is the release where **project-supplied
content became untrusted by default**. Everything a cloned repo can declare — hooks,
skills, settings, agents — now passes a trust gate before it can execute or reach the
model. Alongside that, sub-agents became async, the sandbox became real, and the tool
surface grew planning and meta tools.

---

## 1. Security — trust boundary for untrusted repos

The through-line of this release. Before 0.3.0, cloning a repo and running heirloom in
it could execute attacker-chosen code before you typed anything.

**Trust-on-first-use gates.** Four stores under `~/.heirloom/` (`HEIRLOOM_HOME`
honored), all realpath-keyed, mode 0600, atomic writes, full sha256, hashes only —
never file contents:

| Store | Gates |
|---|---|
| `hooks-trust.json` | project-declared hooks (checked lazily at fire time) |
| `skill-trust.json` | project `SKILL.md` files |
| `settings-trust.json` | execution-capable keys in project `.heirloom/settings.json` |
| `folder-trust.json` | bulk-approves everything present in a tree (fast path) |

**Execution-capable settings keys**, gated: `statusline`, `mcpServers`, `notify`, `env`,
`strictMcpConfig`, `permissions`, `permissionProfile`, `sandbox`, `webSearch`. An
untrusted project's values are stripped before any consumer reads them — interactive
asks, headless strips and warns on stderr.

**Sandbox.** macOS Seatbelt enforcement (`sandbox.enabled`) with cwd containment,
workspace-write carve-outs for temp and the npm cache, and profile-level fs/network
mechanics.

**Notable fixes shipped here**, worth naming in release notes because they were live
holes rather than hardening:
- Arbitrary code execution via ungated project `settings.json` (`statusline.command`
  reached `$SHELL -c`) — `8f3a343`
- Prototype-pollution bypass of that same gate via a top-level `__proto__` key —
  `30fdd67`
- Privilege escalation: a project could set `permissionProfile: unrestricted` +
  `sandbox: false` + `allowAll` — `1bc871c`
- Search-traffic redirect via project `webSearch.searxngUrl` — `7e5232f`
- SearXNG secret handling (`b53dd15`, `39e2419`, `5933903`)
- Truncated legacy trust hashes causing false "changed" tamper prompts — `8f193c7`

---

## 2. Orchestration & sub-agents

- Async sub-agent execution — background tasks outlive the spawning turn
  (`docs/async-subagents.md`)
- Live provider/model in sub-agents, per-turn ask bridge, interrupt propagation
- Sub-agent todo lists isolated from the parent
- Agent definitions in `.heirloom/agents/*.md` with model overrides
- Inline Claude-Code-style execution display in the transcript

## 3. Tools & permissions

- `update_todo_list` planning tool with live checklist panel; snapshots persist and
  restore on resume
- `switch_mode` / `attempt_completion` meta tools, never permission-prompted
- PermissionProfile workstream: schema, validation, evaluation layer, always-denied
  `.git/`, network specificity
- MCP: stdio tools actually reach the model and permission engine; JSON-RPC errors no
  longer crash; tool-definition pins

## 4. Search & context

- SearXNG backend with inline content enrichment
- Context window derived from the model; request overhead counted in the meter
- `CLAUDE.md` (user + repo) read into the instructions chain

## 5. UI

- `@file` mentions, `/mode` in the slash picker, Ctrl+O mode picker
- Status bar legibility; mode and posture as independent segments
- Untrusted-content markers hidden from transcript previews
- Cost estimate behind `showCost` (default hidden)

---

## Remaining before cutting

1. **Push the 10 unpushed commits** on local `main`.
2. **`CHANGELOG.md`** — does not exist. 0.3.0 is the right point to start one.
3. **Version bump** `0.2.1` → `0.3.0` in `package.json`, then tag `v0.3.0`.
4. **Item 16 housekeeping** (`dev-todo.md`) — delete the merged searxng branch.
5. **Decide the security claim.** See below.

## Behavior changes users will notice

Not breaking API changes, but defaults moved:

- `strictMcpConfig` now defaults **true** — MCP server commands are allowlisted by
  basename unless explicitly disabled. Users with an unusual MCP command will need
  `strictMcpConfig: false`.
- A project `.heirloom/settings.json` that sets an execution-capable key now **prompts**
  on first use instead of applying silently.
- Cost estimate is **hidden** unless `showCost` is set.

## Open question — how strongly to claim security

This release genuinely hardened the **config** surface, and the trust model is real.
But two caveats belong in the notes rather than being quietly omitted:

- The settings gate shipped in `8f3a343` was **bypassable on its first attempt**
  (`30fdd67` fixed it). One pass over a security boundary was demonstrably not enough.
- The **MCP response path** and **tool-level input handling** have not been audited.
  A malicious MCP server's responses reach the model without passing the gates this
  release added.

Recommendation: describe 0.3.0 as "project-supplied config is no longer trusted by
default" — precise and true — rather than "safe to run in untrusted repos", which is
not yet earned.
