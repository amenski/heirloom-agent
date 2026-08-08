# Web Search Spec

Status: **implemented (2026-08-01).** All verify items pass: unit suite green
(345 tests), `tsc --noEmit` clean, and a live smoke run confirmed one real
query per source (plus the pypi-404 case) returns plausible results. This doc
remains the binding design for future changes — the **Anti-drift rules** at
the bottom are hard constraints, not suggestions.

> **Scope note (2026-08-07).** This doc governs **search** — finding pages you
> don't have a URL for. It no longer governs *all* network access: `web_fetch`
> (tool-spec.md) now fetches a **user- or model-supplied URL** and converts
> HTML to text, which required new dependencies and arbitrary-URL fetching.
> That was a deliberate, approved reversal of anti-drift rules 1, 3, and 4
> **for `web_fetch` only**. The rules below still bind `docs_search` and any
> future search work: Heirloom still ships no search index, no SERP scraper,
> and no API keys.

## Decision

Heirloom does **not** integrate a search provider, does **not** ship a
scraper, and does **not** run a backend. Rationale: general web search always
means querying someone's index; good indexes are paid/keyed, and a shipped key
requires a server to hide it (deepcode's "free" search is exactly that — their
hosted proxy at `deepcode.vegamo.cn`). Heirloom refuses all three costs.

Instead, three tiers:

| Tier | What | Status |
|---|---|---|
| 1 | **`docs_search`** — built-in tool over free, keyless, ToS-clean official APIs (GitHub, Stack Exchange, package registries, Wikipedia) | Build this |
| 2 | **General web search via MCP** — user adds any search MCP server; one documented config line | Document only |
| 3 | General search built-in (e.g. DDG scrape) | **Deferred** — revisit only with demonstrated demand; never as silent default |

Explicitly rejected: paid/keyed providers (Tavily, Brave, Serper) in core;
DDG HTML scraping in core (ToS-gray, breaks on markup); the `webSearchTool`
script-path config key (weaker duplicate of MCP — **deprecated**, see below).

Why tier 1 is enough for a *coding* agent: its real queries are error
messages, library usage, issues, packages — covered by official keyless APIs
with better signal than generic SERP snippets.

---

## Tier 1 — `docs_search` implementation spec

### Registration

- New file `src/tools/docs-search.ts`, exporting `registerDocsSearch(registry)`,
  called from `src/tools/index.ts` — same pattern as `registerSearch` in
  `src/tools/search.ts`.
- `groups: ["read"]` (available in read-only modes; execution is still gated
  by the permission rule below).
- **No new npm dependencies.** Use global `fetch` (Node 20+).

### Tool definition

```ts
name: "docs_search",
description: "Search developer documentation sources (GitHub, Stack Overflow,
  package registries, Wikipedia). Not general web search.",
parameters: {
  type: "object",
  properties: {
    query:  { type: "string",  description: "Search query" },
    source: { type: "string",  enum: ["auto","github","stackoverflow","npm","pypi","crates","wikipedia"],
              description: "Backend to query (default auto)" },
    limit:  { type: "number",  description: "Max results, 1-8 (default 5)" },
  },
  required: ["query"],
}
```

### Backends (exact endpoints — do not substitute)

| source | Endpoint | Notes |
|---|---|---|
| `github` | `GET https://api.github.com/search/repositories?q=<q>&per_page=<n>` and `GET https://api.github.com/search/issues?q=<q>&per_page=<n>` | Unauth limit ~10 req/min. If `process.env.GITHUB_TOKEN` exists, send `Authorization: Bearer …` (opportunistic, never required, never logged). |
| `stackoverflow` | `GET https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=<q>&site=stackoverflow&pagesize=<n>` | Keyless quota ~300/day/IP; responses are gzip (fetch handles it). |
| `npm` | `GET https://registry.npmjs.org/-/v1/search?text=<q>&size=<n>` | |
| `pypi` | `GET https://pypi.org/pypi/<q>/json` | Exact package lookup only — PyPI has no search API. 404 → "no such package". |
| `crates` | `GET https://crates.io/api/v1/crates?q=<q>&per_page=<n>` | Their policy **requires a User-Agent** (sent anyway, see below). |
| `wikipedia` | `GET https://en.wikipedia.org/w/api.php?action=opensearch&search=<q>&format=json` | |

