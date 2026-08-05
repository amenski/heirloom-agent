import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import OutputArea from "./OutputArea.js";
import { USER_ECHO_TAG, COMMAND_ECHO_TAG } from "./constants.js";
import { MAX_ECHO_LINES } from "./core/echo-format.js";

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

function frameOf(lines: string[]): string {
  const { lastFrame } = render(
    <OutputArea lines={lines} activeLine="" busy={false} />,
  );
  return stripAnsi(lastFrame() ?? "");
}

/**
 * The transcript echo of a submitted prompt. Regression: multi-line input was
 * flattened to one space-joined line, so a pasted block was displayed as
 * something the user never typed.
 */
describe("OutputArea user echo", () => {
  it("renders each line of a multi-line prompt on its own line", () => {
    const frame = frameOf([USER_ECHO_TAG + "first line\nsecond line\nthird line"]);
    const rendered = frame.split("\n").map((l) => l.trim()).filter(Boolean);

    expect(rendered).toContain("▌ first line");
    expect(rendered).toContain("▌ second line");
    expect(rendered).toContain("▌ third line");
  });

  it("does not join separate lines into one", () => {
    const frame = frameOf([USER_ECHO_TAG + "alpha\nbeta"]);
    expect(frame).not.toContain("alpha beta");
  });

  it("still renders a single-line prompt with one gutter", () => {
    const frame = frameOf([USER_ECHO_TAG + "just one line"]);
    expect(frame).toContain("▌ just one line");
    expect(frame.split("\n").filter((l) => l.includes("▌")).length).toBe(1);
  });

  it("collapses a file-sized paste and reports what was hidden", () => {
    const big = Array.from({ length: MAX_ECHO_LINES + 40 }, (_, i) => `line ${i}`).join("\n");
    const frame = frameOf([USER_ECHO_TAG + big]);

    expect(frame).toContain("▌ line 0");
    expect(frame).toContain("+40 more lines");
    expect(frame).not.toContain(`line ${MAX_ECHO_LINES + 39}`);
  });

  it("keeps an ordinary multi-line prompt fully visible", () => {
    const frame = frameOf([USER_ECHO_TAG + "one\ntwo\nthree\nfour"]);
    expect(frame).toContain("▌ four");
    expect(frame).not.toContain("more lines");
  });
});

describe("OutputArea command echo", () => {
  it("renders a slash command on one line", () => {
    expect(frameOf([COMMAND_ECHO_TAG + "/model"])).toContain("› /model");
  });

  it("keeps newlines in a multi-line command argument", () => {
    const frame = frameOf([COMMAND_ECHO_TAG + "/ask why\nthis fails"]);
    expect(frame).toContain("› /ask why");
    expect(frame).toContain("this fails");
    expect(frame).not.toContain("/ask why this fails");
  });
});
