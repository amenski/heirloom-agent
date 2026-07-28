import { createOpenAICompatibleProvider } from "./openai-compatible.js";
import { registerAdapter, getAdapter } from "./registry.js";
import type { Provider } from "./types.js";

export interface ProviderPreset {
  api: string;
  baseUrl: string;
  keyEnv: string;
  defaultModel: string;
}

export const BUILTIN_PRESETS: Record<string, ProviderPreset> = {
  deepseek: {
    api: "openai-compatible",
    baseUrl: "https://api.deepseek.com",
    keyEnv: "DEEPSEEK_API_KEY",
    defaultModel: "deepseek-chat",
  },
  openai: {
    api: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    keyEnv: "OPENAI_API_KEY",
    defaultModel: "gpt-4o",
  },
  openrouter: {
    api: "openai-compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    keyEnv: "OPENROUTER_API_KEY",
    defaultModel: "anthropic/claude-sonnet-4",
  },
  groq: {
    api: "openai-compatible",
    baseUrl: "https://api.groq.com/openai/v1",
    keyEnv: "GROQ_API_KEY",
    defaultModel: "llama-4-scout",
  },
  ollama: {
    api: "openai-compatible",
    baseUrl: "http://localhost:11434/v1",
    keyEnv: "",
    defaultModel: "llama3.2",
  },
};

export function initPresets(): void {
  registerAdapter("openai-compatible", createOpenAICompatibleProvider);
}

export function createProvider(name: string): Provider {
  const preset = BUILTIN_PRESETS[name];
  if (!preset) throw new Error(`Unknown provider: "${name}". Known: ${Object.keys(BUILTIN_PRESETS).join(", ")}`);

  const apiKey = preset.keyEnv ? (process.env[preset.keyEnv] || "") : "";
  if (preset.keyEnv && !apiKey) {
    throw new Error(`Provider "${name}" requires ${preset.keyEnv} to be set`);
  }

  return getAdapter(preset.api, {
    baseUrl: preset.baseUrl,
    apiKey,
    model: preset.defaultModel,
  });
}
