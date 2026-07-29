import type { ModelCapabilities } from "./types.js";
import { getPreset } from "./presets.js";

export function getProviderCapabilities(name: string, modelId?: string): ModelCapabilities {
  const preset = getPreset(name);
  if (!preset) return { supportsTools: true, contextWindow: 128000 };
  return preset.models[modelId ?? preset.defaultModel] ?? preset.models[preset.defaultModel];
}
