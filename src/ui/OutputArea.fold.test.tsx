import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import OutputArea, { foldOldLines } from "./OutputArea.js";
import { USER_ECHO_TAG } from "./constants.js";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

function frameOf(lines: string[], liveLineBudget: number): string {
  const { lastFrame } = render(
    <OutputArea lines={lines} activeLine="" busy={false} liveLineBudget={liveLineBudget} />,
  );
  return strip(lastFrame() ?? "");
}

/**
 * Ink re-lays-out every live element per frame, so the element count must not
 * grow without bound. The transcript lives ONLY in this array (there is no
 * <Static> flush), so the cap folds old lines into one element and must never
 * drop them — that is the property these tests pin.
 */
describe("foldOldLines", () => {
  const entries = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ text: `line ${i}`, key: i }));

  it("returns the input untouched when under budget", () => {
    const input = entries(5);
    expect(foldOldLines(input, 10)).toEqual(input);
  });

  it("is a no-op when the budget is disabled", () => {
    const input = entries(50);
    expect(foldOldLines(input, 0)).toEqual(input);
  });

  it("caps the element count at budget + 1", () => {
    expect(foldOldLines(entries(500), 100)).toHaveLength(101);
  });

  it("keeps every line's text after folding", () => {
    const folded = foldOldLines(entries(500), 100);
    const all = folded.map((f) => f.text).join("\n").split("\n");
    expect(all).toHaveLength(500);
    expect(all[0]).toBe("line 0");
    expect(all[499]).toBe("line 499");
  });

  it("marks only the folded entry", () => {
    const folded = foldOldLines(entries(50), 10);
    expect(folded[0].folded).toBe(true);
    expect(folded.slice(1).every((f) => f.folded !== true)).toBe(true);
  });

  it("keeps the most recent lines individually rendered", () => {
    const folded = foldOldLines(entries(50), 10);
    expect(folded.slice(1).map((f) => f.text)).toEqual(
      Array.from({ length: 10 }, (_, i) => `line ${40 + i}`),
    );
  });

  it("gives the folded entry a stable key", () => {
    expect(foldOldLines(entries(50), 10)[0].key).toBe(0);
  });
});

describe("OutputArea live-line budget", () => {
  it("still shows the oldest output after folding", () => {
    // The regression guarded against: a naive cap (maxLines) drops these
    // entirely, and nothing else holds a copy.
    const lines = Array.from({ length: 200 }, (_, i) => `msg ${i}`);
    const frame = frameOf(lines, 20);
    expect(frame).toContain("msg 0");
    expect(frame).toContain("msg 199");
  });

  it("does not summarize away the middle of the folded block", () => {
    // needsSummary() truncates >20-line blocks; the folded entry must bypass it.
    const lines = Array.from({ length: 200 }, (_, i) => `msg ${i}`);
    const frame = frameOf(lines, 20);
    expect(frame).toContain("msg 100");
    expect(frame).not.toContain("more chars");
  });

  it("leaves output untouched when under budget", () => {
    const frame = frameOf(["alpha", "beta", "gamma"], 400);
    expect(frame).toContain("alpha");
    expect(frame).toContain("gamma");
  });

  it("keeps a recent user echo rendered with its gutter", () => {
    const lines = [
      ...Array.from({ length: 60 }, (_, i) => `old ${i}`),
      USER_ECHO_TAG + "my question",
    ];
    const frame = frameOf(lines, 10);
    expect(frame).toContain("▌ my question");
  });

  it("preserves a folded user echo's text", () => {
    const lines = [
      USER_ECHO_TAG + "asked long ago",
      ...Array.from({ length: 60 }, (_, i) => `later ${i}`),
    ];
    const frame = frameOf(lines, 10);
    expect(frame).toContain("asked long ago");
  });
});
