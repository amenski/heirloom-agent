import { ToolRegistry } from "./registry.js";
import type { ToolCall, ToolOutput } from "../types.js";
import type { ToolContext } from "./types.js";
import type { CheckpointManager } from "../checkpoints/index.js";
import { registerFiles } from "./files.js";
import { registerBash } from "./bash.js";
import { registerSearch } from "./search.js";
import { registerEdits } from "./edit.js";

const registry = new ToolRegistry();
registerFiles(registry);
registerBash(registry);
registerSearch(registry);
registerEdits(registry);

export { registry };
export const TOOL_DEFS = registry.getAllDefs();

const ctx: ToolContext = {
  workingDir: process.cwd(),
  sessionId: "default",
  askUser: async () => true,
  signal: new AbortController().signal,
};

export function setSessionId(id: string): void {
  ctx.sessionId = id;
}

export function setCheckpointManager(cpm: CheckpointManager): void {
  ctx.checkpoint = cpm;
}

export async function executeTool(call: ToolCall): Promise<ToolOutput> {
  return registry.execute(call, ctx);
}
