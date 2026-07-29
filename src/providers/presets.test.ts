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
});
