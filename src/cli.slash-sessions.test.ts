import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleSlashCore } from "./cli.js";

// handleSlashCore is exported from cli.tsx specifically so its cases are
// unit-testable (see cli.model-command.test.ts); importing cli.tsx does NOT
// run the real CLI startup under vitest.

function makeShared(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    providerName: "deepseek",
    activeModel: "deepseek-v4-pro",
    sessionInput: 0,
    sessionOutput: 0,
    ...overrides,
  };
}

describe("/sessions headless (handleSlashCore)", () => {
  let logs: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;
  let sessionStore: { list: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    logs = [];
    logSpy = vi.spyOn(console, "log").mockImplementation((...args) => logs.push(args.map(String).join(" ")));
  });
  afterEach(() => logSpy.mockRestore());

  function call(input: string) {
    return handleSlashCore(
      input, vi.fn(() => ({}) as any),
      {}, {} as any, {} as any, sessionStore as any,
      "sess-1", {} as any, {} as any, undefined,
      () => ({}) as any, {} as any, [], {} as any,
      makeShared(), () => undefined,
      () => null, false, undefined,
      vi.fn(),
    );
  }

  it("lists the cwd's sessions with id, excerpt, age, and count, and resolves (exit 0)", async () => {
    const now = Date.now();
    sessionStore = {
      list: vi.fn().mockResolvedValue([
        { id: "20260813-abcd-1234", title: "Fix the build", firstMessage: "Fix the build", messageCount: 12, createdAt: new Date(now - 60000).toISOString(), updatedAt: new Date(now - 60000).toISOString(), status: "completed" },
        { id: "20260812-efgh-5678", title: "", firstMessage: "Old session", messageCount: 3, createdAt: new Date(now - 90000000).toISOString(), updatedAt: new Date(now - 90000000).toISOString(), status: "interrupted" },
      ]),
    };

    await expect(call("/sessions")).resolves.toBeUndefined();
    expect(logs).toHaveLength(2);
    expect(logs[0]).toContain("20260813-abcd-1234");
    expect(logs[0]).toContain("Fix the build");
    expect(logs[0]).toContain("1m ago");
    expect(logs[0]).toContain("12 msgs");
    // No custom title: the excerpt falls back to the first message.
    expect(logs[1]).toContain("20260812-efgh-5678");
    expect(logs[1]).toContain("Old session");
    expect(logs[1]).toContain("3 msgs");
  });

  it("prints a notice when the project has no sessions", async () => {
    sessionStore = { list: vi.fn().mockResolvedValue([]) };
    await call("/sessions");
    expect(logs).toEqual(["No sessions for this project."]);
  });
});
