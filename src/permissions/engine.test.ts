import { describe, it, expect, beforeEach } from "vitest";
import { PermissionEngine } from "./engine.js";

describe("PermissionEngine", () => {
  let engine: PermissionEngine;

  beforeEach(() => {
    engine = new PermissionEngine("/workspace");
  });

  describe("default ask behavior", () => {
    it("returns ask for any tool by default", () => {
      expect(engine.check("bash")).toBe("ask");
      expect(engine.check("edit")).toBe("ask");
      expect(engine.check("read")).toBe("ask");
    });
  });

  describe("allow rules", () => {
    it("returns allow when rule matches", () => {
      engine.addRule({ tool: "read", action: "allow" });
      expect(engine.check("read")).toBe("allow");
    });

    it("uses last match wins", () => {
      engine.addRule({ tool: "read", action: "deny" });
      engine.addRule({ tool: "read", action: "allow" });
      expect(engine.check("read")).toBe("allow");
    });
  });

  describe("deny rules", () => {
    it("returns deny when deny rule matches", () => {
      engine.addRule({ tool: "bash", action: "deny" });
      expect(engine.check("bash")).toBe("deny");
    });

    it("deny is absolute even in all mode", () => {
      engine.setApprovalMode("all");
      engine.addRule({ tool: "bash", action: "deny" });
      expect(engine.check("bash")).toBe("deny");
    });
  });

  describe("pattern matching", () => {
    it("matches * wildcard", () => {
      engine.addRule({ tool: "*", action: "allow" });
      expect(engine.check("read")).toBe("allow");
      expect(engine.check("edit")).toBe("allow");
    });

    it("matches path pattern", () => {
      engine.addRule({ tool: "bash", pattern: "/workspace/*", action: "allow" });
      expect(engine.check("bash", { path: "/workspace/src" })).toBe("allow");
      expect(engine.check("bash", { path: "/tmp/evil" })).toBe("ask");
    });

    it("matches filePath pattern", () => {
      engine.addRule({ tool: "read", pattern: "/workspace/*", action: "allow" });
      expect(engine.check("read", { path: "/workspace/src/index.ts" })).toBe("allow");
      expect(engine.check("read", { path: "/etc/passwd" })).toBe("ask");
    });
  });

  describe("approval modes", () => {
    it("manual mode requires ask for non-pattern tools", () => {
      engine.setApprovalMode("manual");
      expect(engine.check("bash")).toBe("ask");
    });

    it("all mode allows everything not denied", () => {
      engine.setApprovalMode("all");
      expect(engine.check("bash")).toBe("allow");
      expect(engine.check("read")).toBe("allow");
    });

    it("edits mode allows edits in workspace", () => {
      engine.setApprovalMode("edits");
      expect(engine.check("edit", { path: "/workspace/src/foo.ts" })).toBe("allow");
    });

    it("edits mode asks for edits outside workspace", () => {
      engine.setApprovalMode("edits");
      expect(engine.check("edit", { path: "/etc/passwd" })).toBe("ask");
    });

    it("edits mode asks for non-edit tools", () => {
      engine.setApprovalMode("edits");
      expect(engine.check("bash")).toBe("ask");
    });
  });

  describe("session rules", () => {
    it("session rules override base rules", () => {
      engine.addRule({ tool: "read", action: "deny" });
      engine.addSessionRule({ tool: "read", action: "allow" });
      expect(engine.check("read")).toBe("allow");
    });

    it("getSessionRules returns added session rules", () => {
      engine.addSessionRule({ tool: "read", action: "allow" });
      engine.addSessionRule({ tool: "edit", action: "deny" });
      expect(engine.getSessionRules()).toHaveLength(2);
    });
  });

  describe("defaults", () => {
    it("creates engine with default ask rule", () => {
      const e = PermissionEngine.defaults("/workspace");
      expect(e.check("any_tool")).toBe("ask");
    });
  });
});
