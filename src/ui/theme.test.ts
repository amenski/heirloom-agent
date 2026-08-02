import { describe, it, expect } from "vitest";
import {
  detectSystemThemeFrom,
  resolveTheme,
  BUILTIN_THEMES,
  type SystemThemeDeps,
} from "./theme.js";

/** Build deps with sane defaults, overridable per test. */
function deps(over: Partial<SystemThemeDeps>): SystemThemeDeps {
  return {
    env: {},
    platform: "linux",
    exec: () => {
      throw new Error("exec not stubbed");
    },
    ...over,
  };
}

describe("detectSystemThemeFrom", () => {
  it("reads COLORFGBG light backgrounds (7/15)", () => {
    expect(detectSystemThemeFrom(deps({ env: { COLORFGBG: "0;7" } }))).toBe("light");
    expect(detectSystemThemeFrom(deps({ env: { COLORFGBG: "0;15" } }))).toBe("light");
    // Three-field form ("fg;x;bg") — last field wins.
    expect(detectSystemThemeFrom(deps({ env: { COLORFGBG: "0;default;15" } }))).toBe("light");
  });

  it("reads COLORFGBG dark backgrounds (0-6, 8)", () => {
    expect(detectSystemThemeFrom(deps({ env: { COLORFGBG: "15;0" } }))).toBe("dark");
    expect(detectSystemThemeFrom(deps({ env: { COLORFGBG: "15;6" } }))).toBe("dark");
    expect(detectSystemThemeFrom(deps({ env: { COLORFGBG: "15;8" } }))).toBe("dark");
  });

  it("falls through malformed COLORFGBG to the next stage", () => {
    // Non-numeric background → skip COLORFGBG; non-darwin → fallback dark.
    expect(detectSystemThemeFrom(deps({ env: { COLORFGBG: "15;default" } }))).toBe("dark");
    // Out-of-range background (e.g. 9) is neither light nor dark by our rule →
    // skip to next stage; here darwin Dark resolves it.
    expect(
      detectSystemThemeFrom(deps({ env: { COLORFGBG: "15;9" }, platform: "darwin", exec: () => "Dark\n" })),
    ).toBe("dark");
    expect(
      detectSystemThemeFrom(deps({ env: { COLORFGBG: "15;9" }, platform: "darwin", exec: () => { throw new Error("absent"); } })),
    ).toBe("light");
  });

  it("detects macOS Dark mode via AppleInterfaceStyle", () => {
    expect(detectSystemThemeFrom(deps({ platform: "darwin", exec: () => "Dark\n" }))).toBe("dark");
  });

  it("treats an absent AppleInterfaceStyle key (non-zero exit) as light", () => {
    expect(
      detectSystemThemeFrom(deps({ platform: "darwin", exec: () => { throw new Error("does not exist"); } })),
    ).toBe("light");
  });

  it("falls back to dark on non-darwin with no COLORFGBG", () => {
    expect(detectSystemThemeFrom(deps({ platform: "linux" }))).toBe("dark");
  });
});

describe("extra theme presets", () => {
  const presets: Array<{ name: string; type: "light" | "dark" | "custom" }> = [
    { name: "dracula", type: "dark" },
    { name: "monokai", type: "dark" },
    { name: "github-dark", type: "dark" },
    { name: "github-light", type: "light" },
    { name: "ansi-dark", type: "dark" },
    { name: "ansi-light", type: "light" },
  ];

  for (const { name, type } of presets) {
    it(`registers "${name}" in BUILTIN_THEMES with the right type`, () => {
      const preset = BUILTIN_THEMES[name];
      expect(preset).toBeDefined();
      expect(preset.name).toBe(name);
      expect(preset.type).toBe(type);
    });

    it(`resolves "${name}" by name`, () => {
      const resolved = resolveTheme({ mode: "dark", name });
      expect(resolved.name).toBe(name);
      expect(resolved.type).toBe(type);
    });
  }

  it("lets name take precedence over mode", () => {
    // mode "dark" would otherwise pick DARK_THEME; the named preset wins.
    const resolved = resolveTheme({ mode: "dark", name: "github-light" });
    expect(resolved.name).toBe("github-light");
    expect(resolved.type).toBe("light");
  });

  it("merges overrides on top of a named preset", () => {
    const resolved = resolveTheme({
      mode: "dark",
      name: "dracula",
      overrides: { accent: 200, syntax: { keyword: 111 } as any },
    });
    expect(resolved.name).toBe("dracula");
    expect(resolved.accent).toBe(200);
    // Overridden syntax slot merges; untouched slots stay from the preset.
    expect(resolved.syntax.keyword).toBe(111);
    expect(resolved.syntax.string).toBe(BUILTIN_THEMES.dracula.syntax.string);
  });

  it("falls back gracefully for an unknown name (mode wins)", () => {
    const resolved = resolveTheme({ mode: "light", name: "does-not-exist" });
    expect(resolved.name).toBe("light");
  });
});
