import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ToolRegistry } from "./registry.js";
import type { ToolContext } from "./types.js";
import { registerDocsSearch } from "./docs-search.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeCtx(): ToolContext {
  return {
    workingDir: "/tmp",
    sessionId: "test",
    signal: new AbortController().signal,
  };
}

describe("docs_search", () => {
  let registry: ToolRegistry;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    registry = new ToolRegistry();
    registerDocsSearch(registry);
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("registers with the read group", () => {
    const defs = registry.getByMode(["read"]);
    expect(defs.map((d) => d.name)).toContain("docs_search");
  });

  it("requires a query", async () => {
    const result = await registry.execute({ id: "1", name: "docs_search", arguments: {} }, makeCtx());
    expect(result.error).toContain("PARSE_ERROR");
  });

  it("formats stackoverflow results", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes("stackexchange.com")) {
        return Promise.resolve(
          jsonResponse({
            items: [{ title: "How to fix X", link: "https://stackoverflow.com/q/123", score: 42, is_answered: true }],
          }),
        );
      }
      return Promise.resolve(jsonResponse({ items: [] }));
    });

    const result = await registry.execute(
      { id: "1", name: "docs_search", arguments: { query: "fix X", source: "stackoverflow" } },
      makeCtx(),
    );
    expect(result.error).toBeUndefined();
    expect(result.content).toContain("[stackoverflow] How to fix X");
    expect(result.content).toContain("https://stackoverflow.com/q/123");
    expect(result.content).toContain("score 42");
  });

  it("respects the limit parameter", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          items: Array.from({ length: 8 }, (_, i) => ({ title: `Q${i}`, link: `https://x/${i}`, score: i })),
        }),
      ),
    );

    const result = await registry.execute(
      { id: "1", name: "docs_search", arguments: { query: "x", source: "stackoverflow", limit: 2 } },
      makeCtx(),
    );
    const lines = result.content.split("\n").filter((l) => l.startsWith("- ["));
    expect(lines).toHaveLength(2);
  });

  it("handles 429 rate limiting without throwing", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response("", { status: 429 })));

    const result = await registry.execute(
      { id: "1", name: "docs_search", arguments: { query: "x", source: "npm" } },
      makeCtx(),
    );
    expect(result.error).toBeUndefined();
    expect(result.content).toContain("rate-limited");
  });

  it("handles 403 the same as 429", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response("", { status: 403 })));

    const result = await registry.execute(
      { id: "1", name: "docs_search", arguments: { query: "x", source: "crates" } },
      makeCtx(),
    );
    expect(result.content).toContain("rate-limited");
  });

  it("handles network failure gracefully", async () => {
    fetchMock.mockImplementation(() => Promise.reject(new Error("network down")));

    const result = await registry.execute(
      { id: "1", name: "docs_search", arguments: { query: "x", source: "wikipedia" } },
      makeCtx(),
    );
    expect(result.error).toBeUndefined();
    expect(result.content).toContain("docs_search:");
  });

  it("treats pypi 404 as 'no such package', not an error", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response("Not Found", { status: 404 })));

    const result = await registry.execute(
      { id: "1", name: "docs_search", arguments: { query: "nonexistent-pkg-xyz", source: "pypi" } },
      makeCtx(),
    );
    expect(result.error).toBeUndefined();
    expect(result.content).toContain("no such package");
    expect(result.content).toContain("nonexistent-pkg-xyz");
  });

  it("formats pypi exact match", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          info: { name: "requests", version: "2.31.0", summary: "HTTP for Humans", package_url: "https://pypi.org/project/requests/" },
        }),
      ),
    );

    const result = await registry.execute(
      { id: "1", name: "docs_search", arguments: { query: "requests", source: "pypi" } },
      makeCtx(),
    );
    expect(result.content).toContain("[pypi] requests");
    expect(result.content).toContain("2.31.0");
  });

  it("fans out to stackoverflow + github on auto", async () => {
    const urlsHit: string[] = [];
    fetchMock.mockImplementation((url: string) => {
      urlsHit.push(url);
      return Promise.resolve(jsonResponse({ items: [] }));
    });

    await registry.execute({ id: "1", name: "docs_search", arguments: { query: "x" } }, makeCtx());

    expect(urlsHit.some((u) => u.includes("stackexchange.com"))).toBe(true);
    expect(urlsHit.some((u) => u.includes("api.github.com/search/repositories"))).toBe(true);
    expect(urlsHit.some((u) => u.includes("api.github.com/search/issues"))).toBe(true);
    expect(urlsHit.some((u) => u.includes("npmjs.org") || u.includes("crates.io") || u.includes("pypi.org"))).toBe(false);
  });

  it("only ever fetches allowlisted hosts across all sources", async () => {
    const ALLOWED = new Set([
      "api.github.com",
      "api.stackexchange.com",
      "registry.npmjs.org",
      "pypi.org",
      "crates.io",
      "en.wikipedia.org",
    ]);
    const hostsHit = new Set<string>();
    fetchMock.mockImplementation((url: string) => {
      hostsHit.add(new URL(url).host);
      return Promise.resolve(jsonResponse({ items: [], objects: [], crates: [], info: { name: "x" } }));
    });

    for (const source of ["auto", "github", "stackoverflow", "npm", "pypi", "crates", "wikipedia"]) {
      await registry.execute(
        { id: "1", name: "docs_search", arguments: { query: "x", source } },
        makeCtx(),
      );
    }

    expect(hostsHit.size).toBeGreaterThan(0);
    for (const host of hostsHit) {
      expect(ALLOWED.has(host)).toBe(true);
    }
  });

  it("caps total output at 8000 chars with a truncation marker", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          items: Array.from({ length: 8 }, (_, i) => ({
            title: `Question ${i}`,
            link: `https://stackoverflow.com/q/${i}`,
            score: i,
            body: "x".repeat(2000),
          })),
        }),
      ),
    );

    const result = await registry.execute(
      { id: "1", name: "docs_search", arguments: { query: "x", source: "stackoverflow", limit: 8 } },
      makeCtx(),
    );
    expect(result.content.length).toBeLessThanOrEqual(8000 + "\n… (truncated)".length);
  });

  it("aborts when the context signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.signal?.aborted) {
        return Promise.reject(new DOMException("aborted", "AbortError"));
      }
      return Promise.resolve(jsonResponse({ items: [] }));
    });

    const ctx = makeCtx();
    ctx.signal = controller.signal;
    const result = await registry.execute(
      { id: "1", name: "docs_search", arguments: { query: "x", source: "npm" } },
      ctx,
    );
    expect(result.content).toMatch(/docs_search:/);
  });

  it("does not require a GITHUB_TOKEN and does not send one when unset", async () => {
    const originalToken = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    let sawAuthHeader = false;
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      if (headers?.Authorization) sawAuthHeader = true;
      return Promise.resolve(jsonResponse({ items: [] }));
    });

    await registry.execute({ id: "1", name: "docs_search", arguments: { query: "x", source: "github" } }, makeCtx());
    expect(sawAuthHeader).toBe(false);
    if (originalToken) process.env.GITHUB_TOKEN = originalToken;
  });

  it("sends the fixed User-Agent header", async () => {
    let sentUA: string | undefined;
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      sentUA = headers?.["User-Agent"];
      return Promise.resolve(jsonResponse({ items: [] }));
    });

    await registry.execute({ id: "1", name: "docs_search", arguments: { query: "x", source: "npm" } }, makeCtx());
    expect(sentUA).toContain("heirloom");
  });

  it("uses redirect: manual", async () => {
    let sentRedirect: string | undefined;
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      sentRedirect = init?.redirect;
      return Promise.resolve(jsonResponse({ items: [] }));
    });

    await registry.execute({ id: "1", name: "docs_search", arguments: { query: "x", source: "npm" } }, makeCtx());
    expect(sentRedirect).toBe("manual");
  });
});
