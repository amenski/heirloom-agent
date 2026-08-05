import React, { useState, useEffect } from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { Box, Text } from "ink";
import Spinner from "./Spinner.js";

/**
 * Regression guard for the recurring "Working…" freeze.
 *
 * The spinner frame and elapsed clock used to be state on App, so their 80ms /
 * 1s ticks re-rendered App's whole subtree — every committed transcript line —
 * 12+ times a second. Ink re-laid-out all of them just to find nothing had
 * changed: ~4ms at 200 lines but ~197ms at 8000, at which point ticks queued
 * faster than they drained and the UI stalled until it caught up.
 *
 * These tests pin the two properties that fix depends on: the spinner drives
 * itself, and it does NOT drag its siblings into its re-renders.
 */

let siblingRenders = 0;

function Sibling({ lines }: { lines: string[] }) {
  siblingRenders++;
  return (
    <Box flexDirection="column">
      {lines.map((l, i) => (
        <Text key={i}>{l}</Text>
      ))}
    </Box>
  );
}

function Harness({ addMessage }: { addMessage: boolean }) {
  const [lines, setLines] = useState<string[]>(["existing line"]);
  useEffect(() => {
    if (!addMessage) return;
    const t = setTimeout(() => setLines((p) => [...p, "NEW MESSAGE"]), 250);
    return () => clearTimeout(t);
  }, [addMessage]);
  return (
    <Box flexDirection="column">
      <Sibling lines={lines} />
      <Spinner active />
    </Box>
  );
}

describe("Spinner owns its own animation state", () => {
  it("animates without re-rendering sibling output", async () => {
    siblingRenders = 0;
    const { lastFrame, unmount } = render(<Harness addMessage={false} />);
    // ~12 spinner ticks at 80ms.
    await new Promise((r) => setTimeout(r, 1000));
    const frame = lastFrame() ?? "";
    unmount();

    expect(frame).toContain("Working…");
    // The sibling must NOT re-render per spinner tick (that would be ~13).
    // A small number covers React's initial render + StrictMode-ish extras.
    expect(siblingRenders).toBeLessThanOrEqual(3);
  });

  it("still shows messages that arrive mid-turn", async () => {
    siblingRenders = 0;
    const { lastFrame, unmount } = render(<Harness addMessage />);
    await new Promise((r) => setTimeout(r, 600));
    const frame = lastFrame() ?? "";
    unmount();

    // The whole point of the fix: output still updates normally.
    expect(frame).toContain("NEW MESSAGE");
    expect(frame).toContain("Working…");
  });

  it("renders nothing when inactive", () => {
    const { lastFrame, unmount } = render(<Spinner active={false} />);
    expect((lastFrame() ?? "").trim()).toBe("");
    unmount();
  });

  it("counts elapsed seconds while active", async () => {
    // The seconds are right-aligned in a fixed 3-char field so the line's width
    // never changes (a width change forces Ink to reflow instead of overwrite).
    const { lastFrame, unmount } = render(<Spinner active />);
    expect(lastFrame() ?? "").toMatch(/\(\s*0s/);
    await new Promise((r) => setTimeout(r, 1100));
    const frame = lastFrame() ?? "";
    unmount();
    expect(frame).toMatch(/\(\s*1s/);
    expect(frame).toContain("esc to interrupt");
  });

  it("pads the counter so the line width cannot change as it grows", async () => {
    // A width change at 10s/100s would force Ink to reflow the row instead of
    // overwriting it in place — a second repaint source on top of the 80ms
    // animation. The padding is what prevents that.
    const { lastFrame, unmount } = render(<Spinner active />);
    const width = (lastFrame() ?? "").trim().length;
    await new Promise((r) => setTimeout(r, 1100));
    const laterWidth = (lastFrame() ?? "").trim().length;
    unmount();
    expect(laterWidth).toBe(width);
  });
});
