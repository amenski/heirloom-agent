import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./loader.js";

// Write a project-level .deepcode/settings.json into a fresh temp dir and load it.
// DEEPCODE_HOME is pointed at an empty dir so no global settings interfere.
let projectDir: string;
let homeDir: string;
let prevHome: string | undefined;

function writeProjectSettings(obj: unknown): void {
  const dir = join(projectDir, ".deepcode");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), JSON.stringify(obj), "utf-8");
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "loader-proj-"));
  homeDir = mkdtempSync(join(tmpdir(), "loader-home-"));
  prevHome = process.env.DEEPCODE_HOME;
  process.env.DEEPCODE_HOME = homeDir;
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
  if (prevHome === undefined) delete process.env.DEEPCODE_HOME;
  else process.env.DEEPCODE_HOME = prevHome;
});

describe("loadConfig strictMcpConfig", () => {
  it("accepts strictMcpConfig: true", () => {
    writeProjectSettings({ strictMcpConfig: true });
    const { config, errors, warnings } = loadConfig(projectDir);
    expect(errors).toHaveLength(0);
    expect(warnings).toHaveLength(0);
    expect(config.strictMcpConfig).toBe(true);
  });

  it("accepts strictMcpConfig: false", () => {
    writeProjectSettings({ strictMcpConfig: false });
    const { config, errors } = loadConfig(projectDir);
    expect(errors).toHaveLength(0);
    expect(config.strictMcpConfig).toBe(false);
  });

  it("defaults to undefined when the field is absent (no warning)", () => {
    writeProjectSettings({});
    const { config, errors, warnings } = loadConfig(projectDir);
    expect(errors).toHaveLength(0);
    expect(warnings).toHaveLength(0);
    expect(config.strictMcpConfig).toBeUndefined();
  });

  it("rejects a non-boolean strictMcpConfig with a validation error", () => {
    writeProjectSettings({ strictMcpConfig: "yes" });
    const { config, errors } = loadConfig(projectDir);
    expect(errors).toContain("config.strictMcpConfig: must be a boolean");
    expect(config.strictMcpConfig).toBeUndefined();
  });
});
