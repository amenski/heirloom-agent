import React from "react";
import { Box, Text } from "ink";
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

  // marginY gives the indicator a blank line above and below so it doesn't sit
  // cramped against the output and the input box. The margin only exists while
  // the indicator renders (it returns null when inactive).
  return (
    <Box marginY={1}>
      <Text dimColor>
        {theme?.colorEnabled ? theme.fg(theme.theme.spinner, label) : label}
      </Text>
    </Box>
  );
}
