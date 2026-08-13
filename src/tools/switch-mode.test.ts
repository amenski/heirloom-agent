import { describe, it, expect, vi } from "vitest";
import { ToolRegistry } from "./registry.js";
import type { ToolContext } from "./types.js";
import { registerSwitchMode } from "./switch-mode.js";

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registerSwitchMode(registry);
  return registry;
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workingDir: "/tmp",
    sessionId: "test",
    signal: new AbortController().signal,
    ...overrides,
  };
}

function exec(registry: ToolRegistry, args: Record<string, unknown>, ctx: ToolContext) {
  return registry.execute({ id: "t1", name: "switch_mode", arguments: args }, ctx);
}

describe("switch_mode handler", () => {
  it("calls ctx.setMode and reports the switch", async () => {
    const registry = makeRegistry();
    const setMode = vi.fn(async () => "Architect");
    const out = await exec(registry, { slug: "architect" }, makeCtx({ setMode }));
    expect(setMode).toHaveBeenCalledWith("architect");
    expect(out.error).toBeUndefined();
    expect(out.content).toContain("Switched to Architect mode");
  });

  it("reports an unknown slug as an error", async () => {
    const registry = makeRegistry();
    const setMode = vi.fn(async () => null);
    const out = await exec(registry, { slug: "nope" }, makeCtx({ setMode }));
    expect(out.error).toContain("UNKNOWN_MODE");
    expect(out.content).toContain('Unknown mode: "nope"');
  });

  it("fails cleanly when setMode is not wired", async () => {
    const registry = makeRegistry();
    const out = await exec(registry, { slug: "code" }, makeCtx());
    expect(out.error).toContain("unsupported");
  });

  it("requires the slug argument", async () => {
    const registry = makeRegistry();
    const out = await exec(registry, {}, makeCtx({ setMode: async () => "Code" }));
    expect(out.error).toContain("Missing required argument: slug");
  });
});
