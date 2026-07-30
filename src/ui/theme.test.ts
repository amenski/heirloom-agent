import { describe, it, expect } from "vitest";
import { detectSystemThemeFrom, type SystemThemeDeps } from "./theme.js";

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
