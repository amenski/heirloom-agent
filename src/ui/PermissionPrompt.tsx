import React from "react";
import { Box, Text } from "ink";

interface PermissionPromptProps {
  toolName: string;
  args: Record<string, unknown>;
  colorEnabled: boolean;
}

/** Approve/deny/always prompt shown before a tool execution. */
export default function PermissionPrompt({ toolName, args, colorEnabled }: PermissionPromptProps) {
  const dim = (s: string) => colorEnabled ? `\x1b[2m${s}\x1b[0m` : s;
  const bright = (s: string) => colorEnabled ? `\x1b[97m${s}\x1b[0m` : s;

  const argLines = Object.entries(args)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => {
      const sv = typeof v === "string" ? v : JSON.stringify(v);
      return `  ${k}: ${sv.length > 80 ? sv.slice(0, 80) + "..." : sv}`;
    });

  return (
    <Box flexDirection="column">
      <Text>{dim("── ") + toolName + dim(" ─" + "─".repeat(Math.max(40 - toolName.length, 2)))}</Text>
      {argLines.map((line, i) => (
        <Text key={i}>{line}</Text>
      ))}
      <Text>
        {dim("  [")}{bright("Enter")}{dim("] ")}{bright("allow")}
        {dim("  [a] ")}{bright("always")}
        {dim("  [n] ")}{bright("deny")}
      </Text>
    </Box>
  );
}
