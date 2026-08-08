import { describe, it, expect } from "vitest";
import {
  stripAnsi,
  displayWidth,
  computeRewrappedRows,
  buildEraseLines,
} from "./resize-repaint.js";

describe("stripAnsi", () => {
  it("removes CSI color and cursor sequences", () => {
    expect(stripAnsi("\x1b[2mdim\x1b[0m and \x1b[1A\x1b[2K")).toBe("dim and ");
  });

  it("removes OSC sequences (title, hyperlink)", () => {
    expect(stripAnsi("\x1b]0;title\x07text")).toBe("text");
    expect(stripAnsi("\x1b]8;;https://x\x1b\\link\x1b]8;;\x1b\\")).toBe("link");
  });
});

describe("computeRewrappedRows", () => {
  it("counts one row per line when nothing wraps", () => {
    expect(computeRewrappedRows("a\nb\nc", 80)).toBe(3);
  });

  it("counts empty lines and a trailing newline like log-update does", () => {
    // "a\n" splits into ["a", ""] — the trailing empty entry still occupies
    // a row in Ink's own previousLineCount accounting.
    expect(computeRewrappedRows("a\n", 80)).toBe(2);
    expect(computeRewrappedRows("", 80)).toBe(1);
  });

  it("adds rows for lines that re-wrap at the new width", () => {
    const line40 = "x".repeat(40);
    // 40 cols at width 20 → 2 rows; at width 40 → exactly 1; at 39 → 2.
    expect(computeRewrappedRows(line40, 20)).toBe(2);
    expect(computeRewrappedRows(line40, 40)).toBe(1);
    expect(computeRewrappedRows(line40, 39)).toBe(2);
  });

  it("ignores ANSI escapes when measuring width", () => {
    const styled = "\x1b[36m" + "x".repeat(40) + "\x1b[0m";
    expect(computeRewrappedRows(styled, 40)).toBe(1);
  });

  it("counts wide (CJK) characters as two columns", () => {
    expect(displayWidth("漢字")).toBe(4);
    // 10 CJK chars = 20 cols → 2 rows at width 10.
    expect(computeRewrappedRows("漢".repeat(10), 10)).toBe(2);
  });

  it("clamps a zero/negative column count instead of dividing by it", () => {
    expect(computeRewrappedRows("abc", 0)).toBe(3);
  });
});

describe("buildEraseLines", () => {
  it("matches ansi-escapes eraseLines semantics", () => {
    // erase current line, up, erase, up, erase, then column 1.
    expect(buildEraseLines(3)).toBe("\x1b[2K\x1b[1A\x1b[2K\x1b[1A\x1b[2K\x1b[G");
    expect(buildEraseLines(1)).toBe("\x1b[2K\x1b[G");
    expect(buildEraseLines(0)).toBe("");
  });
});
