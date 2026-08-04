import { describe, it, expect, vi, beforeEach } from "vitest";

// handleSlashCore is exported from cli.tsx specifically so its /model case
// (persist + validate + roll back) is unit-testable. Importing cli.tsx does
// NOT run the real CLI startup: main() is guarded to only auto-run when this
// module is the process entrypoint, which is false under vitest.
import { handleSlashCore } from "./cli.js";

function makeShared(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    providerName: "deepseek",
    activeModel: "deepseek-v4-pro",
    sessionInput: 0,
    sessionOutput: 0,
    ...overrides,
  };
}

describe("/model command (C2: persist + validate + roll back)", () => {
  let sessionStore: { appendState: ReturnType<typeof vi.fn> };
  let resetCompactor: ReturnType<typeof vi.fn<() => void>>;
  let getCompactor: () => any;

  beforeEach(() => {
    sessionStore = { appendState: vi.fn().mockResolvedValue(undefined) };
    resetCompactor = vi.fn<() => void>();
    getCompactor = () => ({}) as any;
  });

  it("on a successful switch, persists provider/model via appendState and resets the compactor", async () => {
    const shared = makeShared();
    const getProvider = vi.fn(() => ({}) as any);

    await handleSlashCore(
      "/model openai/gpt-5.6-sol", getProvider,
      {}, {} as any, {} as any, sessionStore as any,
      "sess-1", {} as any, {} as any, undefined,
      getCompactor, {} as any, [], {} as any,
      shared, () => undefined,
      () => null, false, undefined,
      resetCompactor,
    );

    expect(shared.providerName).toBe("openai");
    expect(shared.activeModel).toBe("gpt-5.6-sol");
    expect(sessionStore.appendState).toHaveBeenCalledWith("sess-1", { provider: "openai", model: "gpt-5.6-sol" });
    expect(resetCompactor).toHaveBeenCalledTimes(1);
  });

  it("on a failing switch, rolls back shared.providerName/activeModel and does not persist", async () => {
    const shared = makeShared({ providerName: "deepseek", activeModel: "deepseek-v4-pro" });
    const getProvider = vi.fn(() => {
      throw new Error('Provider "nope" requires NOPE_API_KEY to be set');
    });

    await handleSlashCore(
      "/model nope/some-model", getProvider,
      {}, {} as any, {} as any, sessionStore as any,
      "sess-1", {} as any, {} as any, undefined,
      getCompactor, {} as any, [], {} as any,
      shared, () => undefined,
      () => null, false, undefined,
      resetCompactor,
    );

    expect(shared.providerName).toBe("deepseek");
    expect(shared.activeModel).toBe("deepseek-v4-pro");
    expect(sessionStore.appendState).not.toHaveBeenCalled();
    expect(resetCompactor).not.toHaveBeenCalled();
  });
});
