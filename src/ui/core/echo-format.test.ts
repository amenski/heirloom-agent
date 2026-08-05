import { describe, it, expect } from "vitest";
import { formatEcho, MAX_ECHO_LINES, MAX_ECHO_CHARS } from "./echo-format.js";

describe("formatEcho", () => {
  it("keeps a single-line echo as one line", () => {
    expect(formatEcho("hello world")).toEqual({ lines: ["hello world"], truncated: null });
  });

  it("preserves newlines instead of flattening them", () => {
    // Regression: the echo used to be .replace(/\n/g, " ")'d into one line.
    const { lines, truncated } = formatEcho("first\nsecond\nthird");
    expect(lines).toEqual(["first", "second", "third"]);
    expect(truncated).toBeNull();
  });

  it("preserves blank lines inside the echo", () => {
    expect(formatEcho("a\n\nb").lines).toEqual(["a", "", "b"]);
  });

  it("keeps a multi-line echo at the limit fully visible", () => {
    const text = Array.from({ length: MAX_ECHO_LINES }, (_, i) => `line ${i}`).join("\n");
    const { lines, truncated } = formatEcho(text);
    expect(lines).toHaveLength(MAX_ECHO_LINES);
    expect(truncated).toBeNull();
  });

  it("collapses an echo past the line limit", () => {
    const text = Array.from({ length: MAX_ECHO_LINES + 8 }, (_, i) => `line ${i}`).join("\n");
    const { lines, truncated } = formatEcho(text);
    expect(lines).toHaveLength(MAX_ECHO_LINES);
    expect(lines[0]).toBe("line 0");
    expect(truncated).toContain("+8 more lines");
  });

  it("uses the singular form when exactly one line is hidden", () => {
    const text = Array.from({ length: MAX_ECHO_LINES + 1 }, (_, i) => `line ${i}`).join("\n");
    expect(formatEcho(text).truncated).toContain("+1 more line (");
  });

  it("collapses a long single-line echo by character count", () => {
    const text = "z".repeat(MAX_ECHO_CHARS + 300);
    const { lines, truncated } = formatEcho(text);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveLength(MAX_ECHO_CHARS);
    expect(truncated).toBe("… +300 more chars");
  });

  it("does not collapse a short multi-line echo", () => {
    const { truncated } = formatEcho("a\nb\nc");
    expect(truncated).toBeNull();
  });

  it("honours custom limits", () => {
    const { lines, truncated } = formatEcho("a\nb\nc\nd", 2);
    expect(lines).toEqual(["a", "b"]);
    expect(truncated).toContain("+2 more lines");
  });
});
