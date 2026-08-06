import React, { useMemo, useState } from "react";
import { Box, Text } from "ink";
import { getSlashCommands } from "../core/slash-commands.js";
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

/**
 * The session header: a wordmark and one line of context.
 *
 * This used to be a six-row ASCII banner plus a six-row settings panel. Two
 * problems with that, both measured rather than assumed:
 *
 * 1. It is PINNED for the whole session (see App.tsx) — not a splash you scroll
 *    past. Fifteen rows is 63% of a standard 24-row terminal, permanently
 *    unavailable to the conversation.
 * 2. The banner mixed glyphs at 61 columns wide. In JetBrains Mono, ASCII,
 *    block-full, block-half and box-drawing all advance 9.625px, but quadrant
 *    glyphs advance 9.667px — a 0.4% drift that compounds across 61 columns
 *    into visible row-to-row skew. A short mark cannot accumulate that error.
 *
 * The mark is reverse video (text on an accent slab) — the highest-contrast
 * device a terminal offers, and the same treatment already used for chips in
 * the status bar and key-caps in the hint bar, so it reads as one system.
 */
export default function WelcomeScreen({ model, thinkingEnabled, reasoningEffort, cwd, width }: Props) {
  const theme = useTheme();
  const accent = theme.colorEnabled ? ansi256(theme.theme.accent) : undefined;
  const inverseFg = theme.colorEnabled ? ansi256(theme.theme.textInverse) : undefined;

  const tips = useMemo(() => {
    const slashItems = getSlashCommands();
    return [...slashItems.map(s => ({ label: s.label, description: s.description })), ...SHORTCUT_TIPS.filter(
      t => !slashItems.some(s => s.label === t.label)
    )];
  }, []);

  const [tipIndex] = useState(() => tips.length > 0 ? Math.floor(Math.random() * tips.length) : 0);
  const tip = tips[Math.min(tipIndex, tips.length - 1)] ?? tips[0];

  function formatCwd(path: string): string {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    const resolved = path.startsWith(home) ? "~" + path.slice(home.length) : path;
    return resolved.length > 40 ? "…" + resolved.slice(-37) : resolved;
  }

  // One line of context, in the same "·"-separated vocabulary as the status
  // bar. The model/thinking/cwd used to be a bordered three-row panel that
  // restated what the status bar already shows a few rows below.
  const thinking = thinkingEnabled ? (reasoningEffort ?? "on") : "off";
  const context = `${model} · thinking ${thinking} · ${formatCwd(cwd)}`;

  return (
    <Box flexDirection="column" marginY={1}>
      <Box>
        <Text backgroundColor={accent} color={inverseFg} bold>
          {" HEIRLOOM "}
        </Text>
        <Text dimColor>{"  " + context}</Text>
      </Box>
      {tip && (
        <Box marginTop={1}>
          <Text dimColor>Tip: {tip.label} — {tip.description}</Text>
        </Box>
      )}
    </Box>
  );
}
