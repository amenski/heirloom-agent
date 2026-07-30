import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import DropdownMenu from "../DropdownMenu/index.js";
import { scanFileMentionItems, filterFileMentionItems, type FileMentionItem } from "../../core/file-mentions.js";

interface Props {
  open: boolean;
  width: number;
  projectRoot: string;
  query: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}

const FileMentionMenu: React.FC<Props> = ({ open, width, projectRoot, query, onSelect, onClose }) => {
  const [items, setItems] = useState<FileMentionItem[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const filtered = filterFileMentionItems(items, query);

  useEffect(() => {
    if (open) {
      setItems(scanFileMentionItems(projectRoot));
      setActiveIndex(0);
    }
  }, [open, projectRoot]);

  useEffect(() => {
    if (activeIndex >= filtered.length) setActiveIndex(Math.max(0, filtered.length - 1));
  }, [filtered.length, activeIndex]);

  useInput(
    (input, key) => {
      if (!open) return;
      if (key.escape) { onClose(); return; }
      if (key.upArrow) { if (filtered.length > 0) setActiveIndex((i) => (i - 1 + filtered.length) % filtered.length); return; }
      if (key.downArrow) { if (filtered.length > 0) setActiveIndex((i) => (i + 1) % filtered.length); return; }
      if (key.tab || (key.return && !key.shift && !key.meta)) {
        const selected = filtered[activeIndex];
        if (selected) { onSelect(selected.path); return; }
        if (key.tab) { onClose(); return; }
      }
    },
    { isActive: open },
  );

  if (!open) return null;

  return (
    <DropdownMenu
      width={width}
      title="Mention File"
      helpText="Enter/Tab insert · Esc close"
      emptyText={query ? "No matching files" : "Type after @ to search files"}
      items={filtered.map((item) => ({
        key: item.path,
        label: item.path,
        description: item.type === "directory" ? "directory" : "file",
      }))}
      activeIndex={activeIndex}
      activeColor="#229ac3"
      maxVisible={8}
      renderItem={(item, isActive) => (
        <Box flexDirection="row" paddingX={1} gap={1}>
          <Text color={isActive ? "#229ac3" : undefined}>{isActive ? "> " : "  "}</Text>
          <Box flexGrow={1}>
            <Text color={isActive ? "#229ac3" : undefined} wrap="truncate-end" bold={isActive}>{item.label}</Text>
          </Box>
          {item.description ? (
            <Box width={10} flexShrink={0}><Text dimColor>{item.description}</Text></Box>
          ) : null}
        </Box>
      )}
    />
  );
};

export default FileMentionMenu;
