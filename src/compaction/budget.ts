import type { Message } from "../types.js";

export function estimateTokens(messages: Message[]): number {
  let total = 0;
  for (const m of messages) {
    total += m.content?.length ?? 0;
    if (m.role === "assistant" && m.toolCalls) {
      for (const tc of m.toolCalls) {
        total += JSON.stringify(tc.arguments).length + tc.name.length;
      }
    }
  }
  return Math.ceil(total / 4);
}

export function shouldCompact(messages: Message[], contextWindow: number): boolean {
  const used = estimateTokens(messages);
  const threshold = contextWindow * 0.7;
  return used >= threshold;
}
