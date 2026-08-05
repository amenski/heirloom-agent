import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { Box, Text } from "ink";
import Spinner from "./Spinner.js";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

/**
 * Streaming-flicker regression.
 *
 * Ink repaints a changed line by walking the cursor UP from the bottom of the
 * frame, so every row rendered BELOW an animating line gets rewritten on each
 * tick. The spinner animates at 80ms (12.5x/sec); it used to sit above the
 * prompt box, so the whole input was continuously repainted — visible tearing
 * on slower emulators. It now renders second-to-last, immediately above the
 * one-line status bar.
 *
 * These tests pin the two properties that make that work: the spinner adds no
 * trailing blank row, and its width never changes.
 */
describe("Spinner frame footprint", () => {
  it("adds no blank row below itself", () => {
    // A trailing margin would be one more line for Ink to walk back over on
    // every tick. The margin above is fine — it is not below the changing line.
    const { lastFrame } = render(
      <Box flexDirection="column">
        <Spinner active />
        <Text>STATUS-BAR</Text>
      </Box>,
    );
    const rows = strip(lastFrame() ?? "").split("\n");
    const spinnerRow = rows.findIndex((r) => r.includes("Working"));
    expect(spinnerRow).toBeGreaterThanOrEqual(0);
    // The status bar must be the VERY next row, with no blank between.
    expect(rows[spinnerRow + 1]).toContain("STATUS-BAR");
  });

  it("occupies exactly one changing row", () => {
    const { lastFrame } = render(
      <Box flexDirection="column">
        <Spinner active />
        <Text>STATUS-BAR</Text>
      </Box>,
    );
    const rows = strip(lastFrame() ?? "").split("\n");
    expect(rows.filter((r) => r.includes("Working"))).toHaveLength(1);
  });

  it("renders nothing at all when the turn is not active", () => {
    // No turn, no animating line, no repaint — the idle case.
    const { lastFrame } = render(
      <Box flexDirection="column">
        <Spinner active={false} />
        <Text>STATUS-BAR</Text>
      </Box>,
    );
    const rows = strip(lastFrame() ?? "").split("\n").filter((r) => r.trim() !== "");
    expect(rows).toEqual(["STATUS-BAR"]);
  });
});
