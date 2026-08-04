import { describe, it, expect } from "vitest";
import { fuzzyScore } from "./fuzzy.js";

describe("fuzzyScore", () => {
  it("matches a plain substring", () => {
    expect(fuzzyScore("deepseek-v4-pro", "pro")).not.toBeNull();
  });

  it("matches non-adjacent characters in order", () => {
    expect(fuzzyScore("deepseek-v4-pro", "dsp")).not.toBeNull();
  });

  it("rejects characters that appear out of order", () => {
    expect(fuzzyScore("deepseek-v4-pro", "pd")).toBeNull();
  });

  it("rejects characters that are absent", () => {
    expect(fuzzyScore("deepseek-v4-pro", "xyz")).toBeNull();
  });

  it("ranks a substring hit ahead of a scattered subsequence", () => {
    // Substring hits score below 1000; scattered subsequences are offset above
    // it, so a direct match always sorts first.
    expect(fuzzyScore("gpt-5.6-sol", "sol")!).toBeLessThan(1000);
    expect(fuzzyScore("deepseek-v4-pro", "dsp")!).toBeGreaterThanOrEqual(1000);
  });

  it("treats an empty query as matching everything", () => {
    expect(fuzzyScore("anything", "")).toBe(0);
  });

  it("is case insensitive", () => {
    expect(fuzzyScore("DeepSeek-V4-Pro", "pro")).not.toBeNull();
  });
});
