import type { ToolOutput, ToolDef } from "../types.js";
import type { ToolHandler, ToolContext } from "./types.js";
import { ToolRegistry } from "./registry.js";

const USER_AGENT = "heirloom (https://github.com/amenski/heirloom-agent)";
const TIMEOUT_MS = 10_000;
const BODY_CAP_BYTES = 512 * 1024;
const OUTPUT_CAP_CHARS = 8_000;
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 8;

type Source = "auto" | "github" | "stackoverflow" | "npm" | "pypi" | "crates" | "wikipedia";

interface DocsResult {
  source: string;
  title: string;
  url: string;
  meta?: string;
  snippet?: string;
}

function clampLimit(raw: unknown): number {
  const n = typeof raw === "number" ? Math.floor(raw) : DEFAULT_LIMIT;
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function truncateSnippet(s: string, max = 200): string {
  const clean = stripHtml(s);
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

async function fetchJson(url: string, ctx: ToolContext, extraHeaders?: Record<string, string>): Promise<unknown> {
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), TIMEOUT_MS);
  try {
    const signal = AbortSignal.any([ctx.signal, timeoutController.signal]);
    const res = await fetch(url, {
      signal,
      redirect: "manual",
      headers: { "User-Agent": USER_AGENT, Accept: "application/json", ...extraHeaders },
    });

    if (res.status === 403 || res.status === 429) {
      throw new RateLimitError();
    }
    if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
      throw new Error(`unexpected redirect (status ${res.status})`);
    }
    if (!res.ok) {
      throw new Error(`request failed (status ${res.status})`);
    }

    const reader = res.body?.getReader();
    if (!reader) return await res.json();

    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > BODY_CAP_BYTES) {
          await reader.cancel();
          throw new Error("response body exceeded size cap");
        }
        chunks.push(value);
      }
    }
    const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
    return JSON.parse(text);
  } finally {
    clearTimeout(timeoutId);
  }
}

class RateLimitError extends Error {
  constructor() {
    super("rate-limited");
  }
}

async function runSource(source: Exclude<Source, "auto">, query: string, limit: number, ctx: ToolContext): Promise<DocsResult[] | { rateLimited: true } | { noSuchPackage: string }> {
  try {
    switch (source) {
      case "github":
        return await searchGithub(query, limit, ctx);
      case "stackoverflow":
        return await searchStackOverflow(query, limit, ctx);
      case "npm":
        return await searchNpm(query, limit, ctx);
      case "pypi":
        return await searchPypi(query, ctx);
      case "crates":
        return await searchCrates(query, limit, ctx);
      case "wikipedia":
        return await searchWikipedia(query, ctx);
    }
  } catch (err) {
    if (err instanceof RateLimitError) return { rateLimited: true };
    if (err instanceof NoSuchPackageError) return { noSuchPackage: query };
    throw err;
  }
}

async function searchGithub(query: string, limit: number, ctx: ToolContext): Promise<DocsResult[]> {
  const headers: Record<string, string> = {};
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const q = encodeURIComponent(query);

  const [repos, issues] = await Promise.all([
    fetchJson(`https://api.github.com/search/repositories?q=${q}&per_page=${limit}`, ctx, headers),
    fetchJson(`https://api.github.com/search/issues?q=${q}&per_page=${limit}`, ctx, headers),
  ]);

  const results: DocsResult[] = [];
  const repoItems = (repos as { items?: unknown[] })?.items ?? [];
  for (const item of repoItems) {
    const r = item as { full_name?: string; html_url?: string; description?: string; stargazers_count?: number };
    results.push({
      source: "github",
      title: r.full_name ?? "(unknown repo)",
      url: r.html_url ?? "",
      meta: typeof r.stargazers_count === "number" ? `★${r.stargazers_count}` : undefined,
      snippet: r.description ?? undefined,
    });
  }
  const issueItems = (issues as { items?: unknown[] })?.items ?? [];
  for (const item of issueItems) {
    const it = item as { title?: string; html_url?: string; state?: string; body?: string };
    results.push({
      source: "github",
      title: it.title ?? "(untitled issue)",
      url: it.html_url ?? "",
      meta: it.state,
      snippet: it.body ?? undefined,
    });
  }
  return results;
}

async function searchStackOverflow(query: string, limit: number, ctx: ToolContext): Promise<DocsResult[]> {
  const q = encodeURIComponent(query);
  const data = await fetchJson(
    `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${q}&site=stackoverflow&pagesize=${limit}`,
    ctx,
  );
  const items = (data as { items?: unknown[] })?.items ?? [];
  return items.map((item): DocsResult => {
    const it = item as { title?: string; link?: string; score?: number; is_answered?: boolean };
    return {
      source: "stackoverflow",
      title: it.title ?? "(untitled question)",
      url: it.link ?? "",
      meta: `score ${it.score ?? 0}${it.is_answered ? ", answered" : ""}`,
    };
  });
}

async function searchNpm(query: string, limit: number, ctx: ToolContext): Promise<DocsResult[]> {
  const q = encodeURIComponent(query);
  const data = await fetchJson(`https://registry.npmjs.org/-/v1/search?text=${q}&size=${limit}`, ctx);
  const objects = (data as { objects?: unknown[] })?.objects ?? [];
  return objects.map((obj): DocsResult => {
    const o = obj as { package?: { name?: string; version?: string; description?: string; links?: { npm?: string } } };
    const pkg = o.package ?? {};
    return {
      source: "npm",
      title: pkg.name ?? "(unknown package)",
      url: pkg.links?.npm ?? (pkg.name ? `https://www.npmjs.com/package/${pkg.name}` : ""),
      meta: pkg.version,
      snippet: pkg.description,
    };
  });
}

