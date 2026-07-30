import { ToolRegistry } from "./registry.js";
import type { ToolCall, ToolOutput } from "../types.js";
import type { ToolContext } from "./types.js";
import type { CheckpointManager } from "../checkpoints/index.js";
import { registerFiles } from "./files.js";
import { registerBash } from "./bash.js";
import { registerSearch } from "./search.js";
import { registerEdits } from "./edit.js";
import { registerAskUserQuestion } from "./ask_user_question.js";

const registry = new ToolRegistry();
registerFiles(registry);
registerBash(registry);
registerSearch(registry);
registerEdits(registry);
registerAskUserQuestion(registry);

export { registry };
export const TOOL_DEFS = registry.getAllDefs();

const ctx: ToolContext = {
  workingDir: process.cwd(),
  sessionId: "default",
  askUser: undefined,
  askQuestion: undefined,
  signal: new AbortController().signal,
  fileMtimes: new Map(),
};

export function setSessionId(id: string): void {
  ctx.sessionId = id;
}

export function setAskQuestion(fn: ToolContext["askQuestion"]): void {
  ctx.askQuestion = fn;
}

export function setCheckpointManager(cpm: CheckpointManager): void {
  ctx.checkpoint = cpm;
}

export function setSignal(signal: AbortSignal): void {
  ctx.signal = signal;
}

export async function executeTool(call: ToolCall): Promise<ToolOutput> {
  return registry.execute(call, ctx);
}
