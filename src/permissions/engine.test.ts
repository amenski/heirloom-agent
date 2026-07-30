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

    it("classifies glob as scan", () => {
      const scopes = engine.classifyScopes("glob", { pattern: "**/*.ts" });
      expect(scopes).toEqual(["scan"]);
    });

    it("classifies search as scan", () => {
      const scopes = engine.classifyScopes("search", { pattern: "foo", dir: "/workspace" });
      expect(scopes).toEqual(["scan"]);
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

    it("asks unlisted scopes with defaultMode askAll (out-of-cwd read)", () => {
      engine = new PermissionEngine({ defaultMode: "askAll" }, "/workspace");
      expect(engine.check("read_file", { path: "/etc/passwd" })).toBe("ask");
    });

    it("deny takes priority over allow", () => {
      engine = new PermissionEngine({ allow: ["network"], deny: ["network"] }, "/workspace");
      expect(engine.check("run_bash", { command: "curl example.com" })).toBe("deny");
    });

    it("ask takes priority over default allow", () => {
      engine = new PermissionEngine({ ask: ["network"], defaultMode: "allowAll" }, "/workspace");
      expect(engine.check("run_bash", { command: "curl example.com" })).toBe("ask");
    });

    it("asks for glob/search by default (scan scope)", () => {
      engine = new PermissionEngine({ defaultMode: "allowAll" }, "/workspace");
      expect(engine.check("glob", { pattern: "**/*.ts" })).toBe("ask");
      expect(engine.check("search", { pattern: "foo" })).toBe("ask");
    });

    it("allows glob/search when scan is in allow set", () => {
      engine = new PermissionEngine({ allow: ["scan"], defaultMode: "allowAll" }, "/workspace");
      expect(engine.check("glob", { pattern: "**/*.ts" })).toBe("allow");
      expect(engine.check("search", { pattern: "foo" })).toBe("allow");
    });
  });

  describe("default posture with no config on disk", () => {
    it("allows read_file in cwd by default", () => {
      expect(engine.check("read_file", { path: "/workspace/src/main.ts" })).toBe("allow");
    });

    it("allows list_files (read-in-cwd) by default", () => {
      expect(engine.check("list_files", { path: "/workspace" })).toBe("allow");
    });

    it("allows load_skill (read-in-cwd) by default", () => {
      expect(engine.check("load_skill", {})).toBe("allow");
    });

    it("asks for read_file out of cwd by default", () => {
      expect(engine.check("read_file", { path: "/etc/passwd" })).toBe("ask");
    });

    it("asks for write_to_file in cwd by default", () => {
      expect(engine.check("write_to_file", { path: "/workspace/test.txt" })).toBe("ask");
    });

    it("asks for edit out of cwd by default", () => {
      expect(engine.check("edit", { path: "/etc/config" })).toBe("ask");
    });

    it("asks for rm in cwd (delete-in-cwd) by default", () => {
      expect(engine.check("run_bash", { command: "rm -rf node_modules" })).toBe("ask");
    });

    it("asks for glob/search (scan) by default", () => {
      expect(engine.check("glob", { pattern: "**/*.ts" })).toBe("ask");
      expect(engine.check("search", { pattern: "foo" })).toBe("ask");
    });

    it("asks for network commands by default", () => {
      expect(engine.check("run_bash", { command: "curl https://example.com" })).toBe("ask");
    });

    it("asks for mcp tools by default", () => {
      expect(engine.check("mcp__filesystem", {})).toBe("ask");
    });

    it("asks for git log (query-git-log) by default", () => {
      expect(engine.check("run_bash", { command: "git log --oneline" })).toBe("ask");
    });

    it("asks for git commit (mutate-git-log) by default", () => {
      expect(engine.check("run_bash", { command: "git commit -m test" })).toBe("ask");
    });

    it("asks for unknown/empty-scope tools by default", () => {
      expect(engine.check("unknown_tool", {})).toBe("ask");
    });
  });

  describe("explicit config precedence", () => {
    it("honors an explicit empty allow array verbatim (no read-in-cwd auto-injection)", () => {
      engine = new PermissionEngine({ allow: [] }, "/workspace");
      expect(engine.check("read_file", { path: "/workspace/src/main.ts" })).toBe("ask");
    });

    it("honors an explicit non-empty allow array verbatim (does not add read-in-cwd)", () => {
      engine = new PermissionEngine({ allow: ["network"] }, "/workspace");
      expect(engine.check("read_file", { path: "/workspace/src/main.ts" })).toBe("ask");
      expect(engine.check("run_bash", { command: "curl example.com" })).toBe("allow");
    });

    it("honors an explicit defaultMode allowAll even with no allow list given", () => {
      engine = new PermissionEngine({ defaultMode: "allowAll" }, "/workspace");
      expect(engine.check("write_to_file", { path: "/workspace/test.txt" })).toBe("allow");
    });

    it("deny still wins over the default read-in-cwd allow", () => {
      engine = new PermissionEngine({ deny: ["read-in-cwd"] }, "/workspace");
      expect(engine.check("read_file", { path: "/workspace/src/main.ts" })).toBe("deny");
    });

    it("autoApprove still overrides the default ask-everything posture", () => {
      engine.setAutoApprove(true);
      expect(engine.check("write_to_file", { path: "/workspace/test.txt" })).toBe("allow");
      expect(engine.check("run_bash", { command: "curl example.com" })).toBe("allow");
    });
  });

  describe("autoApprove", () => {
    it("turns a would-be ask into allow", () => {
      engine = new PermissionEngine({ ask: ["network"], defaultMode: "askAll" }, "/workspace");
      expect(engine.check("run_bash", { command: "curl example.com" })).toBe("ask");
      engine.setAutoApprove(true);
      expect(engine.check("run_bash", { command: "curl example.com" })).toBe("allow");
    });

    it("still honors explicit deny", () => {
      engine = new PermissionEngine({ deny: ["network"] }, "/workspace");
      engine.setAutoApprove(true);
      expect(engine.check("run_bash", { command: "curl example.com" })).toBe("deny");
    });

    it("can be toggled back off", () => {
      engine = new PermissionEngine({ defaultMode: "askAll" }, "/workspace");
      engine.setAutoApprove(true);
      expect(engine.check("read_file", { path: "/etc/passwd" })).toBe("allow");
      engine.setAutoApprove(false);
      expect(engine.check("read_file", { path: "/etc/passwd" })).toBe("ask");
      expect(engine.isAutoApprove()).toBe(false);
    });
  });

  describe("getDefaultMode", () => {
    it("returns askAll by default", () => {
      expect(engine.getDefaultMode()).toBe("askAll");
    });

    it("returns askAll when configured", () => {
      engine = new PermissionEngine({ defaultMode: "askAll" }, "/workspace");
      expect(engine.getDefaultMode()).toBe("askAll");
    });
  });
});
