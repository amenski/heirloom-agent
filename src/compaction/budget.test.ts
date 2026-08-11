import { describe, it, expect } from "vitest";
import { estimateTokens, shouldCompact, estimateOverheadTokens } from "./budget.js";
import type { Message } from "../types.js";

describe("estimateTokens", () => {
  it("estimates tokens as char count / 4", () => {
    const messages: Message[] = [
      { role: "user", content: "hello" },
    ];
    expect(estimateTokens(messages)).toBe(2); // 5 chars / 4 = 1.25 -> ceil = 2
  });

  it("returns 0 for empty messages", () => {
    expect(estimateTokens([])).toBe(0);
  });

  it("includes tool call argument lengths", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: null,
        toolCalls: [
          { id: "1", name: "edit", arguments: { path: "/x", oldString: "abc", newString: "def" } },
        ],
      },
    ];

    const tokens = estimateTokens(messages);
    expect(tokens).toBeGreaterThan(0);

    const argsLength = JSON.stringify({ path: "/x", oldString: "abc", newString: "def" }).length;
    const nameLength = "edit".length;
    expect(tokens).toBe(Math.ceil((0 + argsLength + nameLength) / 4));
  });

  it("sums across all messages", () => {
    const messages: Message[] = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
    ];
    expect(estimateTokens(messages)).toBe(Math.ceil(3 / 4));
  });

  it("handles messages with null content", () => {
    const messages: Message[] = [
      { role: "assistant", content: null },
    ];
    expect(estimateTokens(messages)).toBe(0);
  });
});

describe("shouldCompact", () => {
  it("returns false when usage below 70% threshold", () => {
    const messages: Message[] = [
      { role: "user", content: "short" },
    ];
    const contextWindow = 100;
    expect(shouldCompact(messages, contextWindow)).toBe(false);
  });

  it("returns true when usage at or above 70% threshold", () => {
    const longContent = "x".repeat(280); // 280 chars / 4 = 70 tokens
    const messages: Message[] = [
      { role: "user", content: longContent },
    ];
    const contextWindow = 100;
    expect(shouldCompact(messages, contextWindow)).toBe(true);
  });

  it("returns false just below threshold", () => {
    const longContent = "x".repeat(276); // 276 chars / 4 = 69 tokens, below 70
    const messages: Message[] = [
      { role: "user", content: longContent },
    ];
    const contextWindow = 100;
    expect(shouldCompact(messages, contextWindow)).toBe(false);
  });

  it("counts estimateOverheadTokens as part of the fill level", () => {
    const messages: Message[] = [{ role: "user", content: "x".repeat(200) }]; // 50 tok
    const tools = [{ name: "read", parameters: { path: "string" } }];
    const overhead = estimateOverheadTokens(tools, "x".repeat(80)); // +20 tok of prefix
    expect(shouldCompact(messages, 100)).toBe(false);
    expect(shouldCompact(messages, 100, undefined, overhead)).toBe(true);
  });

  it("overhead pushes usage over the threshold when bare messages would not", () => {
    const longContent = "x".repeat(276); // 69 tokens, below 70 on its own
    const messages: Message[] = [
      { role: "user", content: longContent },
    ];
    const contextWindow = 100;
    expect(shouldCompact(messages, contextWindow)).toBe(false);
    expect(shouldCompact(messages, contextWindow, undefined, 5)).toBe(true);
  });
});

describe("estimateOverheadTokens", () => {
  it("counts tool schemas and the volatile prefix at chars/4", () => {
    const tools = [{ name: "read" }];
    const schemaChars = JSON.stringify(tools).length;
    expect(estimateOverheadTokens(tools, "x".repeat(40))).toBe(
      Math.ceil((schemaChars + 40) / 4),
    );
  });

  it("is zero with no tools and no prefix", () => {
    expect(estimateOverheadTokens(undefined, undefined)).toBe(0);
  });

  it("tolerates a missing volatile prefix", () => {
    const tools = [{ name: "read" }];
    expect(estimateOverheadTokens(tools)).toBe(
      Math.ceil(JSON.stringify(tools).length / 4),
    );
  });
});
