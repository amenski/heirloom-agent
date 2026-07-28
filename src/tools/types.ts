import type { ToolDef, ToolCall, ToolOutput } from "../types.js";
import type { CheckpointManager } from "../checkpoints/index.js";

export type ToolHandler = (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolOutput>;

export interface ToolContext {
  workingDir: string;
  sessionId: string;
  askUser(question: string): Promise<boolean>;
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
