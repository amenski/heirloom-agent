import { describe, it, expect } from "vitest";
import { summarizeReasoning, MAX_REASONING_ECHO } from "./reasoning-echo.js";

describe("summarizeReasoning", () => {
  it("returns null for an empty or whitespace-only buffer", () => {
    expect(summarizeReasoning("")).toBeNull();
    expect(summarizeReasoning("   \n\t ")).toBeNull();
  });

  it("passes a short buffer through unchanged", () => {
    expect(summarizeReasoning("Checking the config loader.")).toBe(
      "Checking the config loader.",
    );
  });

  it("flattens newlines so the echo cannot occupy more than one row", () => {
    // The whole point: a multi-row flush shifts every row below it at once,
    // which the incremental renderer cannot skip.
    const out = summarizeReasoning("first thought\nsecond thought\n\nthird");
    expect(out).toBe("first thought second thought third");
    expect(out).not.toContain("\n");
  });

  it("collapses runs of whitespace", () => {
    expect(summarizeReasoning("a     b\t\tc")).toBe("a b c");
  });

  it("never exceeds the maximum width", () => {
    const long = "thinking about the problem ".repeat(60);
    const out = summarizeReasoning(long)!;
    expect(out.length).toBeLessThanOrEqual(MAX_REASONING_ECHO);
  });

  it("marks a clipped echo with an ellipsis", () => {
    const out = summarizeReasoning("word ".repeat(100))!;
    expect(out.endsWith("…")).toBe(true);
  });

  it("clips at a word boundary when one is near the limit", () => {
    const out = summarizeReasoning("alpha bravo charlie delta echo foxtrot", 20)!;
    expect(out).toBe("alpha bravo charlie…");
    expect(out.length).toBeLessThanOrEqual(20);
  });

  it("clips mid-token rather than losing most of the line", () => {
    // A single very long token has no usable boundary; better to show a prefix
    // than to collapse to almost nothing.
    const out = summarizeReasoning("x".repeat(200), 20)!;
    expect(out).toHaveLength(20);
    expect(out.endsWith("…")).toBe(true);
  });

  it("honours a custom width", () => {
    expect(summarizeReasoning("a".repeat(50), 10)!).toHaveLength(10);
  });
});

describe("single-row guarantee", () => {
  it("keeps the echo to one row at realistic terminal widths", () => {
    // The requirement is not "short" but "one row": a multi-row flush shifts
    // every row below it in a single commit, which the incremental renderer
    // cannot skip. Measured before this fix: a ~1600-char buffer added 6 rows.
    const long = "thinking about the problem carefully ".repeat(45);
    const echo = `✱ ${summarizeReasoning(long)}`;
    for (const width of [80, 100, 120]) {
      expect(echo.length, `must fit one row at ${width} cols`).toBeLessThanOrEqual(width);
    }
  });

  it("stays one row even for a pathological single-token buffer", () => {
    const echo = `✱ ${summarizeReasoning("x".repeat(5000))}`;
    expect(echo.length).toBeLessThanOrEqual(80);
  });
});
