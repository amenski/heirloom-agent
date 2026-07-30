import { describe, it, expect, beforeEach } from "vitest";
import { PermissionEngine, type PermissionScope } from "./engine.js";

describe("PermissionEngine", () => {
  let engine: PermissionEngine;

  beforeEach(() => {
    engine = new PermissionEngine(undefined, "/workspace");
  });

  describe("classifyScopes", () => {
    it("classifies read_file in-cwd", () => {
      const scopes = engine.classifyScopes("read_file", { path: "/workspace/src/main.ts" });
      expect(scopes).toEqual(["read-in-cwd"]);
    });

    it("classifies read_file out-cwd", () => {
      const scopes = engine.classifyScopes("read_file", { path: "/etc/passwd" });
      expect(scopes).toEqual(["read-out-cwd"]);
    });

    it("classifies write_to_file in-cwd", () => {
      const scopes = engine.classifyScopes("write_to_file", { path: "/workspace/src/main.ts" });
      expect(scopes).toEqual(["write-in-cwd"]);
    });

    it("classifies edit out-cwd", () => {
      const scopes = engine.classifyScopes("edit", { path: "/etc/config" });
      expect(scopes).toEqual(["write-out-cwd"]);
    });

    it("classifies glob as read-in-cwd", () => {
      const scopes = engine.classifyScopes("glob", { pattern: "**/*.ts" });
      expect(scopes).toEqual(["read-in-cwd"]);
    });

    it("classifies mcp__* as mcp", () => {
      const scopes = engine.classifyScopes("mcp__filesystem", {});
      expect(scopes).toEqual(["mcp"]);
    });

    it("classifies bash with curl as network", () => {
      const scopes = engine.classifyScopes("run_bash", { command: "curl https://example.com" });
      expect(scopes).toContain("network");
    });

    it("classifies bash with npm install", () => {
      const scopes = engine.classifyScopes("run_bash", { command: "npm install react" });
      expect(scopes).toContain("write-in-cwd");
      expect(scopes).toContain("network");
    });

    it("classifies bash with git log", () => {
      const scopes = engine.classifyScopes("run_bash", { command: "git log --oneline" });
      expect(scopes).toContain("query-git-log");
    });

    it("classifies bash with git push", () => {
      const scopes = engine.classifyScopes("run_bash", { command: "git push origin main" });
      expect(scopes).toContain("mutate-git-log");
    });

    it("classifies bash with rm as delete-in-cwd", () => {
      const scopes = engine.classifyScopes("run_bash", { command: "rm -rf node_modules" });
      expect(scopes).toContain("delete-in-cwd");
    });

    it("returns empty for unknown tool", () => {
      const scopes = engine.classifyScopes("unknown_tool", {});
      expect(scopes).toEqual([]);
    });
  });

  describe("check", () => {
    it("allows when scope is in allow set", () => {
      engine = new PermissionEngine({ allow: ["read-in-cwd"] }, "/workspace");
      expect(engine.check("read_file", { path: "/workspace/src/main.ts" })).toBe("allow");
    });

    it("denies when scope is in deny set", () => {
      engine = new PermissionEngine({ deny: ["network"] }, "/workspace");
      expect(engine.check("run_bash", { command: "curl example.com" })).toBe("deny");
    });

    it("asks when scope is in ask set", () => {
      engine = new PermissionEngine({ ask: ["write-in-cwd"] }, "/workspace");
      expect(engine.check("write_to_file", { path: "/workspace/test.txt" })).toBe("ask");
    });

    it("asks when scopes empty", () => {
      expect(engine.check("unknown_tool", {})).toBe("ask");
    });

    it("allows unlisted scopes with defaultMode allowAll", () => {
      engine = new PermissionEngine({ defaultMode: "allowAll" }, "/workspace");
      expect(engine.check("read_file", { path: "/workspace/src/main.ts" })).toBe("allow");
    });

    it("asks unlisted scopes with defaultMode askAll", () => {
      engine = new PermissionEngine({ defaultMode: "askAll" }, "/workspace");
      expect(engine.check("read_file", { path: "/workspace/src/main.ts" })).toBe("ask");
    });

    it("deny takes priority over allow", () => {
      engine = new PermissionEngine({ allow: ["network"], deny: ["network"] }, "/workspace");
      expect(engine.check("run_bash", { command: "curl example.com" })).toBe("deny");
    });

    it("ask takes priority over default allow", () => {
      engine = new PermissionEngine({ ask: ["network"], defaultMode: "allowAll" }, "/workspace");
      expect(engine.check("run_bash", { command: "curl example.com" })).toBe("ask");
    });
  });

  describe("getDefaultMode", () => {
    it("returns allowAll by default", () => {
      expect(engine.getDefaultMode()).toBe("allowAll");
    });

    it("returns askAll when configured", () => {
      engine = new PermissionEngine({ defaultMode: "askAll" }, "/workspace");
      expect(engine.getDefaultMode()).toBe("askAll");
    });
  });
});
