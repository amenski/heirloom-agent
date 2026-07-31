import { describe, it, expect } from "vitest";
import { Compactor } from "./compactor.js";
import type { Message } from "../types.js";
import type { Provider, StreamEvent } from "../providers/types.js";

// Minimal provider stub — the auto-gate tests never reach streamChat, but
// compact() falls through to it when compaction proceeds.
const stubProvider: Provider = {
  name: "stub",
  async *streamChat(): AsyncGenerator<StreamEvent> {
    yield { type: "text_delta", content: "summary" };
    yield { type: "done", finishReason: "stop" };
  },
};

// Enough content to blow past a tiny context window at threshold 0.7.
function bigMessages(): Message[] {
  return Array.from({ length: 6 }, (_, i) => ({
    role: "user" as const,
    content: "x".repeat(200) + ` msg${i}`,
  }));
}

describe("Compactor auto gate (compaction.auto)", () => {
  it("needsCompaction is true past threshold when auto defaults on", () => {
    const c = new Compactor(stubProvider, 100, 0.7);
    expect(c.needsCompaction(bigMessages())).toBe(true);
  });

  it("needsCompaction is true past threshold when auto is explicitly true", () => {
    const c = new Compactor(stubProvider, 100, 0.7, true);
    expect(c.needsCompaction(bigMessages())).toBe(true);
  });

  it("needsCompaction is always false when auto is false", () => {
    const c = new Compactor(stubProvider, 100, 0.7, false);
    expect(c.needsCompaction(bigMessages())).toBe(false);
  });

  it("compact() is a no-op when auto is false (returns messages unchanged)", async () => {
    const c = new Compactor(stubProvider, 100, 0.7, false);
    const msgs = bigMessages();
    const out = await c.compact(msgs);
    expect(out).toBe(msgs);
  });

  it("summarizeForResume bypasses the auto gate", async () => {
    const c = new Compactor(stubProvider, 100, 0.7, false);
    const summary = await c.summarizeForResume(bigMessages());
    expect(summary).toBe("summary");
  });
});
