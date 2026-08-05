import React, { useEffect, useState } from "react";
import { describe, it, expect } from "vitest";
import { render, Box, Text } from "ink";

/**
 * Ink's `incrementalRendering` option, which the app enables in cli.tsx.
 *
 * Without it Ink erases the ENTIRE frame and redraws it on every render —
 * `\x1b[2K\x1b[1A` once per row. With an animated indicator ticking at 80ms
 * that is a full-screen clear-and-repaint 12.5x/second, which terminals show as
 * flicker (severely on slower emulators). With it, Ink moves the cursor and
 * rewrites only the lines that changed.
 *
 * This test drives real Ink against a fake stdout and asserts on the bytes, so
 * it fails if the option is dropped or if Ink changes the default behaviour.
 */
function fakeStdout() {
  const writes: string[] = [];
  const stream = {
    write: (s: string) => {
      writes.push(s);
      return true;
    },
    isTTY: true,
    columns: 100,
    rows: 30,
    on() {}, off() {}, removeListener() {}, emit() {},
  };
  return { writes, stream: stream as unknown as NodeJS.WriteStream };
}

function Ticker() {
  const [n, setN] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setN((x) => x + 1), 20);
    return () => clearInterval(t);
  }, []);
  return <Text>{`tick ${n % 8}`}</Text>;
}

function Frame() {
  return (
    <Box flexDirection="column">
      {Array.from({ length: 6 }, (_, i) => (
        <Text key={i}>static line {i}</Text>
      ))}
      <Ticker />
    </Box>
  );
}

const ERASE_LINE = "[2K";
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("incrementalRendering", () => {
  it("rewrites only changed lines instead of erasing the frame", async () => {
    const { writes, stream } = fakeStdout();
    const inst = render(<Frame />, {
      stdout: stream,
      patchConsole: false,
      incrementalRendering: true,
    });
    await settle(120);
    inst.unmount();

    const body = writes.join("");
    expect(body).toContain("tick");
    // The whole point: no full-line erases in the steady-state repaint.
    expect(body).not.toContain(ERASE_LINE);
  });

  it("erases every row when the option is off (the behaviour we opt out of)", async () => {
    // Pins WHY the option is set — if this ever stops erasing, Ink changed its
    // default and the comment in cli.tsx is stale.
    const { writes, stream } = fakeStdout();
    const inst = render(<Frame />, { stdout: stream, patchConsole: false });
    await settle(120);
    inst.unmount();

    expect(writes.join("")).toContain(ERASE_LINE);
  });

  it("writes dramatically fewer bytes per frame when incremental", async () => {
    const measure = async (incrementalRendering: boolean) => {
      const { writes, stream } = fakeStdout();
      const inst = render(<Frame />, {
        stdout: stream,
        patchConsole: false,
        incrementalRendering,
      });
      await settle(120);
      inst.unmount();
      // Ignore the tiny synchronized-output and cursor control writes.
      return writes.filter((w) => w.length > 40).join("").length;
    };

    const incremental = await measure(true);
    const full = await measure(false);
    expect(incremental).toBeLessThan(full);
  });
});
