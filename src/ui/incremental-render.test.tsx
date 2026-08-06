import React from "react";
import { describe, it, expect } from "vitest";
import { render, Box, Text } from "ink";
import { fakeStdout } from "./test-helpers.js";

/**
 * Ink's `incrementalRendering` option, which the app enables in cli.tsx.
 *
 * Without it Ink erases the ENTIRE frame and redraws it on every render —
 * `\x1b[2K\x1b[1A` once per row. With an animated indicator ticking at 80ms
 * that is a full-screen clear-and-repaint 12.5x/second, which terminals show as
 * flicker (severely on slower emulators). With it, Ink moves the cursor and
 * rewrites only the lines that changed.
 *
 * These tests drive real Ink against a fake stdout and assert on the bytes, so
 * they fail if the option is dropped or if Ink changes its default.
 *
 * Two environment traps, both hit in this file before:
 *
 * 1. Frames are driven with explicit `rerender()` calls, never a timer. An
 *    earlier version rendered a 20ms <Ticker> and waited 120ms of wall-clock,
 *    so a loaded runner produced fewer repaints than expected.
 * 2. `interactive: true` is passed explicitly. Ink infers interactivity from
 *    `is-in-ci` (process.env.CI) and stdout.isTTY, and when non-interactive it
 *    emits no ANSI at all — so assertions about escape sequences cannot pass
 *    under CI without forcing it.
 *
 * Nothing here depends on machine speed or on ambient environment variables.
 */

/** A frame whose last row changes per `tick`, with static rows above it. */
function Frame({ tick }: { tick: number }) {
  return (
    <Box flexDirection="column">
      {Array.from({ length: 6 }, (_, i) => (
        <Text key={i}>static line {i}</Text>
      ))}
      <Text>{`tick ${tick}`}</Text>
    </Box>
  );
}

const ERASE_LINE = "[2K";

/**
 * Render `Frame` and step it through several frames, returning everything
 * written after the initial paint — i.e. the steady-state repaint traffic,
 * which is what actually causes flicker.
 */
function captureRepaints(incrementalRendering: boolean, frames = 5) {
  const { writes, stream } = fakeStdout();
  const inst = render(<Frame tick={0} />, {
    stdout: stream,
    patchConsole: false,
    // Force interactive mode. Ink decides this from `is-in-ci` (which reads
    // process.env.CI) plus stdout.isTTY, and in non-interactive mode it
    // disables ANSI erase sequences, cursor manipulation and synchronized
    // output entirely — writing only the final frame at unmount. GitHub
    // Actions always sets CI=true, so without this the escape sequences these
    // tests exist to assert on are structurally absent and both assertions
    // fail with the plain-text frame.
    interactive: true,
    ...(incrementalRendering ? { incrementalRendering: true } : {}),
  });

  // Everything written so far is the first paint; measure only what follows.
  const afterFirstPaint = writes.length;
  for (let i = 1; i <= frames; i++) {
    inst.rerender(<Frame tick={i} />);
  }
  inst.unmount();

  const repaints = writes.slice(afterFirstPaint);
  return { body: repaints.join(""), writes: repaints };
}

describe("incrementalRendering", () => {
  it("rewrites only changed lines instead of erasing the frame", () => {
    const { body } = captureRepaints(true);
    expect(body).toContain("tick");
    // The whole point: no full-line erases in the steady-state repaint.
    expect(body).not.toContain(ERASE_LINE);
  });

  it("erases every row when the option is off (the behaviour we opt out of)", () => {
    // Pins WHY the option is set — if this ever stops erasing, Ink changed its
    // default and the comment in cli.tsx is stale.
    const { body } = captureRepaints(false);
    expect(body).toContain(ERASE_LINE);
  });

  it("writes dramatically fewer bytes per repaint when incremental", () => {
    const incremental = captureRepaints(true).body.length;
    const full = captureRepaints(false).body.length;
    expect(incremental).toBeGreaterThan(0);
    expect(full).toBeGreaterThan(0);
    expect(incremental).toBeLessThan(full);
  });
});
