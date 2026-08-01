# Agents Forget. Here's How We Built Memory That Actually Evolves.

*A practical, research-grounded memory architecture for LLM agents — and the bugs we hit along the way.*

---

Every AI agent has amnesia. Close the session, and the "assistant" that knew your project inside-out becomes a stranger with a polite greeting. Context windows keep getting bigger, but nobody wants to re-read 200k tokens of history to remember what happened yesterday — and the models won't do it for you.

We spent the last few weeks fixing this on our multi-agent setup (four specialized agents: an orchestrator, a coder, a researcher, a reviewer). The result is a memory system that is hierarchical, structured, semantically searchable, and — the part most people skip — *self-updating*.

Everything here is framework-agnostic. Whether you use LangGraph, the OpenAI Agents SDK, a homegrown ReAct loop, or something else entirely, the same five decisions apply.

---

## 1. What the papers actually say

Before touching a single file, we checked the state of the art. Four ideas shaped everything:

**MemGPT — "LLMs as Operating Systems" (Packer et al., 2023).**
Memory is a hierarchy, like a computer: fast memory (the context window = RAM) and slow memory (external storage = disk). The system pages data between them. You don't cram everything into context — you manage what's *resident* vs. what's *stored*. This is the foundation of every modern agent memory design.

**Generative Agents (Park et al., 2023).**
The origin of the "memory stream": every event gets logged, then a *reflection* process periodically distills raw events into higher-level insights. Retrieval scores memories by recency × importance × relevance. This is where "daily notes" + "curated summaries" comes from.

**A-MEM — Agentic Memory for LLM Agents (Xu et al., NeurIPS 2025).**
The most relevant paper for us. Flat storage + retrieval isn't enough. Memory should be *structured notes* with attributes (context, keywords, tags), linked into a network, and — crucially — **evolving**: when a new memory arrives, it can update and rewrite *old* memories. It's Zettelkasten applied to agents, and it beat prior baselines across six foundation models.

**CoALA — Cognitive Architectures for Language Agents (Sumers et al., 2024).**
The taxonomy: working memory, episodic memory (what happened), semantic memory (facts/knowledge), procedural memory (how to do things). It's the vocabulary everyone uses to describe the others.

**The takeaway:** modern agent memory = *hierarchical tiers* + *structured, linked notes* + *semantic retrieval* + *reflection that updates old knowledge*. Not a vector DB bolted onto a prompt.

---

## 2. The design: three tiers, one vault

We mapped the theory onto a concrete layout: a folder of plain Markdown files — no proprietary blob format. Every file is real, human-readable, and diffable in git.

```text
memory-vault/
├── Home.md                          # hub page, links to everything
├── agents/
│   ├── orchestrator/memory/2026-08-01.md   # EPISODIC: raw daily logs
│   └── coder/memory/2026-08-01.md
└── projects/
    ├── project-alpha/MEMORY.md      # SEMANTIC: canonical project knowledge
    └── project-beta/MEMORY.md
```

| Tier | What it maps to | Research basis |
|---|---|---|
| **Working memory** | The model's context window | MemGPT's fast tier |
| **Episodic** | `agents/<id>/memory/YYYY-MM-DD.md` — raw daily logs | Generative Agents' memory stream |
| **Semantic** | `projects/<name>/MEMORY.md` — distilled status, decisions, architecture | CoALA's semantic memory, A-MEM's notes |

The key organizational decision: **structure by project, not by agent**. When the coder finishes a feature in Project Alpha, the knowledge belongs to the *project's* memory — not buried in the coder's personal log. Any agent (or human) can later open `projects/alpha/MEMORY.md` and know exactly where the project stands. Files cross-link with `[[wikilinks]]` (Obsidian-style), and a `Home.md` hub ties it together. It's a knowledge graph you can read with any text editor — and any agent can ingest it with a simple directory walk.

---

## 3. Semantic search without selling your data

Structured files get you a long way. But keywords fail when wording drifts — ask "the refund app" and it won't match a note that says "return-reminder". That's where embeddings come in.

The temptation is to call an API (OpenAI, Gemini, Voyage). We went **fully local** instead:

