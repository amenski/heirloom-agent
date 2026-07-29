import React from "react";
import { Text } from "ink";
import { SPINNER_FRAMES } from "./ToolCallFormatter.js";

interface SpinnerProps {
  busy: boolean;
  firstToken: boolean;
  frame: number;
}

/** Animated "thinking..." indicator shown while the agent is generating. */
export default function Spinner({ busy, firstToken, frame }: SpinnerProps) {
  if (!busy || firstToken) return null;

  return (
    <Text dimColor>{SPINNER_FRAMES[frame]} thinking... (esc to abort)</Text>
  );
}
