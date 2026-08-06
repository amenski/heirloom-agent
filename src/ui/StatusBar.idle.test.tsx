import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "ink-testing-library";
import StatusBar from "./StatusBar.js";
import { stripAnsi as strip } from "./test-helpers.js";

const SEGMENTS = [
  { id: "1", text: "▶ normal (shift+tab)", dimColor: true },
  { id: "2", text: "DeepSeek/deepseek-v4-pro", bold: true },
  { id: "3", text: "effort high", dimColor: true },
];

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Idle flicker regression.
 *
 * The status bar used to be rendered with `showTimer`, which starts a 1s
 * interval for the whole session. The elapsed text genuinely changed every
 * tick, so Ink's line diff had to rewrite that line — and because the bar is
 * the LAST element, rewriting it walks the cursor up over the prompt box and
 * repaints down through it. On a slower terminal (IntelliJ) that reads as a
 * visible flicker once a second, forever, even with nothing running.
 */
describe("StatusBar idle rendering", () => {
  it("renders no elapsed clock when the timer is not requested", () => {
    const { lastFrame } = render(<StatusBar segments={SEGMENTS} />);
    const frame = strip(lastFrame() ?? "");
    // An elapsed readout would look like "1s" / "2m 3s" / "1:02:03".
    expect(frame).not.toMatch(/\d+s\b/);
    expect(frame).not.toMatch(/\d+:\d\d/);
  });

  it("starts no repeating timer when idle", () => {
    // The flicker's actual mechanism: a 1s interval that dirties the last line
    // of the frame forever. Assert on the interval itself — Ink's test renderer
    // does not repaint under fake timers, so comparing frames proves nothing.
    const spy = vi.spyOn(globalThis, "setInterval");
    render(<StatusBar segments={SEGMENTS} />);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("shows effort alongside the model", () => {
    const { lastFrame } = render(<StatusBar segments={SEGMENTS} />);
    const frame = strip(lastFrame() ?? "");
    expect(frame).toContain("DeepSeek/deepseek-v4-pro");
    expect(frame).toContain("effort high");
  });

  it("still supports the timer when a caller explicitly asks for it", () => {
    // The prop is intentionally kept — only App stopped passing it.
    const { lastFrame } = render(
      <StatusBar segments={SEGMENTS} showTimer sessionStart={Date.now() - 5000} />,
    );
    expect(strip(lastFrame() ?? "")).toMatch(/\ds\b/);
  });
});
