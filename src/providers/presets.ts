import { createOpenAICompatibleProvider } from "./openai-compatible.js";
import { registerAdapter, getAdapter } from "./registry.js";
import { createRetryingProvider } from "./retry.js";
import type { Provider } from "./types.js";
import type { ProviderConfig } from "../config/loader.js";

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

let configProviders: Record<string, ProviderConfig> = {};

export function setConfigProviders(entries: Record<string, ProviderConfig>): void {
  configProviders = entries;
}

export function getKnownProviderNames(): string[] {
  const names = new Set([
    ...Object.keys(BUILTIN_PRESETS),
    ...Object.keys(configProviders),
  ]);
  return [...names];
}

export function getProviderModels(name: string): Record<string, { contextWindow: number }> | undefined {
  const cp = configProviders[name];
  if (cp?.models) return cp.models;
  return undefined;
}

export function getContextWindowForModel(
  providerName: string,
  modelId: string,
  fallback: number,
): number {
  const models = getProviderModels(providerName);
  if (models) {
    const match = models[modelId];
    if (match?.contextWindow) return match.contextWindow;
  }
  return fallback;
}

export function initPresets(): void {
  registerAdapter("openai-compatible", createOpenAICompatibleProvider);
}

export function createProvider(name: string, modelOverride?: string): Provider {
  const configEntry = configProviders[name];

  if (configEntry) {
    const apiKey = configEntry.apiKeyEnv
      ? (process.env[configEntry.apiKeyEnv] ?? "")
      : "";
    if (configEntry.apiKeyEnv && !apiKey) {
      throw new Error(
        `Provider "${name}" requires ${configEntry.apiKeyEnv} to be set`,
      );
    }
    const model =
      modelOverride ??
      (configEntry.models ? Object.keys(configEntry.models)[0] : "default");
    return createRetryingProvider(
      getAdapter(configEntry.api, {
        baseUrl: configEntry.baseUrl ?? "",
        apiKey,
        model,
      }),
    );
  }

  const preset = BUILTIN_PRESETS[name];
  if (!preset) {
    const known = getKnownProviderNames();
    throw new Error(
      `Unknown provider: "${name}". Known: ${known.join(", ")}`,
    );
  }

  const apiKey = preset.keyEnv ? (process.env[preset.keyEnv] || "") : "";
  if (preset.keyEnv && !apiKey) {
    throw new Error(`Provider "${name}" requires ${preset.keyEnv} to be set`);
  }

  return createRetryingProvider(
    getAdapter(preset.api, {
      baseUrl: preset.baseUrl,
      apiKey,
      model: modelOverride ?? preset.defaultModel,
    }),
  );
}
