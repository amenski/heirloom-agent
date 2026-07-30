import React from "react";
import { Text } from "ink";
import { useTheme } from "../contexts.js";

export default function ThemedGradient({ children }: { children: string }) {
  const theme = useTheme();
  if (!theme.colorEnabled) return <Text>{children}</Text>;
  const colored = theme.fg(theme.theme.accent, children);
  return <Text>{colored}</Text>;
}
