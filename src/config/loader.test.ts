import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, migrateLegacyPermissions } from "./loader.js";

describe("validatePermissions (rule shape)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "heirloom-loader-"));
    mkdirSync(join(dir, ".deepcode"), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeSettings(json: unknown) {
    writeFileSync(join(dir, ".deepcode", "settings.json"), JSON.stringify(json), "utf-8");
  }

  it("accepts a well-formed rules array", () => {
    writeSettings({
      permissions: {
        rules: [
          { tool: "run_bash", pattern: "git status", action: "allow" },
          { tool: "run_bash", pattern: "git commit:*", action: "allow" },
        ],
        defaultMode: "askAll",
      },
    });
    const { config, errors } = loadConfig(dir);
    expect(errors).toEqual([]);
    expect(config.permissions?.rules).toHaveLength(2);
  });

  it("parses a :* suffix pattern as prefix kind", () => {
    writeSettings({ permissions: { rules: [{ tool: "run_bash", pattern: "git commit:*", action: "allow" }] } });
    const { config } = loadConfig(dir);
    expect(config.permissions?.rules?.[0]).toMatchObject({ kind: "prefix", pattern: "git commit" });
  });

  it("parses a plain string pattern as exact kind", () => {
    writeSettings({ permissions: { rules: [{ tool: "run_bash", pattern: "git status", action: "allow" }] } });
    const { config } = loadConfig(dir);
    expect(config.permissions?.rules?.[0]).toMatchObject({ kind: "exact", pattern: "git status" });
  });

  it("parses a glob-containing pattern as glob kind", () => {
    writeSettings({ permissions: { rules: [{ tool: "read_file", pattern: "./src/**", action: "allow" }] } });
    const { config } = loadConfig(dir);
    expect(config.permissions?.rules?.[0]).toMatchObject({ kind: "glob", pattern: "./src/**" });
  });

  it("rejects a rule missing tool", () => {
    writeSettings({ permissions: { rules: [{ pattern: "git status", action: "allow" }] } });
    const { errors } = loadConfig(dir);
    expect(errors.some((e) => e.includes("missing string \"tool\""))).toBe(true);
  });

  it("rejects a rule with an invalid action", () => {
    writeSettings({ permissions: { rules: [{ tool: "run_bash", pattern: "git status", action: "maybe" }] } });
    const { errors } = loadConfig(dir);
    expect(errors.some((e) => e.includes("invalid action"))).toBe(true);
  });

  it("rejects permissions.rules that isn't an array", () => {
    writeSettings({ permissions: { rules: "not-an-array" } });
    const { errors } = loadConfig(dir);
    expect(errors.some((e) => e.includes("permissions.rules must be an array"))).toBe(true);
  });

  it("accepts a scan-equivalent rule with no whitelist to drift out of sync (the original bug's root cause is gone)", () => {
    writeSettings({ permissions: { rules: [{ tool: "glob", pattern: "", action: "allow" }] } });
    const { config, errors } = loadConfig(dir);
    expect(errors).toEqual([]);
    expect(config.permissions?.rules?.[0]).toMatchObject({ tool: "glob", kind: "any", action: "allow" });
  });
});

describe("migrateLegacyPermissions", () => {
  it("is a no-op (empty result) for an already-new-shape config", () => {
    const result = migrateLegacyPermissions({ rules: [{ tool: "run_bash", pattern: "git status", action: "allow" }] });
    expect(result.rules).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("translates read-in-cwd to a glob allow rule for read_file", () => {
    const result = migrateLegacyPermissions({ allow: ["read-in-cwd"] });
    expect(result.rules).toContainEqual(
      expect.objectContaining({ tool: "read_file", kind: "glob", pattern: "./**", action: "allow" }),
    );
  });

  it("translates scan to glob/search any-kind rules", () => {
    const result = migrateLegacyPermissions({ allow: ["scan"] });
    expect(result.rules).toContainEqual(expect.objectContaining({ tool: "glob", kind: "any", action: "allow" }));
    expect(result.rules).toContainEqual(expect.objectContaining({ tool: "search", kind: "any", action: "allow" }));
  });

  it("translates mcp to an mcp__* wildcard rule", () => {
    const result = migrateLegacyPermissions({ allow: ["mcp"] });
    expect(result.rules).toContainEqual(expect.objectContaining({ tool: "mcp__*", kind: "any", action: "allow" }));
  });

  it("drops the network scope with an explicit warning rather than approximating it", () => {
    const result = migrateLegacyPermissions({ allow: ["network"] });
    expect(result.rules.some((r) => r.tool === "network")).toBe(false);
    expect(result.warnings.some((w) => w.includes("network"))).toBe(true);
  });

  it("preserves the action (deny/ask) from the legacy scope list it came from", () => {
    const result = migrateLegacyPermissions({ deny: ["read-in-cwd"] });
    expect(result.rules).toContainEqual(expect.objectContaining({ tool: "read_file", action: "deny" }));
  });

  it("emits a summary warning naming how many scopes were migrated", () => {
    const result = migrateLegacyPermissions({ allow: ["read-in-cwd", "scan"] });
    expect(result.warnings.some((w) => w.includes("migrated") && w.includes("2"))).toBe(true);
  });

  it("returns empty rules and warnings for an empty legacy config", () => {
    const result = migrateLegacyPermissions({});
    expect(result.rules).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});

describe("loadConfig: migration integration, no disk write during load", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "heirloom-loader-migration-"));
    mkdirSync(join(dir, ".deepcode"), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("migrates a legacy-shape settings.json in-memory and surfaces a warning", () => {
    const settingsPath = join(dir, ".deepcode", "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: ["read-in-cwd"], defaultMode: "askAll" } }), "utf-8");

    const { config, warnings } = loadConfig(dir);
    expect(config.permissions?.rules).toContainEqual(
      expect.objectContaining({ tool: "read_file", kind: "glob", pattern: "./**", action: "allow" }),
    );
    expect(warnings.some((w) => w.includes("migrated"))).toBe(true);
  });

  it("does not write to disk during loadConfig, even when migration occurs", () => {
    const settingsPath = join(dir, ".deepcode", "settings.json");
    const original = JSON.stringify({ permissions: { allow: ["read-in-cwd"], defaultMode: "askAll" } });
    writeFileSync(settingsPath, original, "utf-8");
    const statBefore = statSync(settingsPath).mtimeMs;

    loadConfig(dir);

    const contentAfter = readFileSync(settingsPath, "utf-8");
    const statAfter = statSync(settingsPath).mtimeMs;
    expect(contentAfter).toBe(original);
    expect(statAfter).toBe(statBefore);
  });

  it("is idempotent: loading an already-migrated (new-shape) file does not re-migrate or warn", () => {
    const settingsPath = join(dir, ".deepcode", "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({ permissions: { rules: [{ tool: "read_file", pattern: "./**", action: "allow" }] } }),
      "utf-8",
    );

    const { config, warnings } = loadConfig(dir);
    expect(config.permissions?.rules).toHaveLength(1);
    expect(warnings.some((w) => w.includes("migrated"))).toBe(false);
  });

  it("no settings.json is created by loadConfig alone", () => {
    // No settings.json written at all — loadConfig must not create one.
    loadConfig(dir);
    expect(existsSync(join(dir, ".deepcode", "settings.json"))).toBe(false);
  });
});

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
