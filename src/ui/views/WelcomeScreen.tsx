import React, { useMemo, useState } from "react";
import { Box, Text } from "ink";
import { getSlashCommands } from "../core/slash-commands.js";
import { heirloomLogo } from "../ascii-art.js";
import ThemedGradient from "./ThemedGradient.js";
import { useTheme } from "../contexts.js";
import { ansi256 } from "../theme.js";

const SHORTCUT_TIPS = [
  { label: "Enter", description: "Send the prompt" },
  { label: "Shift+Enter", description: "Insert a newline" },
  { label: "Esc", description: "Interrupt the current model turn" },
  { label: "/", description: "Open the slash command menu" },
  { label: "/model", description: "Select model and thinking mode" },
  { label: "/new", description: "Start a fresh conversation" },
  { label: "/resume", description: "Pick a previous session" },
  { label: "Ctrl+M", description: "Open model picker" },
  { label: "Ctrl+D twice", description: "Quit" },
];

interface Props {
  model: string;
  thinkingEnabled: boolean;
  reasoningEffort?: string;
  cwd: string;
  width: number;
}

export default function WelcomeScreen({ model, thinkingEnabled, reasoningEffort, cwd, width }: Props) {
  const theme = useTheme();
  const accent = theme.colorEnabled ? ansi256(theme.theme.accent) : undefined;
  const tips = useMemo(() => {
    const slashItems = getSlashCommands();
    return [...slashItems.map(s => ({ label: s.label, description: s.description })), ...SHORTCUT_TIPS.filter(
      t => !slashItems.some(s => s.label === t.label)
    )];
  }, []);

  const [tipIndex] = useState(() => tips.length > 0 ? Math.floor(Math.random() * tips.length) : 0);
  const tip = tips[Math.min(tipIndex, tips.length - 1)] ?? tips[0];
  const compact = width < 70;
  const narrow = width < 112;

  function formatCwd(path: string): string {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    const resolved = path.startsWith(home) ? "~" + path.slice(home.length) : path;
    return resolved.length > 40 ? "…" + resolved.slice(-37) : resolved;
  }

  const logo = heirloomLogo();

  return (
    <Box flexDirection="column" marginY={1} paddingX={narrow ? 0 : 1}>
      <Box marginBottom={1}>
        <ThemedGradient>{logo}</ThemedGradient>
      </Box>
      <Box flexDirection="column" width={compact ? undefined : narrow ? undefined : 72}>
        <Box borderStyle="round" borderColor={accent} flexDirection="column" paddingX={1}>
          <Box marginBottom={1}>
            <Text bold color={accent}>{">"}_ Heirloom</Text>
          </Box>
          <SettingRow label="Model" value={model} />
          <SettingRow label="Thinking" value={thinkingEnabled ? (reasoningEffort ?? "enabled") : "disabled"} />
          <SettingRow label="CWD" value={formatCwd(cwd)} />
        </Box>
      </Box>
      {tip && (
        <Box marginTop={1}>
          <Text dimColor>Tip: {tip.label} — {tip.description}</Text>
        </Box>
      )}
    </Box>
  );
}

function SettingRow({ label, value }: { label: string; value: string }) {
  return (
    <Box flexDirection="row">
      <Box width={14}><Text>{label}</Text></Box>
      <Box flexGrow={1} justifyContent="flex-end"><Text>{value}</Text></Box>
    </Box>
  );
}
