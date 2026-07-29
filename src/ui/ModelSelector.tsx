import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

export interface ModelEntry {
  provider: string;
  model: string;
  contextWindow?: number;
}

interface ModelSelectorProps {
  entries: ModelEntry[];
  onSelect: (entry: ModelEntry | null) => void;
  currentProvider: string;
  currentModel: string;
  colorEnabled: boolean;
}

function fmtContext(ctx?: number): string {
  if (!ctx) return "";
  const k = Math.round(ctx / 1000);
  return `ctx ${k}k`;
}

function getProviderLabel(name: string): string {
  const labels: Record<string, string> = {
    deepseek: "DeepSeek",
    openai: "OpenAI",
    openrouter: "OpenRouter",
    groq: "Groq",
    ollama: "Ollama",
  };
  return labels[name] ?? name;
}

export default function ModelSelector({
  entries,
  onSelect,
  currentProvider,
  currentModel,
  colorEnabled,
}: ModelSelectorProps) {
  const isActive = (entry: ModelEntry) =>
    entry.provider === currentProvider && entry.model === currentModel;

  // Build a flat list of renderable items: provider headers + model rows
  type Item = { type: "header"; provider: string } | { type: "model"; entry: ModelEntry };

  const items: Item[] = [];
  const addedProviders = new Set<string>();
  for (const entry of entries) {
    if (!addedProviders.has(entry.provider)) {
      addedProviders.add(entry.provider);
      items.push({ type: "header", provider: entry.provider });
    }
    items.push({ type: "model", entry });
  }

  // Index within the flat list (0-based)
  const [cursor, setCursor] = useState(() => {
    // Start on the currently active model if found
    const idx = items.findIndex(
      (it) => it.type === "model" && isActive(it.entry),
    );
    return idx >= 0 ? idx : items.findIndex((it) => it.type === "model");
  });

  const dim = (s: string) => (colorEnabled ? `\x1b[2m${s}\x1b[0m` : s);
  const bright = (s: string) => (colorEnabled ? `\x1b[97m${s}\x1b[0m` : s);

  useInput((_value: string, key: any) => {
    if (key.upArrow) {
      setCursor((c) => {
        let next = c - 1;
        while (next >= 0 && items[next].type === "header") next--;
        return next >= 0 ? next : c;
      });
      return;
    }
    if (key.downArrow) {
      setCursor((c) => {
        let next = c + 1;
        while (next < items.length && items[next].type === "header") next++;
        return next < items.length ? next : c;
      });
      return;
    }
    if (key.return) {
      const item = items[cursor];
      if (item && item.type === "model") {
        onSelect(item.entry);
      }
      return;
    }
    if (key.escape) {
      onSelect(null);
      return;
    }
  });

  const modelColWidth = Math.max(
    ...entries.map((e) => e.model.length),
    10,
  );

  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      <Box>
        <Text>{dim("┌")}{dim(" Select model ")}{dim("─".repeat(40))}</Text>
      </Box>

      {items.map((item, i) => {
        if (item.type === "header") {
          return (
            <Box key={`h-${i}`}>
              <Text>{dim("│")} </Text>
              <Text>{getProviderLabel(item.provider)}</Text>
            </Box>
          );
        }

        const entry = item.entry;
        const active = isActive(entry);
        const selected = i === cursor;

        let prefix: string;
        if (selected && active) prefix = "▶●";
        else if (selected) prefix = "▶ ";
        else if (active) prefix = " ●";
        else prefix = "  ";

        const ctx = fmtContext(entry.contextWindow);
        const label = `${prefix} ${entry.model.padEnd(modelColWidth)} ${ctx}`;

        // Build colored text segments
        let lineContent = label;
        if (selected) {
          lineContent = bright(label);
        } else if (active) {
          lineContent = bright(label);
        }

        return (
          <Box key={`m-${i}`}>
            <Text>{dim("│")} </Text>
            <Text>{lineContent}</Text>
          </Box>
        );
      })}

      <Box>
        <Text>
          {dim("└")}{dim("─".repeat(40))}{"\n"}
          {dim("  ↑↓ navigate  Enter select  Esc cancel")}
        </Text>
      </Box>
    </Box>
  );
}
