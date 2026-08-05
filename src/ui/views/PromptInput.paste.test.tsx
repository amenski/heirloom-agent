import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "ink-testing-library";
import PromptInput, { type PromptSubmission } from "./PromptInput.js";
import { __resetInputWireForTests } from "../hooks/useTerminalInput.js";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const BACKSPACE = "\x7f";

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const flush = () => new Promise((r) => setTimeout(r, 60));

/**
 * A pasted block is stored verbatim but drawn as "[pasted N chars]" so the input
 * doesn't grow to the height of the paste. The buffer stays the source of truth:
 * whatever is submitted must be the original text, not the placeholder.
 */
const mounted: Array<{ unmount: () => void }> = [];

afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount();
  __resetInputWireForTests();
});

function setup() {
  const onSubmit = vi.fn<(s: PromptSubmission) => void>();
  const inst = render(
    <PromptInput onSubmit={onSubmit} screenWidth={80} promptHistory={[]} busy={false} />,
  );
  mounted.push(inst);
  return { ...inst, onSubmit };
}

describe("PromptInput large-paste collapsing", () => {
  it("draws a multi-line paste as a single placeholder line", async () => {
    const { stdin, lastFrame } = setup();
    const pasted = "line one\nline two\nline three";
    stdin.write(PASTE_START + pasted + PASTE_END);
    await flush();

    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("[pasted 3 lines, 28 chars]");
    expect(frame).not.toContain("line two");
  });

  it("collapses a long single-line paste with a char count", async () => {
    const { stdin, lastFrame } = setup();
    const pasted = "z".repeat(167);
    stdin.write(PASTE_START + pasted + PASTE_END);
    await flush();

    expect(stripAnsi(lastFrame() ?? "")).toContain("[pasted 167 chars]");
  });

  it("leaves a short paste visible", async () => {
    const { stdin, lastFrame } = setup();
    stdin.write(PASTE_START + "src/ui/App.tsx" + PASTE_END);
    await flush();

    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("src/ui/App.tsx");
    expect(frame).not.toContain("[pasted");
  });

  it("submits the real pasted text, not the placeholder", async () => {
    const { stdin, onSubmit } = setup();
    const pasted = "alpha\nbeta\ngamma";
    stdin.write(PASTE_START + pasted + PASTE_END);
    await flush();
    stdin.write("\r");
    await flush();

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0].text).toBe(pasted);
  });

  it("keeps the placeholder while typing after the paste", async () => {
    const { stdin, lastFrame } = setup();
    stdin.write(PASTE_START + "a\nb\nc" + PASTE_END);
    await flush();
    stdin.write(" review this");
    await flush();

    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("[pasted 3 lines, 5 chars]");
    expect(frame).toContain("review this");
  });

  it("still submits paste plus typed text in full", async () => {
    const { stdin, onSubmit } = setup();
    stdin.write(PASTE_START + "a\nb\nc" + PASTE_END);
    await flush();
    stdin.write(" done");
    await flush();
    stdin.write("\r");
    await flush();

    expect(onSubmit.mock.calls[0][0].text).toBe("a\nb\nc done");
  });

  it("expands the real text when backspace eats into the paste", async () => {
    const { stdin, lastFrame } = setup();
    stdin.write(PASTE_START + "a\nb\ncdef" + PASTE_END);
    await flush();
    expect(stripAnsi(lastFrame() ?? "")).toContain("[pasted");

    stdin.write(BACKSPACE); // deletes the final "f", reaching into the span
    await flush();

    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).not.toContain("[pasted");
    expect(frame).toContain("cde");
  });

  it("collapses two separate pastes independently", async () => {
    const { stdin, lastFrame } = setup();
    stdin.write(PASTE_START + "a\nb" + PASTE_END);
    await flush();
    stdin.write(" and ");
    await flush();
    stdin.write(PASTE_START + "c\nd\ne" + PASTE_END);
    await flush();

    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("[pasted 2 lines, 3 chars]");
    expect(frame).toContain("[pasted 3 lines, 5 chars]");
    expect(frame).toContain("and");
  });

  it("clears the placeholder after submitting", async () => {
    const { stdin, lastFrame } = setup();
    stdin.write(PASTE_START + "a\nb\nc" + PASTE_END);
    await flush();
    stdin.write("\r");
    await flush();

    expect(stripAnsi(lastFrame() ?? "")).not.toContain("[pasted");
  });
});
