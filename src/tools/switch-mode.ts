import type { ToolDef } from "../types.js";
import type { ToolHandler } from "./types.js";
import type { ToolRegistry } from "./registry.js";

const switchModeHandler: ToolHandler = async (args, ctx) => {
  const slug = typeof args.slug === "string" ? args.slug.trim() : "";
  if (!slug) {
    return { content: "Error: slug is required.", error: "Missing required argument: slug" };
  }
  if (!ctx.setMode) {
    return { content: "Error: mode switching is not available in this context.", error: "unsupported" };
  }
  const name = await ctx.setMode(slug);
  if (!name) {
    return { content: `Unknown mode: "${slug}".`, error: "UNKNOWN_MODE" };
  }
  return { content: `Switched to ${name} mode. The new mode's tool set and instructions apply from the next turn.` };
};

const switchModeDef: ToolDef = {
  name: "switch_mode",
  description:
    "Switch the active persona mode (general, code, or a custom mode). The new mode's tool set and instructions apply from the next turn. Legacy modes remain accepted for resumed sessions and explicit compatibility switches.",
  parameters: {
    type: "object",
    properties: {
      slug: { type: "string", description: "The mode slug to switch to." },
      reason: { type: "string", description: "Optional reason for the switch." },
    },
    required: ["slug"],
  },
};

export function registerSwitchMode(registry: ToolRegistry): void {
  registry.register({
    def: switchModeDef,
    handler: switchModeHandler,
    groups: ["read", "edit", "command", "mcp", "workflow"],
  });
}
