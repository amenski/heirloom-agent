import type { ToolDef, ToolCall, ToolOutput } from "../types.js";
import type { CheckpointManager } from "../checkpoints/index.js";
import type { SessionStore } from "../sessions/store.js";
import type { TodoStore } from "./todo.js";

export type ToolHandler = (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolOutput>;

export interface AskQuestionOption {
  label: string;
  description?: string;
}

export interface AskQuestionItem {
  question: string;
  multiSelect?: boolean;
  options: AskQuestionOption[];
}

export interface ToolContext {
  workingDir: string;
  sessionId: string;
  askUser?: (toolName: string, args: Record<string, unknown>) => Promise<boolean>;
  /** Asks the user one or more multiple-choice (optionally multi-select) questions and returns each answer text keyed by question. */
  askQuestion?: (questions: AskQuestionItem[]) => Promise<Record<string, string> | null>;
  signal: AbortSignal;
  checkpoint?: CheckpointManager;
  fileMtimes?: Map<string, number>;
  /** Per-run todo store (update_todo_list). Defaults to the module singleton;
   *  sub-agents receive a fresh store threaded through the orchestrator's
   *  per-call context. */
  todoStore?: TodoStore;
  /** Session store for persisting todo-list snapshots (update_todo_list).
   *  Absent in headless runs — appends no-op. */
  sessionStore?: SessionStore;
  /** Mode-switch callback (switch_mode tool). Resolves to the mode name, or
   *  null for an unknown slug. Absent when mode switching is not wired. */
  setMode?: (slug: string) => Promise<string | null>;
}

export interface ToolRegistration {
  def: ToolDef;
  handler: ToolHandler;
  groups: ToolGroup[];
  always?: boolean;
}

export type ToolGroup = "read" | "edit" | "command" | "mcp" | "workflow";
