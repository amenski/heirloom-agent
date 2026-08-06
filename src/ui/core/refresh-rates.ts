// How often the UI is allowed to repaint.
//
// Every tick of these timers dirties part of the frame and makes Ink write to
// the terminal, so they are a direct throttle on repaint traffic. Fast
// emulators (iTerm, Terminal.app, Alacritty) coalesce writes and the cost is
// invisible. Slower ones — notably IntelliJ's embedded terminal — paint each
// write, so a high refresh rate reads as continuous flicker.
//
// Measured over 1.5s of simulated streaming (transcript growing, active line
// changing, indicator animating), with incremental rendering already on:
//
//   profile        flush  indicator   writes   bytes
//   fast (was)      50ms       80ms      125    6.1KB
//   balanced       100ms      160ms       71    2.5KB
//   slow           150ms      200ms       47    1.4KB
//
// "balanced" is the default: 2.4x less traffic than before, and the indicator
// still advances 6.3 times a second — comfortably above the ~4-5 steps/sec
// floor where an animation stops reading as motion.

export type RefreshProfile = {
  /** Interval for draining queued output lines into the transcript. */
  flushMs: number;
  /** Interval for committing the streaming active line to the rendered frame. */
  activeLineMs: number;
  /** Interval for advancing the working indicator. */
  indicatorMs: number;
};

const PROFILES: Record<string, RefreshProfile> = {
  // For terminals that coalesce writes well. Smoothest, most traffic.
  fast: { flushMs: 50, activeLineMs: 50, indicatorMs: 80 },
  // Default. Halves the traffic with no perceptible loss of smoothness.
  balanced: { flushMs: 100, activeLineMs: 100, indicatorMs: 160 },
  // For emulators that paint every write (IntelliJ, some SSH sessions, tmux
  // over a slow link). Streaming text arrives in visible chunks rather than
  // continuously, which is the tradeoff for a stable frame.
  slow: { flushMs: 150, activeLineMs: 150, indicatorMs: 200 },
};

const DEFAULT_PROFILE = "balanced";

/**
 * Resolve the active refresh profile.
 *
 * `HEIRLOOM_REFRESH` selects a named profile (fast | balanced | slow). An
 * unrecognised value falls back to the default rather than throwing — a typo
 * in an env var should not stop the CLI from starting.
 */
export function resolveRefreshProfile(
  env: NodeJS.ProcessEnv = process.env,
): RefreshProfile {
  const name = (env.HEIRLOOM_REFRESH ?? "").trim().toLowerCase();
  return PROFILES[name] ?? PROFILES[DEFAULT_PROFILE];
}

/** The profile names a user can select, for help text and validation. */
export const REFRESH_PROFILE_NAMES = Object.keys(PROFILES);
