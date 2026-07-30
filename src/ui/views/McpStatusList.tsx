import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import { getMCPServerStatuses, getMCPServerTools, reconnectMCPServer, getServerConfigs, type McpServerStatus, type McpServerStatusEntry } from "../../mcp/connector.js";

interface Props {
  onClose: () => void;
  width: number;
}

const STATUS_ICONS: Record<McpServerStatus, string> = {
  connected: "\u2713",
  failed: "\u2717",
  reconnecting: "\u21BB",
  starting: "\u25CF",
};

export default function McpStatusList({ onClose, width }: Props) {
  const [statuses, setStatuses] = useState<McpServerStatusEntry[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [drillDown, setDrillDown] = useState<string | null>(null);

  function refresh() {
    setStatuses(getMCPServerStatuses());
  }

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 2000);
    return () => clearInterval(interval);
  }, []);

  const servers = statuses.length > 0 ? statuses : Object.keys(getServerConfigs()).map((n) => ({
    name: n,
    status: "starting" as McpServerStatus,
    toolCount: 0,
  }));

  useInput((value, key) => {
    if (drillDown) {
      if (key.escape) {
        setDrillDown(null);
        return;
      }
      return;
    }

    if (key.escape) {
      onClose();
      return;
    }
    if (key.upArrow) { setSelectedIdx((i) => Math.max(0, i - 1)); return; }
    if (key.downArrow) { setSelectedIdx((i) => Math.min(servers.length - 1, i + 1)); return; }

    if (key.return) {
      const s = servers[selectedIdx];
      if (s) setDrillDown(s.name);
      return;
    }

    if ((value === "r" || value === "R") && !key.ctrl && !key.meta) {
      const s = servers[selectedIdx];
      if (s && s.status === "failed") {
        const configs = getServerConfigs();
        if (configs[s.name]) {
          reconnectMCPServer(s.name, configs[s.name]).then(() => refresh());
        }
      }
      return;
    }
  });

  const drillDownTools = drillDown ? getMCPServerTools(drillDown) : [];

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginY={1} width={width}>
      {drillDown ? (
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text color="cyan" bold>MCP: {drillDown}</Text>
            <Text> — {drillDownTools.length} tools</Text>
          </Box>
          {drillDownTools.length === 0 ? (
            <Text dimColor>No tools registered.</Text>
          ) : (
            <Box flexDirection="column">
              {drillDownTools.map((t: any) => (
                <Box key={t.name}>
                  <Text dimColor>  </Text>
                  <Text>{t.name}</Text>
                </Box>
              ))}
            </Box>
          )}
          <Box marginTop={1}><Text dimColor>Esc to go back</Text></Box>
        </Box>
      ) : (
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text color="cyan" bold>MCP Servers</Text>
          </Box>

          {servers.length === 0 ? (
            <Text dimColor>No MCP servers configured.</Text>
          ) : (
            <Box flexDirection="column">
              {servers.map((s, i) => {
                const isSelected = i === selectedIdx;
                const icon = STATUS_ICONS[s.status] ?? "?";
                return (
                  <Box key={s.name}>
                    <Text color={isSelected ? "cyanBright" : undefined} dimColor={!isSelected}>
                      {isSelected ? "> " : "  "}
                      {icon} {s.name} ({s.toolCount} tools)
                      {s.status === "failed" && isSelected ? (
                        <Text color="yellow"> — press R to reconnect</Text>
                      ) : s.status === "failed" ? (
                        <Text dimColor color="yellow"> (failed)</Text>
                      ) : null}
                      {s.status === "reconnecting" ? (
                        <Text dimColor color="yellow"> reconnecting...</Text>
                      ) : null}
                      {s.status === "starting" ? (
                        <Text dimColor> starting...</Text>
                      ) : null}
                    </Text>
                  </Box>
                );
              })}
            </Box>
          )}

          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>↑↓ navigate · Enter drill-down · R reconnect · Esc close</Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}
