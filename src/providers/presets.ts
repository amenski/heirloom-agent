import { createAISDKProvider } from "./aisdk.js";
import type { Provider, ModelCapabilities } from "./types.js";
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
      "deepseek-v4-flash": { supportsTools: true, contextWindow: 1000000, pricing: { inputPerM: 0.14, outputPerM: 0.28 }, effort: { values: ["low", "high", "max"], default: "high" } },
      "deepseek-v4-pro": { supportsTools: true, contextWindow: 1000000, pricing: { inputPerM: 0.435, outputPerM: 0.87 }, effort: { values: ["low", "high", "max"], default: "high" } },
    },
  },
  openai: {
    api: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    keyEnv: "OPENAI_API_KEY",
    defaultModel: "gpt-5.6-sol",
    models: {
      // NOTE: no `effort` cap here — OpenAI's chat-completions API rejects
      // reasoning_effort when function tools are also present, and Heirloom
      // always sends tools.
      "gpt-5.6-sol": { supportsTools: true, contextWindow: 256000, pricing: { inputPerM: 2.50, outputPerM: 10.00 } },
      "gpt-5.6-terra": { supportsTools: true, contextWindow: 256000, pricing: { inputPerM: 1.25, outputPerM: 5.00 } },
      "gpt-5.6-luna": { supportsTools: true, contextWindow: 128000, pricing: { inputPerM: 0.25, outputPerM: 1.00 } },
    },
  },
  openrouter: {
    api: "openai-compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    keyEnv: "OPENROUTER_API_KEY",
    defaultModel: "anthropic/claude-sonnet-4.6",
    models: {
      "anthropic/claude-sonnet-4.6": { supportsTools: true, contextWindow: 200000, pricing: { inputPerM: 3.00, outputPerM: 15.00 } },
    },
  },
  groq: {
    api: "openai-compatible",
    baseUrl: "https://api.groq.com/openai/v1",
    keyEnv: "GROQ_API_KEY",
    defaultModel: "llama-3.3-70b-versatile",
    models: {
      "llama-3.3-70b-versatile": { supportsTools: true, contextWindow: 128000, pricing: { inputPerM: 0.59, outputPerM: 0.79 } },
      "llama-3.1-8b-instant": { supportsTools: true, contextWindow: 128000, pricing: { inputPerM: 0.05, outputPerM: 0.08 } },
      "openai/gpt-oss-120b": { supportsTools: true, contextWindow: 128000, pricing: { inputPerM: 0.15, outputPerM: 0.75 }, effort: { values: ["low", "medium", "high"], default: "medium" } },
      "openai/gpt-oss-20b": { supportsTools: true, contextWindow: 128000, pricing: { inputPerM: 0.10, outputPerM: 0.50 }, effort: { values: ["low", "medium", "high"], default: "medium" } },
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

export interface ProviderOptions {
  modelOverride?: string;
  baseUrl?: string;
  apiKey?: string;
}

let configProviders: Record<string, { api: string; baseUrl?: string; apiKeyEnv?: string; models?: Record<string, { contextWindow: number }> }> = {};

export function setConfigProviders(entries: Record<string, { api: string; baseUrl?: string; apiKeyEnv?: string; models?: Record<string, { contextWindow: number }> }>): void {
  configProviders = entries;
}

export function getKnownProviderNames(): string[] {
  const names = new Set([
    ...Object.keys(BUILTIN_PRESETS),
    ...Object.keys(configProviders),
  ]);
  return [...names];
}

/**
 * Whether an API key can be resolved for each known provider, using the same
 * precedence createProvider does (env var, then credentials.yaml). Returns
 * BOOLEANS ONLY — the UI needs to show "no key" without ever handling a secret.
 * Providers with no keyEnv (e.g. a local ollama) always count as configured.
 */
export function getConfiguredProviders(): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const name of getKnownProviderNames()) {
    const preset = BUILTIN_PRESETS[name];
    if (!preset || !preset.keyEnv) {
      out[name] = true;
      continue;
    }
    out[name] = !!(process.env[preset.keyEnv] || getCredential(name));
  }
  return out;
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

export function createProvider(name: string, options?: ProviderOptions): Provider {
  const configEntry = configProviders[name];

  if (configEntry) {
    const apiKey = options?.apiKey
      || (configEntry.apiKeyEnv ? process.env[configEntry.apiKeyEnv] : undefined)
      || "";
    const model = options?.modelOverride ??
      (configEntry.models ? Object.keys(configEntry.models)[0] : "default");
    const preset: ProviderPreset = {
      api: configEntry.api,
      baseUrl: options?.baseUrl ?? configEntry.baseUrl ?? "",
      keyEnv: configEntry.apiKeyEnv ?? "",
      defaultModel: model,
      models: {},
    };
    return createAISDKProvider(preset, model, apiKey);
  }

  const preset = BUILTIN_PRESETS[name];
  if (!preset) {
    throw new Error(
      `Unknown provider: "${name}". Known: ${getKnownProviderNames().join(", ")}`,
    );
  }

  const apiKey = options?.apiKey
    || (preset.keyEnv ? process.env[preset.keyEnv] : undefined)
    || getCredential(name)
    || "";
  if (!apiKey && preset.keyEnv) {
    throw new Error(
      `Provider "${name}" requires ${preset.keyEnv} to be set, or run \`heirloom auth\` to store a key in credentials.yaml`,
    );
  }

  // Honor a config-supplied base URL (settings.json env.BASE_URL) for built-in
  // presets — otherwise the hardcoded preset baseUrl always wins and there is no
  // way to point a provider at a proxy/gateway (QA B2).
  const effectivePreset: ProviderPreset = options?.baseUrl
    ? { ...preset, baseUrl: options.baseUrl }
    : preset;

  return createAISDKProvider(
    effectivePreset,
    options?.modelOverride ?? preset.defaultModel,
    apiKey,
  );
}
