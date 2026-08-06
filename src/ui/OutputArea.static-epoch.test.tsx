import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import OutputArea from "./OutputArea.js";
import { stripAnsi } from "./test-helpers.js";

/**
 * Committed lines already flushed to a real terminal's scrollback via
 * <Static> can't be un-printed — /clear and /new erase the screen and must
 * also make Static "forget" what it already rendered, or the next commit
 * would just add to the old content instead of replacing it. Ink's pattern
 * for this is remounting Static via a changing `key`; OutputArea threads that
 * through as the `staticEpoch` prop (bumped by App.tsx at each scrollback
 * wipe — see wipeScrollback in App.tsx).
 *
 * Empirically probed against ink-testing-library: bumping the key genuinely
 * remounts Static and its previously-rendered items do not reappear in a
 * fresh frame (confirmed here, not just asserted as "the wiring exists").
 */
describe("OutputArea staticEpoch", () => {
  it("keeps rendering the same items when staticEpoch is unchanged", () => {
    const { lastFrame, rerender } = render(
      <OutputArea lines={["alpha", "beta"]} activeLine="" busy={false} staticEpoch={0} />,
    );
    expect(stripAnsi(lastFrame() ?? "")).toContain("alpha");

    rerender(<OutputArea lines={["alpha", "beta", "gamma"]} activeLine="" busy={false} staticEpoch={0} />);
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("alpha");
    expect(frame).toContain("gamma");
  });

  it("forgets previously-rendered items when staticEpoch is bumped", () => {
    const { lastFrame, rerender } = render(
      <OutputArea lines={["alpha", "beta"]} activeLine="" busy={false} staticEpoch={0} />,
    );
    expect(stripAnsi(lastFrame() ?? "")).toContain("alpha");

    // Simulate a /new or /resume wipe: lines reset, epoch bumped.
    rerender(<OutputArea lines={[]} activeLine="" busy={false} staticEpoch={1} />);
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("alpha");
  });

  it("shows freshly-seeded content after a wipe, without the old transcript", () => {
    const { lastFrame, rerender } = render(
      <OutputArea lines={["old line"]} activeLine="" busy={false} staticEpoch={0} />,
    );
    rerender(<OutputArea lines={[]} activeLine="" busy={false} staticEpoch={1} />);
    rerender(<OutputArea lines={["new banner"]} activeLine="" busy={false} staticEpoch={1} />);

    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("new banner");
    expect(frame).not.toContain("old line");
  });
});
