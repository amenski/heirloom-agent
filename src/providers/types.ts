import type { Message, ToolDef } from "../types.js";

export interface ModelCapabilities {
  supportsTools: boolean;
  contextWindow: number;
  displayName?: string;
  /** Absent = this model has no reasoning-effort knob. */
  effort?: {
    /** The model's own vocabulary, e.g. ["minimal","low","medium","high"]. */
    values: string[];
    /** Used when the user hasn't picked a value. */
    default: string;
  };
  pricing?: { inputPerM: number; outputPerM: number };
}

export type StreamEvent =
  | { type: "text_delta"; content: string }
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_delta"; id: string; arguments: string }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "done"; finishReason: string };

export interface Provider {
  readonly name: string;
  streamChat(
    messages: Message[],
    tools: ToolDef[],
    options?: { temperature?: number; maxTokens?: number; signal?: AbortSignal; effort?: string },
  ): AsyncGenerator<StreamEvent>;
}
