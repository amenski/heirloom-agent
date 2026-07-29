import { createAISDKProvider } from "./aisdk.js";
import type { Provider, ModelCapabilities } from "./types.js";
import type { ProviderConfig } from "../config/loader.js";
import { getCredential } from "../config/credentials.js";

export interface ProviderPreset {
  api: string;
  baseUrl: string;
  keyEnv: string;
  defaultModel: string;
  models: Record<string, ModelCapabilities>;
}

export const BUILTIN_PRESETS: Record<string, ProviderPreset> = {
  deepseek: {
    api: "openai-compatible",
    baseUrl: "https://api.deepseek.com",
    keyEnv: "DEEPSEEK_API_KEY",
    defaultModel: "deepseek-v4-pro",
    models: {
      "deepseek-v4-flash": { supportsTools: true, contextWindow: 1000000, pricing: { inputPerM: 0.14, outputPerM: 0.28 } },
      "deepseek-v4-pro": { supportsTools: true, contextWindow: 1000000, pricing: { inputPerM: 0.435, outputPerM: 0.87 } },
    },
  },
  openai: {
    api: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    keyEnv: "OPENAI_API_KEY",
    defaultModel: "gpt-4o",
    models: {
      "gpt-4o": { supportsTools: true, contextWindow: 128000, pricing: { inputPerM: 2.50, outputPerM: 10.00 } },
    },
  },
  openrouter: {
    api: "openai-compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    keyEnv: "OPENROUTER_API_KEY",
    defaultModel: "anthropic/claude-sonnet-4",
    models: {
      "anthropic/claude-sonnet-4": { supportsTools: true, contextWindow: 200000, pricing: { inputPerM: 3.00, outputPerM: 15.00 } },
    },
  },
  groq: {
    api: "openai-compatible",
    baseUrl: "https://api.groq.com/openai/v1",
    keyEnv: "GROQ_API_KEY",
    defaultModel: "llama-4-scout",
    models: {
      "llama-4-scout": { supportsTools: true, contextWindow: 128000, pricing: { inputPerM: 0.11, outputPerM: 0.34 } },
    },
  },
  ollama: {
    api: "openai-compatible",
    baseUrl: "http://localhost:11434/v1",
    keyEnv: "",
    defaultModel: "llama3.2",
    models: {
      "llama3.2": { supportsTools: false, contextWindow: 8192 },
    },
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

export function getPreset(name: string): ProviderPreset | undefined {
  return BUILTIN_PRESETS[name];
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
  const preset = BUILTIN_PRESETS[providerName];
  if (preset) {
    const match = preset.models[modelId] ?? preset.models[preset.defaultModel];
    if (match?.contextWindow) return match.contextWindow;
  }
  return fallback;
}

export function initPresets(): void {
}

export function createProvider(name: string, modelOverride?: string): Provider {
  const configEntry = configProviders[name];

  if (configEntry) {
    const apiKey = (configEntry.apiKeyEnv ? process.env[configEntry.apiKeyEnv] : undefined)
      || getCredential(name)
      || "";
    if (configEntry.apiKeyEnv && !apiKey) {
      throw new Error(
        `Provider "${name}" requires ${configEntry.apiKeyEnv} to be set, or run \`heirloom auth\` to store a key in credentials.yaml`,
      );
    }
    const model =
      modelOverride ??
      (configEntry.models ? Object.keys(configEntry.models)[0] : "default");
    const preset: ProviderPreset = {
      api: configEntry.api,
      baseUrl: configEntry.baseUrl ?? "",
      keyEnv: configEntry.apiKeyEnv ?? "",
      defaultModel: model,
      models: {},
    };
    return createAISDKProvider(preset, model, apiKey);
  }

  const preset = BUILTIN_PRESETS[name];
  if (!preset) {
    const known = getKnownProviderNames();
    throw new Error(
      `Unknown provider: "${name}". Known: ${known.join(", ")}`,
    );
  }

  const apiKey = (preset.keyEnv ? process.env[preset.keyEnv] : undefined)
    || getCredential(name)
    || "";
  if (preset.keyEnv && !apiKey) {
    throw new Error(
      `Provider "${name}" requires ${preset.keyEnv} to be set, or run \`heirloom auth\` to store a key in credentials.yaml`,
    );
  }

  return createAISDKProvider(preset, modelOverride ?? preset.defaultModel, apiKey);
}
