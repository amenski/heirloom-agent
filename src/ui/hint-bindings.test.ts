import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseTerminalInput } from "./hooks/useTerminalInput.js";

const src = (p: string) => readFileSync(join(process.cwd(), "src", p), "utf-8");

/**
 * The hint bar advertises keyboard chords. A hint for a chord nothing handles
 * is worse than no hint — the user presses it, nothing happens, and they
 * distrust the rest of the bar.
 *
 * This caught two dead hints:
 *
 * - "^⇧P commands": a terminal sends byte 0x10 for BOTH ctrl+p and
 *   ctrl+shift+p — shift is not encoded in the legacy scheme — so the
 *   shift-qualified binding could never match. PromptInput also claims ctrl+p
 *   for history navigation before App's useInput would see it.
 * - "^M model" NEVER worked at all (an earlier version of this comment
 *   claimed it did): Ctrl+M is byte 0x0D — identical to Enter — consumed by
 *   the parser as `return` before ctrl detection. Pressing it SUBMITTED the
 *   prompt. The hint, the handler, and the default binding are all removed;
 *   the aliasing tests below keep the whole class out.
 */
describe("hint bar chords are reachable", () => {
  it("cannot distinguish ctrl+p from ctrl+shift+p", () => {
    // The root cause, asserted directly: if this ever changes (e.g. the Kitty
    // keyboard protocol is adopted), a shift-qualified ctrl binding becomes
    // viable and the note in keybindings.ts should be revisited.
    const key = parseTerminalInput("\x10").keys[0];
    expect(key.ctrl).toBe(true);
    expect(key.value).toBe("p");
    expect(key.shift).toBe(false);
  });

  it("advertises no chord that PromptInput swallows first", () => {
    // PromptInput owns the stdin wire (it calls stdin.resume() while active),
    // so any ctrl chord it handles never reaches App's useInput. A hint for
    // such a chord is a lie unless PromptInput itself acts on it.
    const app = src("ui/App.tsx");
    const prompt = src("ui/views/PromptInput.tsx");

    // Chords PromptInput consumes and returns from, by ctrl-letter.
    const swallowed = new Set(
      [...prompt.matchAll(/key\.ctrl && key\.value === "(\w)"/g)].map((m) => m[1]),
    );
    expect(swallowed.size).toBeGreaterThan(0);

    // Chords the hint bar advertises, written as "^X".
    const hintBlock = app.slice(app.indexOf("<HintBar"), app.indexOf("</Box>", app.indexOf("<HintBar")));
    const advertised = [...hintBlock.matchAll(/key: "\^(?:⇧)?(\w)"/g)].map((m) => m[1].toLowerCase());

    for (const letter of advertised) {
      if (!swallowed.has(letter)) continue;
      // If PromptInput swallows it, PromptInput must be the one acting on it.
      const handler = new RegExp(
        `key\\.ctrl && key\\.value === "${letter}"\\s*\\)\\s*\\{[^}]*on\\w+\\?\\.\\(`,
      );
      expect(
        handler.test(prompt),
        `hint bar advertises ^${letter.toUpperCase()} but PromptInput swallows it without invoking a handler`,
      ).toBe(true);
    }
  });

  it("does not advertise the unreachable command palette chord", () => {
    // Scope to the hint ARRAYS, not the surrounding block — the explanatory
    // comment above them legitimately names the dead chord.
    const app = src("ui/App.tsx");
    const hints = [...app.matchAll(/\{ key: "([^"]+)", label: "[^"]+" \}/g)].map((m) => m[1]);
    expect(hints.length).toBeGreaterThan(0);
    expect(hints).not.toContain("^⇧P");
  });

  it("byte-aliased chords can never arrive as ctrl combinations", () => {
    // Ctrl+M === Enter (0x0D) and Ctrl+I === Tab (0x09) at the byte level.
    // The parser rightly consumes them as return/tab, so any handler or hint
    // for ctrl+m / ctrl+i is dead on arrival.
    const cr = parseTerminalInput("\x0d").keys[0];
    expect(cr.return).toBe(true);
    expect(cr.ctrl).toBe(false);
    const tab = parseTerminalInput("\x09").keys[0];
    expect(tab.tab).toBe(true);
    expect(tab.ctrl).toBe(false);
  });

  it("advertises no byte-aliased chord in the hint bar", () => {
    const app = src("ui/App.tsx");
    const hints = [...app.matchAll(/\{ key: "([^"]+)", label: "[^"]+" \}/g)].map((m) => m[1]);
    expect(hints.length).toBeGreaterThan(0);
    for (const h of hints) {
      expect(h, `hint "${h}" uses a chord that is byte-identical to Enter/Tab`)
        .not.toMatch(/\^(?:⇧)?[MI]$/);
    }
  });
});
