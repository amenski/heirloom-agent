import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import { Box, Text } from "ink";
import { ThemeProvider, TerminalProvider } from "./contexts.js";
import HintBar from "./HintBar.js";
import { stripAnsi as strip } from "./test-helpers.js";

function renderBar(ui: React.ReactElement) {
  return render(
    <ThemeProvider>
      <TerminalProvider>{ui}</TerminalProvider>
    </ThemeProvider>,
  );
}

const LEFT = [{ key: "esc", label: "interrupt" }];
const RIGHT = [{ key: "ctrl+shift+p", label: "commands" }];

/**
 * The bottom row of the frame, and the only continuously-changing element.
 *
 * Ink repaints a changed line by walking the cursor UP from the bottom, so every
 * row below an animating line is rewritten on each tick. This bar carries the
 * 80ms working animation precisely because nothing renders under it. The tests
 * below pin the properties that keep that true: one row, stable width, and no
 * animation (or timer) when idle.
 */
describe("HintBar", () => {
  // Chords render as key-caps. Without colour a chip degrades to "[esc]", which
  // is what these assertions match — the shape survives either way.
  it("renders hints on a single row", () => {
    const { lastFrame } = renderBar(<HintBar left={LEFT} right={RIGHT} />);
    const rows = strip(lastFrame() ?? "").split("\n").filter((r) => r.trim() !== "");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("[esc] interrupt");
    expect(rows[0]).toContain("[ctrl+shift+p] commands");
  });

  it("starts no timer when no turn is running", () => {
    // An idle animation would repaint this row forever — the bug fixed in
    // c74d54d, reintroduced one level down.
    const spy = vi.spyOn(globalThis, "setInterval");
    renderBar(<HintBar left={LEFT} />);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("animates only while working", () => {
    const spy = vi.spyOn(globalThis, "setInterval");
    renderBar(<HintBar working left={LEFT} />);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("keeps the hints flush left and unmoved whether idle or working", () => {
    // The indicator field is reserved even when blank, so nothing shifts when a
    // turn starts and the row is overwritten in place rather than reflowed. It
    // trails the hints rather than leading them — leading it indented every
    // hint by the field width, which read as a stray margin.
    const idle = strip(renderBar(<HintBar left={LEFT} right={RIGHT} />).lastFrame() ?? "");
    const busy = strip(renderBar(<HintBar working left={LEFT} right={RIGHT} />).lastFrame() ?? "");
    expect(idle.indexOf("[esc]")).toBe(0);
    expect(busy.indexOf("[esc]")).toBe(0);
    // And the right-hand group must not move either.
    expect(busy.indexOf("ctrl+shift+p")).toBe(idle.indexOf("ctrl+shift+p"));
  });

  it("right-aligns the right-hand group", () => {
    const { lastFrame } = renderBar(<HintBar left={LEFT} right={RIGHT} />);
    const row = strip(lastFrame() ?? "").split("\n")[0];
    expect(row.indexOf("ctrl+shift+p")).toBeGreaterThan(row.indexOf("esc"));
    // Padded apart rather than run together.
    expect(row).toMatch(/interrupt\s{2,}\[ctrl\+shift\+p\]/);
  });

  it("stays one row even with nothing to show", () => {
    const { lastFrame } = renderBar(<HintBar left={[]} />);
    expect(strip(lastFrame() ?? "").split("\n")).toHaveLength(1);
  });

  it("renders below whatever precedes it", () => {
    // Position is the whole point: it must be last.
    const { lastFrame } = renderBar(
      <Box flexDirection="column">
        <Text>STATUS-BAR</Text>
        <HintBar working left={LEFT} />
      </Box>,
    );
    const rows = strip(lastFrame() ?? "").split("\n").filter((r) => r.trim() !== "");
    expect(rows[0]).toContain("STATUS-BAR");
    expect(rows[rows.length - 1]).toContain("[esc] interrupt");
  });
});
