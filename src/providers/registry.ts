import type { Provider, ModelCapabilities } from "./types.js";
import { getPreset } from "./presets.js";

export interface AdapterConfig {
  baseUrl: string;
  apiKey: string;
  model?: string;
}

export type AdapterFactory = (config: AdapterConfig) => Provider;

const adapters = new Map<string, AdapterFactory>();

export function registerAdapter(api: string, factory: AdapterFactory): void {
  adapters.set(api, factory);
}

export function getAdapter(api: string, config: AdapterConfig): Provider {
  const factory = adapters.get(api);
  if (!factory) throw new Error(`Unknown API adapter: "${api}". Known: ${[...adapters.keys()].join(", ")}`);
  return factory(config);
}

export function getProviderCapabilities(name: string): ModelCapabilities {
  const preset = getPreset(name);
  return preset?.capabilities || { supportsTools: true, contextWindow: 128000 };
}
