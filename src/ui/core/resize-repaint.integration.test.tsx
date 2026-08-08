import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { installResizeRepaintFix } from "./resize-repaint.js";

/**
 * Guards the fragile part of the resize fix: it reaches into Ink's internals
 * (build/instances.js, the instance's log/calculateLayout/onRender fields) via
 * a file-URL import. If an Ink upgrade changes any of that shape, this test
 * fails loudly instead of the fix silently degrading to stock behavior.
 */
describe("installResizeRepaintFix against the real ink", () => {
  it("finds the live instance, swaps the listener, and survives a resize", async () => {
    const { stdout, lastFrame, unmount } = render(<Text>probe</Text>);

    const stream = stdout as unknown as NodeJS.WriteStream;
    const before = stream.listeners?.("resize")?.length ?? 0;

    const installed = await installResizeRepaintFix(stream);
    expect(installed).toBe(true);

    // Swapped, not stacked: at most one listener gained (ink registers its own
    // only on interactive TTYs, so on this fake stream `before` is 0 and ours
    // is the only one; on a real TTY the off/on pair keeps the count equal).
    const after = stream.listeners?.("resize")?.length ?? 0;
    expect(after).toBeLessThanOrEqual(before + 1);

    // A resize through the swapped handler must not throw and must leave the
    // frame renderable.
    stream.emit("resize");
    expect(lastFrame()).toContain("probe");

    unmount();
  });

  it("returns false (stock behavior) for a stream ink never rendered to", async () => {
    const fake = { listeners: () => [], on: () => fake, off: () => fake } as unknown as NodeJS.WriteStream;
    expect(await installResizeRepaintFix(fake)).toBe(false);
  });
});