- **Model:** `embeddinggemma-300m` (Google's small open embedding model, GGUF format, ~0.6 GB)
- **Runtime:** `node-llama-cpp` (or llama.cpp, or whatever runs GGUF on your stack) — CPU-only, no GPU, no cloud call
- **Retrieval:** hybrid — 70% vector similarity + 30% BM25 keyword, so you get semantic recall *and* exact-match reliability

The config, in whatever shape your framework takes:

```json5
memorySearch: {
  provider: "local",                  // no API key, nothing leaves the machine
  model: "embeddinggemma-300m-q8_0.gguf",
  hybrid: { vectorWeight: 0.7, textWeight: 0.3 },
  chunkSize: 400, chunkOverlap: 80,   // ~400-token chunks
  cache: { enabled: true }
}
```

The indexer chunks each Markdown file, embeds them into a SQLite database, and watches the files for changes. Results come back ranked with scores and exact `file:line` citations.

Why local matters: the whole point of an agent knowledge base is that your notes are *yours*. Embedding private project knowledge through a third-party API is a data leak you didn't need. A 300m model on CPU indexes a personal vault in minutes.

---

## 4. The rule that makes it all work: memory updates are mandatory

Here's the uncomfortable truth we hit after wiring up all the fancy retrieval: **retrieval only finds what's written down.**

A vector index over a stale vault is just a fast way to find outdated information. The real bottleneck was never search — it was *discipline*. Agents finish a feature and move on; the knowledge evaporates with the session transcript.

So we made memory updates a hard rule, enforced at three levels:

1. **Global instructions** (the file every agent reads first at session start):
   > Memory update is **OBLIGATORY** on every successful feature implementation, completed research, and review verdict. A feature is not "done" until memory reflects it.

2. **Per-agent workflows** (each agent's operating instructions):
   - Coder: memory update is the final step — write to `projects/<name>/MEMORY.md` + the daily log + the checkpoint doc, **before moving on**.
   - Reviewer: the review verdict gets appended to the project memory.
   - Researcher: findings land in the project's `MEMORY.md`, not just the chat.

3. **Long-term memory files** (`MEMORY.md` per agent) so the rule survives restarts.

This is A-MEM's "memory evolution" made operational: new facts don't just get appended — they *update* the project's canonical knowledge. Status changes. Decisions get recorded. The vault is never a snapshot; it's a living document.

---

## 5. The bug that taught us the most

Any good engineering story has a villain. Ours: **symlinks**.

Our agent workspaces point at the vault via symlinks (`workspace/MEMORY.md → vault/agents/main/MEMORY.md`). Elegant — one source of truth, no copying. Then we enabled vector search and got... zero results. The model downloaded fine, the index built fine, and indexed exactly **0 files**.

Digging into the source revealed why:

```js
const stat = await fs.lstat(absPath);
if (stat.isSymbolicLink() || !stat.isFile()) return;   // ← rejects our symlinks
```

The indexer *deliberately* refuses symlinks — a security decision (never index paths outside the workspace). Our elegant symlink architecture was invisible to it by design.

**The fix:** most frameworks have a supported escape hatch — a config key for *additional* paths to index. Point it at the real paths instead of the symlinks:

```json5
memorySearch: {
  extraPaths: [
    "/path/to/vault/agents/main",   // the agent's own memory
    "/path/to/vault/projects"       // all project knowledge
  ]
}
```

One config change, and the index went from 0 → 26 files / 82 chunks. Bonus: agents can now semantically search **project knowledge** across the whole vault, not just their own notes.

**Lesson:** when a tool "doesn't work," read the source. The indexer wasn't broken — our mental model of it was.

---

## 6. Before / after

| | Before | After |
|---|---|---|
| Recall | Keyword grep at best; memory search disabled entirely | Semantic + keyword hybrid, ranked, with citations |
| Cross-project knowledge | Only what an agent happened to read this session | Any agent can ask "what's the status of X?" and get the answer |
| Memory freshness | Depends on whoever remembered to write | Mandatory update step in every workflow |
| Privacy | — | Full local embeddings; zero data leaves the machine |
| Cost | — | $0 (one-time 0.6 GB model download) |

The honest caveat: at 26 files, even grep finds most things. The embeddings pay off as the vault grows — and more importantly, the *discipline* pays off immediately. The index is the foundation; the update rule is the compounding return.

---

## 7. What we'd do next

- **Reflection cron** — a scheduled job that consolidates each agent's daily notes into project `MEMORY.md` at end of day, so curation doesn't depend on a heartbeat.
- **Memory evolution done properly** — automatically updating old project notes when new facts contradict them (A-MEM's full loop; currently it's rule-driven, not automatic).
- **Importance scoring** — Generative Agents-style recency × importance × relevance retrieval, instead of plain similarity.

---

## TL;DR — the recipe

1. **Structure by project, not by agent.** Canonical `MEMORY.md` per project; raw daily logs per agent. Human-readable Markdown, no proprietary formats.
2. **Three tiers:** context window (working) → daily notes (episodic) → project memory (semantic).
3. **Semantic retrieval, fully local.** A 300m embedding model on CPU is enough for a personal vault. Hybrid vector + BM25 for the best of both.
4. **Make memory updates a hard rule.** Enforced in the global instructions, per-agent workflows, and long-term memory files. A feature isn't done until memory reflects it.
5. **When a tool misbehaves, read the source.** Our "broken" indexer was correctly refusing symlinks; the fix was one config key.

Agents don't have to be amnesiacs. The pieces are all boring, open, and cheap: Markdown files, a folder structure, a small local model, and a rule that says *write it down*.

---

*References: MemGPT (arXiv:2310.08560), Generative Agents (arXiv:2304.03442), A-MEM (arXiv:2502.12110, NeurIPS 2025), CoALA (arXiv:2309.02427).*
