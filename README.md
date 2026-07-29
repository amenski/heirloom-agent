# Heirloom

A personal AI coding agent for the terminal. Provider-agnostic, mode-gated,
permission-first — built from first principles to be **fully understood by
its owner**: no agent framework, no magic. TypeScript, a provider adapter,
and a loop.

The name is the point: something you build once, understand completely, and
keep. Every layer is independently readable and replaceable, and every
design decision is written down in [`docs/`](./docs/) with its rationale and
the project it was learned from (opencode, RooCode, Aider, SWE-agent).

## What it does

- **ReAct agent loop** with self-reflection, layered error recovery, and
  loop detection — streams responses, executes tools, verifies its own edits
- **Any OpenAI-compatible LLM** via config alone: DeepSeek, OpenRouter,
  Groq, Ollama (local), OpenAI ship as presets; adding another is YAML, not code
- **Modes** (personas): `code`, `ask` (read-only), `architect`, `debug`,
  `orchestrator` — each gates which tools even exist for the model
- **Permissions**: pattern rules (`allow`/`ask`/`deny`, last match wins) with
  session-level approval modes (`manual` / `edits` / `all`) — `deny` is
  absolute in every mode
- **11 tools**, including 6 specialized edit strategies with stale-file
  detection — the agent cannot blind-overwrite a file it hasn't read
- **Sessions**: append-only JSONL, resumable (`--continue`), with structured
  auto-compaction for arbitrarily long conversations
- **Checkpoints**: shadow-Git snapshots before edits; `/restore` rewinds
  files (or files + conversation)
- **RepoMap**: symbol extraction + PageRank so the model sees a compressed,
  relevant view of your codebase
- **Skills**: reads the cross-tool [Agent Skills](https://agentskills.io)
  format from `~/.agents/skills/` — skills installed for other agents work here
- **Headless mode** (`-p`) for scripting, with fail-closed permissions

## Quickstart

Requires Node 20+ and an API key for at least one provider.

```bash
npm install

# connect a provider (writes ~/.heirloom/credentials.yaml, chmod 600)
npm start -- auth

# interactive session
npm start

# resume where you left off
npm start -- --continue

# headless one-shot
npm start -- -p "explain src/agent.ts" --approve edits
```

Or set an env var instead of the wizard: `export DEEPSEEK_API_KEY=...`
(DeepSeek is the default provider; `HEIRLOOM_PROVIDER=openrouter` etc. to
switch).

A real `heirloom` binary (build + `bin` entry) is on the roadmap; until
then `npm start --` is the entry point.

## Everyday use

```
heirloom [code] > /mode ask          # switch persona (read-only)
heirloom [Ask] > /approve edits      # auto-approve edits in this workspace
heirloom [Ask ⚡edits] >
```

| Keys / commands | |
|---|---|
| `Esc` (or `Ctrl+C`) | abort the current turn — nothing partial is saved |
| `Shift+Tab` | cycle approval mode `manual → edits → all` |
| `/help` | full command list |
| `/sessions`, `/new`, `/clear` | session management |
| `/checkpoint`, `/restore files` | snapshot / rewind workspace |
| `/skills`, `/skill <name>` | list / force-load a skill |

Full reference: [`docs/cli-spec.md`](./docs/cli-spec.md).

## Configuration

`~/.heirloom/config.yaml` (global) and `.heirloom/config.yaml` (per-project;
project wins). Keys never go in config — env vars or the `auth`-managed
credentials file. Example — adding OpenRouter with zero code:

```yaml
providers:
  openrouter:
    api: openai-compatible
    baseUrl: https://openrouter.ai/api/v1
    apiKeyEnv: OPENROUTER_API_KEY
    models:
      anthropic/claude-sonnet-4.5: { contextWindow: 200000 }
```

Per-repo instructions for the agent: `.heirloom/instructions.md` (or
`AGENTS.md`). Custom personas: drop a YAML in `~/.heirloom/modes/`.

## Security posture (read this)

Heirloom executes LLM-chosen commands on your machine. The design treats
everything reaching the model — repo files, command output, third-party
skills — as untrusted input, and **you at the permission prompt are the
firewall**. There is no sandbox; sessions are plaintext files under
`~/.heirloom/`. The full threat model, including known defects and their
status, is honestly documented in
[`docs/security-spec.md`](./docs/security-spec.md). Read it before running
with `/approve all` on a repo you didn't write.

## Documentation

| Doc | Contents |
|---|---|
| [architecture.md](./docs/architecture.md) | The 7 layers, design tradeoffs, research foundation |
| [subsystems.md](./docs/subsystems.md) | Memory, context tiers, ReAct variant, compaction, token optimization, failure modes |
| [system-prompt.md](./docs/system-prompt.md) | The actual prompt text + change protocol |
| [tool-spec.md](./docs/tool-spec.md) | Contracts for all tools: params, truncation, error codes |
| [provider-spec.md](./docs/provider-spec.md) | Adapter contract; adapters vs providers |
| [config-spec.md](./docs/config-spec.md) | Config schema, providers map, credentials |
| [mode-spec.md](./docs/mode-spec.md) | Persona schema + built-ins |
| [permission-spec.md](./docs/permission-spec.md) | Rules, approval modes, ask prompt |
| [session-spec.md](./docs/session-spec.md) | JSONL session format, resume, compaction markers |
| [skill-spec.md](./docs/skill-spec.md) | Agent Skills format, search paths, trigger mechanism |
| [cli-spec.md](./docs/cli-spec.md) | Invocation, flags, commands, keybindings |
| [security-spec.md](./docs/security-spec.md) | Threat model, mitigations, non-goals |
| [conventions.md](./docs/conventions.md) | Code style, testing strategy, doc workflow |

## Development

```bash
npm test              # vitest — unit suites for edit strategies, permissions,
                      # registry, compaction, sessions
npx tsc --noEmit      # type gate
```

Agent-level evals live in `fixtures/` as golden tasks, run headless.

Status: working and under active development by one person, for one person.
Issues and ideas welcome; expectations should match.
