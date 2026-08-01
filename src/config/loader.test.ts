import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, migrateLegacyPermissions } from "./loader.js";

describe("validatePermissions (rule shape)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "heirloom-loader-"));
    mkdirSync(join(dir, ".heirloom"), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeSettings(json: unknown) {
    writeFileSync(join(dir, ".heirloom", "settings.json"), JSON.stringify(json), "utf-8");
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
    mkdirSync(join(dir, ".heirloom"), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("migrates a legacy-shape settings.json in-memory and surfaces a warning", () => {
    const settingsPath = join(dir, ".heirloom", "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: ["read-in-cwd"], defaultMode: "askAll" } }), "utf-8");

    const { config, warnings } = loadConfig(dir);
    expect(config.permissions?.rules).toContainEqual(
      expect.objectContaining({ tool: "read_file", kind: "glob", pattern: "./**", action: "allow" }),
    );
    expect(warnings.some((w) => w.includes("migrated"))).toBe(true);
  });

  it("does not write to disk during loadConfig, even when migration occurs", () => {
    const settingsPath = join(dir, ".heirloom", "settings.json");
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
    const settingsPath = join(dir, ".heirloom", "settings.json");
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
    expect(existsSync(join(dir, ".heirloom", "settings.json"))).toBe(false);
  });
});

// Write a project-level .heirloom/settings.json into a fresh temp dir and load it.
// HEIRLOOM_HOME is pointed at an empty dir so no global settings interfere.
let projectDir: string;
let homeDir: string;
let prevHome: string | undefined;

function writeProjectSettings(obj: unknown): void {
  const dir = join(projectDir, ".heirloom");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), JSON.stringify(obj), "utf-8");
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "loader-proj-"));
  homeDir = mkdtempSync(join(tmpdir(), "loader-home-"));
  prevHome = process.env.HEIRLOOM_HOME;
  process.env.HEIRLOOM_HOME = homeDir;
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
  if (prevHome === undefined) delete process.env.HEIRLOOM_HOME;
  else process.env.HEIRLOOM_HOME = prevHome;
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

describe("loadConfig statusline", () => {
  it("accepts a well-formed command + module provider config", () => {
    writeProjectSettings({
      statusline: {
        enabled: true,
        refreshMs: 3000,
        separator: " | ",
        providers: [
          { type: "command", id: "git", command: "git branch --show-current", color: "cyan", timeoutMs: 1500, cwd: "." },
          { type: "module", id: "x", path: "./.deepcode/plugins/x.mjs", color: "yellow" },
        ],
      },
    });
    const { config, errors } = loadConfig(projectDir);
    expect(errors).toEqual([]);
    expect(config.statusline).toEqual({
      enabled: true,
      refreshMs: 3000,
      separator: " | ",
      providers: [
        { type: "command", id: "git", command: "git branch --show-current", color: "cyan", timeoutMs: 1500, cwd: "." },
        { type: "module", id: "x", path: "./.deepcode/plugins/x.mjs", color: "yellow" },
      ],
    });
  });

  it("defaults enabled to true when providers exist", () => {
    writeProjectSettings({ statusline: { providers: [{ type: "command", id: "g", command: "echo hi" }] } });
    const { config } = loadConfig(projectDir);
    expect(config.statusline?.enabled).toBe(true);
  });

  it("defaults enabled to false when there are no providers", () => {
    writeProjectSettings({ statusline: { providers: [] } });
    const { config } = loadConfig(projectDir);
    expect(config.statusline?.enabled).toBe(false);
  });

  it("defaults refreshMs to 2000 and separator to ' · '", () => {
    writeProjectSettings({ statusline: { providers: [{ type: "command", id: "g", command: "echo hi" }] } });
    const { config } = loadConfig(projectDir);
    expect(config.statusline?.refreshMs).toBe(2000);
    expect(config.statusline?.separator).toBe(" · ");
  });

  it("clamps refreshMs to a minimum of 500", () => {
    writeProjectSettings({ statusline: { refreshMs: 100, providers: [{ type: "command", id: "g", command: "echo hi" }] } });
    const { config } = loadConfig(projectDir);
    expect(config.statusline?.refreshMs).toBe(500);
  });

  it("rejects a command provider missing command", () => {
    writeProjectSettings({ statusline: { providers: [{ type: "command", id: "g" }] } });
    const { errors } = loadConfig(projectDir);
    expect(errors.some((e) => e.includes("statusline.providers.g.command is required"))).toBe(true);
  });

  it("rejects a module provider missing path", () => {
    writeProjectSettings({ statusline: { providers: [{ type: "module", id: "m" }] } });
    const { errors } = loadConfig(projectDir);
    expect(errors.some((e) => e.includes("statusline.providers.m.path is required"))).toBe(true);
  });

  it("rejects a provider with an unknown type", () => {
    writeProjectSettings({ statusline: { providers: [{ type: "widget", id: "w" }] } });
    const { errors } = loadConfig(projectDir);
    expect(errors.some((e) => e.includes('statusline.providers.w.type must be "command" or "module"'))).toBe(true);
  });

  it("rejects a provider missing id", () => {
    writeProjectSettings({ statusline: { providers: [{ type: "command", command: "x" }] } });
    const { errors } = loadConfig(projectDir);
    expect(errors.some((e) => e.includes('statusline.providers entry missing string "id"'))).toBe(true);
  });

  it("rejects providers that isn't an array", () => {
    writeProjectSettings({ statusline: { providers: "nope" } });
    const { errors } = loadConfig(projectDir);
    expect(errors.some((e) => e.includes("statusline.providers must be an array"))).toBe(true);
  });

  it("rejects statusline that isn't an object", () => {
    writeProjectSettings({ statusline: "on" });
    const { errors } = loadConfig(projectDir);
    expect(errors.some((e) => e.includes("statusline must be an object"))).toBe(true);
  });

  it("does not warn about statusline being an unknown field", () => {
    writeProjectSettings({ statusline: { providers: [{ type: "command", id: "g", command: "echo hi" }] } });
    const { warnings } = loadConfig(projectDir);
    expect(warnings.some((w) => w.includes('unknown field "statusline"'))).toBe(false);
  });
});

