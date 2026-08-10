import type { ToolOutput, ToolDef } from "../types.js";
import type { ToolHandler, ToolContext } from "./types.js";
import { ToolRegistry } from "./registry.js";
import { pkg } from "../version.js";

const USER_AGENT = `heirloom-agent/${pkg.version} (+cli)`;
const TIMEOUT_MS = 10_000;
const BODY_CAP_BYTES = 512 * 1024;
const OUTPUT_CAP_CHARS = 8_000;
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 8;

interface WebResult {
  title: string;
  url: string;
  snippet?: string;
}

function clampLimit(raw: unknown): number {
  const n = typeof raw === "number" ? Math.floor(raw) : DEFAULT_LIMIT;
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

/** Decodes the XML/HTML entities Bing uses in RSS titles and descriptions. `&amp;` is decoded last so double-encoded entities stay readable. */
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function truncateSnippet(s: string, max = 200): string {
  const clean = stripHtml(s);
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function unwrapCdata(s: string): string {
  const m = s.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  return m ? m[1] : s;
}

/** Parses Bing's `format=rss` search feed into flat results, dropping items without a usable title or link. */
export function parseBingRss(xml: string): WebResult[] {
  const results: WebResult[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match: RegExpExecArray | null;
  while ((match = itemRegex.exec(xml)) !== null) {
    const item = match[1];
    const titleRaw = item.match(/<title>(.*?)<\/title>/)?.[1] ?? "";
    const linkRaw = item.match(/<link>(.*?)<\/link>/)?.[1] ?? "";
    const descRaw = item.match(/<description>(.*?)<\/description>/)?.[1] ?? "";

    const title = decodeEntities(unwrapCdata(titleRaw)).trim();
    const url = decodeEntities(unwrapCdata(linkRaw)).trim();
    if (!title || !url) continue;

    const snippet = stripHtml(decodeEntities(unwrapCdata(descRaw)));
    results.push({ title, url, snippet: snippet || undefined });
  }
  return results;
}

async function fetchRss(query: string, ctx: ToolContext): Promise<string> {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&format=rss`;
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), TIMEOUT_MS);
  try {
    const signal = AbortSignal.any([ctx.signal, timeoutController.signal]);
    const res = await fetch(url, {
      signal,
      redirect: "manual",
      headers: { "User-Agent": USER_AGENT, Accept: "application/rss+xml, application/xml, text/xml, */*" },
    });

    if (res.status === 403 || res.status === 429) {
      throw new RateLimitedError();
    }
    if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
      throw new Error(`unexpected redirect (status ${res.status})`);
    }
    if (!res.ok) {
      throw new Error(`request failed (status ${res.status})`);
    }

    const reader = res.body?.getReader();
    if (!reader) return await res.text();

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
    return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
  } finally {
    clearTimeout(timeoutId);
  }
}

class RateLimitedError extends Error {
  constructor() {
    super("rate-limited");
  }
}

function formatResults(results: WebResult[], rateLimited: boolean): string {
  const lines: string[] = [];
  for (const r of results) {
    lines.push(`- [web] ${r.title} — ${r.url}`);
    if (r.snippet) lines.push(`  ${truncateSnippet(r.snippet)}`);
  }
  if (rateLimited) {
    lines.push("web_search: Bing rate-limited the request, try again shortly.");
  }
  if (lines.length === 0) return "No results found.";

  let out = lines.join("\n");
  if (out.length > OUTPUT_CAP_CHARS) {
    out = `${out.slice(0, OUTPUT_CAP_CHARS)}\n… (truncated)`;
  }
  return out;
}

const webSearchHandler: ToolHandler = async (args, ctx) => {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) {
    return { content: "", error: "PARSE_ERROR: query is required" };
  }
  const limit = clampLimit(args.limit);

  try {
    const xml = await fetchRss(query, ctx);
    const results = parseBingRss(xml).slice(0, limit);
    return { content: formatResults(results, false) };
  } catch (err) {
    if (err instanceof RateLimitedError) {
      return { content: formatResults([], true) };
    }
    if ((err as { name?: string })?.name === "AbortError" || ctx.signal.aborted) {
      return { content: "web_search: request timed out or was aborted." };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { content: `web_search: request failed — ${message}` };
  }
};

const webSearchDef: ToolDef = {
  name: "web_search",
  description:
    "Search the general web (Bing-backed, no API key) for pages, articles, news, and current information on any topic. Returns titles, URLs, and snippets; use web_fetch to read a result in full.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      limit: { type: "number", description: "Max results, 1-8 (default 5)" },
    },
    required: ["query"],
  },
};

export function registerWebSearch(registry: ToolRegistry): void {
  registry.register({ def: webSearchDef, handler: webSearchHandler, groups: ["read"] });
}
