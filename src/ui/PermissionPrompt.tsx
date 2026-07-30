import React from "react";
import { Box, Text } from "ink";
import type { PermissionRule } from "../permissions/index.js";

export interface PermissionRequest {
  toolName: string;
  command: string;
  description?: string;
  /** The rule the engine matched to produce this ask (if any) — drives risk display. */
  winningRule?: PermissionRule;
}

export type PermissionDecision = "once" | "session" | "always" | "deny";

interface Props {
  request: PermissionRequest;
  cursor: number;
  onChoose: (decision: PermissionDecision) => void;
  onCancel: () => void;
}

export interface RiskInfo {
  level: "low" | "medium" | "high";
  color: string;
  label: string;
}

const READ_TOOLS = new Set(["read_file", "read", "list_files", "glob", "search", "load_skill"]);

/**
 * Risk is driven by the matched rule, not a static per-scope table: a
 * destructive-origin match is always high risk regardless of tool, a write
 * or run_bash call with no narrowing rule is medium, and a plain read is low.
 */
export function riskLevel(request: PermissionRequest): RiskInfo {
  const rule = request.winningRule;

  if (rule?.origin === "builtin-destructive") {
    return { level: "high", color: "#ef4444", label: "destructive command" };
  }

  if (READ_TOOLS.has(request.toolName)) {
    return { level: "low", color: "#22c55e", label: "read-only" };
  }

  if (request.toolName === "run_bash" || request.toolName.startsWith("write") || request.toolName === "edit") {
    return { level: "medium", color: "#f59e0b", label: "modifies state" };
  }

  return { level: "medium", color: "#f59e0b", label: "unclassified" };
}

const OPTIONS: { decision: PermissionDecision; label: string }[] = [
  { decision: "once", label: "Yes, just once" },
  { decision: "session", label: "Yes, for this session" },
  { decision: "always", label: "Yes, always allow" },
  { decision: "deny", label: "No" },
];

export default function PermissionPrompt({ request, cursor, onChoose, onCancel }: Props) {
  const risk = riskLevel(request);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginY={1}>
      <Box marginBottom={1}>
        <Text color="yellow" bold>Permission required</Text>
      </Box>
      <Text bold>{request.toolName}</Text>
      <Text>{request.command}</Text>
      {request.description ? <Text dimColor>{request.description}</Text> : null}
      <Box marginTop={1}>
        <Text dimColor>Risk: </Text>
        <Text color={risk.color}>{risk.label}</Text>
      </Box>
      <Box marginTop={1}>
        <Text>Do you want to proceed?</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {OPTIONS.map((opt, i) => (
          <Text key={opt.decision} color={i === cursor ? "cyanBright" : undefined}>
            {i === cursor ? "> " : "  "}
            {i + 1}. {opt.label}
          </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>1-4 select · ↑↓ navigate · Esc cancel</Text>
      </Box>
    </Box>
  );
}

/**
 * Stronger-confirmation variant shown when the winning rule is
 * destructive-origin. v1 scope cut: visually distinct (red banner, explicit
 * warning) rather than a new typed/held-confirmation input paradigm — the
 * load-bearing safety property is the engine forcing kind "exact" on
 * approval (see PermissionEngine.narrowToExact), which doesn't depend on
 * this prompt's interaction style.
 */
export function DestructiveConfirmPrompt({ request, cursor, onChoose, onCancel }: Props) {
  return (
    <Box flexDirection="column" borderStyle="double" borderColor="#ef4444" paddingX={1} marginY={1}>
      <Box marginBottom={1}>
        <Text color="#ef4444" bold>⚠ Destructive command</Text>
      </Box>
      <Text bold>{request.toolName}</Text>
      <Text color="#ef4444">{request.command}</Text>
      {request.description ? <Text dimColor>{request.description}</Text> : null}
      <Box marginTop={1}>
        <Text dimColor>This command can cause irreversible data loss. Approving "always" whitelists only this exact command, never the whole category.</Text>
      </Box>
      <Box marginTop={1}>
        <Text>Do you want to proceed?</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {OPTIONS.map((opt, i) => (
          <Text key={opt.decision} color={i === cursor ? "cyanBright" : undefined}>
            {i === cursor ? "> " : "  "}
            {i + 1}. {opt.label}
          </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>1-4 select · ↑↓ navigate · Esc cancel</Text>
      </Box>
    </Box>
  );
}

export function buildPermissionRequest(toolName: string, args: Record<string, unknown>, winningRule?: PermissionRule): PermissionRequest {
  const cmd = (args.command as string) || (args.path as string) || (args.filePath as string) || "";
  return { toolName, command: cmd, winningRule };
}
