import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "ink-testing-library";
import PromptInput from "./views/PromptInput.js";
import { __resetInputWireForTests } from "./hooks/useTerminalInput.js";
import { stripAnsi as strip } from "./test-helpers.js";

const flush = () => new Promise((r) => setTimeout(r, 60));

const mounted: Array<{ unmount: () => void }> = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount();
  __resetInputWireForTests();
});

function setup(props: Partial<React.ComponentProps<typeof PromptInput>> = {}) {
  const inst = render(
    <PromptInput
      onSubmit={vi.fn()}
      screenWidth={120}
      promptHistory={[]}
      busy={false}
      {...props}
    />,
  );
  mounted.push(inst);
  return inst;
}

/**
 * @-file mentions (Claude Code parity): typing "@" opens the file picker,
 * Enter/Tab inserts the highlighted path, and Esc closes it. The repo root is
 * scanned at render time, so these tests run against the actual tree —
 * package.json exists at the root of every checkout, which keeps the top
 * result deterministic.
 */
describe("PromptInput @file mentions", () => {
  it("opens the picker on a bare @ and on a typed query", async () => {
    const { stdin, lastFrame } = setup();
    stdin.write("@");
    await flush();
    expect(strip(lastFrame() ?? "")).toContain("Mention File");

    stdin.write("package");
    await flush();
    expect(strip(lastFrame() ?? "")).toContain("package.json");
  });

  it("does not open the picker for a word-internal @ (email)", async () => {
    const { stdin, lastFrame } = setup();
    stdin.write("mail a@b.com");
    await flush();
    expect(strip(lastFrame() ?? "")).not.toContain("Mention File");
  });

  it("Enter inserts the highlighted path instead of submitting", async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = setup({ onSubmit });
    stdin.write("@package");
    await flush();
    stdin.write("\r");
    await flush();
    expect(onSubmit).not.toHaveBeenCalled();
    const frame = strip(lastFrame() ?? "");
    // The file was inserted with a trailing space and the menu closed.
    expect(frame).toContain("@package.json ");
    expect(frame).not.toContain("Mention File");
  });

  it("Tab inserts the highlighted path", async () => {
    const { stdin, lastFrame } = setup();
    stdin.write("@package");
    await flush();
    stdin.write("\t");
    await flush();
    expect(strip(lastFrame() ?? "")).toContain("@package.json ");
  });

  it("Tab on a directory inserts the dir with a slash and drills in", async () => {
    const { stdin, lastFrame } = setup();
    stdin.write("@src");
    await flush();
    stdin.write("\t");
    await flush();
    const frame = strip(lastFrame() ?? "");
    expect(frame).toContain("@src/");
    // Drill-down: the picker reopens filtered inside the directory.
    expect(frame).toContain("Mention File");
  });

  it("Esc closes the picker for the token; a second Esc reaches interrupt", async () => {
    const onInterrupt = vi.fn();
    const { stdin, lastFrame } = setup({ onInterrupt });
    stdin.write("@package");
    await flush();
    expect(strip(lastFrame() ?? "")).toContain("Mention File");

    stdin.write("\x1b"); // closes the picker
    await flush();
    expect(strip(lastFrame() ?? "")).not.toContain("Mention File");

    stdin.write("\x1b"); // picker closed — this Esc interrupts instead
    await flush();
    expect(onInterrupt).toHaveBeenCalledTimes(1);
  });

  it("backspacing out of a dismissed token reopens the picker", async () => {
    const { stdin, lastFrame } = setup();
    stdin.write("@package");
    await flush();
    stdin.write("\x1b"); // dismiss
    await flush();
    expect(strip(lastFrame() ?? "")).not.toContain("Mention File");

    stdin.write("\x7f"); // backspace → "@packag"
    await flush();
    expect(strip(lastFrame() ?? "")).toContain("Mention File");
  });

  it("Esc on an empty query also closes and a typed char reopens", async () => {
    const { stdin, lastFrame } = setup();
    stdin.write("@");
    await flush();
    expect(strip(lastFrame() ?? "")).toContain("Mention File");

    stdin.write("\x1b");
    await flush();
    expect(strip(lastFrame() ?? "")).not.toContain("Mention File");

    // Same token as dismissed ("") — a plain char would also be filtered to
    // nothing, but the menu must stay closed until the token changes.
    stdin.write("s");
    await flush();
    expect(strip(lastFrame() ?? "")).toContain("Mention File");
  });
});
