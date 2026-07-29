import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FAKE_HOME = mkdtempSync(join(tmpdir(), "heirloom-presets-test-"));

vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return { ...original, homedir: () => FAKE_HOME };
});

describe("createProvider key resolution", () => {
  const ENV_KEY = "DEEPSEEK_API_KEY";
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
    mkdirSync(join(FAKE_HOME, ".heirloom"), { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = originalEnv;
    rmSync(join(FAKE_HOME, ".heirloom"), { recursive: true, force: true });
  });

  it("falls back to credentials.yaml when the env var is unset", async () => {
    writeFileSync(join(FAKE_HOME, ".heirloom", "credentials.yaml"), "deepseek: sk-test-dummy\n");

    const { registerAdapter } = await import("./registry.js");
    const seen: string[] = [];
    registerAdapter("openai-compatible", (config) => {
      seen.push(config.apiKey);
      return {} as never;
    });

    const { createProvider } = await import("./presets.js");
    createProvider("deepseek");
    expect(seen).toEqual(["sk-test-dummy"]);
  });

  it("prefers the env var over credentials.yaml when both are set", async () => {
    process.env[ENV_KEY] = "sk-env-dummy";
    writeFileSync(join(FAKE_HOME, ".heirloom", "credentials.yaml"), "deepseek: sk-test-dummy\n");

    const { registerAdapter } = await import("./registry.js");
    const seen: string[] = [];
    registerAdapter("openai-compatible", (config) => {
      seen.push(config.apiKey);
      return {} as never;
    });

    const { createProvider } = await import("./presets.js");
    createProvider("deepseek");
    expect(seen).toEqual(["sk-env-dummy"]);
  });

  it("throws a helpful error when neither env var nor credentials.yaml has the key", async () => {
    const { createProvider } = await import("./presets.js");
    expect(() => createProvider("deepseek")).toThrow(/DEEPSEEK_API_KEY/);
    expect(() => createProvider("deepseek")).toThrow(/heirloom auth/);
  });

  it("creates a deepseek provider for the deepseek-reasoner model via modelOverride", async () => {
    process.env[ENV_KEY] = "sk-env-dummy";

    const { registerAdapter } = await import("./registry.js");
    const seen: { baseUrl: string; model?: string }[] = [];
    registerAdapter("openai-compatible", (config) => {
      seen.push({ baseUrl: config.baseUrl, model: config.model });
      return {} as never;
    });

    const { createProvider } = await import("./presets.js");
    createProvider("deepseek", "deepseek-reasoner");
    expect(seen).toEqual([{ baseUrl: "https://api.deepseek.com", model: "deepseek-reasoner" }]);
  });
});

describe("BUILTIN_PRESETS models map", () => {
  it("has no separate deepseek_reasoner provider — deepseek carries both models", async () => {
    const { BUILTIN_PRESETS } = await import("./presets.js");
    expect(BUILTIN_PRESETS.deepseek_reasoner).toBeUndefined();
    expect(BUILTIN_PRESETS.deepseek.models["deepseek-chat"]).toEqual({
      supportsTools: true,
      contextWindow: 128000,
    });
    expect(BUILTIN_PRESETS.deepseek.models["deepseek-reasoner"]).toEqual({
      supportsTools: false,
      contextWindow: 128000,
    });
  });

  it("getContextWindowForModel resolves deepseek-reasoner to 128000 from the preset", async () => {
    const { getContextWindowForModel } = await import("./presets.js");
    expect(getContextWindowForModel("deepseek", "deepseek-reasoner", -1)).toBe(128000);
    expect(getContextWindowForModel("deepseek", "deepseek-chat", -1)).toBe(128000);
  });

  it("getContextWindowForModel falls back for an unknown provider", async () => {
    const { getContextWindowForModel } = await import("./presets.js");
    expect(getContextWindowForModel("nonexistent", "whatever", 42)).toBe(42);
  });
});

describe("getProviderCapabilities per model", () => {
  it("resolves supportsTools per model instead of per provider", async () => {
    const { getProviderCapabilities } = await import("./registry.js");
    expect(getProviderCapabilities("deepseek", "deepseek-chat").supportsTools).toBe(true);
    expect(getProviderCapabilities("deepseek", "deepseek-reasoner").supportsTools).toBe(false);
  });

  it("falls back to the provider's default model when no model is given", async () => {
    const { getProviderCapabilities } = await import("./registry.js");
    expect(getProviderCapabilities("deepseek")).toEqual({ supportsTools: true, contextWindow: 128000 });
  });
});
