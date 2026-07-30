import React, { useEffect, useState } from "react";
import { useInput } from "ink";
import DropdownMenu from "../DropdownMenu/index.js";
import { getPreset } from "../../../providers/presets.js";

interface Props {
  open: boolean;
  providerName: string;
  currentModel: string | undefined;
  width: number;
  onClose: () => void;
  onSelect: (provider: string, model: string) => void;
  onStatusMessage?: (msg: string | null) => void;
}

const ModelsDropdown: React.FC<Props> = ({
  open, providerName, currentModel,
  width, onClose, onSelect, onStatusMessage,
}) => {
  const [activeIndex, setActiveIndex] = useState(0);

  const availableModels = React.useMemo(() => {
    const preset = getPreset(providerName);
    if (!preset) return [currentModel ?? "deepseek-v4-pro"];
    return Object.keys(preset.models);
  }, [providerName, currentModel]);

  useEffect(() => {
    if (open) {
      const idx = availableModels.indexOf(currentModel ?? "");
      setActiveIndex(idx >= 0 ? idx : 0);
    }
  }, [open, availableModels, currentModel]);

  useEffect(() => {
    if (!open) return;
    if (activeIndex >= availableModels.length) setActiveIndex(Math.max(0, availableModels.length - 1));
  }, [activeIndex, open, availableModels.length]);

  function selectItem(): void {
    const model = availableModels[activeIndex] ?? currentModel ?? "deepseek-v4-pro";
    onSelect(providerName, model);
    onClose();
  }

  useInput(
    (input, key) => {
      if (!open) return;
      const count = availableModels.length;
      if (key.upArrow) { setActiveIndex((i) => (i - 1 + count) % count); return; }
      if (key.downArrow) { setActiveIndex((i) => (i + 1) % count); return; }
      if ((input === " " && !key.ctrl && !key.meta) || (key.return && !key.shift && !key.meta)) { selectItem(); return; }
      if (key.tab || key.escape) { onClose(); return; }
    },
    { isActive: open },
  );

  if (!open) return null;

  const items = availableModels.map((m) => ({
    key: m, label: m,
    description: m === currentModel ? "current" : "",
    selected: m === currentModel,
  }));

  return (
    <DropdownMenu
      width={width}
      title="Select Model"
      helpText="Space/Enter select · Esc cancel"
      items={items}
      activeIndex={activeIndex}
      activeColor="#229ac3"
      maxVisible={6}
    />
  );
};

export default ModelsDropdown;
