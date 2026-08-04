import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import ModelsDropdown from "./index.js";
import type { ModelEntry } from "../../types.js";

const ESC = "\x1b";
const DOWN = `${ESC}[B`;
const UP = `${ESC}[A`;
const ENTER = "\r";

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

// Each keypress triggers an async React state update inside ink's useInput;
// writes issued back-to-back in the same tick race the re-render, so tests
// that simulate a sequence of keys must flush between writes. A bare Esc byte
// specifically needs >= ink's pendingInputFlushDelayMilliseconds (20ms) since
// ink holds it briefly in case it's the start of a longer escape sequence.
const flush = () => new Promise((r) => setTimeout(r, 25));

const entries: ModelEntry[] = [
  { provider: "deepseek", model: "deepseek-v4-pro", contextWindow: 1000000 },
  { provider: "deepseek", model: "deepseek-v4-flash", contextWindow: 1000000 },
  { provider: "openai", model: "gpt-5.6-sol", contextWindow: 256000 },
  { provider: "groq", model: "llama-3.3-70b-versatile", contextWindow: 128000 },
];

const labels = { deepseek: "DeepSeek", openai: "OpenAI", groq: "Groq" };

describe("ModelsDropdown — searchable, provider-grouped picker", () => {
  it("groups models under provider headings and shows context windows", () => {
    const { lastFrame } = render(
      <ModelsDropdown
        open providerName="deepseek" currentModel="deepseek-v4-pro"
        entries={entries} labels={labels} width={80} onClose={vi.fn()} onSelect={vi.fn()}
      />,
    );
    const frame = stripAnsi(lastFrame() ?? "");
    // Provider headings use the display label...
    expect(frame).toContain("DeepSeek");
    expect(frame).toContain("OpenAI");
    // ...and models appear as bare names beneath them, not "provider/model".
    for (const e of entries) expect(frame).toContain(e.model);
    expect(frame).toContain("1000k ctx");
    expect(frame).toContain("256k ctx");
  });

  it("marks the entry matching BOTH provider and model as current", () => {
    const { lastFrame } = render(
      <ModelsDropdown
        open providerName="openai" currentModel="gpt-5.6-sol"
        entries={entries} labels={labels} width={80} onClose={vi.fn()} onSelect={vi.fn()}
      />,
    );
    const line = stripAnsi(lastFrame() ?? "").split("\n").find((l) => l.includes("gpt-5.6-sol"));
    expect(line).toBeDefined();
    expect(line).toContain("current");
    // A model on a different provider must not be flagged current.
    const other = stripAnsi(lastFrame() ?? "").split("\n").find((l) => l.includes("deepseek-v4-pro"));
    expect(other).not.toContain("current");
  });

  it("opens with the cursor on the active model", async () => {
    const { lastFrame } = render(
      <ModelsDropdown
        open providerName="openai" currentModel="gpt-5.6-sol"
        entries={entries} labels={labels} width={80} onClose={vi.fn()} onSelect={vi.fn()}
      />,
    );
    // The anchoring effect runs after the first paint, so settle a tick before
    // reading the frame.
    await flush();
    // The "> " marker must sit on the current model, not default to row 0.
    // Regression: an effect keyed on `rows` (a fresh array every render) reset
    // the cursor continuously and fought the arrow keys.
    const line = stripAnsi(lastFrame() ?? "").split("\n").find((l) => l.includes("gpt-5.6-sol"));
    expect(line).toMatch(/>\s+gpt-5\.6-sol/);
  });

  it("filters as you type, matching across provider and model name", async () => {
    const { lastFrame, stdin } = render(
      <ModelsDropdown
        open providerName="deepseek" currentModel="deepseek-v4-pro"
        entries={entries} labels={labels} width={80} onClose={vi.fn()} onSelect={vi.fn()}
      />,
    );
    stdin.write("llama");
    await flush();
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("llama-3.3-70b-versatile");
    expect(frame).toContain("Groq");
    // Non-matching providers drop out entirely, headings included.
    expect(frame).not.toContain("gpt-5.6-sol");
    expect(frame).not.toContain("OpenAI");
  });

  it("fuzzy-matches non-adjacent characters", async () => {
    const { lastFrame, stdin } = render(
      <ModelsDropdown
        open providerName="openai" currentModel="gpt-5.6-sol"
        entries={entries} labels={labels} width={80} onClose={vi.fn()} onSelect={vi.fn()}
      />,
    );
    stdin.write("dsp"); // d-eep-s-eek-v4-p-ro
    await flush();
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("deepseek-v4-pro");
    expect(frame).not.toContain("llama-3.3-70b-versatile");
  });

  it("selects the entry's own provider, skipping over group headings", async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const { stdin } = render(
      <ModelsDropdown
        open providerName="deepseek" currentModel="deepseek-v4-pro"
        entries={entries} labels={labels} width={80} onClose={onClose} onSelect={onSelect}
      />,
    );
    // Models are sorted within each provider, so the rows are:
    //   [DeepSeek] deepseek-v4-flash  deepseek-v4-pro  [OpenAI] gpt-5.6-sol
    //   [Groq] llama-3.3-70b-versatile
    // The cursor starts on the current model (deepseek-v4-pro). One down lands
    // on gpt-5.6-sol and a second on llama — proving arrow keys step OVER both
    // the "OpenAI" and "Groq" headings instead of stopping on them.
    stdin.write(DOWN);
    await flush();
    stdin.write(DOWN);
    await flush();
    stdin.write(ENTER);
    await flush();
    // Selection carries the entry's OWN provider, not the active providerName.
    expect(onSelect).toHaveBeenCalledWith("groq", "llama-3.3-70b-versatile");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("dims providers with no API key and labels them", () => {
    const { lastFrame } = render(
      <ModelsDropdown
        open providerName="deepseek" currentModel="deepseek-v4-pro"
        entries={entries} labels={labels}
        configured={{ deepseek: true, openai: false, groq: false }}
        width={80} onClose={vi.fn()} onSelect={vi.fn()}
      />,
    );
    const lines = stripAnsi(lastFrame() ?? "").split("\n");
    expect(lines.find((l) => l.includes("gpt-5.6-sol"))).toContain("no key");
    expect(lines.find((l) => l.includes("deepseek-v4-pro"))).not.toContain("no key");
  });

  it("Esc clears an active search first, then closes", async () => {
    const onClose = vi.fn();
    const { lastFrame, stdin } = render(
      <ModelsDropdown
        open providerName="deepseek" currentModel="deepseek-v4-pro"
        entries={entries} labels={labels} width={80} onClose={onClose} onSelect={vi.fn()}
      />,
    );
    stdin.write("llama");
    await flush();
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("gpt-5.6-sol");

    stdin.write(ESC);
    await flush();
    // Search cleared: the full list is back and the picker is still open.
    expect(stripAnsi(lastFrame() ?? "")).toContain("gpt-5.6-sol");
    expect(onClose).not.toHaveBeenCalled();

    stdin.write(ESC);
    await flush();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("guards the empty-entries case: does not crash, and Esc still closes", async () => {
    const onClose = vi.fn();
    const onSelect = vi.fn();
    const { lastFrame, stdin } = render(
      <ModelsDropdown
        open providerName="deepseek" currentModel="deepseek-v4-pro"
        entries={[]} width={80} onClose={onClose} onSelect={onSelect}
      />,
    );
    expect(lastFrame()).toBeTruthy();
    stdin.write(DOWN);
    await flush();
    stdin.write(UP);
    await flush();
    stdin.write(ENTER);
    await flush();
    expect(onSelect).not.toHaveBeenCalled();
    stdin.write(ESC);
    await flush();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