class NoSuchPackageError extends Error {
  constructor(pkg: string) {
    super(`no such package "${pkg}"`);
  }
}

async function searchPypi(query: string, ctx: ToolContext): Promise<DocsResult[]> {
  const name = encodeURIComponent(query.trim());
  try {
    const data = await fetchJson(`https://pypi.org/pypi/${name}/json`, ctx);
    const info = (data as { info?: { name?: string; version?: string; summary?: string; package_url?: string } })?.info;
    if (!info) throw new NoSuchPackageError(query);
    return [
      {
        source: "pypi",
        title: info.name ?? query,
        url: info.package_url ?? `https://pypi.org/project/${query}/`,
        meta: info.version,
        snippet: info.summary,
      },
    ];
  } catch (err) {
    if (err instanceof Error && /status 404/.test(err.message)) {
      throw new NoSuchPackageError(query);
    }
    throw err;
  }
}

async function searchCrates(query: string, limit: number, ctx: ToolContext): Promise<DocsResult[]> {
  const q = encodeURIComponent(query);
  const data = await fetchJson(`https://crates.io/api/v1/crates?q=${q}&per_page=${limit}`, ctx);
  const crates = (data as { crates?: unknown[] })?.crates ?? [];
  return crates.map((c): DocsResult => {
    const cr = c as { name?: string; max_version?: string; description?: string };
    return {
      source: "crates",
      title: cr.name ?? "(unknown crate)",
      url: cr.name ? `https://crates.io/crates/${cr.name}` : "",
      meta: cr.max_version,
      snippet: cr.description,
    };
  });
}

async function searchWikipedia(query: string, ctx: ToolContext): Promise<DocsResult[]> {
  const q = encodeURIComponent(query);
  const data = await fetchJson(`https://en.wikipedia.org/w/api.php?action=opensearch&search=${q}&format=json`, ctx);
  const arr = data as [string, string[], string[], string[]];
  const titles = arr?.[1] ?? [];
  const descs = arr?.[2] ?? [];
  const urls = arr?.[3] ?? [];
  return titles.map((title, i): DocsResult => ({
    source: "wikipedia",
    title,
    url: urls[i] ?? "",
    snippet: descs[i],
  }));
}

function formatResults(results: DocsResult[], rateLimitedSources: string[], notices: string[] = []): string {
  const lines: string[] = [];
  for (const r of results) {
    const metaPart = r.meta ? ` (${r.meta})` : "";
    lines.push(`- [${r.source}] ${r.title} — ${r.url}${metaPart}`);
    if (r.snippet) lines.push(`  ${truncateSnippet(r.snippet)}`);
  }
  for (const src of rateLimitedSources) {
    lines.push(`docs_search: ${src} rate-limited, try later or a different source.`);
  }
  for (const notice of notices) {
    lines.push(notice);
  }
  if (lines.length === 0) return "No results found.";

  let out = lines.join("\n");
  if (out.length > OUTPUT_CAP_CHARS) {
    out = `${out.slice(0, OUTPUT_CAP_CHARS)}\n… (truncated)`;
  }
  return out;
}

const docsSearchHandler: ToolHandler = async (args, ctx) => {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) {
    return { content: "", error: "PARSE_ERROR: query is required" };
  }
  const source = (typeof args.source === "string" ? args.source : "auto") as Source;
  const limit = clampLimit(args.limit);

  const sourcesToRun: Exclude<Source, "auto">[] =
    source === "auto" ? ["stackoverflow", "github"] : [source];

  try {
    const outcomes = await Promise.all(
      sourcesToRun.map((src) => runSource(src, query, limit, ctx)),
    );

    const results: DocsResult[] = [];
    const rateLimited: string[] = [];
    const notices: string[] = [];
    for (let i = 0; i < outcomes.length; i++) {
      const outcome = outcomes[i];
      if (outcome && typeof outcome === "object" && "rateLimited" in outcome) {
        rateLimited.push(sourcesToRun[i]);
      } else if (outcome && typeof outcome === "object" && "noSuchPackage" in outcome) {
        notices.push(`docs_search: no such package "${outcome.noSuchPackage}".`);
      } else {
        results.push(...(outcome as DocsResult[]));
      }
    }

    const capped = results.slice(0, limit);
    return { content: formatResults(capped, rateLimited, notices) };
  } catch (err) {
    if (err instanceof RateLimitError) {
      return { content: `docs_search: ${source} rate-limited, try later or a different source.` };
    }
    const message = err instanceof Error ? err.message : String(err);
    if ((err as { name?: string })?.name === "AbortError" || ctx.signal.aborted) {
      return { content: "docs_search: request timed out or was aborted." };
    }
    return { content: `docs_search: request failed — ${message}` };
  }
};

const docsSearchDef: ToolDef = {
  name: "docs_search",
  description:
    "Search developer documentation sources (GitHub, Stack Overflow, package registries, Wikipedia). Not general web search.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      source: {
        type: "string",
        enum: ["auto", "github", "stackoverflow", "npm", "pypi", "crates", "wikipedia"],
        description: "Backend to query (default auto)",
      },
      limit: { type: "number", description: "Max results, 1-8 (default 5)" },
    },
    required: ["query"],
  },
};

export function registerDocsSearch(registry: ToolRegistry): void {
  registry.register({ def: docsSearchDef, handler: docsSearchHandler, groups: ["read"] });
}
