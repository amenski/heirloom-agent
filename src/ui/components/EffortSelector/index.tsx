import React, { useEffect, useState } from "react";
import { useInput } from "ink";
import DropdownMenu from "../DropdownMenu/index.js";
import { useTheme } from "../../contexts.js";
import { ansi256 } from "../../theme.js";

const DEFAULT_EFFORT_LEVELS = ["high", "max"] as const;

interface Props {
  open: boolean;
  currentEffort: string | undefined;
  /** Valid effort values for the active model (from its preset's effort.values). */
  values?: readonly string[];
  width: number;
  onClose: () => void;
  onSelect: (effort: string) => void;
}

const EffortSelector: React.FC<Props> = ({
  open, currentEffort, values = DEFAULT_EFFORT_LEVELS, width, onClose, onSelect,
}) => {
  const theme = useTheme();
  const accent = theme.colorEnabled ? ansi256(theme.theme.accent) : undefined;
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    if (open) {
      const idx = values.indexOf(currentEffort ?? "");
      setActiveIndex(idx >= 0 ? idx : Math.max(0, values.length - 1));
    }
  }, [open, currentEffort, values]);

  function selectItem(): void {
    onSelect(values[activeIndex] ?? values[values.length - 1]);
    onClose();
  }

  useInput(
    (input, key) => {
      if (!open) return;
      if (key.upArrow) { setActiveIndex((i) => (i - 1 + values.length) % values.length); return; }
      if (key.downArrow) { setActiveIndex((i) => (i + 1) % values.length); return; }
      if ((input === " " && !key.ctrl && !key.meta) || (key.return && !key.shift && !key.meta)) { selectItem(); return; }
      if (key.tab || key.escape) { onClose(); return; }
    },
    { isActive: open },
  );

  if (!open) return null;

  const items = values.map((e) => ({
    key: e, label: e,
    description: getDescription(e),
    selected: e === (currentEffort ?? values[values.length - 1]),
  }));

  return (
    <DropdownMenu
      width={width}
      title="Reasoning Effort"
      helpText="Space/Enter select · Esc cancel"
      items={items}
      activeIndex={activeIndex}
      activeColor={accent}
      maxVisible={4}
    />
  );
};

function getDescription(level: string): string {
  switch (level) {
    case "high": return "balanced speed vs depth";
    case "max":  return "maximum reasoning depth (slower)";
    default:     return "";
  }
}

export default EffortSelector;
