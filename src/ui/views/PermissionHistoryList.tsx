import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import type { SessionStore, PermissionAuditRecord } from "../../sessions/store.js";

interface Props {
  sessionStore: SessionStore;
  sessionId: string;
  onClose: () => void;
  width: number;
}

const DECISION_COLOR: Record<string, string> = {
  deny: "#ef4444",
  once: "#22c55e",
  session: "#f59e0b",
  always: "#f59e0b",
};

const DECISION_LABEL: Record<string, string> = {
  deny: "deny",
  once: "once",
  session: "session",
  always: "always",
};

type HistoryEntry = PermissionAuditRecord & { at: string };

export default function PermissionHistoryList({ sessionStore, sessionId, onClose, width }: Props) {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedIdx, setSelectedIdx] = useState(0);

  useEffect(() => {
    let cancelled = false;
    sessionStore.queryPermissionHistory(sessionId).then((history) => {
      if (cancelled) return;
      setEntries(history);
      setLoading(false);
      setSelectedIdx(Math.max(0, history.length - 1));
    });
    return () => {
      cancelled = true;
    };
  }, [sessionStore, sessionId]);

  useInput((_value, key) => {
    if (key.escape) {
      onClose();
      return;
    }
    if (key.upArrow) {
      setSelectedIdx((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedIdx((i) => Math.min(entries.length - 1, i + 1));
      return;
    }
  });

  const selected = entries[selectedIdx];

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginY={1} width={width}>
      <Box marginBottom={1}>
        <Text color="cyan" bold>Permission History</Text>
        {entries.length > 0 && <Text dimColor> — {entries.length} decision{entries.length === 1 ? "" : "s"}</Text>}
      </Box>

      {loading ? (
        <Text dimColor>Loading…</Text>
      ) : entries.length === 0 ? (
        <Text dimColor>No permission decisions recorded yet this session.</Text>
      ) : (
        <Box flexDirection="column">
          {entries.map((entry, i) => {
            const isSelected = i === selectedIdx;
            const color = DECISION_COLOR[entry.decision] ?? undefined;
            const time = entry.at.slice(11, 19);
            return (
              <Box key={i}>
                <Text color={isSelected ? "cyanBright" : undefined} dimColor={!isSelected}>
                  {isSelected ? "> " : "  "}
                  {time} · {entry.tool}
                </Text>
                <Text color={color}> [{DECISION_LABEL[entry.decision] ?? entry.decision}]</Text>
              </Box>
            );
          })}
        </Box>
      )}

      {selected && (
        <Box flexDirection="column" marginTop={1} borderStyle="single" borderColor="gray" paddingX={1}>
          <Text dimColor>Subject: </Text>
          <Text>{selected.subject}</Text>
          {selected.winningRule && (
            <Text dimColor>
              Rule: {selected.winningRule.origin} · {selected.winningRule.kind} · "{selected.winningRule.pattern}" → {selected.winningRule.action}
            </Text>
          )}
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>↑↓ navigate · Esc close</Text>
      </Box>
    </Box>
  );
}
