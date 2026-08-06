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
 * - "^M model" worked, but not via the binding it appeared to use: App's
 *   openModelPicker action is shadowed by PromptInput's own ctrl+m handler.
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
});
