import { describe, it, expect } from "vitest";
import { parseTerminalInput } from "./useTerminalInput.js";

describe("parseTerminalInput", () => {
  it("parses a complete bracketed paste without dropping the first character", () => {
    const { keys, pendingPaste } = parseTerminalInput("\x1b[200~hello world\x1b[201~");
    expect(pendingPaste).toBeNull();
    expect(keys).toHaveLength(1);
    expect(keys[0].paste).toBe("hello world");
  });

  it("parses plain characters following a complete paste in the same chunk", () => {
    const { keys, pendingPaste } = parseTerminalInput("\x1b[200~hi\x1b[201~ok");
    expect(pendingPaste).toBeNull();
    expect(keys[0].paste).toBe("hi");
    expect(keys.slice(1).map((k) => k.value).join("")).toBe("ok");
  });

  it("reassembles a paste split across two chunks", () => {
    const first = parseTerminalInput("\x1b[200~hello ");
    expect(first.keys).toHaveLength(0);
    expect(first.pendingPaste).toBe("hello ");

    const second = parseTerminalInput("world\x1b[201~", first.pendingPaste);
    expect(second.pendingPaste).toBeNull();
    expect(second.keys).toHaveLength(1);
    expect(second.keys[0].paste).toBe("hello world");
  });

  it("reassembles a paste split across more than two chunks", () => {
    const c1 = parseTerminalInput("\x1b[200~a");
    const c2 = parseTerminalInput("b", c1.pendingPaste);
    const c3 = parseTerminalInput("c\x1b[201~", c2.pendingPaste);
    expect(c3.keys[0].paste).toBe("abc");
    expect(c3.pendingPaste).toBeNull();
  });

  it("parses Enter as return, not ctrl+m", () => {
    const { keys } = parseTerminalInput("\r");
    expect(keys[0].return).toBe(true);
  });

  it("parses Shift+Tab (CSI Z) distinctly from plain Tab", () => {
    expect(parseTerminalInput("\x1b[Z").keys[0]).toMatchObject({ tab: true, shift: true });
    expect(parseTerminalInput("\t").keys[0]).toMatchObject({ tab: true, shift: false });
  });

  it("parses ctrl+letter combinations", () => {
    expect(parseTerminalInput("\x01").keys[0]).toMatchObject({ ctrl: true, value: "a" });
    expect(parseTerminalInput("\x18").keys[0]).toMatchObject({ ctrl: true, value: "x" });
  });

  it("parses arrow keys", () => {
    expect(parseTerminalInput("\x1b[A").keys[0].upArrow).toBe(true);
    expect(parseTerminalInput("\x1b[1;5D").keys[0].leftArrow).toBe(true);
  });

  it("parses a lone escape key", () => {
    expect(parseTerminalInput("\x1b").keys[0].escape).toBe(true);
  });
});
