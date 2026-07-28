# Heirloom — Design Document

> Personal AI coding agent. Provider-agnostic, mode-gated, safety-first.
> Target: opencode-quality CLI, built incrementally from first principles.

---

## Philosophy

Build an agent that **you fully understand**. Every line has a known purpose.
No framework, no magic — just TypeScript, a provider adapter, and a loop.

The name "heirloom" means something you build once and keep. The architecture
reflects that: each layer is independently understandable, replaceable, and
testable. No layer depends on implementation details of another.

---

_See [subsystems.md](./subsystems.md) for deep dives on memory, context management, ReAct variants, compaction strategy, and token optimization._

## Architecture: 7 Layers

Inspired by how opencode, RooCode, Aider, and SWE-agent decompose the problem:

```
┌─────────────────────────────────────────────────────────────┐
│  Layer 7: CLI + TUI (index.ts, readline → future: Ink TUI)  │
│  What the user sees. Commands, prompts, streaming output.   │
├─────────────────────────────────────────────────────────────┤
│  Layer 6: Modes (personas with tool gates + file restrictions)
│  RooCode's killer feature. Each mode is a YAML-defined       │
│  persona: Code, Ask, Architect, Debug, Orchestrator.         │
├─────────────────────────────────────────────────────────────┤
│  Layer 5: Safety (permissions + checkpoint/restore)          │
│  opencode's pattern-based allow/ask/deny rules.              │
│  RooCode's shadow Git checkpoints for undo.                  │
├─────────────────────────────────────────────────────────────┤
│  Layer 4: Context (compaction + RepoMap + token budget)      │
│  opencode's auto-compaction with overflow detection.         │
│  Aider's tree-sitter + PageRank for codebase awareness.      │
├─────────────────────────────────────────────────────────────┤
│  Layer 3: Agent Loop (enhanced ReAct engine)                 │
│  ReAct paper: Thought → Action → Observation.                │
│  Aider's self-reflection. SWE-agent's layered error recovery.│
├─────────────────────────────────────────────────────────────┤
│  Layer 2: Tools (registry + 6 edit strategies + bash + fs)   │
│  RooCode's 6-edit-tool strategy. SWE-agent's ACI design.    │
│  Tools are designed for LLM consumption, not human use.      │
├─────────────────────────────────────────────────────────────┤
│  Layer 1: Provider Adapters (DeepSeek → Anthropic → ...)     │
│  Canonical types never touch any provider SDK.               │
│  Each adapter is ~120 lines of pure mapping.                 │
└─────────────────────────────────────────────────────────────┘
```

---

## Layer 1: Provider Adapters

**Why a canonical type system?** Every provider has its own message format:
- OpenAI: `{ role, content, tool_calls: [{ id, type: "function", function: {...} }] }`
- Anthropic: `{ role, content: [{ type: "text", text }, { type: "tool_use", ... }] }`
- Google: yet another shape

If the agent loop speaks any of these natively, swapping providers means
rewriting the loop. A canonical type system means the loop never changes.

**Design decisions:**
- `ToolCall.arguments` is `Record<string,unknown>` (parsed), not a JSON string.
  The provider adapter handles serialization. The agent loop and tool handlers
  always receive structured data.
- `StreamEvent` is a discriminated union of 4 events. Every adapter yields them
  in the same order: text_delta* → (tool_call_start → tool_call_delta*)* → done.
  The agent loop doesn't know or care which provider is streaming.

**References:**
- opencode's `ProviderConfig` + model capabilities matrix
- The OpenAI/Anthropic SDK type definitions studied side-by-side

---

## Layer 2: Tools

**Why 6 edit tools instead of 1?** RooCode's key insight: when you give the LLM
one generic "edit" tool, it has to figure out the right strategy from the
description alone. When you give it 6 specialized tools, the system prompt
guides it to pick the right one. More tokens in the prompt = fewer wrong tool
calls.

| Tool | Strategy | Inspired By |
|------|----------|-------------|
| `edit` | Exact string → replacement | opencode |
| `apply_diff` | Unified diff, first occurrence | RooCode, Aider's editblock |
| `apply_patch` | Multi-file unified diff | RooCode |
| `search_replace` | Global find-and-replace | RooCode |
| `edit_file` | Search-replace with count validation | RooCode |
| `write_to_file` | Full file overwrite | RooCode, opencode |

**Why a ToolRegistry?** SWE-agent's command system showed that tools need
metadata (which mode they belong to, what files they access, whether they're
dangerous). A registry centralizes this instead of scattering it across files.

**Why a ToolContext?** Tools need more than just arguments. They need:
- `workingDir` — where the agent is operating
- `sessionId` — for checkpoint scoping
- `askUser` — for inline permission prompts
- `signal` — for cancellation

These come from the agent session, not from the LLM. SWE-agent passes them
implicitly; opencode passes them through a ToolContext. We follow opencode.

**References:**
- RooCode's 6-edit-tool strategy (see research notes)
- SWE-agent's ACI: "design tools for LLMs, not humans" (Yang et al., 2024)
- SWE-agent's Command system with typed arguments and blocklists