describe("loadConfig enabledSkills", () => {
  it("parses a per-skill enable/disable map", () => {
    writeProjectSettings({ enabledSkills: { foo: false, bar: true } });
    const { config, errors, warnings } = loadConfig(projectDir);
    expect(errors).toHaveLength(0);
    expect(warnings).toHaveLength(0);
    expect(config.enabledSkills).toEqual({ foo: false, bar: true });
  });

  it("rejects a non-boolean skill value", () => {
    writeProjectSettings({ enabledSkills: { foo: "off" } });
    const { errors } = loadConfig(projectDir);
    expect(errors).toContain("config.enabledSkills.foo: must be boolean");
  });

  it("rejects a non-object enabledSkills", () => {
    writeProjectSettings({ enabledSkills: "nope" });
    const { errors } = loadConfig(projectDir);
    expect(errors).toContain("config.enabledSkills: must be an object");
  });
});

describe("loadConfig compaction.auto", () => {
  it("parses compaction.auto: false alongside threshold", () => {
    writeProjectSettings({ compaction: { auto: false, threshold: 0.6 } });
    const { config, errors, warnings } = loadConfig(projectDir);
    expect(errors).toHaveLength(0);
    expect(warnings).toHaveLength(0);
    expect(config.compaction).toEqual({ auto: false, threshold: 0.6 });
  });

  it("parses compaction.auto: true", () => {
    writeProjectSettings({ compaction: { auto: true } });
    const { config } = loadConfig(projectDir);
    expect(config.compaction?.auto).toBe(true);
  });
});

describe("loadConfig workflow keys", () => {
  it("keeps gitStatus / gitPollInterval without warnings", () => {
    writeProjectSettings({ workflow: { gitStatus: false, gitPollInterval: 5000 } });
    const { config, errors, warnings } = loadConfig(projectDir);
    expect(errors).toHaveLength(0);
    expect(warnings).toHaveLength(0);
    expect(config.workflow).toEqual({ gitStatus: false, gitPollInterval: 5000 });
  });

  it("deprecates gitCommands with a warning", () => {
    writeProjectSettings({ workflow: { gitCommands: true } });
    const { warnings } = loadConfig(projectDir);
    expect(warnings.some((w) => w.includes("workflow.gitCommands is deprecated"))).toBe(true);
  });

  it("deprecates detectBuildTools with a warning", () => {
    writeProjectSettings({ workflow: { detectBuildTools: true } });
    const { warnings } = loadConfig(projectDir);
    expect(warnings.some((w) => w.includes("workflow.detectBuildTools is deprecated"))).toBe(true);
  });
});

describe("loadConfig debugLogEnabled (deprecated)", () => {
  it("emits a deprecation warning pointing at the --debug flag", () => {
    writeProjectSettings({ debugLogEnabled: true });
    const { warnings } = loadConfig(projectDir);
    expect(
      warnings.some((w) => w.includes("debugLogEnabled is deprecated and ignored — use the --debug flag")),
    ).toBe(true);
  });
});

describe("loadConfig telemetryEnabled (deleted key)", () => {
  it("treats telemetryEnabled as an unknown field", () => {
    writeProjectSettings({ telemetryEnabled: false });
    const { config, warnings } = loadConfig(projectDir);
    expect(warnings.some((w) => w.includes('unknown field "telemetryEnabled"'))).toBe(true);
    expect((config as Record<string, unknown>).telemetryEnabled).toBeUndefined();
  });
});
