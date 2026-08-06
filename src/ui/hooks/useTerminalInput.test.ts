import { describe, it, expect, beforeEach } from "vitest";
import { PassThrough } from "node:stream";
import { parseTerminalInput, attachInputWire, __resetInputWireForTests, __setActiveHandlerForTests, type InputKey } from "./useTerminalInput.js";

function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

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

  describe("SS3 arrow keys (application cursor key mode / DECCKM)", () => {
    const cases: Array<[string, keyof InputKey, string]> = [
      ["\x1bOA", "upArrow", "\x1b[A"],
      ["\x1bOB", "downArrow", "\x1b[B"],
      ["\x1bOC", "rightArrow", "\x1b[C"],
      ["\x1bOD", "leftArrow", "\x1b[D"],
    ];

    it.each(cases)("parses SS3 %s to exactly one key with the correct arrow flag and no stray chars", (seq, flag) => {
      const { keys } = parseTerminalInput(seq);
      expect(keys).toHaveLength(1);
      expect(keys[0][flag]).toBe(true);
      expect(keys[0].escape).toBe(false);
    });

    it.each(cases)("SS3 %s matches its CSI equivalent exactly (parity across terminal modes)", (seq, _flag, csiEquivalent) => {
      const ss3Key = parseTerminalInput(seq).keys[0];
      const csiKey = parseTerminalInput(csiEquivalent).keys[0];
      expect(ss3Key).toEqual(csiKey);
    });

    it("regression: SS3 down arrow must not fire escape semantics", () => {
      const { keys } = parseTerminalInput("\x1bOB");
      expect(keys.some((k) => k.escape)).toBe(false);
    });
  });
});

describe("input wire (single module-level listener)", () => {
  let stream: PassThrough;

  beforeEach(() => {
    stream = new PassThrough();
    __resetInputWireForTests();
  });

  it("attaches the data listener exactly once (idempotent)", () => {
    attachInputWire(stream);
    attachInputWire(stream);
    expect(stream.listenerCount("data")).toBe(1);
  });

  it("enables bracketed paste mode so multi-line pastes arrive as one event", () => {
    const written: string[] = [];
    const isTTY = process.stdout.isTTY;
    const write = process.stdout.write.bind(process.stdout);
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    process.stdout.write = ((s: string) => { written.push(String(s)); return true; }) as typeof process.stdout.write;
    try {
      attachInputWire(stream);
    } finally {
      process.stdout.write = write;
      Object.defineProperty(process.stdout, "isTTY", { value: isTTY, configurable: true });
    }
    expect(written.join("")).toContain("\x1b[?2004h");
  });

  it("dispatches parsed keys to the active handler while flowing", async () => {
    attachInputWire(stream);
    const keys: InputKey[] = [];
    __setActiveHandlerForTests((k) => keys.push(k));
    stream.resume();
    stream.write("/theme\r");
    await settle();
    expect(keys.filter((k) => k.value !== "\r").map((k) => k.value).join("")).toBe("/theme");
    expect(keys.some((k) => k.return)).toBe(true);
  });

  it("hands the stream to a readable drain while paused (modal case)", async () => {
    attachInputWire(stream);
    __setActiveHandlerForTests(null);
    stream.pause();
    const drained: string[] = [];
    stream.on("readable", () => {
      let chunk: Buffer | null;
      while ((chunk = stream.read()) !== null) drained.push(chunk.toString());
    });
    stream.write("x\r");
    await settle();
    expect(drained.join("")).toBe("x\r");
  });

  it("carries a split paste across an inactivity window", async () => {
    attachInputWire(stream);
    const keys: InputKey[] = [];
    __setActiveHandlerForTests((k) => keys.push(k));
    stream.resume();
    stream.write("\x1b[200~he"); // part 1 while active → pendingPaste "he"
    await settle();
    __setActiveHandlerForTests(null);
    stream.pause();
    stream.write("llo\x1b[201~"); // part 2 while inactive → buffered
    __setActiveHandlerForTests((k) => keys.push(k));
    stream.resume();
    await settle();
    expect(keys.filter((k) => k.paste).map((k) => k.paste).join("")).toBe("hello");
  });
});
