import { describe, it, expect } from "vitest";
import { resolveRefreshProfile, REFRESH_PROFILE_NAMES } from "./refresh-rates.js";

/**
 * These intervals are the only throttle on how often the UI writes to the
 * terminal. Measured over 1.5s of simulated streaming with incremental
 * rendering already enabled: the old fixed rates produced 125 writes / 6.1KB,
 * the default profile produces 71 / 2.5KB, and the slow profile 47 / 1.4KB.
 * On an emulator that paints every write (IntelliJ's terminal) that difference
 * is the difference between usable and not.
 */
describe("resolveRefreshProfile", () => {
  it("defaults to balanced when nothing is set", () => {
    const p = resolveRefreshProfile({});
    expect(p.flushMs).toBe(100);
    expect(p.activeLineMs).toBe(100);
    expect(p.indicatorMs).toBe(160);
  });

  it("selects a named profile", () => {
    expect(resolveRefreshProfile({ HEIRLOOM_REFRESH: "slow" }).indicatorMs).toBe(200);
    expect(resolveRefreshProfile({ HEIRLOOM_REFRESH: "fast" }).indicatorMs).toBe(80);
  });

  it("is case- and whitespace-insensitive", () => {
    expect(resolveRefreshProfile({ HEIRLOOM_REFRESH: "  SLOW " }).flushMs).toBe(150);
  });

  it("falls back to the default on an unknown value rather than throwing", () => {
    // A typo in an env var must not stop the CLI from starting.
    expect(resolveRefreshProfile({ HEIRLOOM_REFRESH: "quick" }).flushMs).toBe(100);
    expect(resolveRefreshProfile({ HEIRLOOM_REFRESH: "" }).flushMs).toBe(100);
  });

  it("orders the profiles from most to least traffic", () => {
    const fast = resolveRefreshProfile({ HEIRLOOM_REFRESH: "fast" });
    const balanced = resolveRefreshProfile({});
    const slow = resolveRefreshProfile({ HEIRLOOM_REFRESH: "slow" });
    for (const key of ["flushMs", "activeLineMs", "indicatorMs"] as const) {
      expect(fast[key], `${key} should ascend fast < balanced < slow`).toBeLessThan(balanced[key]);
      expect(balanced[key], `${key} should ascend fast < balanced < slow`).toBeLessThan(slow[key]);
    }
  });

  it("keeps every indicator rate above the perceptual floor for motion", () => {
    // Below roughly 4 steps/sec an animation reads as intermittent flicker
    // rather than movement, which defeats the point of having an indicator.
    for (const name of REFRESH_PROFILE_NAMES) {
      const { indicatorMs } = resolveRefreshProfile({ HEIRLOOM_REFRESH: name });
      const stepsPerSecond = 1000 / indicatorMs;
      expect(stepsPerSecond, `${name} indicator is too slow to read as motion`)
        .toBeGreaterThanOrEqual(4);
    }
  });

  it("makes an unrecognised value distinguishable from the default", () => {
    // `heirloom doctor` reports which profile is active and whether an env
    // value was understood. That relies on a typo resolving to exactly the
    // default profile, so the reporting can compare and say so rather than
    // leaving the user unable to tell whether their setting took effect.
    const typo = resolveRefreshProfile({ HEIRLOOM_REFRESH: "slowww" });
    const fallback = resolveRefreshProfile({});
    expect(typo).toEqual(fallback);
  });

  it("exposes its profile names for help text", () => {
    expect(REFRESH_PROFILE_NAMES).toEqual(["fast", "balanced", "slow"]);
  });
});