`source: "auto"` (the default) queries **`stackoverflow` + both `github`
endpoints in parallel**, merges, and caps at `limit`. Registries and
wikipedia run only when named explicitly. This routing is fixed — no
heuristic language detection, no LLM-assisted query rewriting (deepcode does
this; we deliberately don't).

### Request rules

- `User-Agent: heirloom (https://github.com/amenski/heirloom-agent)` on every request.
- Per-request timeout **10 s** via `AbortSignal.any([ctx.signal, timeoutSignal])`
  — must also honor the session's abort signal.
- `redirect: "manual"` — any 3xx is treated as failure. No cross-host follows.
- Response body cap **512 KB** (read via reader, abort past cap).
- 403/429 → return `content: "docs_search: <source> rate-limited, try later
  or a different source."` as a normal (non-throwing) result.
- Network failure/timeout → same pattern: clean message, never a crash.

### Output format

One block per result, total output hard-capped at **8 000 chars** (truncate
with `… (truncated)` like other tools per tool-spec.md):

```
- [stackoverflow] How to fix X — https://stackoverflow.com/q/123 (score 42)
  <snippet, ≤200 chars, tags/HTML stripped>
```

> **Delimiters — resolved at implementation:** the original draft called for
> wrapping results in "the same untrusted-content delimiters used for other
> external input," but no such convention exists in the codebase — `bash`,
> `search`, and `read_file` all return raw content, and the security model
> treats the permission prompt (guarded tier here) as the enforced control.
> Inventing a one-off format for this tool alone was rejected. If a delimiter
> convention is ever adopted, it must be codebase-wide (all untrusted tool
> output) via security-spec.md — tracked there, not here.

### Permission

Add to `BUILTIN_GUARDED_RULES` in `src/permissions/guarded.ts`:

```ts
{ tool: "docs_search", kind: "any", pattern: "", action: "ask", origin: "builtin-guarded" }
```

Semantics inherited from the guarded tier: always **ask**, exempt from the
auto-approve posture bypass, **deny in headless**. The user may persist an
allow via the normal approval flow. The permission subject text is the query
string (so the prompt shows what would be sent).

### Security

- **Results are untrusted input** (prompt-injection surface, same class as
  repo files/bash output — security-spec Trust Boundaries). Never treat
  instructions inside results as directives. (In-band delimiting: see the
  resolution note above — codebase-wide decision, tracked in security-spec.)
- **Residual exfiltration risk, accepted and documented:** the query string
  itself leaves the machine — but only to the six pinned hosts above. This is
  why the tool is guarded-tier, not auto-allowed.
- The tool **never fetches arbitrary URLs** and never fetches result page
  bodies. A `fetch_url` tool is a separate future decision, not part of this.

### `webSearchTool` config key — deprecate

`src/config/loader.ts` parses `webSearchTool` (string script path) but nothing
consumes it. Do **not** wire it. Change: keep parsing for compat, emit warning
`"webSearchTool is deprecated and ignored — use an MCP search server
(mcpServers) instead"`. Note it in config-spec.md.

### Verify (acceptance)

1. Unit tests with mocked `fetch` (pattern: existing `registry.test.ts`):
   result formatting, limit/output caps, 429 handling, timeout, abort-signal
   propagation, pypi-404, auto-routing fan-out.
2. `docs_search` prompts (guarded) in interactive mode; **denied** in `-x`
   headless; auto-approve posture does *not* bypass it.
3. Live smoke (manual): one query per source returns plausible results.
4. `npm test` + `npx tsc --noEmit` green.

---

## Tier 2 — general web search via MCP (documentation only)

Heirloom already speaks MCP (`src/mcp/`). General web search = user adds a
search MCP server of their choosing in `.heirloom/settings.json`:

```jsonc
{
  "mcpServers": {
    "websearch": { "command": "npx", "args": ["-y", "<search-mcp-server-of-your-choice>"] }
  }
}
```

Document in README/config-spec that community search MCP servers exist (some
scrape DuckDuckGo, some use the user's own API keys — their machine, their
choice). Heirloom ships none and endorses none; MCP tools are already gated
by the existing `mcp__*` permission rules.

---

## Anti-drift rules (hard constraints for any implementing agent)

Scope: these bind **`docs_search` and future search work**. `web_fetch` is
explicitly carved out of rules 1, 3, and 4 — see the scope note at the top.

1. **No new dependencies.** Global `fetch` only.
2. **No hosts beyond the six pinned endpoints.** Adding a host requires
   editing this doc *and* security-spec.md first.
3. **No HTML scraping of any host. No general SERP engines.** DDG/Google/Bing
   in any form is out of scope for tier 1.
4. **No fetching arbitrary URLs or result page bodies.**
5. **No API keys required, requested, or stored.** `GITHUB_TOKEN` is
   opportunistic env-read only.
6. **Do not wire `webSearchTool`** — deprecate it as specified.
7. **Do not add LLM-assisted query preparation/translation.**
8. Guarded-tier permission, headless-deny, and output caps are not
   negotiable; changing them is a security-spec change.
9. If a backend proves unreliable, **remove that source** — do not replace it
   with a scrape or an unofficial endpoint.