---

## Layer 3: Agent Loop

**Why ReAct?** The ReAct paper (Yao et al., 2022) established that interleaving
reasoning (the LLM's text output) with acting (tool calls) produces better
results than either alone. Every major coding agent uses this pattern.

**Enhancements over vanilla ReAct:**

1. **Streaming.** Text streams to the user in real time (open code pattern).
   Tool calls accumulate in the background, then execute as a batch.

2. **Self-reflection** (from Aider). When a tool fails (file not found, diff
   doesn't apply), the error is fed back to the LLM as a system message before
   the user ever sees it. The LLM gets one chance to self-correct.

3. **Layered error recovery** (from SWE-agent):
   - Layer 1: Parse error → requery with format template
   - Layer 2: Tool execution error → self-reflection
   - Layer 3: Fatal → save state, notify user

4. **Auto-compaction** (from opencode). When the conversation exceeds the
   context window budget, old messages are summarized before the next LLM call.

**Design decisions:**
- The agent loop takes a `Provider` interface, not a concrete client. This is
  the dependency inversion that makes the whole architecture work.
- `maxTurns` (default 20) prevents infinite tool-calling loops. opencode calls
  this `steps`; it's the same concept.

**References:**
- ReAct: Synergizing Reasoning and Acting in Language Models (Yao et al., 2022)
- Aider's `run_one()` method with self-reflection (base_coder.py)
- SWE-agent's `forward_with_handling` with layered retry (agents.py)

---

## Layer 4: Context Management

**Why RepoMap?** Aider's key innovation: instead of giving the LLM the entire
file tree or requiring the user to manually add files, use tree-sitter to build
a symbol graph, then PageRank-rank symbols by relevance to the current
conversation. The LLM gets a compressed but semantically rich view of the
codebase.

**Why compaction?** opencode demonstrated that auto-compaction (summarizing old
messages when the context window fills up) enables conversations of arbitrary
length. Without it, the agent hits the context limit and the user has to
manually clear.

**Design decisions:**
- Token estimation uses a char/4 heuristic in Phase 4. Future: use tiktoken
  for exact counts.
- Compaction uses the same LLM (or a cheaper model) to summarize, extracting
  files changed, decisions made, and key observations.
- RepoMap uses binary search to maximize useful files within a fixed token
  budget (Aider's approach).

**References:**
- Aider's RepoMap (repomap.py) — tree-sitter + PageRank + binary search
- opencode's compaction — auto-trigger, overflow detection, summarization

---

## Layer 5: Safety

**Why pattern-based permissions?** opencode's system is the most mature: rules
are evaluated in insertion order, the last matching rule wins, and patterns
support glob syntax. This is simpler than RooCode's allowlist/denylist with
longest-prefix matching, and equally expressive.

**Why checkpoint/restore?** RooCode's shadow Git repository is the only
open-source coding agent that ties checkpoints to the conversation, allowing
you to rewind both files AND conversation state. This makes experimentation
safe — you can always undo.

**Design decisions:**
- Default: `ask` for all tools. User must explicitly allow.
- Broad rules first, narrow rules last (insertion order matters, like opencode).
- Shadow Git repo is per-session, distinct from the user's Git repo.
- The shadow repo honors the project's `.gitignore` (plus always-excludes
  `.git/`, `node_modules/`) — otherwise every checkpoint commits dependency
  trees and checkpointing becomes unusably slow on real repos.
- Two restore modes: files-only (compare approaches) and full (complete reset).

**References:**
- opencode's `PermissionRuleset` with last-match-wins
- RooCode's checkpoint system (shadow Git repo)
- Claude Code's permission modes → approval modes (see [permission-spec.md](./permission-spec.md))

---

## Layer 6: Modes

**Why modes?** RooCode's most innovative feature. A "mode" is a persona that
gates which tools the LLM can access and which files it can modify:

- **Code**: full access (read, edit, command). Everyday coding.
- **Ask**: read-only. Quick answers without risk.
- **Architect**: read + docs-only writes. Planning, not implementation.
- **Debug**: full access with systematic troubleshooting instructions.
- **Orchestrator**: only `new_task`. Delegates to other modes.

This prevents the "oops, I accidentally edited your production config" problem
at the architectural level, not the permission level.

**Design decisions:**
- Modes are YAML files, not code. Users can define custom modes.
- Tool gates are by group (read/edit/command), not by individual tool.
- File restrictions use regex patterns.
- Sticky model per mode — switching to Architect auto-switches to a reasoning model.
- Project modes override global modes (like opencode's config merge).

**Why orchestrator mode?** RooCode's Boomerang Tasks showed that multi-agent
orchestration can be done without complex infrastructure: the orchestrator
spawns sub-agents with isolated context, and only summaries bubble back. This
prevents context poisoning from long task chains.

**References:**
- RooCode's mode system (custom_modes.yaml, .roomodes)
- RooCode's Boomerang Tasks (orchestrator with context isolation)

---

## Layer 7: CLI

**Why readline for now?** Phase 1 is about the engine, not the UI. readline
gives us a working CLI in ~40 lines. Future: replace with Ink (React for
terminals) for syntax highlighting, streaming with virtual diff, and TUI
controls like opencode.

**Commands** (full reference: [cli-spec.md](./cli-spec.md)):
- `/exit` — quit
- `/help` — show commands
- `/mode <slug>` — switch mode
- `/clear` — clear conversation
- `/compact` — force compaction
- `/checkpoint` — manual checkpoint
- `/restore [files|full]` — restore

**References:**
- opencode's TUI (SolidJS + @opentui)
- RooCode's CLI (headless extension host pattern with ExtensionClient)

---

## Research Foundation

| Paper / Source | Key Idea | Applied To |
|---------------|----------|------------|
| ReAct (Yao 2022) | Thought → Action → Observation loop | Layer 3: Core agent loop |
| SWE-agent (Yang 2024) | Agent-Computer Interface, layered error recovery | Layers 2, 3: Tool design, error handling |
| Toolformer (Schick 2023) | LLMs self-decide when to call APIs | Layer 3: `tool_choice: "auto"` |
| opencode | Permissions, compaction, plugin hooks, MCP | Layers 4, 5, 9 |
| RooCode | Modes, 6-edit-tool, checkpoints, orchestrator | Layers 2, 5, 6 |
| Aider | RepoMap, SEARCH/REPLACE, self-reflection, token budget | Layers 2, 3, 4 |

---

## File Manifest

```
src/
├── types.ts                    # Canonical types: Message, ToolDef, ToolCall, ToolOutput
├── agent.ts                    # Layer 3: Enhanced ReAct loop
├── config.ts                   # Config loading (~/.heirloom/config.yaml)
├── index.ts                    # Layer 7: CLI entry point
│
├── providers/
│   ├── types.ts                # Provider interface + StreamEvent union
│   ├── deepseek.ts             # DeepSeek adapter (OpenAI-compatible API)
│   └── anthropic.ts            # Anthropic adapter (future)
│
├── tools/
│   ├── types.ts                # ToolContext, ToolHandler types
│   ├── registry.ts             # ToolRegistry class
│   ├── files.ts                # read_file, write_to_file, list_files, glob
│   ├── edit.ts                 # 6 edit strategies (edit, apply_diff, apply_patch, etc.)
│   ├── bash.ts                 # run_bash
│   ├── search.ts               # search (grep)
│   └── index.ts                # Register all tools, export for CLI
│
├── permissions/
│   └── engine.ts               # Pattern-based allow/ask/deny ruleset
│
├── checkpoints/
│   └── index.ts                # Shadow Git checkpoint/restore manager
│
├── compaction/
│   ├── budget.ts               # Token estimation + threshold check
│   └── compactor.ts            # Summarization engine
│
├── repomap/
│   └── index.ts                # tree-sitter symbol extraction + PageRank ranking
│
├── modes/
│   ├── loader.ts               # YAML mode loader + precedence rules
│   └── builtin/                # Default modes
│       ├── code.yaml
│       ├── ask.yaml
│       ├── architect.yaml
│       ├── debug.yaml
│       └── orchestrator.yaml
│
├── skills/
│   └── loader.ts               # Progressive disclosure skill loader (future)
│
└── mcp/
    └── client.ts               # MCP client for external tool discovery (future)
```

---

## Key Design Tradeoffs

1. **Canonical types vs SDK types.** Canonical types add a mapping layer (~40
   lines per adapter) but make the agent loop provider-agnostic forever.
   Decision: canonical types. The mapping code is trivial and the benefit is permanent.

2. **6 edit tools vs 1.** More tools = more tokens in the system prompt. But
   more specialized tools = higher-quality edits. RooCode's data shows this
   tradeoff pays off. Decision: 6 tools.

3. **Git-based checkpoints vs file snapshots.** Git is heavier but gives us
   diff viewing, selective restore, and conversation-aware rollback for free.
   Decision: shadow Git repo.

4. **YAML modes vs code-defined modes.** YAML is less type-safe but allows
   users to define custom modes without writing TypeScript. RooCode uses YAML
   successfully. Decision: YAML.

5. **readline vs Ink TUI.** readline is 40 lines; Ink is a framework. Phase 1
   ships with readline because the engine is the priority. Decision: start with
   readline, migrate to Ink when the engine stabilizes.

6. **Single process vs client/server.** opencode runs a local server; the TUI
   is just a client. That enables IDE integration, shared sessions, and
   multiple frontends — at the cost of a protocol layer and two lifecycles.
   Decision: single process. Heirloom is a personal agent; the extra moving
   parts buy nothing yet. Guardrail: the agent loop must never import readline
   or write to stdout directly (I/O stays in Layer 7, passed in as callbacks),
   so a server frontend remains a Layer 7 swap, not a rewrite.
   *Note: `runAgent` currently violates this — it writes to `process.stdout`
   directly. Fix when touching agent.ts in Phase 2.*
