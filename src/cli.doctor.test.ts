import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { probeSearXngHealth, runDoctor } from "./cli.js";
import { loadConfig } from "./config/loader.js";

// runDoctor calls loadConfig() itself (three times); mock it so the test
// controls whether webSearch.searxngUrl is configured. Importing cli.tsx does
// not run the real CLI startup under vitest (see cli.usage.test.ts). The real
// module is spread in (credentials.ts imports resolveHome from it).
vi.mock("./config/loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config/loader.js")>();
  return { ...actual, loadConfig: vi.fn() };
});

const mockLoadConfig = vi.mocked(loadConfig);

function mockConfig(searxngUrl?: string): void {
  mockLoadConfig.mockReturnValue({
    config: { model: "test-model", webSearch: searxngUrl ? { searxngUrl } : {} },
    errors: [],
    warnings: [],
  } as any);
}

describe("probeSearXngHealth (doctor SearXNG healthz probe, F2)", () => {
  it("GETs {url}/healthz and reports ok with the latency", async () => {
    const fetchStub = vi.fn(async (url: string) => {
      expect(url).toBe("http://127.0.0.1:8888/healthz");
      return { ok: true, status: 200 };
    });
    const health = await probeSearXngHealth("http://127.0.0.1:8888", fetchStub as any);
    expect(health.ok).toBe(true);
    expect(health.ms).toBeGreaterThanOrEqual(0);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("normalizes a trailing slash on the base URL", async () => {
    const fetchStub = vi.fn(async (_url: string) => ({ ok: true }));
    const health = await probeSearXngHealth("http://localhost:8888/", fetchStub as any);
    expect(health.ok).toBe(true);
    expect(fetchStub.mock.calls[0][0]).toBe("http://localhost:8888/healthz");
  });

  it("treats a non-2xx healthz (e.g. 500) as unreachable", async () => {
    const fetchStub = vi.fn(async () => ({ ok: false, status: 500 }));
    const health = await probeSearXngHealth("http://x", fetchStub as any);
    expect(health.ok).toBe(false);
  });

  it("treats a network error as unreachable", async () => {
    const fetchStub = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    });
    const health = await probeSearXngHealth("http://x", fetchStub as any);
    expect(health.ok).toBe(false);
  });

  it("times out an unresponsive healthz and never retries (default 3 s, injectable)", async () => {
    const fetchStub = vi.fn(
      (_url: string, opts: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          opts.signal.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const health = await probeSearXngHealth("http://x", fetchStub as any, 25);
    expect(health.ok).toBe(false);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });
});

describe("runDoctor SearXNG line", () => {
  let logs: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logs = [];
    logSpy = vi.spyOn(console, "log").mockImplementation((...args) =>
      logs.push(args.map(String).join(" ")),
    );
  });
  afterEach(() => {
    logSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("prints 'ok (N ms)' when /healthz responds", async () => {
    mockConfig("http://127.0.0.1:8888");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true })));
    await runDoctor();
    expect(logs.some((l) => /^  SearXNG\s+ok \(\d+ ms\)$/.test(l))).toBe(true);
  });

  it("prints the Bing-fallback notice when /healthz is unreachable", async () => {
    mockConfig("http://127.0.0.1:8888");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connect ECONNREFUSED");
      }),
    );
    await runDoctor();
    expect(
      logs.some((l) => l === "  SearXNG           unreachable — searches will fall back to Bing."),
    ).toBe(true);
  });

  it("omits the SearXNG line entirely when no searxngUrl is configured", async () => {
    mockConfig();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true })));
    await runDoctor();
    expect(logs.some((l) => l.startsWith("  SearXNG"))).toBe(false);
  });
});
