import React from "react";
import { Text } from "ink";
import type { StatusSegment } from "./types.js";

interface StatusBarProps {
  segments: StatusSegment[];
}

/** Bottom status bar showing mode, model, context usage, and cost. */
export default function StatusBar({ segments }: StatusBarProps) {
  if (segments.length === 0) return null;

  return (
    <Text>
      {segments.map((seg, i) => (
        <Text key={i} bold={seg.bold} dimColor={seg.dimColor} color={seg.color as any}>
          {seg.text}
        </Text>
      ))}
    </Text>
  );
}
