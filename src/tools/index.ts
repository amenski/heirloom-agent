import { ToolRegistry } from "./registry.js";
import type { ToolCall, ToolOutput } from "../types.js";
import type { ToolContext } from "./types.js";
import type { CheckpointManager } from "../checkpoints/index.js";
import { registerFiles } from "./files.js";
import { registerBash } from "./bash.js";
import { registerSearch } from "./search.js";
import { registerEdits } from "./edit.js";
import { registerAskUserQuestion } from "./ask_user_question.js";
import { registerWebSearch } from "./web-search.js";
import { registerWebFetch } from "./web-fetch.js";
import { registerJobs } from "./jobs.js";
import { registerTodo, todoStore } from "./todo.js";
import type { TodoStore } from "./todo.js";

const registry = new ToolRegistry();
registerFiles(registry);
registerBash(registry);
registerSearch(registry);
registerEdits(registry);
registerAskUserQuestion(registry);
registerWebSearch(registry);
registerWebFetch(registry);
registerJobs(registry);
registerTodo(registry);

export { registry };
export const TOOL_DEFS = registry.getAllDefs();

const ctx: ToolContext = {
  workingDir: process.cwd(),
  sessionId: "default",
  askUser: undefined,
  askQuestion: undefined,
  signal: new AbortController().signal,
  fileMtimes: new Map(),
  // Defaults to the module singleton — the parent run's store, which the TUI
  // panel subscribes to. The orchestrator swaps this pointer for a fresh
  // store while a sub-agent runs (nested runs are strictly sequential, so a
  // single pointer with save/restore is safe), then restores it.
  todoStore,
};

export function setTodoStore(store: TodoStore): void {
  ctx.todoStore = store;
}

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
