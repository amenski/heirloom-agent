import { describe, it, expect, afterEach, vi } from "vitest";
import { Readable } from "node:stream";
import { readHiddenLine } from "./hidden-input.js";

// Build a non-TTY readable stream standing in for a piped stdin.
function pipedStdin(data: string): Readable {
  const stream = new Readable({ read() {} });
  // `isTTY` is undefined on piped streams, which is what readHiddenLine checks.
  (stream as unknown as { isTTY?: boolean }).isTTY = undefined;
  stream.push(data);
  stream.push(null);
  return stream;
}

describe("readHiddenLine (piped stdin)", () => {
  const realStdin = process.stdin;

  afterEach(() => {
    Object.defineProperty(process, "stdin", { value: realStdin, configurable: true });
    vi.restoreAllMocks();
  });

  function setStdin(stream: Readable) {
    Object.defineProperty(process, "stdin", { value: stream, configurable: true });
  }

  it("reads a single line verbatim from a pipe", async () => {
    setStdin(pipedStdin("sk-piped-key\n"));
    const result = await readHiddenLine("Paste key: ");
    expect(result).toBe("sk-piped-key");
  });

  it("reads a line even without a trailing newline", async () => {
    setStdin(pipedStdin("sk-no-newline"));
    const result = await readHiddenLine("Paste key: ");
    expect(result).toBe("sk-no-newline");
  });

  it("returns null on empty piped input (closed with no line)", async () => {
    setStdin(pipedStdin(""));
    const result = await readHiddenLine("Paste key: ");
    expect(result).toBeNull();
  });

  it("does not write the prompt to stdout for piped input", async () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    setStdin(pipedStdin("sk-key\n"));
    await readHiddenLine("Paste key: ");
    const wrote = writeSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(wrote).not.toContain("Paste key:");
  });
});
