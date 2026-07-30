import React from "react";
import { Box, Text } from "ink";
import type { PermissionRule } from "../permissions/index.js";
import { useTheme } from "./contexts.js";
import { ansi256, type ThemeContextValue } from "./theme.js";

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
  /** Semantic theme slot that colors the risk label (high=error, etc.). */
  slot: "error" | "warning" | "success";
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
    return { level: "high", slot: "error", label: "destructive command" };
  }

  if (READ_TOOLS.has(request.toolName)) {
    return { level: "low", slot: "success", label: "read-only" };
  }

  if (request.toolName === "run_bash" || request.toolName.startsWith("write") || request.toolName === "edit") {
    return { level: "medium", slot: "warning", label: "modifies state" };
  }

  return { level: "medium", slot: "warning", label: "unclassified" };
}

/** Resolve a semantic theme slot to an Ink color string, honoring the color gate. */
function slotColor(theme: ThemeContextValue, key: keyof ThemeContextValue["theme"]): string | undefined {
  if (!theme.colorEnabled) return undefined;
  return ansi256(theme.theme[key] as number);
}

const OPTIONS: { decision: PermissionDecision; label: string }[] = [
  { decision: "once", label: "Yes, just once" },
  { decision: "session", label: "Yes, for this session" },
  { decision: "always", label: "Yes, always allow" },
  { decision: "deny", label: "No" },
];

export default function PermissionPrompt({ request, cursor, onChoose, onCancel }: Props) {
  const theme = useTheme();
  const risk = riskLevel(request);
  const warningColor = slotColor(theme, "warning");
  const accentColor = slotColor(theme, "accent");

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={warningColor} paddingX={1} marginY={1}>
      <Box marginBottom={1}>
        <Text color={warningColor} bold>Permission required</Text>
      </Box>
      <Text bold>{request.toolName}</Text>
      <Text>{request.command}</Text>
      {request.description ? <Text dimColor>{request.description}</Text> : null}
      <Box marginTop={1}>
        <Text dimColor>Risk: </Text>
        <Text color={slotColor(theme, risk.slot)}>{risk.label}</Text>
      </Box>
      <Box marginTop={1}>
        <Text>Do you want to proceed?</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {OPTIONS.map((opt, i) => (
          <Text key={opt.decision} color={i === cursor ? accentColor : undefined}>
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
  const theme = useTheme();
  const errorColor = slotColor(theme, "error");
  const accentColor = slotColor(theme, "accent");

  return (
    <Box flexDirection="column" borderStyle="double" borderColor={errorColor} paddingX={1} marginY={1}>
      <Box marginBottom={1}>
        <Text color={errorColor} bold>⚠ Destructive command</Text>
      </Box>
      <Text bold>{request.toolName}</Text>
      <Text color={errorColor}>{request.command}</Text>
      {request.description ? <Text dimColor>{request.description}</Text> : null}
      <Box marginTop={1}>
        <Text dimColor>This command can cause irreversible data loss. Approving "always" whitelists only this exact command, never the whole category.</Text>
      </Box>
      <Box marginTop={1}>
        <Text>Do you want to proceed?</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {OPTIONS.map((opt, i) => (
          <Text key={opt.decision} color={i === cursor ? accentColor : undefined}>
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
