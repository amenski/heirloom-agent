import { describe, it, expect } from "vitest";
import { ToolRegistry } from "./registry.js";
import type { ToolContext } from "./types.js";
import { registerAttemptCompletion } from "./attempt-completion.js";

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registerAttemptCompletion(registry);
  return registry;
}

function makeCtx(): ToolContext {
  return {
    workingDir: "/tmp",
    sessionId: "test",
    signal: new AbortController().signal,
  };
}

describe("attempt_completion handler", () => {
  it("returns the summary with stop: true", async () => {
    const registry = makeRegistry();
    const out = await registry.execute(
      { id: "t1", name: "attempt_completion", arguments: { summary: "Done: 3 files changed" } },
      makeCtx(),
    );
    expect(out.error).toBeUndefined();
    expect(out.content).toBe("Done: 3 files changed");
    expect(out.stop).toBe(true);
  });

  it("requires the summary argument", async () => {
    const registry = makeRegistry();
    const out = await registry.execute(
      { id: "t1", name: "attempt_completion", arguments: {} },
      makeCtx(),
    );
    expect(out.error).toContain("Missing required argument: summary");
    expect(out.stop).toBeUndefined();
  });
});
