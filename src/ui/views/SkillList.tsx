import React, { useState, useMemo, useRef, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import type { SkillDef } from "../../skills/index.js";
import { useTheme } from "../contexts.js";
import { ansi256, type ThemeContextValue } from "../theme.js";

/** Resolve a semantic theme slot to an Ink color string, honoring the color gate. */
function slotColor(theme: ThemeContextValue, key: keyof ThemeContextValue["theme"]): string | undefined {
  if (!theme.colorEnabled) return undefined;
  return ansi256(theme.theme[key] as number);
}

interface Props {
  skills: SkillDef[];
  /** User picked a skill; the host force-loads it (like /skill <name>). */
  onSelect: (name: string) => void;
  onClose: () => void;
  width: number;
  height: number;
}

/**
 * Selectable list of available skills. Mirrors SessionList's navigation and
 * search so /skills behaves like the other interactive pickers rather than
 * dumping plain text into the scrollback. Enter force-loads the selected
 * skill; Esc closes.
 */
export default function SkillList({ skills, onSelect, onClose, width, height }: Props) {
  const theme = useTheme();
  const accent = slotColor(theme, "accent");
  const borderColor = slotColor(theme, "border");
  const [searchText, setSearchText] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const searchRef = useRef("");

  const filtered = useMemo(() => {
    const q = searchText.toLowerCase();
    if (!q) return skills;
    return skills.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        (s.description ?? "").toLowerCase().includes(q),
    );
  }, [skills, searchText]);

  // Each row now spans ~3 terminal lines (name + indented wrapped description +
  // margin), so budget the visible height accordingly rather than 1 line/row —
  // otherwise the slice overflows and pushes the footer off-screen.
  const APPROX_LINES_PER_ROW = 3;
  const pageSize = Math.max(3, Math.floor((height - 8) / APPROX_LINES_PER_ROW));
  const safeIndex = Math.max(0, Math.min(selectedIndex, filtered.length - 1));

  useEffect(() => {
    if (safeIndex < scrollOffset) setScrollOffset(safeIndex);
    else if (safeIndex >= scrollOffset + pageSize) setScrollOffset(safeIndex - pageSize + 1);
  }, [safeIndex, pageSize, scrollOffset]);

  const visible = filtered.slice(scrollOffset, scrollOffset + pageSize);

  useInput((value, key) => {
    if (key.escape) {
      if (searchText) {
        setSearchText("");
        searchRef.current = "";
        return;
      }
      onClose();
      return;
    }
    if (key.upArrow) {
      setSelectedIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedIndex((i) => Math.min(filtered.length - 1, i + 1));
      return;
    }
    if (key.return) {
      const s = filtered[safeIndex];
      if (s) onSelect(s.name);
      return;
    }
    if (key.backspace && searchText && !value) {
      searchRef.current = searchRef.current.slice(0, -1);
      setSearchText(searchRef.current);
      return;
    }
    if (value && value.length === 1 && !key.ctrl && !key.meta && !key.shift) {
      searchRef.current += value;
      setSearchText(searchRef.current);
      setSelectedIndex(0);
      setScrollOffset(0);
      return;
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={borderColor} paddingX={1} marginY={1} width={width}>
      <Box marginBottom={1}>
        <Text color={accent} bold>Skills</Text>
        {searchText && <Text dimColor> — matching "{searchText}"</Text>}
      </Box>

      {filtered.length === 0 ? (
        <Text dimColor>{skills.length === 0 ? "No skills available." : "No skills match."}</Text>
      ) : (
        <Box flexDirection="column">
          {scrollOffset > 0 && (
            <Text dimColor>{`  ... (${scrollOffset} more above) ...`}</Text>
          )}
          {visible.map((s, i) => {
            const globalIdx = scrollOffset + i;
            const isSelected = globalIdx === safeIndex;
            // Name on its own line, description indented beneath it. The
            // description sits in its own padded Box so wrapped continuation
            // lines hang-indent under the name rather than running to the left
            // margin and merging every skill into one text wall.
            return (
              <Box key={s.name} flexDirection="column" marginBottom={1}>
                <Text color={isSelected ? accent : undefined} bold={isSelected}>
                  {isSelected ? "> " : "  "}
                  {s.name}
                </Text>
                <Box paddingLeft={4}>
                  <Text dimColor wrap="wrap">{s.description || "no description"}</Text>
                </Box>
              </Box>
            );
          })}
          {scrollOffset + pageSize < filtered.length && (
            <Text dimColor>{`  ... (${filtered.length - scrollOffset - pageSize} more below) ...`}</Text>
          )}
        </Box>
      )}

      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>↑↓ navigate · Enter load · Esc close</Text>
        {searchText && <Text dimColor>Search: {searchText}</Text>}
      </Box>
    </Box>
  );
}
