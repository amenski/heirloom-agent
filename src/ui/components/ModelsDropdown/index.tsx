import React, { useEffect, useState } from "react";
import { useInput } from "ink";
import DropdownMenu from "../DropdownMenu/index.js";
import { getPreset } from "../../../providers/presets.js";

type ModelStep = "model" | "thinking";

interface ThinkingModeOption {
  label: string;
  thinkingEnabled: boolean;
  reasoningEffort?: "high" | "max";
}

export const MODEL_COMMAND_THINKING_OPTIONS: ThinkingModeOption[] = [
  { label: "Thinking mode [max]", thinkingEnabled: true, reasoningEffort: "max" },
  { label: "Thinking mode [high]", thinkingEnabled: true, reasoningEffort: "high" },
  { label: "No thinking", thinkingEnabled: false },
];

export interface ModelConfigSelection {
  model: string;
  thinkingEnabled: boolean;
  reasoningEffort?: "high" | "max";
}

function getDefaultThinkingIndex(config: Pick<ModelConfigSelection, "thinkingEnabled" | "reasoningEffort">): number {
  const idx = MODEL_COMMAND_THINKING_OPTIONS.findIndex((opt) => {
    if (!config.thinkingEnabled) return !opt.thinkingEnabled;
    return opt.thinkingEnabled && opt.reasoningEffort === config.reasoningEffort;
  });
  return idx >= 0 ? idx : 0;
}

interface Props {
  open: boolean;
  providerName: string;
  currentModel: string | undefined;
  thinkingEnabled: boolean;
  reasoningEffort?: "high" | "max";
  width: number;
  onClose: () => void;
  onSelect: (provider: string, model: string, thinkingEnabled: boolean, reasoningEffort?: "high" | "max") => void;
  onStatusMessage?: (msg: string | null) => void;
}

const ModelsDropdown: React.FC<Props> = ({
  open, providerName, currentModel, thinkingEnabled, reasoningEffort,
  width, onClose, onSelect, onStatusMessage,
}) => {
  const [step, setStep] = useState<ModelStep | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [pendingModel, setPendingModel] = useState<string | null>(null);

  const availableModels = React.useMemo(() => {
    const preset = getPreset(providerName);
    if (!preset) return [currentModel ?? "deepseek-v4-pro"];
    return Object.keys(preset.models);
  }, [providerName, currentModel]);

  useEffect(() => {
    if (open) {
      const idx = availableModels.indexOf(currentModel ?? "");
      setPendingModel(null);
      setStep("model");
      setActiveIndex(idx >= 0 ? idx : 0);
    } else {
      setStep(null);
    }
  }, [open, availableModels, currentModel]);

  useEffect(() => {
    if (!step) return;
    const count = step === "model" ? availableModels.length : MODEL_COMMAND_THINKING_OPTIONS.length;
    if (activeIndex >= count) setActiveIndex(Math.max(0, count - 1));
  }, [activeIndex, step, availableModels.length]);

  function selectItem(): void {
    if (step === "model") {
      const model = availableModels[activeIndex] ?? currentModel ?? "deepseek-v4-pro";
      setPendingModel(model);
      setStep("thinking");
      setActiveIndex(getDefaultThinkingIndex({ thinkingEnabled, reasoningEffort }));
      return;
    }
    const option = MODEL_COMMAND_THINKING_OPTIONS[activeIndex] ?? MODEL_COMMAND_THINKING_OPTIONS[0]!;
    onSelect(
      providerName,
      pendingModel ?? currentModel ?? "deepseek-v4-pro",
      option.thinkingEnabled,
      option.reasoningEffort,
    );
    onClose();
  }

  useInput(
    (input, key) => {
      if (!step) return;
      const count = step === "model" ? availableModels.length : MODEL_COMMAND_THINKING_OPTIONS.length;
      if (key.upArrow) { setActiveIndex((i) => (i - 1 + count) % count); return; }
      if (key.downArrow) { setActiveIndex((i) => (i + 1) % count); return; }
      if ((input === " " && !key.ctrl && !key.meta) || (key.return && !key.shift && !key.meta)) { selectItem(); return; }
      if (key.tab || key.escape) { onClose(); return; }
    },
    { isActive: open },
  );

  if (!open || !step) return null;

  const items = step === "model"
    ? availableModels.map((m) => ({
        key: m, label: m,
        description: m === currentModel ? "current" : "",
        selected: m === (pendingModel ?? currentModel),
      }))
    : MODEL_COMMAND_THINKING_OPTIONS.map((opt, i) => ({
        key: opt.label, label: opt.label,
        description: opt.thinkingEnabled ? `reasoningEffort: ${opt.reasoningEffort}` : "thinking disabled",
        selected: getDefaultThinkingIndex({ thinkingEnabled, reasoningEffort }) === i,
      }));

  return (
    <DropdownMenu
      width={width}
      title={step === "model" ? "Select Model" : "Select Thinking Mode"}
      helpText={step === "model" ? "Space/Enter select · Esc cancel" : "Space/Enter apply · Esc cancel"}
      items={items}
      activeIndex={activeIndex}
      activeColor="#229ac3"
      maxVisible={6}
    />
  );
};

export default ModelsDropdown;
