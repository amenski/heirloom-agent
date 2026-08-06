import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { ThemeProvider, TerminalProvider } from "../contexts.js";
import WelcomeScreen from "./WelcomeScreen.js";
import { stripAnsi as strip } from "../test-helpers.js";

function setup(props: Partial<React.ComponentProps<typeof WelcomeScreen>> = {}) {
  return render(
    <ThemeProvider>
      <TerminalProvider>
        <WelcomeScreen
          model="DeepSeek V4 Pro"
          thinkingEnabled
          reasoningEffort="high"
          cwd="/Users/someone/projects/heirloom-agent"
          width={80}
          {...props}
        />
      </TerminalProvider>
    </ThemeProvider>,
  );
}

/**
 * The session header is PINNED for the whole session — it is not a splash the
 * user scrolls past. Every row it occupies is permanently unavailable to the
 * conversation, so its height is the property worth guarding.
 */
describe("WelcomeScreen", () => {
  it("fits in a handful of rows", () => {
    // Was 15 rows (six-row ASCII banner + six-row settings panel), which is
    // 63% of a standard 24-row terminal, forever.
    const rows = strip(setup().lastFrame() ?? "").split("\n").length;
    expect(rows).toBeLessThanOrEqual(6);
  });

  it("renders the wordmark padded for an inverse block", () => {
    // Reverse video is the highest-contrast device a terminal offers, and
    // matches the chip treatment in the status bar and hint bar. The leading
    // and trailing spaces are load-bearing: they are what extends the
    // background slab past the text, exactly like `chip()` in core/chips.ts.
    // (Ink strips colour in the test renderer, so the padding — not the
    // escape sequence — is the observable property here.)
    const frame = strip(setup().lastFrame() ?? "");
    expect(frame).toContain(" HEIRLOOM ");
    const markLine = frame.split("\n").find((l) => l.includes("HEIRLOOM"))!;
    expect(markLine.startsWith(" HEIRLOOM ")).toBe(true);
  });

  it("shows the resolved model name, never a placeholder", () => {
    // Regression: App passed `ctx.activeModel ?? "unknown"`, but activeModel is
    // undefined until a model is explicitly chosen — so a fresh session showed
    // "deepseek/unknown" while the status bar showed the real name.
    const frame = strip(setup().lastFrame() ?? "");
    expect(frame).toContain("DeepSeek V4 Pro");
    expect(frame).not.toContain("unknown");
  });

  it("states model, thinking and cwd on one line", () => {
    const frame = strip(setup().lastFrame() ?? "");
    const contextLine = frame.split("\n").find((l) => l.includes("DeepSeek V4 Pro"));
    expect(contextLine).toBeDefined();
    expect(contextLine).toContain("thinking high");
    expect(contextLine).toContain("heirloom-agent");
  });

  it("reports thinking as off when disabled", () => {
    const frame = strip(setup({ thinkingEnabled: false }).lastFrame() ?? "");
    expect(frame).toContain("thinking off");
  });

  it("falls back to 'on' when thinking is enabled without an effort level", () => {
    const frame = strip(setup({ reasoningEffort: undefined }).lastFrame() ?? "");
    expect(frame).toContain("thinking on");
  });

  it("abbreviates a long home-relative path", () => {
    const frame = strip(setup({ cwd: process.env.HOME + "/a/very/deep/nested/path/that/keeps/going/on/and/on" }).lastFrame() ?? "");
    expect(frame).toContain("…");
  });

  it("renders no multi-row ASCII banner", () => {
    // The old banner was 61 columns of block/box glyphs across six rows,
    // shredded in IntelliJ's JediTerm. Its glyphs measured identical advance
    // widths, so font-metric drift wasn't the cause — likely renderer-side
    // (JediTerm custom-painting those glyph ranges), unverified.
    const frame = strip(setup().lastFrame() ?? "");
    const blockRows = frame.split("\n").filter((l) => /█{4,}/.test(l));
    expect(blockRows).toHaveLength(0);
  });
});
