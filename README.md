# Heirloom

[![Build](https://github.com/amenski/heirloom-agent/actions/workflows/build.yml/badge.svg)](https://github.com/amenski/heirloom-agent/actions/workflows/build.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)

A personal AI coding agent for the terminal — provider-agnostic, mode-gated,
and permission-first. No framework, no magic: one TypeScript codebase you can
fully read, with every design decision written down in [`docs/`](./docs/)
alongside its rationale. The name is the point — something you build once,
understand completely, and keep.

It started as a fix for an agent that broke inside IntelliJ's embedded
terminal, and grew into a full agent by deliberately combining the proven
parts of opencode, RooCode, Aider, and SWE-agent — modes, checkpoints, repo
map, pattern permissions, layered error recovery — with no telemetry and no
privileged vendor. The research trail, papers included, is in
[`docs/architecture.md`](./docs/architecture.md).

> **Status: working, daily-driven, looking for testers.** I use it every day
> with **DeepSeek**, the best-tested path. Other provider presets are untested
> in the real world — [a "works" or "breaks" issue](https://github.com/amenski/heirloom-agent/issues)
> is genuinely useful.

---

## Highlights

- **Any model, chosen in config** — presets for DeepSeek (the daily driver),
  OpenAI, OpenRouter, Groq, and local Ollama; any other OpenAI-compatible
  provider is configuration, not code.
- **ReAct agent loop** with self-reflection, layered error recovery, and loop
  detection — streams responses, runs tools, and verifies its own edits.
- **Modes (personas)** — `code`, `ask` (read-only), `architect`, `debug`,
  `orchestrator`; each gates which tools the model can even see.
- **Permission-first** — `allow` / `ask` / `deny` pattern rules plus a session
  posture, with every decision recorded (`/permissions`). You at the prompt
  are the firewall.
- **Grounded, safe edits** — a ranked repo map injected into the system
  prompt; stale-file detection so the agent can't blind-overwrite a file it
  hasn't read; shadow-Git checkpoints with `/undo`.
- **Resumable sessions** — append-only JSONL with auto-compaction for
  arbitrarily long conversations; resume by ID, picker, or `--last`.
- **Extensible** — MCP servers via config, the cross-tool
  [Agent Skills](https://agentskills.io) format, and a headless mode (`-x`)
  with fail-closed permissions for scripting.

There's more (themes, statusline plugins, notify hook, built-in docs search,
`/cost`) — `/help` and the [docs](#documentation) cover it.

---

## Quickstart

Requires **Node 20+** and an API key for at least one provider.

```bash
git clone https://github.com/amenski/heirloom-agent.git
cd heirloom-agent
npm install
```

Connect a provider (stores a key in `~/.heirloom/credentials.yaml`, `chmod 600`):

```bash
npm start -- auth
```

…or just export an env var — e.g. `export DEEPSEEK_API_KEY=...`.

Then launch:

```bash
npm start                              # interactive TUI
npm start -- -p "explain src/agent.ts" # launch with a prompt
npm start -- -l                        # resume the last session here
npm start -- -x -p "summarize the diff"# headless one-shot, no TUI
```

Prefer a real binary? Build once and link it:

```bash
npm run build
npm link          # now `heirloom` is on your PATH
heirloom          # same thing, no `npm start --`
```

Check your setup any time with `heirloom doctor`.

---

## Everyday use

```
heirloom [code] > /mode ask       switch persona (read-only)
heirloom [ask]  > Shift+Tab        toggle askAll / allowAll posture
heirloom [ask ⚡] >
```

| Keys / commands | |
|---|---|
| `Enter` | send · `Shift+Enter` newline |
| `Esc` | interrupt the current turn — nothing partial is saved |
| `Shift+Tab` | toggle the approval posture |
| `/` | open the command menu |
| `/help` | full command list |
| `/model`, `/effort` | pick model · set reasoning effort |
| `/new`, `/resume`, `/continue` | session management |
| `/undo` | rewind code and/or conversation |
| `/theme` | switch color theme (live preview) |
| `/permissions` | this session's permission history |
| `/skills`, `/mcp` | list skills · inspect MCP servers |
| `Ctrl+D` twice | quit |

### CLI flags

| Flag | Meaning |
|---|---|
| `-p, --prompt <text>` | submit a prompt on launch |
| `-x, --exec` | run one prompt non-interactively (needs `--prompt`) |
| `-r, --resume [id]` | resume a session by ID, or open the picker |
| `-l, --last` | resume the most recent session for this directory |
| `--model <provider/model>` | override the configured model |
| `--mode <name>` | start in a given mode |
| `--debug` | write redacted request/response JSONL |

```bash
cat error.log | heirloom -x -p "Explain this error"
```

---

## Configuration

Settings live in JSON, merged global → project (project wins):

- `~/.heirloom/settings.json` — user-level
- `./.heirloom/settings.json` — per-project

```jsonc
{
  "model": "deepseek-v4-pro",
  "provider": "deepseek",
  "permissions": {
    "defaultMode": "askAll",
    "rules": [
      { "tool": "read_file",     "pattern": "./**", "action": "allow" },
      { "tool": "write_to_file", "pattern": "./**", "action": "allow" },
      { "tool": "run_bash",      "pattern": "*",    "action": "ask"   }
    ]
  },
  "mcpServers": {
    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] }
  }
}
```

- **Keep API keys out of config where you can.** The canonical store is the
  `auth`-managed credentials file (`~/.heirloom/credentials.yaml`, `chmod 600`),
  or a provider env var. A key set at `env.API_KEY` in `settings.json` does work,
  but is discouraged — settings.json is meant to be shareable/committable.
- **Use the `rules` permission shape** shown above. The old
  `allow`/`deny` scope-array form still loads, but triggers a migration warning
  on every launch until you rewrite it.
- **Per-repo instructions** for the agent: `.heirloom/instructions.md` (or
  `AGENTS.md`).
- **Custom personas**: drop a YAML into `~/.heirloom/modes/`.

See [`docs/config-spec.md`](./docs/config-spec.md) for the full schema.

---

## Security posture (please read)

Heirloom executes LLM-chosen commands on your machine. The design treats
everything reaching the model — repo files, command output, third-party
skills — as untrusted input, and **you at the permission prompt are the
firewall**. There is no sandbox; sessions are plaintext files under your home
directory. The full threat model, including known defects and their status, is
documented honestly in
[`docs/security-spec.md`](./docs/security-spec.md). Read it before running with
`allowAll` on a repo you didn't write.

Heirloom collects **no telemetry** and phones home for nothing — there is no
telemetry subsystem and no config key that enables one.

---

## Documentation

Every subsystem has a spec. Start with the architecture overview, then dive
into whatever you're touching.

| Doc | Contents |
|---|---|
| [architecture.md](./docs/architecture.md) | The layers, tradeoffs, research foundation |
| [subsystems.md](./docs/subsystems.md) | Memory, context tiers, ReAct variant, compaction, failure modes |
| [tool-spec.md](./docs/tool-spec.md) | Tool contracts: params, truncation, error codes |
| [provider-spec.md](./docs/provider-spec.md) | Adapter contract; adapters vs providers |
| [config-spec.md](./docs/config-spec.md) | Config schema, providers, credentials |
| [mode-spec.md](./docs/mode-spec.md) | Persona schema + built-ins |
| [permission-spec.md](./docs/permission-spec.md) | Rules, approval modes, the ask prompt |
| [session-spec.md](./docs/session-spec.md) | JSONL format, resume, compaction markers |
| [skill-spec.md](./docs/skill-spec.md) | Agent Skills format, search paths, triggers |
| [cli-spec.md](./docs/cli-spec.md) | Invocation, flags, commands, keybindings |
| [security-spec.md](./docs/security-spec.md) | Threat model, mitigations, non-goals |
| [conventions.md](./docs/conventions.md) | Code style, testing strategy, doc workflow |

---

## Contributing

Contributions are genuinely welcome — bug reports, docs fixes, new provider
presets, and features all help.

**Get set up:**

```bash
npm install
npm test              # vitest — edit strategies, permissions, registry, compaction, sessions
npx tsc --noEmit      # type gate (also runs in CI)
npm run build         # bundle with tsup
```

Then read **[CONTRIBUTING.md](./CONTRIBUTING.md)** for the PR checklist, a map
of the source tree, and good first contributions. All participation is governed
by our [Code of Conduct](./CODE_OF_CONDUCT.md).

Not sure where to start? Open an issue describing what you'd like to do and
we'll point you at the right layer.

---

## License

Licensed under the [Apache License 2.0](./LICENSE). By contributing, you agree
that your contributions will be licensed under the same terms.
