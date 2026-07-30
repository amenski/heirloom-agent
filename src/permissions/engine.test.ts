import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PermissionEngine, type PermissionRule } from "./engine.js";

function rule(partial: Partial<PermissionRule>): PermissionRule {
  return { tool: "run_bash", kind: "any", pattern: "", action: "allow", origin: "config", ...partial };
}

describe("PermissionEngine.resolve", () => {
  let engine: PermissionEngine;

  beforeEach(() => {
    engine = new PermissionEngine(undefined, "/workspace");
  });

  describe("default posture with no config on disk", () => {
    it("asks for an unrecognized tool with no matching rules, even though defaultMode is askAll", () => {
      expect(engine.resolve("unknown_tool", {}).action).toBe("ask");
    });

    it("asks for a plain read_file call by default (no rules configured)", () => {
      expect(engine.resolve("read_file", { path: "/workspace/src/main.ts" }).action).toBe("ask");
    });

    it("asks for run_bash by default", () => {
      expect(engine.resolve("run_bash", { command: "git status" }).action).toBe("ask");
    });
  });

  describe("explicit config precedence", () => {
    it("honors an explicit empty rules array verbatim (asks for everything)", () => {
      engine = new PermissionEngine({ rules: [] }, "/workspace");
      expect(engine.resolve("read_file", { path: "/workspace/src/main.ts" }).action).toBe("ask");
    });

    it("an allow rule for a specific tool makes that call resolve to allow", () => {
      engine = new PermissionEngine({ rules: [rule({ tool: "run_bash", kind: "any", action: "allow" })] }, "/workspace");
      expect(engine.resolve("run_bash", { command: "git status" }).action).toBe("allow");
    });

    it("an ask rule resolves to ask even with defaultMode allowAll", () => {
      engine = new PermissionEngine(
        { rules: [rule({ tool: "run_bash", kind: "any", action: "ask" })], defaultMode: "allowAll" },
        "/workspace",
      );
      expect(engine.resolve("run_bash", { command: "git status" }).action).toBe("ask");
    });

    it("defaultMode allowAll allows a tool that has at least one rule configured, when no rule matches this specific call", () => {
      engine = new PermissionEngine(
        { rules: [rule({ tool: "run_bash", kind: "exact", pattern: "npm test", action: "allow" })], defaultMode: "allowAll" },
        "/workspace",
      );
      const result = engine.resolve("run_bash", { command: "git status" });
      expect(result.action).toBe("allow");
    });

    it("defaultMode allowAll still asks for a tool with zero configured rules anywhere (unrecognized-tool safety net)", () => {
      engine = new PermissionEngine({ rules: [rule({ tool: "read_file" })], defaultMode: "allowAll" }, "/workspace");
      expect(engine.resolve("run_bash", { command: "git status" }).action).toBe("ask");
    });
  });

  describe("deny wins by default across kinds (not by raw specificity)", () => {
    it("a narrow prefix deny beats a blanket glob allow (first-draft inversion regression)", () => {
      engine = new PermissionEngine(
        {
          rules: [
            rule({ tool: "read_file", kind: "glob", pattern: "**", action: "allow" }),
            rule({ tool: "read_file", kind: "prefix", pattern: "/etc", action: "deny" }),
          ],
        },
        "/workspace",
      );
      const result = engine.resolve("read_file", { path: "/etc/passwd" });
      expect(result.action).toBe("deny");
    });

    it("a global any-kind deny kill-switch wins over any allow rule (second-draft inversion regression)", () => {
      engine = new PermissionEngine(
        {
          rules: [
            rule({ tool: "*", kind: "any", action: "deny" }),
            rule({ tool: "run_bash", kind: "exact", pattern: "git status", action: "allow" }),
          ],
        },
        "/workspace",
      );
      const result = engine.resolve("run_bash", { command: "git status" });
      expect(result.action).toBe("deny");
    });

    it("a strictly-more-specific allow can override a deny", () => {
      engine = new PermissionEngine(
        {
          rules: [
            rule({ tool: "run_bash", kind: "prefix", pattern: "curl", action: "deny" }),
            rule({ tool: "run_bash", kind: "prefix", pattern: "curl https://api.internal.corp", action: "allow" }),
          ],
        },
        "/workspace",
      );
      const result = engine.resolve("run_bash", { command: "curl https://api.internal.corp/health" });
      expect(result.action).toBe("allow");
    });

    it("an equally-broad allow does NOT override a deny (tie goes to deny)", () => {
      engine = new PermissionEngine(
        {
          rules: [
            rule({ tool: "run_bash", kind: "prefix", pattern: "curl", action: "deny" }),
            rule({ tool: "run_bash", kind: "prefix", pattern: "curl", action: "allow" }),
          ],
        },
        "/workspace",
      );
      const result = engine.resolve("run_bash", { command: "curl https://example.com" });
      expect(result.action).toBe("deny");
    });

    it("ask likewise wins by default over an equally-broad allow", () => {
      engine = new PermissionEngine(
        {
          rules: [
            rule({ tool: "run_bash", kind: "prefix", pattern: "npm", action: "ask" }),
            rule({ tool: "run_bash", kind: "prefix", pattern: "npm", action: "allow" }),
          ],
        },
        "/workspace",
      );
      expect(engine.resolve("run_bash", { command: "npm test" }).action).toBe("ask");
    });
  });

  describe("run_bash: per-segment resolution and normalization", () => {
    it("resolves a compound command as deny if any segment denies", () => {
      engine = new PermissionEngine(
        {
          rules: [
            rule({ tool: "run_bash", kind: "prefix", pattern: "git status", action: "allow" }),
            rule({ tool: "run_bash", kind: "prefix", pattern: "rm -rf", action: "deny" }),
          ],
        },
        "/workspace",
      );
      const result = engine.resolve("run_bash", { command: "git status && rm -rf /tmp/x" });
      expect(result.action).toBe("deny");
    });

    it("resolves a compound command as ask if any segment asks and none deny", () => {
      engine = new PermissionEngine(
        {
          rules: [
            rule({ tool: "run_bash", kind: "prefix", pattern: "git status", action: "allow" }),
            rule({ tool: "run_bash", kind: "prefix", pattern: "npm", action: "ask" }),
          ],
        },
        "/workspace",
      );
      const result = engine.resolve("run_bash", { command: "git status && npm test" });
      expect(result.action).toBe("ask");
    });

    it("resolves a compound command as allow only when every segment allows", () => {
      engine = new PermissionEngine(
        {
          rules: [
            rule({ tool: "run_bash", kind: "prefix", pattern: "git status", action: "allow" }),
            rule({ tool: "run_bash", kind: "prefix", pattern: "npm test", action: "allow" }),
          ],
        },
        "/workspace",
      );
      const result = engine.resolve("run_bash", { command: "git status && npm test" });
      expect(result.action).toBe("allow");
    });

    it("strips a leading sudo before matching", () => {
      engine = new PermissionEngine(
        { rules: [rule({ tool: "run_bash", kind: "exact", pattern: "npm test", action: "allow" })] },
        "/workspace",
      );
      expect(engine.resolve("run_bash", { command: "sudo npm test" }).action).toBe("allow");
    });
  });

  describe("run_bash: unresolved-ask fail-closed", () => {
    it("env-wrapped destructive commands resolve to ask (not silently denied nor allowed)", () => {
      engine = new PermissionEngine({ rules: [], defaultMode: "allowAll" }, "/workspace");
      const result = engine.resolve("run_bash", { command: "env rm -rf ~/projects" });
      expect(result.action).toBe("ask");
      expect(result.wasUnresolved).toBe(true);
    });

    it("inline command substitution resolves to ask", () => {
      const result = engine.resolve("run_bash", { command: "echo $(rm -rf ~)" });
      expect(result.action).toBe("ask");
      expect(result.wasUnresolved).toBe(true);
    });

    it("find -exec resolves to ask", () => {
      const result = engine.resolve("run_bash", { command: "find . -exec rm -rf {} \\;" });
      expect(result.action).toBe("ask");
      expect(result.wasUnresolved).toBe(true);
    });

    it("xargs resolves to ask", () => {
      const result = engine.resolve("run_bash", { command: "echo file | xargs rm" });
      expect(result.action).toBe("ask");
      expect(result.wasUnresolved).toBe(true);
    });

    it("an ordinary resolvable ask (no unresolved construct) is NOT flagged wasUnresolved", () => {
      const result = engine.resolve("run_bash", { command: "git status" });
      expect(result.action).toBe("ask");
      expect(result.wasUnresolved).toBe(false);
    });

    it("a failed bash -c unwrap resolves to ask with wasUnresolved true", () => {
      const result = engine.resolve("run_bash", { command: "bash -c 'echo $(whoami)'" });
      expect(result.action).toBe("ask");
      expect(result.wasUnresolved).toBe(true);
    });
  });

  describe("destructive tier", () => {
    it("denies rm -rf / by default with no config at all", () => {
      expect(engine.resolve("run_bash", { command: "rm -rf / --no-preserve-root" }).action).toBe("deny");
    });

    it("denies git push --force by default", () => {
      expect(engine.resolve("run_bash", { command: "git push --force origin main" }).action).toBe("deny");
    });

    it("a strictly-more-specific user allow overrides a destructive deny", () => {
      engine = new PermissionEngine(
        { rules: [rule({ tool: "run_bash", kind: "prefix", pattern: "git reset --hard HEAD~1", action: "allow" })] },
        "/workspace",
      );
      expect(engine.resolve("run_bash", { command: "git reset --hard HEAD~1" }).action).toBe("allow");
    });

    it("an equally-broad user allow does NOT override a destructive deny", () => {
      engine = new PermissionEngine(
        { rules: [rule({ tool: "run_bash", kind: "prefix", pattern: "git reset --hard", action: "allow" })] },
        "/workspace",
      );
      expect(engine.resolve("run_bash", { command: "git reset --hard HEAD~1" }).action).toBe("deny");
    });

    it("approveAlways forces kind exact when narrowing a destructive-origin match", () => {
      const dir = mkdtempSync(join(tmpdir(), "heirloom-engine-destructive-always-"));
      try {
        const scopedEngine = new PermissionEngine(undefined, dir);
        const destructiveMatch = rule({ tool: "run_bash", kind: "prefix", pattern: "git reset --hard", origin: "builtin-destructive", action: "deny" });
        scopedEngine.approveAlways(
          rule({ tool: "run_bash", kind: "prefix", pattern: "git reset --hard HEAD~1", action: "allow" }),
          destructiveMatch,
        );
        const result = scopedEngine.resolve("run_bash", { command: "git reset --hard HEAD~1" });
        expect(result.action).toBe("allow");
        expect(result.winningRule?.kind).toBe("exact");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("approveForSession forces kind exact when narrowing a destructive-origin match", () => {
      const destructiveMatch = rule({ tool: "run_bash", kind: "prefix", pattern: "git reset --hard", origin: "builtin-destructive", action: "deny" });
      engine.approveForSession(
        rule({ tool: "run_bash", kind: "prefix", pattern: "git reset --hard HEAD~1", action: "allow" }),
        destructiveMatch,
      );
      const result = engine.resolve("run_bash", { command: "git reset --hard HEAD~1" });
      expect(result.action).toBe("allow");
      expect(result.winningRule?.kind).toBe("exact");
    });
  });

  describe("session tier: not persisted to disk", () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "heirloom-engine-session-"));
      engine = new PermissionEngine(undefined, dir);
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("approveForSession takes effect immediately in-memory", () => {
      engine.approveForSession(rule({ tool: "run_bash", kind: "exact", pattern: "npm test", action: "allow" }));
      expect(engine.resolve("run_bash", { command: "npm test" }).action).toBe("allow");
    });

    it("approveForSession never writes settings.json", () => {
      engine.approveForSession(rule({ tool: "run_bash", kind: "exact", pattern: "npm test", action: "allow" }));
      expect(existsSync(join(dir, ".deepcode", "settings.json"))).toBe(false);
    });

    it("a fresh engine instance does not see a session-approved rule", () => {
      engine.approveForSession(rule({ tool: "run_bash", kind: "exact", pattern: "npm test", action: "allow" }));
      const fresh = new PermissionEngine(undefined, dir);
      expect(fresh.resolve("run_bash", { command: "npm test" }).action).toBe("ask");
    });
  });

  describe("always tier: atomic persistence", () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "heirloom-engine-always-"));
      engine = new PermissionEngine(undefined, dir);
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("approveAlways takes effect immediately in-memory, no reload needed", () => {
      engine.approveAlways(rule({ tool: "run_bash", kind: "exact", pattern: "npm test", action: "allow" }));
      expect(engine.resolve("run_bash", { command: "npm test" }).action).toBe("allow");
    });

    it("approveAlways writes settings.json with the new rules shape", () => {
      engine.approveAlways(rule({ tool: "run_bash", kind: "exact", pattern: "npm test", action: "allow" }));
      const settingsPath = join(dir, ".deepcode", "settings.json");
      expect(existsSync(settingsPath)).toBe(true);
      const written = JSON.parse(readFileSync(settingsPath, "utf-8"));
      expect(written.permissions.rules).toEqual([{ tool: "run_bash", pattern: "npm test", action: "allow" }]);
    });

    it("a fresh engine instance loaded from the persisted rules resolves the same way", () => {
      engine.approveAlways(rule({ tool: "run_bash", kind: "exact", pattern: "npm test", action: "allow" }));
      const settingsPath = join(dir, ".deepcode", "settings.json");
      const written = JSON.parse(readFileSync(settingsPath, "utf-8"));
      const reloaded = new PermissionEngine(
        { rules: written.permissions.rules.map((r: { tool: string; pattern: string; action: string }) => ({ ...r, kind: "exact", origin: "config" })) },
        dir,
      );
      expect(reloaded.resolve("run_bash", { command: "npm test" }).action).toBe("allow");
    });

    it("preserves unrelated top-level JSON keys already on disk", () => {
      engine.approveAlways(rule({ tool: "run_bash", kind: "exact", pattern: "npm test", action: "allow" }));
      const settingsPath = join(dir, ".deepcode", "settings.json");
      const first = JSON.parse(readFileSync(settingsPath, "utf-8"));
      first.someOtherKey = "preserved";
      writeFileSync(settingsPath, JSON.stringify(first, null, 2), "utf-8");

      engine.approveAlways(rule({ tool: "run_bash", kind: "exact", pattern: "git status", action: "allow" }));
      const second = JSON.parse(readFileSync(settingsPath, "utf-8"));
      expect(second.someOtherKey).toBe("preserved");
      expect(second.permissions.rules.length).toBe(2);
    });
  });

  describe("buildDefaultRule", () => {
    it("builds an exact-kind rule from the literal bash command", () => {
      const built = engine.buildDefaultRule("run_bash", { command: "npm test" });
      expect(built).toEqual({ tool: "run_bash", kind: "exact", pattern: "npm test", action: "allow", origin: "config" });
    });

    it("builds an exact-kind rule from a file path for non-bash tools", () => {
      const built = engine.buildDefaultRule("read_file", { path: "/workspace/secret.txt" });
      expect(built).toEqual({ tool: "read_file", kind: "exact", pattern: "/workspace/secret.txt", action: "allow", origin: "config" });
    });

    it("approving the built default rule for session makes the exact same call resolve to allow", () => {
      const built = engine.buildDefaultRule("run_bash", { command: "npm test" });
      engine.approveForSession(built);
      expect(engine.resolve("run_bash", { command: "npm test" }).action).toBe("allow");
    });

    it("the built default rule does not broaden to a similar-but-different call", () => {
      const built = engine.buildDefaultRule("run_bash", { command: "npm test" });
      engine.approveForSession(built);
      expect(engine.resolve("run_bash", { command: "npm test -- --watch" }).action).toBe("ask");
    });
  });

  describe("glob rules against absolute paths (relativize-to-workingDir)", () => {
    it("a './**' glob rule matches a real absolute in-cwd path (this is what migrateLegacyPermissions emits for read-in-cwd)", () => {
      engine = new PermissionEngine(
        { rules: [{ tool: "read_file", kind: "glob", pattern: "./**", action: "allow", origin: "config" }] },
        "/workspace",
      );
      const result = engine.resolve("read_file", { path: "/workspace/src/main.ts" });
      expect(result.action).toBe("allow");
    });

    it("a './**' glob rule does not match a path outside workingDir", () => {
      engine = new PermissionEngine(
        { rules: [{ tool: "read_file", kind: "glob", pattern: "./**", action: "allow", origin: "config" }] },
        "/workspace",
      );
      const result = engine.resolve("read_file", { path: "/etc/passwd" });
      expect(result.action).toBe("ask");
    });

    it("a narrower './src/**' glob rule matches only paths under that subdirectory", () => {
      engine = new PermissionEngine(
        { rules: [{ tool: "read_file", kind: "glob", pattern: "./src/**", action: "allow", origin: "config" }] },
        "/workspace",
      );
      expect(engine.resolve("read_file", { path: "/workspace/src/main.ts" }).action).toBe("allow");
      expect(engine.resolve("read_file", { path: "/workspace/docs/readme.md" }).action).toBe("ask");
    });
  });
});
