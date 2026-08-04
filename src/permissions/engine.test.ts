import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
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

    it("allows a plain in-repo read_file call by default (reads inside the working tree are free)", () => {
      expect(engine.resolve("read_file", { path: "/workspace/src/main.ts" }).action).toBe("allow");
    });

    it("still asks for a read_file call outside the working tree by default", () => {
      expect(engine.resolve("read_file", { path: "/etc/passwd" }).action).toBe("ask");
    });

    it("asks for run_bash by default", () => {
      expect(engine.resolve("run_bash", { command: "git status" }).action).toBe("ask");
    });
  });

  describe("builtin-allow: free read-only access inside the working tree", () => {
    it("allows read_file, list_files, glob, and search inside the repo with no config", () => {
      expect(engine.resolve("read_file", { path: "/workspace/src/a.ts" }).action).toBe("allow");
      expect(engine.resolve("list_files", { path: "/workspace/src" }).action).toBe("allow");
      expect(engine.resolve("glob", { path: "**/*.ts" }).action).toBe("allow");
      expect(engine.resolve("search", { path: "TODO" }).action).toBe("allow");
    });

    it("does not extend the free-read fallback to write_to_file or edit", () => {
      expect(engine.resolve("write_to_file", { path: "/workspace/src/a.ts" }).action).toBe("ask");
      expect(engine.resolve("edit", { path: "/workspace/src/a.ts" }).action).toBe("ask");
    });

    it("still asks for reads outside the working tree", () => {
      expect(engine.resolve("read_file", { path: "/etc/passwd" }).action).toBe("ask");
      expect(engine.resolve("list_files", { path: "/etc" }).action).toBe("ask");
    });

    it("a user deny rule still overrides the free-read fallback (real match pre-empts it)", () => {
      engine = new PermissionEngine(
        { rules: [{ tool: "read_file", kind: "glob", pattern: "./secret/**", action: "deny", origin: "config" }] },
        "/workspace",
      );
      expect(engine.resolve("read_file", { path: "/workspace/secret/x.ts" }).action).toBe("deny");
      // other in-repo reads remain free
      expect(engine.resolve("read_file", { path: "/workspace/src/a.ts" }).action).toBe("allow");
    });
  });

  describe("explicit config precedence", () => {
    it("honors an explicit empty rules array verbatim (asks for everything except the free in-repo reads)", () => {
      engine = new PermissionEngine({ rules: [] }, "/workspace");
      // An empty config still asks for state-changing tools...
      expect(engine.resolve("run_bash", { command: "git status" }).action).toBe("ask");
      // ...but in-repo reads remain free via the builtin-allow fallback.
      expect(engine.resolve("read_file", { path: "/workspace/src/main.ts" }).action).toBe("allow");
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

    it("flags sudo as unresolved-ask (privilege escalation always prompts)", () => {
      engine = new PermissionEngine(
        { rules: [rule({ tool: "run_bash", kind: "exact", pattern: "npm test", action: "allow" })] },
        "/workspace",
      );
      // sudo is now detected by isUnresolved before stripSudo, so even a
      // harmless sudo npm test prompts — privilege escalation is always ask.
      const result = engine.resolve("run_bash", { command: "sudo npm test" });
      expect(result.action).toBe("ask");
      expect(result.wasUnresolved).toBe(true);
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

    it("buildDefaultRule + narrowToExact only allows the specific approved command, not the broader prefix category", () => {
      // This is the real code path: handlePermissionDecision passes
      // buildDefaultRule (specific command) + the builtin match (narrowing
      // signal). The destructive deny should still block a different reset.
      // Use approveForSession to skip filesystem persistence (this engine
      // has workingDir "/workspace" which doesn't exist on disk).
      const destructiveMatch = rule({ tool: "run_bash", kind: "prefix", pattern: "git reset --hard", origin: "builtin-destructive", action: "deny" });
      engine.approveForSession(
        engine.buildDefaultRule("run_bash", { command: "git reset --hard HEAD~1" }),
        destructiveMatch,
      );
      // The exact approved command is allowed
      expect(engine.resolve("run_bash", { command: "git reset --hard HEAD~1" }).action).toBe("allow");
      // A slightly different command still resolves to deny (not blanket-allowed)
      expect(engine.resolve("run_bash", { command: "git reset --hard HEAD~2" }).action).toBe("deny");
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
      expect(existsSync(join(dir, ".heirloom", "settings.json"))).toBe(false);
    });

    it("a fresh engine instance does not see a session-approved rule", () => {
      engine.approveForSession(rule({ tool: "run_bash", kind: "exact", pattern: "npm test", action: "allow" }));
      const fresh = new PermissionEngine(undefined, dir);
      expect(fresh.resolve("run_bash", { command: "npm test" }).action).toBe("ask");
    });
  });

  describe("folderScopeRule: offer whole-folder only on a second call of the same kind", () => {
    it("returns undefined for a tool that is neither a read nor a write/edit tool", () => {
      engine.approveForSession(rule({ tool: "run_bash", kind: "exact", pattern: "npm test", action: "allow" }));
      expect(engine.folderScopeRule("run_bash", { path: "./src/b.ts" })).toBeUndefined();
    });

    it("returns undefined when no sibling read is approved yet (first read)", () => {
      expect(engine.folderScopeRule("read_file", { path: "./src/a.ts" })).toBeUndefined();
    });

    it("returns a recursive folder glob once a sibling exact read is approved", () => {
      engine.approveForSession(rule({ tool: "read_file", kind: "exact", pattern: "./src/a.ts", action: "allow" }));
      const folderRule = engine.folderScopeRule("read_file", { path: "./src/b.ts" });
      expect(folderRule).toEqual({
        tool: "read_file",
        kind: "glob",
        pattern: "./src/**",
        action: "allow",
        origin: "config",
      });
    });

    it("does not offer the folder when the only prior approval is the same file", () => {
      engine.approveForSession(rule({ tool: "read_file", kind: "exact", pattern: "./src/a.ts", action: "allow" }));
      expect(engine.folderScopeRule("read_file", { path: "./src/a.ts" })).toBeUndefined();
    });

    it("does not offer the folder for a sibling approval in a different folder", () => {
      engine.approveForSession(rule({ tool: "read_file", kind: "exact", pattern: "./lib/a.ts", action: "allow" }));
      expect(engine.folderScopeRule("read_file", { path: "./src/b.ts" })).toBeUndefined();
    });

    it("returns undefined for an external path", () => {
      engine.approveForSession(rule({ tool: "read_file", kind: "exact", pattern: "/etc/a.conf", action: "allow" }));
      expect(engine.folderScopeRule("read_file", { path: "/etc/b.conf" })).toBeUndefined();
    });

    it("normalizes the incoming path spelling before comparing folders", () => {
      engine.approveForSession(rule({ tool: "read_file", kind: "exact", pattern: "./src/a.ts", action: "allow" }));
      // "src/b.ts" (no leading ./) must normalize to the same folder as "./src/a.ts"
      const folderRule = engine.folderScopeRule("read_file", { path: "src/b.ts" });
      expect(folderRule?.pattern).toBe("./src/**");
    });

    it("returns a recursive folder glob for a write tool once a sibling exact write is approved", () => {
      engine.approveForSession(rule({ tool: "write_to_file", kind: "exact", pattern: "./src/a.ts", action: "allow" }));
      const folderRule = engine.folderScopeRule("write_to_file", { path: "./src/b.ts" });
      expect(folderRule).toEqual({
        tool: "write_to_file",
        kind: "glob",
        pattern: "./src/**",
        action: "allow",
        origin: "config",
      });
    });

    it("does not offer a write folder grant when the only sibling approval is a READ in that folder", () => {
      engine.approveForSession(rule({ tool: "read_file", kind: "exact", pattern: "./src/a.ts", action: "allow" }));
      expect(engine.folderScopeRule("write_to_file", { path: "./src/b.ts" })).toBeUndefined();
    });

    it("returns undefined for a write tool with an external (non-\"./\") path", () => {
      engine.approveForSession(rule({ tool: "write_to_file", kind: "exact", pattern: "/etc/a.conf", action: "allow" }));
      expect(engine.folderScopeRule("write_to_file", { path: "/etc/b.conf" })).toBeUndefined();
    });

    it("returns undefined for the first write in a folder (no sibling write approval yet)", () => {
      expect(engine.folderScopeRule("write_to_file", { path: "./src/a.ts" })).toBeUndefined();
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
      const settingsPath = join(dir, ".heirloom", "settings.json");
      expect(existsSync(settingsPath)).toBe(true);
      const written = JSON.parse(readFileSync(settingsPath, "utf-8"));
      expect(written.permissions.rules).toEqual([{ tool: "run_bash", pattern: "npm test", action: "allow" }]);
    });

    it("a fresh engine instance loaded from the persisted rules resolves the same way", () => {
      engine.approveAlways(rule({ tool: "run_bash", kind: "exact", pattern: "npm test", action: "allow" }));
      const settingsPath = join(dir, ".heirloom", "settings.json");
      const written = JSON.parse(readFileSync(settingsPath, "utf-8"));
      const reloaded = new PermissionEngine(
        { rules: written.permissions.rules.map((r: { tool: string; pattern: string; action: string }) => ({ ...r, kind: "exact", origin: "config" })) },
        dir,
      );
      expect(reloaded.resolve("run_bash", { command: "npm test" }).action).toBe("allow");
    });

    it("preserves unrelated top-level JSON keys already on disk", () => {
      engine.approveAlways(rule({ tool: "run_bash", kind: "exact", pattern: "npm test", action: "allow" }));
      const settingsPath = join(dir, ".heirloom", "settings.json");
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

    it("builds an exact-kind rule from a file path, normalized to working-dir-relative form", () => {
      const built = engine.buildDefaultRule("read_file", { path: "/workspace/secret.txt" });
      expect(built).toEqual({ tool: "read_file", kind: "exact", pattern: "./secret.txt", action: "allow", origin: "config" });
    });

    it("normalizes different spellings of the same path to one canonical form", () => {
      expect(engine.buildDefaultRule("read_file", { path: "src/main.ts" }).pattern).toBe("./src/main.ts");
      expect(engine.buildDefaultRule("read_file", { path: "./src/main.ts" }).pattern).toBe("./src/main.ts");
      expect(engine.buildDefaultRule("read_file", { path: "/workspace/src/main.ts" }).pattern).toBe("./src/main.ts");
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

    it("broadens an external path to a parent-directory glob", () => {
      const built = engine.buildDefaultRule("read_file", { path: "/etc/nginx/nginx.conf" });
      expect(built.kind).toBe("glob");
      expect(built.pattern).toBe("/etc/nginx/*");
    });

    it("broadens an existing internal directory to a recursive glob", () => {
      const dir = mkdtempSync(join(tmpdir(), "heirloom-buildrule-dir-"));
      try {
        // Create a subdirectory inside the working dir so it's internal
        const subdir = join(dir, "packages");
        mkdirSync(subdir);
        const scopedEngine = new PermissionEngine(undefined, dir);
        const built = scopedEngine.buildDefaultRule("read_file", { path: subdir });
        expect(built.kind).toBe("glob");
        expect(built.pattern).toBe("./packages/**");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("keeps an internal non-existent path as exact match (file, not directory)", () => {
      const built = engine.buildDefaultRule("read_file", { path: "src/nonexistent.ts" });
      expect(built.kind).toBe("exact");
      expect(built.pattern).toBe("./src/nonexistent.ts");
    });

    it("guarded narrowing still forces exact even when buildDefaultRule broadens to glob", () => {
      const dir = mkdtempSync(join(tmpdir(), "heirloom-buildrule-guarded-dir-"));
      try {
        // Create a subdirectory so buildDefaultRule would broaden to glob
        const subdir = join(dir, "config");
        mkdirSync(subdir);
        const envPath = join(subdir, ".env");
        const scopedEngine = new PermissionEngine(undefined, dir);
        const guardedMatch: PermissionRule = { tool: "read_file", kind: "glob", pattern: "**/.env*", action: "ask", origin: "builtin-guarded" };
        // buildDefaultRule broadens the subdir to glob, but narrowing forces exact on the .env path
        scopedEngine.approveAlways(scopedEngine.buildDefaultRule("read_file", { path: envPath }), guardedMatch);
        const result = scopedEngine.resolve("read_file", { path: envPath });
        expect(result.action).toBe("allow");
        expect(result.winningRule?.kind).toBe("exact");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
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
      // Uses write_to_file, not read_file: in-repo reads are free via the
      // builtin-allow fallback, which would mask a narrow read glob's scoping.
      // write_to_file has no such fallback, so it isolates the glob semantics.
      engine = new PermissionEngine(
        { rules: [{ tool: "write_to_file", kind: "glob", pattern: "./src/**", action: "allow", origin: "config" }] },
        "/workspace",
      );
      expect(engine.resolve("write_to_file", { path: "/workspace/src/main.ts" }).action).toBe("allow");
      expect(engine.resolve("write_to_file", { path: "/workspace/docs/readme.md" }).action).toBe("ask");
    });
  });

  describe("path normalization: different spellings of the same path", () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "heirloom-engine-pathnorm-"));
      engine = new PermissionEngine(undefined, dir);
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("an exact-match rule approved with one spelling matches the same file via a different spelling", () => {
      // Approve with an absolute path
      const absPath = join(dir, "src/main.ts");
      engine.approveForSession(engine.buildDefaultRule("read_file", { path: absPath }));

      // Same file, different spellings — all should resolve to allow
      expect(engine.resolve("read_file", { path: absPath }).action).toBe("allow");
      expect(engine.resolve("read_file", { path: "src/main.ts" }).action).toBe("allow");
      expect(engine.resolve("read_file", { path: "./src/main.ts" }).action).toBe("allow");
    });

    it("an exact-match rule approved with a relative spelling matches absolute-path calls", () => {
      engine.approveForSession(engine.buildDefaultRule("read_file", { path: "./src/main.ts" }));

      const absPath = join(dir, "src/main.ts");
      expect(engine.resolve("read_file", { path: absPath }).action).toBe("allow");
      expect(engine.resolve("read_file", { path: "src/main.ts" }).action).toBe("allow");
    });

    it("normalizes persisted absolute-path rules on load (backward compat)", () => {
      // Simulate a pre-normalization persisted rule with an absolute pattern
      const absPath = join(dir, "src/main.ts");
      const oldRule: PermissionRule = {
        tool: "read_file", kind: "exact", pattern: absPath, action: "allow", origin: "config",
      };
      const reloaded = new PermissionEngine({ rules: [oldRule] }, dir);
      expect(reloaded.resolve("read_file", { path: "src/main.ts" }).action).toBe("allow");
      expect(reloaded.resolve("read_file", { path: "./src/main.ts" }).action).toBe("allow");
    });

    it("does not affect bash exact-match rules (resolvedPath is undefined for run_bash)", () => {
      engine.approveForSession(engine.buildDefaultRule("run_bash", { command: "npm test" }));
      expect(engine.resolve("run_bash", { command: "npm test" }).action).toBe("allow");
      // Only the exact command should match — no path normalization for bash
      expect(engine.resolve("run_bash", { command: "npm test -- --watch" }).action).toBe("ask");
    });
  });

  describe("guarded tier: secret-adjacent paths always ask, never silently auto-allow", () => {
    it("reading .env resolves to ask with isGuarded true, even with no config at all", () => {
      const result = engine.resolve("read_file", { path: "/workspace/.env" });
      expect(result.action).toBe("ask");
      expect(result.isGuarded).toBe(true);
    });

    it("an ordinary read (no guarded match) has isGuarded false", () => {
      const result = engine.resolve("read_file", { path: "/workspace/src/main.ts" });
      expect(result.isGuarded).toBe(false);
    });

    it("defaultMode allowAll does NOT silently allow a guarded path — ask still wins over the fallback", () => {
      engine = new PermissionEngine({ defaultMode: "allowAll", rules: [{ tool: "read_file", kind: "any", pattern: "", action: "allow", origin: "config" }] }, "/workspace");
      const result = engine.resolve("read_file", { path: "/workspace/.env" });
      expect(result.action).toBe("ask");
      expect(result.isGuarded).toBe(true);
    });

    it("the free in-repo read fallback does NOT allow a guarded path — .env still asks with no config at all", () => {
      // Regression guard for builtin-allow: the "./**" read fallback must be
      // pre-empted by the guarded .env match. If builtin-allow were ever
      // pooled with the specificity-ranked rules, its "./**" (specificity 51)
      // would out-rank the guarded "**/.env*" ask (specificity 6) and silently
      // allow reading secrets. This test fails loudly if that happens.
      const result = engine.resolve("read_file", { path: "/workspace/.env" });
      expect(result.action).toBe("ask");
      expect(result.isGuarded).toBe(true);
    });

    it("a strictly-more-specific user allow can still override a guarded ask (same override mechanics as any other ask-tier rule)", () => {
      engine = new PermissionEngine(
        { rules: [{ tool: "read_file", kind: "exact", pattern: "/workspace/.env", action: "allow", origin: "config" }] },
        "/workspace",
      );
      const result = engine.resolve("read_file", { path: "/workspace/.env" });
      expect(result.action).toBe("allow");
    });

    it("approveAlways on a guarded match forces kind exact, mirroring destructive narrowing", () => {
      const dir = mkdtempSync(join(tmpdir(), "heirloom-engine-guarded-"));
      try {
        const scopedEngine = new PermissionEngine(undefined, dir);
        const envPath = join(dir, ".env");
        const guardedMatch: PermissionRule = { tool: "read_file", kind: "glob", pattern: "**/.env*", action: "ask", origin: "builtin-guarded" };
        scopedEngine.approveAlways(scopedEngine.buildDefaultRule("read_file", { path: envPath }), guardedMatch);
        const result = scopedEngine.resolve("read_file", { path: envPath });
        expect(result.action).toBe("allow");
        expect(result.winningRule?.kind).toBe("exact");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("buildDefaultRule + guarded narrowToExact only allows the specific file, not the whole guarded glob category", () => {
      const dir = mkdtempSync(join(tmpdir(), "heirloom-engine-guarded-scope-"));
      try {
        const scopedEngine = new PermissionEngine(undefined, dir);
        const envPath = join(dir, ".env");
        const nestedEnvPath = join(dir, "subdir", ".env");
        const guardedMatch: PermissionRule = { tool: "read_file", kind: "glob", pattern: "**/.env*", action: "ask", origin: "builtin-guarded" };
        // Approve always on the root .env using buildDefaultRule (the real code path)
        scopedEngine.approveAlways(scopedEngine.buildDefaultRule("read_file", { path: envPath }), guardedMatch);
        // The exact approved file is allowed
        expect(scopedEngine.resolve("read_file", { path: envPath }).action).toBe("allow");
        // A different .env in a subdirectory still resolves to ask (not blanket-allowed)
        expect(scopedEngine.resolve("read_file", { path: nestedEnvPath }).action).toBe("ask");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
