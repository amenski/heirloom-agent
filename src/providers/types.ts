import type { Message, ToolDef } from "../types.js";

export interface ModelCapabilities {
  supportsTools: boolean;
  contextWindow: number;
  displayName?: string;
  effort?: {
    values: string[];
    default: string;
  };
  /**
   * USD per million tokens. APPROXIMATE — the values in models.json were not
   * verified against live price sheets and vendors change them without notice.
   * Only feeds the status-bar cost estimate, never a billing or routing
   * decision, so drift is cosmetic. (Context limits live in `contextWindow`,
   * which is separate and does drive compaction.)
   */
  pricing?: { inputPerM: number; outputPerM: number };
}

export type StreamEvent =
  | { type: "text_delta"; content: string }
  | { type: "reasoning_delta"; content: string }
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_delta"; id: string; arguments: string }
  | { type: "usage"; inputTokens: number; outputTokens: number; cachedInputTokens?: number }
  | { type: "done"; finishReason: string };

export interface Provider {
  readonly name: string;
  streamChat(
    messages: Message[],
    tools: ToolDef[],
    options?: { temperature?: number; maxTokens?: number; signal?: AbortSignal; effort?: string; thinkingEnabled?: boolean },
  ): AsyncGenerator<StreamEvent>;
}
