import { describe, it, expect } from "vitest";
import { startStallWatchdog } from "./stall-watchdog.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("startStallWatchdog", () => {
  it("detects a lag caused by a synchronous busy-block", async () => {
    const watchdog = startStallWatchdog({ intervalMs: 10, thresholdMs: 100 });

    // A sync block guarantees the interval cannot fire during it, so the
    // very next tick observes a lag of roughly the block's duration.
    const end = Date.now() + 250;
    while (Date.now() < end) {
      // busy-wait
    }
    await sleep(50);

    const report = await watchdog.stop();
    expect(report.count).toBeGreaterThanOrEqual(1);
    expect(report.worstLagMs).toBeGreaterThanOrEqual(100);
  });

  it("reports zero stalls when the event loop stays responsive", async () => {
    const watchdog = startStallWatchdog({ intervalMs: 10, thresholdMs: 150 });
    await sleep(80);
    const report = await watchdog.stop();
    expect(report.count).toBe(0);
    expect(report.worstLagMs).toBe(0);
  });

  it("degrades gracefully and never rejects, regardless of profiling mode", async () => {
    const watchdog = startStallWatchdog({ intervalMs: 10, thresholdMs: 150 });
    await sleep(30);
    const report = await watchdog.stop();
    expect(report).toMatchObject({
      count: expect.any(Number),
      worstLagMs: expect.any(Number),
      events: expect.any(Array),
    });
    expect(report.profilePath === null || typeof report.profilePath === "string").toBe(true);
  });

  it("caps stored events and returns a complete report shape", async () => {
    const watchdog = startStallWatchdog({ intervalMs: 5, thresholdMs: 0 });
    await sleep(100);
    const report = await watchdog.stop();
    expect(report.events.length).toBeLessThanOrEqual(1000);
    expect(report.count).toBe(report.events.length);
    expect(typeof report.worstLagMs).toBe("number");
    expect("profilePath" in report).toBe(true);
  });

  it("getStallCount reflects events observed before stop()", async () => {
    const watchdog = startStallWatchdog({ intervalMs: 10, thresholdMs: 100 });
    const end = Date.now() + 200;
    while (Date.now() < end) {
      // busy-wait
    }
    // The busy-block prevents the timer callback from running at all until
    // control returns to the event loop; give it a tick to fire.
    await sleep(20);
    expect(watchdog.getStallCount()).toBeGreaterThanOrEqual(1);
    await watchdog.stop();
  });
});
