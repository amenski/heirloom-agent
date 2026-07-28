import { describe, it, expect, beforeEach } from "vitest";
import { ToolRegistry } from "./registry.js";
import type { ToolDef, ToolOutput } from "../types.js";
import type { ToolHandler, ToolContext } from "./types.js";

function makeDef(name: string): ToolDef {
  return {
    name,
    description: `${name} tool`,
    parameters: { type: "object", properties: {}, required: [] },
  };
}

const noopHandler: ToolHandler = async (_args, _ctx) => ({
  content: "ok",
});

const mockCtx: ToolContext = {
  workingDir: "/tmp",
  sessionId: "test",
  askUser: async () => true,
  signal: new AbortController().signal,
};

describe("ToolRegistry", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  describe("register and getByMode", () => {
    it("returns tools matching the requested groups", () => {
      registry.register({ def: makeDef("read_file"), handler: noopHandler, groups: ["read"] });
      registry.register({ def: makeDef("edit"), handler: noopHandler, groups: ["edit"] });
      registry.register({ def: makeDef("bash"), handler: noopHandler, groups: ["command"] });

      const readTools = registry.getByMode(["read"]);
      expect(readTools).toHaveLength(1);
      expect(readTools[0].name).toBe("read_file");
    });

    it("returns tools matching any of the requested groups", () => {
      registry.register({ def: makeDef("read_file"), handler: noopHandler, groups: ["read"] });
      registry.register({ def: makeDef("edit"), handler: noopHandler, groups: ["edit"] });
      registry.register({ def: makeDef("bash"), handler: noopHandler, groups: ["command"] });

      const both = registry.getByMode(["read", "command"]);
      expect(both).toHaveLength(2);
      const names = both.map((d) => d.name);
      expect(names).toContain("read_file");
      expect(names).toContain("bash");
    });

    it("always tools included regardless of mode", () => {
      registry.register({ def: makeDef("read_file"), handler: noopHandler, groups: [], always: true });
      registry.register({ def: makeDef("edit"), handler: noopHandler, groups: ["edit"] });

      const readTools = registry.getByMode(["read"]);
      expect(readTools).toHaveLength(1);
      expect(readTools[0].name).toBe("read_file");
    });
  });

  describe("execute", () => {
    it("returns error for unknown tool", async () => {
      const result = await registry.execute(
        { id: "1", name: "nonexistent", arguments: {} },
        mockCtx,
      );
      expect(result.error).toContain("Unknown tool");
    });

    it("executes registered tool", async () => {
      registry.register({
        def: makeDef("greet"),
        handler: async (args) => {
          return { content: `Hello ${args.name}` };
        },
        groups: ["command"],
      });

      const result = await registry.execute(
        { id: "1", name: "greet", arguments: { name: "World" } },
        mockCtx,
      );
      expect(result.error).toBeUndefined();
      expect(result.content).toBe("Hello World");
    });

    it("catches handler errors gracefully", async () => {
      registry.register({
        def: makeDef("failing"),
        handler: async () => {
          throw new Error("boom");
        },
        groups: ["command"],
      });

      const result = await registry.execute(
        { id: "1", name: "failing", arguments: {} },
        mockCtx,
      );
      expect(result.error).toBe("boom");
    });
  });

  describe("getAllDefs", () => {
    it("returns all registered tool defs", () => {
      registry.register({ def: makeDef("a"), handler: noopHandler, groups: ["read"] });
      registry.register({ def: makeDef("b"), handler: noopHandler, groups: ["edit"] });

      const all = registry.getAllDefs();
      expect(all).toHaveLength(2);
      expect(all.map((d) => d.name).sort()).toEqual(["a", "b"]);
    });
  });
});
