import React, { useEffect, useMemo, useState } from "react";
import { Box, Text } from "ink";
import type { PermissionScope } from "../permissions/index.js";

interface PermissionRequest {
  toolName: string;
  command: string;
  description?: string;
  scopes: PermissionScope[];
}

interface Props {
  request: PermissionRequest;
  scopeIndex: number;
  cursor: number;
  onChoose: (decision: "allow" | "always" | "deny", scope: PermissionScope) => void;
  onCancel: () => void;
}

const SCOPE_RISK: Record<string, { color: string; description: string }> = {
  "read-in-cwd": { color: "#22c55e", description: "reads inside this workspace" },
  "read-out-cwd": { color: "#f59e0b", description: "reads outside this workspace" },
  "write-in-cwd": { color: "#f59e0b", description: "writes inside this workspace" },
  "write-out-cwd": { color: "#ef4444", description: "writes outside this workspace" },
  "delete-in-cwd": { color: "#ef4444", description: "deletes inside this workspace" },
  "delete-out-cwd": { color: "#ef4444", description: "deletes outside this workspace" },
  "query-git-log": { color: "#22c55e", description: "queries git history" },
  "mutate-git-log": { color: "#ef4444", description: "changes git history" },
  "network": { color: "#f59e0b", description: "network access" },
  "mcp": { color: "#f59e0b", description: "MCP tool access" },
};

function getScopeInfo(scope: PermissionScope) {
  return SCOPE_RISK[scope] ?? { color: "#ef4444", description: scope };
}

const OPTIONS = [
  { kind: "allow" as const, label: "Yes" },
  { kind: "always" as const, label: "Yes, and always allow" },
  { kind: "deny" as const, label: "No" },
];

export default function PermissionPrompt({ request, scopeIndex, cursor, onChoose, onCancel }: Props) {
  const scope = request.scopes[scopeIndex];
  if (!scope) return null;

  const scopeInfo = getScopeInfo(scope);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginY={1}>
      <Box marginBottom={1}>
        <Text color="yellow" bold>Permission required</Text>
        {request.scopes.length > 1 && (
          <Text dimColor> {scopeIndex + 1}/{request.scopes.length}</Text>
        )}
      </Box>
      <Text bold>{request.toolName}</Text>
      <Text>{request.command}</Text>
      {request.description ? <Text dimColor>{request.description}</Text> : null}
      <Box marginTop={1}>
        <Text dimColor>Scope: </Text>
        <Text color={scopeInfo.color}>{scope}</Text>
        <Text dimColor> — {scopeInfo.description}</Text>
      </Box>
      <Box marginTop={1}>
        <Text>Do you want to proceed?</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {OPTIONS.map((opt, i) => (
          <Text key={opt.kind} color={i === cursor ? "cyanBright" : undefined}>
            {i === cursor ? "> " : "  "}
            {i + 1}. {opt.label}
            {opt.kind === "always" && (
              <Text color={scopeInfo.color}> {scope}</Text>
            )}
          </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>1-3 select · ↑↓ navigate · Esc cancel</Text>
      </Box>
    </Box>
  );
}

export function buildPermissionRequest(toolName: string, args: Record<string, unknown>, scopes: PermissionScope[]): PermissionRequest {
  const cmd = args.command as string || args.path as string || args.filePath as string || "";
  return { toolName, command: cmd, scopes };
}
