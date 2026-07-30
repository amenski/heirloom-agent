import type { ToolDef, ToolCall, ToolOutput } from "../types.js";
import type { CheckpointManager } from "../checkpoints/index.js";

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
}

export interface ToolRegistration {
  def: ToolDef;
  handler: ToolHandler;
  groups: ToolGroup[];
  always?: boolean;
}

export type ToolGroup = "read" | "edit" | "command" | "mcp" | "workflow";
