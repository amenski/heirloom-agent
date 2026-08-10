import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ToolRegistry } from "./registry.js";
import type { ToolContext } from "./types.js";
import { registerWebSearch, parseBingRss } from "./web-search.js";

function rssResponse(xml: string, status = 200): Response {
  return new Response(xml, {
    status,
    headers: { "Content-Type": "application/rss+xml" },
  });
}

function sampleRss(): string {
  return `<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel><title>Bing: test</title><item><title>Claude Code</title><link>https://docs.claude.com/</link><description>Official docs for <b>Claude Code</b> &amp; hooks.</description></item><item><title></title><link>https://example.com/untitled</link><description>No title, skip me</description></item><item><title>No link</title><link></link><description>Skip me too</description></item><item><title>Guide &amp; Tutorial</title><link>https://example.com/guide</link><description>Learn how to use hooks in Claude Code.</description></item></channel></rss>`;
}

function makeCtx(): ToolContext {
  return {
    workingDir: "/tmp",
    sessionId: "test",
    signal: new AbortController().signal,
  };
}

describe("parseBingRss", () => {
  it("extracts titles, links, and stripped snippets", () => {
    const results = parseBingRss(sampleRss());
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      title: "Claude Code",
      url: "https://docs.claude.com/",
      snippet: "Official docs for Claude Code & hooks.",
    });
  });

  it("drops items without a title or link", () => {
    const results = parseBingRss(sampleRss());
    expect(results.some((r) => r.title === "No link")).toBe(false);
    expect(results.some((r) => r.url === "https://example.com/untitled")).toBe(false);
  });

  it("decodes entities and strips tags", () => {
    const xml = `<rss><channel><item><title>a &amp; b &lt;tag&gt;</title><link>https://x.com/</link><description><p>Hello <em>world</em></p></description></item></channel></rss>`;
    const results = parseBingRss(xml);
    expect(results[0].title).toBe("a & b <tag>");
    expect(results[0].snippet).toBe("Hello world");
  });

  it("returns an empty array for non-RSS input", () => {
    expect(parseBingRss("<html>not rss</html>")).toEqual([]);
  });
});

describe("web_search", () => {
  let registry: ToolRegistry;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    registry = new ToolRegistry();
    registerWebSearch(registry);
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("registers with the read group", () => {
    const defs = registry.getByMode(["read"]);
    expect(defs.map((d) => d.name)).toContain("web_search");
  });

  it("requires a query", async () => {
    const result = await registry.execute({ id: "1", name: "web_search", arguments: {} }, makeCtx());
    expect(result.error).toContain("PARSE_ERROR");
  });

  it("formats results from the Bing RSS feed", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(rssResponse(sampleRss())));

    const result = await registry.execute(
      { id: "1", name: "web_search", arguments: { query: "claude code" } },
      makeCtx(),
    );
    expect(result.error).toBeUndefined();
    expect(result.content).toContain("[web] Claude Code");
    expect(result.content).toContain("https://docs.claude.com/");
    expect(result.content).toContain("Official docs for Claude Code & hooks.");
  });

  it("respects the limit parameter", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(rssResponse(sampleRss())));

    const result = await registry.execute(
      { id: "1", name: "web_search", arguments: { query: "x", limit: 1 } },
      makeCtx(),
    );
    const lines = result.content.split("\n").filter((l) => l.startsWith("- [web]"));
    expect(lines).toHaveLength(1);
  });

  it("handles 429 rate limiting without throwing", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response("", { status: 429 })));

    const result = await registry.execute(
      { id: "1", name: "web_search", arguments: { query: "x" } },
      makeCtx(),
    );
    expect(result.error).toBeUndefined();
    expect(result.content).toContain("rate-limited");
  });

  it("handles 403 the same as 429", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response("", { status: 403 })));

    const result = await registry.execute(
      { id: "1", name: "web_search", arguments: { query: "x" } },
      makeCtx(),
    );
    expect(result.content).toContain("rate-limited");
  });

  it("handles network failure gracefully", async () => {
    fetchMock.mockImplementation(() => Promise.reject(new Error("network down")));

    const result = await registry.execute(
      { id: "1", name: "web_search", arguments: { query: "x" } },
      makeCtx(),
    );
    expect(result.error).toBeUndefined();
    expect(result.content).toContain("web_search:");
  });

  it("aborts when the context signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.signal?.aborted) {
        return Promise.reject(new DOMException("aborted", "AbortError"));
      }
      return Promise.resolve(rssResponse(sampleRss()));
    });

    const ctx = makeCtx();
    ctx.signal = controller.signal;
    const result = await registry.execute({ id: "1", name: "web_search", arguments: { query: "x" } }, ctx);
    expect(result.content).toMatch(/web_search:/);
  });

  it("only ever fetches www.bing.com", async () => {
    const hostsHit = new Set<string>();
    fetchMock.mockImplementation((url: string) => {
      hostsHit.add(new URL(url).host);
      return Promise.resolve(rssResponse(sampleRss()));
    });

    await registry.execute({ id: "1", name: "web_search", arguments: { query: "x" } }, makeCtx());
    expect([...hostsHit]).toEqual(["www.bing.com"]);
  });

  it("sends the fixed User-Agent and redirect: manual", async () => {
    let sentUA: string | undefined;
    let sentRedirect: string | undefined;
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      sentUA = headers?.["User-Agent"];
      sentRedirect = init?.redirect;
      return Promise.resolve(rssResponse(sampleRss()));
    });

    await registry.execute({ id: "1", name: "web_search", arguments: { query: "x" } }, makeCtx());
    expect(sentUA).toContain("heirloom");
    expect(sentRedirect).toBe("manual");
  });

  it("caps total output at 8000 chars with a truncation marker", async () => {
    const bigItem = `<item><title>T</title><link>https://x.com/</link><description>${"y".repeat(3000)}</description></item>`;
    const xml = `<rss><channel>${bigItem.repeat(8)}</channel></rss>`;
    fetchMock.mockImplementation(() => Promise.resolve(rssResponse(xml)));

    const result = await registry.execute(
      { id: "1", name: "web_search", arguments: { query: "x", limit: 8 } },
      makeCtx(),
    );
    expect(result.content.length).toBeLessThanOrEqual(8000 + "\n… (truncated)".length);
  });
});
