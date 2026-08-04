import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { ModelEntry } from "../../types.js";
import { useTheme } from "../../contexts.js";
import { ansi256, type ThemeContextValue } from "../../theme.js";
import {
  buildRows,
  moveSelection,
  selectableIndices,
  formatContext,
  type PickerRow,
} from "../../core/model-picker.js";

/** Resolve a semantic theme slot to an Ink color string, honoring the color gate. */
function slotColor(theme: ThemeContextValue, key: keyof ThemeContextValue["theme"]): string | undefined {
  if (!theme.colorEnabled) return undefined;
  return ansi256(theme.theme[key] as number);
}

interface Props {
  open: boolean;
  providerName: string;
  currentModel: string | undefined;
  entries: ModelEntry[];
  /** Provider name -> whether an API key is resolvable. Unconfigured ones are dimmed. */
  configured?: Record<string, boolean>;
  /** Display names for providers (deepseek -> DeepSeek). */
  labels?: Record<string, string>;
  width: number;
  height?: number;
  onClose: () => void;
  onSelect: (provider: string, model: string) => void;
}

/**
 * Searchable model picker: type to fuzzy-filter across provider and model name,
 * with results grouped under provider headings.
 *
 * Rows are a flat list where headers are display-only; navigation steps over
 * them via selectableIndices/moveSelection so arrow keys only ever land on a
 * real model. Matching/grouping lives in ../../core/model-picker.js so the
 * rules stay unit-testable apart from rendering.
 */
const ModelsDropdown: React.FC<Props> = ({
  open, providerName, currentModel, entries, configured, labels,
  width, height = 24, onClose, onSelect,
}) => {
  const theme = useTheme();
  const accent = slotColor(theme, "accent");
  const borderColor = slotColor(theme, "border");

  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(-1);
  const [scrollOffset, setScrollOffset] = useState(0);
  const queryRef = useRef("");

  const rows = useMemo(
    () => buildRows({ entries, query, currentProvider: providerName, currentModel, configured, labels }),
    [entries, query, providerName, currentModel, configured, labels],
  );

  // Anchor the cursor while rendering rather than in an effect. An effect keyed
  // on `rows` re-fires every render (rows is a fresh array) and fights the
  // arrow keys; keying it on `query` alone reads `rows` from a stale closure.
  // Deriving it here keeps the cursor valid for the rows actually on screen:
  // with no query it sits on the active model, while filtering it sits on the
  // top hit so Enter takes the obvious match.
  const selectable = useMemo(() => selectableIndices(rows), [rows]);
  const anchored = useMemo(() => {
    if (selectable.length === 0) return -1;
    if (!query) {
      const currentIdx = rows.findIndex((r) => r.kind === "model" && r.current);
      if (currentIdx >= 0) return currentIdx;
    }
    return selectable[0];
  }, [rows, selectable, query]);

  // `cursor` is -1 until the user moves; -1 means "wherever anchoring says".
  const effectiveCursor = cursor >= 0 && selectable.includes(cursor) ? cursor : anchored;

  // Drop a stale cursor when the query changes so the next arrow key steps from
  // the visible anchor instead of a row that has been filtered away.
  useEffect(() => {
    setCursor(-1);
  }, [query, open]);

  const pageSize = Math.max(4, height - 8);

  useEffect(() => {
    if (effectiveCursor < 0) return;
    if (effectiveCursor < scrollOffset) setScrollOffset(effectiveCursor);
    else if (effectiveCursor >= scrollOffset + pageSize) setScrollOffset(effectiveCursor - pageSize + 1);
  }, [effectiveCursor, pageSize, scrollOffset]);

  function selectItem(): void {
    const row = rows[effectiveCursor];
    if (!row || row.kind !== "model") return;
    onSelect(row.provider, row.model);
    onClose();
  }

  useInput(
    (input, key) => {
      if (!open) return;
      if (key.escape) {
        // First Esc clears an active search, second closes — same as SkillList.
        if (queryRef.current) {
          queryRef.current = "";
          setQuery("");
          setScrollOffset(0);
          return;
        }
        onClose();
        return;
      }
      // Step from effectiveCursor so the first arrow key moves relative to the
      // row the user can see highlighted, not from an unset -1.
      if (key.upArrow) { setCursor(moveSelection(rows, effectiveCursor, -1)); return; }
      if (key.downArrow) { setCursor(moveSelection(rows, effectiveCursor, 1)); return; }
      if (key.return) { selectItem(); return; }
      if (key.tab) { onClose(); return; }
      if (key.backspace || key.delete) {
        if (queryRef.current) {
          queryRef.current = queryRef.current.slice(0, -1);
          setQuery(queryRef.current);
          setScrollOffset(0);
        }
        return;
      }
      // Space is a search character here, not a selector — the list is
      // filterable, so typing must take precedence.
      //
      // Do NOT gate on input.length === 1: a fast typist or a paste arrives as
      // one multi-character chunk, and requiring a single char silently drops
      // it. Filter out control bytes instead and append whatever printable
      // text came through.
      if (input && !key.ctrl && !key.meta) {
        // eslint-disable-next-line no-control-regex
        const printable = input.replace(/[\x00-\x1f\x7f]/g, "");
        if (!printable) return;
        queryRef.current += printable;
        setQuery(queryRef.current);
        setScrollOffset(0);
        return;
      }
    },
    { isActive: open },
  );

  if (!open) return null;

  const visible = rows.slice(scrollOffset, scrollOffset + pageSize);
  const hiddenAbove = scrollOffset;
  const hiddenBelow = Math.max(0, rows.length - scrollOffset - pageSize);
  const labelWidth = Math.max(
    12,
    ...rows.filter((r): r is Extract<PickerRow, { kind: "model" }> => r.kind === "model")
      .map((r) => r.label.length),
  );

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={borderColor} paddingX={1} marginY={1} width={width}>
      <Box marginBottom={1}>
        <Text color={accent} bold>Select Model</Text>
        <Text dimColor> — search: </Text>
        <Text>{query || "…"}</Text>
      </Box>

      {rows.length === 0 ? (
        <Text dimColor>No models match "{query}".</Text>
      ) : (
        <Box flexDirection="column">
          {hiddenAbove > 0 && <Text dimColor>{`  ... (${hiddenAbove} more above) ...`}</Text>}
          {visible.map((row, i) => {
            const idx = scrollOffset + i;
            if (row.kind === "header") {
              return (
                <Box key={`h:${row.provider}`} marginTop={i === 0 ? 0 : 1}>
                  <Text color={accent} bold>{row.label}</Text>
                </Box>
              );
            }
            const isSelected = idx === effectiveCursor;
            const ctx = formatContext(row.contextWindow);
            const note = !row.configured ? "no key" : row.current ? "current" : "";
            return (
              <Box key={`${row.provider}/${row.model}`}>
                <Text
                  color={isSelected ? accent : undefined}
                  bold={isSelected}
                  dimColor={!isSelected && !row.configured}
                >
                  {isSelected ? "> " : "  "}
                  {row.label.padEnd(labelWidth)}
                </Text>
                {ctx && <Text dimColor>{"  " + ctx}</Text>}
                {note && <Text dimColor>{"  " + note}</Text>}
              </Box>
            );
          })}
          {hiddenBelow > 0 && <Text dimColor>{`  ... (${hiddenBelow} more below) ...`}</Text>}
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>↑↓ navigate · Enter select · type to search · Esc close</Text>
      </Box>
    </Box>
  );
};

export default ModelsDropdown;
