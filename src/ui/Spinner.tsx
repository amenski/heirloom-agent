import React from "react";
import { Text } from "ink";
import { SPINNER_FRAMES } from "./ToolCallFormatter.js";

interface SpinnerProps {
  /** True for the whole turn — including tool calls and follow-up model turns. */
  active: boolean;
  /** Current spinner animation frame. */
  frame: number;
  /** Seconds elapsed since the turn started. */
  elapsed: number;
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
 */
export default function Spinner({ active, frame, elapsed, theme }: SpinnerProps) {
  if (!active) return null;

  const spinnerChar = SPINNER_FRAMES[frame] ?? SPINNER_FRAMES[0];
  const label = `${spinnerChar} Working… (${elapsed}s · esc to interrupt)`;

  if (theme?.colorEnabled) {
    return <Text dimColor>{theme.fg(theme.theme.spinner, label)}</Text>;
  }

  return <Text dimColor>{label}</Text>;
}
