import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { SPINNER_FRAMES } from "./ToolCallFormatter.js";

interface SpinnerProps {
  /** True for the whole turn — including tool calls and follow-up model turns. */
  active: boolean;
  /** Optional theme for colored spinner */
  theme?: {
    colorEnabled: boolean;
    fg: (color: number, text: string) => string;
    theme: { spinner: number };
  };
}

/**
 * Persistent "working" indicator shown for the entire duration of a turn, so
 * there is always a live signal while the agent runs — during silent stretches
 * of tool execution, not just before the first token. Shows elapsed time and
 * the abort hint.
 *
 * The animation frame and the elapsed clock are LOCAL state on purpose. They
 * used to live in App, where a setState every 80ms (frame) and every 1000ms
 * (clock) re-rendered App's whole subtree — including OutputArea and every
 * committed transcript line. Ink then re-laid-out all of them just to discover
 * nothing had changed: O(transcript) work 12+ times a second, measured at ~4ms
 * with 200 lines but ~197ms at 8000. Past ~80ms/tick the timers queue faster
 * than they drain, so the UI stalls and only catches up once the backlog
 * clears — the "it freezes and won't take input, then catches up" report.
 * Owning the state here confines each tick to this component, so the animation
 * costs the same no matter how long the session has been running.
 *
 * Both timers are driven off `active`, so the turn lifecycle still belongs to
 * App: flipping `active` to true starts them and resets the clock to 0,
 * flipping it to false stops them.
 *
 * POSITION IS LOAD-BEARING: App renders this immediately above the status bar,
 * not under the transcript where it used to sit. Ink repaints a changed line by
 * walking the cursor up from the bottom of the frame, so every row BELOW an
 * animating line is rewritten 12.5x/second. Above the input that meant
 * continuously repainting the prompt box; here almost nothing is below it.
 */
export default function Spinner({ active, theme }: SpinnerProps) {
  const [frame, setFrame] = useState(0);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!active) return;
    // Reset per turn so each turn starts at frame 0 / 0s, matching the old
    // startSpinner()/startElapsedTimer() behavior.
    setFrame(0);
    setElapsed(0);

    const started = Date.now();
    const frameTimer = setInterval(() => {
      setFrame((f) => (f + 1) % SPINNER_FRAMES.length);
    }, 80);
    const elapsedTimer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - started) / 1000));
    }, 1000);

    return () => {
      clearInterval(frameTimer);
      clearInterval(elapsedTimer);
    };
  }, [active]);

  if (!active) return null;

  const spinnerChar = SPINNER_FRAMES[frame] ?? SPINNER_FRAMES[0];
  // Pad the seconds so the line's WIDTH is stable. An unpadded counter changes
  // width at 10s/100s, and a width change forces Ink to reflow rather than
  // overwrite in place — a second source of repaint on top of the animation.
  const secs = String(elapsed).padStart(3, " ");
  const label = `${spinnerChar} Working… (${secs}s · esc to interrupt)`;

  // Sits directly above the status bar (see App.tsx), so it needs no margin
  // below — a trailing blank row there would be one more line for Ink to walk
  // back over on every 80ms tick.
  return (
    <Box marginTop={1}>
      <Text dimColor>
        {theme?.colorEnabled ? theme.fg(theme.theme.spinner, label) : label}
      </Text>
    </Box>
  );
}
