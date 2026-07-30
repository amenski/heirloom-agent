import React from "react";
import { Text } from "ink";
import { SPINNER_FRAMES } from "./ToolCallFormatter.js";

interface SpinnerProps {
  busy: boolean;
  firstToken: boolean;
  frame: number;
  /** Optional theme for colored spinner */
  theme?: {
    colorEnabled: boolean;
    fg: (color: number, text: string) => string;
    theme: { spinner: number };
  };
}

/** Animated "thinking..." indicator shown while the agent is generating. */
export default function Spinner({ busy, firstToken, frame, theme }: SpinnerProps) {
  if (!busy || firstToken) return null;

  const spinnerChar = SPINNER_FRAMES[frame] ?? SPINNER_FRAMES[0];
  const label = `${spinnerChar} thinking... (esc to abort)`;

  if (theme?.colorEnabled) {
    return <Text dimColor>{theme.fg(theme.theme.spinner, label)}</Text>;
  }

  return <Text dimColor>{label}</Text>;
}
