import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderPreset } from "./presets.js";
import type { Provider } from "./types.js";

const FAKE_HOME = mkdtempSync(join(tmpdir(), "heirloom-presets-test-"));

vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return { ...original, homedir: () => FAKE_HOME };
});

const { aisdkMock } = vi.hoisted(() => {
  const fn = vi.fn<(preset: ProviderPreset, model: string, apiKey: string) => Provider>(() => ({} as never));
  return { aisdkMock: fn };
});

vi.mock("./aisdk.js", () => ({
  createAISDKProvider: aisdkMock,
}));

describe("createProvider key resolution", () => {
  const ENV_KEY = "DEEPSEEK_API_KEY";
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
    mkdirSync(join(FAKE_HOME, ".heirloom"), { recursive: true });
    vi.resetModules();
    aisdkMock.mockClear();
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = originalEnv;
    rmSync(join(FAKE_HOME, ".heirloom"), { recursive: true, force: true });
  });

  it("falls back to credentials.yaml when the env var is unset", async () => {
    writeFileSync(join(FAKE_HOME, ".heirloom", "credentials.yaml"), "deepseek: sk-test-dummy\n");

    const { createProvider } = await import("./presets.js");
    createProvider("deepseek");

    expect(aisdkMock).toHaveBeenCalledTimes(1);
    expect(aisdkMock.mock.calls[0][2]).toBe("sk-test-dummy");
  });

  it("prefers the env var over credentials.yaml when both are set", async () => {
    process.env[ENV_KEY] = "sk-env-dummy";
    writeFileSync(join(FAKE_HOME, ".heirloom", "credentials.yaml"), "deepseek: sk-test-dummy\n");

    const { createProvider } = await import("./presets.js");
    createProvider("deepseek");

    expect(aisdkMock).toHaveBeenCalledTimes(1);
    expect(aisdkMock.mock.calls[0][2]).toBe("sk-env-dummy");
  });

  it("throws a helpful error when neither env var nor credentials.yaml has the key", async () => {
    const { createProvider } = await import("./presets.js");
    expect(() => createProvider("deepseek")).toThrow(/DEEPSEEK_API_KEY/);
    expect(() => createProvider("deepseek")).toThrow(/heirloom auth/);
  });

  it("creates a deepseek provider for the deepseek-v4-pro model via modelOverride", async () => {
    process.env[ENV_KEY] = "sk-env-dummy";

    const { createProvider } = await import("./presets.js");
    createProvider("deepseek", "deepseek-v4-pro");

    expect(aisdkMock).toHaveBeenCalledTimes(1);
    const model = aisdkMock.mock.calls[0]?.[1];
    expect(model).toBe("deepseek-v4-pro");
  });
});

describe("BUILTIN_PRESETS models map", () => {
  it("deepseek preset carries both v4 models with correct capabilities", async () => {
    const { BUILTIN_PRESETS } = await import("./presets.js");
    expect(BUILTIN_PRESETS.deepseek_reasoner).toBeUndefined();
    expect(BUILTIN_PRESETS.deepseek.models["deepseek-v4-flash"]).toMatchObject({
      supportsTools: true,
      contextWindow: 1000000,
      pricing: { inputPerM: 0.14, outputPerM: 0.28 },
    });
    expect(BUILTIN_PRESETS.deepseek.models["deepseek-v4-pro"]).toMatchObject({
      supportsTools: true,
      contextWindow: 1000000,
      pricing: { inputPerM: 0.435, outputPerM: 0.87 },
    });
  });

  it("getContextWindowForModel resolves deepseek models from the preset", async () => {
    const { getContextWindowForModel } = await import("./presets.js");
    expect(getContextWindowForModel("deepseek", "deepseek-v4-flash", -1)).toBe(1000000);
    expect(getContextWindowForModel("deepseek", "deepseek-v4-pro", -1)).toBe(1000000);
  });

  it("getContextWindowForModel falls back for an unknown provider", async () => {
    const { getContextWindowForModel } = await import("./presets.js");
    expect(getContextWindowForModel("nonexistent", "whatever", 42)).toBe(42);
  });
});

describe("getProviderCapabilities per model", () => {
  it("resolves supportsTools per model instead of per provider", async () => {
    const { getProviderCapabilities } = await import("./registry.js");
    expect(getProviderCapabilities("deepseek", "deepseek-v4-flash").supportsTools).toBe(true);
    expect(getProviderCapabilities("deepseek", "deepseek-v4-pro").supportsTools).toBe(true);
  });

  it("falls back to the provider's default model when no model is given", async () => {
    const { getProviderCapabilities } = await import("./registry.js");
    const def = getProviderCapabilities("deepseek");
    expect(def.supportsTools).toBe(true);
    expect(def.contextWindow).toBe(1000000);
    expect(def.pricing).toBeDefined();
  });
});
