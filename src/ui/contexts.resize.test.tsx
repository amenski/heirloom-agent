import React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { TerminalProvider, useTerminalInfo, RESIZE_SETTLE_MS } from "./contexts.js";

/**
 * Regression coverage for the resize-repaint bug: dragging a window edge emits
 * a SIGWINCH burst, and the old handler re-rendered on every event (allocating
 * a fresh object each time, so even a no-op resize re-rendered). Each mid-drag
 * repaint was erased using the row count from the previous width, stranding a
 * copy of the input frame on screen.
 */

let renderCount = 0;
let seenWidths: number[] = [];

function Probe() {
  const { columns } = useTerminalInfo();
  renderCount++;
  seenWidths.push(columns);
  return <Text>{`cols:${columns}`}</Text>;
}

const originalColumns = process.stdout.columns;
const originalRows = process.stdout.rows;

function setSize(columns: number, rows = 24) {
  Object.defineProperty(process.stdout, "columns", { value: columns, configurable: true });
  Object.defineProperty(process.stdout, "rows", { value: rows, configurable: true });
  process.stdout.emit("resize");
}

const settle = () => new Promise((r) => setTimeout(r, RESIZE_SETTLE_MS * 3));

afterEach(() => {
  Object.defineProperty(process.stdout, "columns", { value: originalColumns, configurable: true });
  Object.defineProperty(process.stdout, "rows", { value: originalRows, configurable: true });
  renderCount = 0;
  seenWidths = [];
});

describe("TerminalProvider resize handling", () => {
  it("coalesces a burst of resize events into one update at the settled size", async () => {
    setSize(100);
    const { lastFrame, unmount } = render(
      <TerminalProvider>
        <Probe />
      </TerminalProvider>,
    );
    await settle();
    seenWidths = [];

    // Simulate a drag: many events, spread out enough that an unthrottled
    // handler would push each intermediate width through to the child.
    for (const w of [96, 88, 80, 72, 64, 60]) {
      setSize(w);
      await new Promise((r) => setTimeout(r, RESIZE_SETTLE_MS / 3));
    }
    await settle();

    expect(lastFrame()).toContain("cols:60");
    // Only the settled width may reach the child. Every intermediate width that
    // renders is a frame Ink then erases using the previous width's row count —
    // the mismatch that strands a duplicate input box on screen.
    const intermediates = seenWidths.filter((w) => w !== 60);
    expect(intermediates).toEqual([]);
    unmount();
  });

  it("does not re-render when a resize event reports unchanged dimensions", async () => {
    setSize(100);
    const { unmount } = render(
      <TerminalProvider>
        <Probe />
      </TerminalProvider>,
    );
    await settle();
    const before = renderCount;

    setSize(100);
    setSize(100);
    await settle();

    expect(renderCount).toBe(before);
    unmount();
  });
});
