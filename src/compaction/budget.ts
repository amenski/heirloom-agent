import type { Message } from "../types.js";

// Per-message raw char-sum cache. estimateTokens is called repeatedly over the
// same growing message array inside the turn loop (recordTokens + compaction
// check), and re-serializing every tool call's arguments each time is an
// O(conversation-size) synchronous scan that starves the UI event loop. Keying
// by message identity lets us compute each message's contribution once; the
// loop mutates a single stable `messages` array, so references are stable. We
// cache the RAW char sum (not the divided/rounded token count) so the final
// Math.ceil(total / 4) stays byte-identical to computing from scratch.
const rawCharCache = new WeakMap<Message, number>();

function messageRawChars(m: Message): number {
  const cached = rawCharCache.get(m);
  if (cached !== undefined) return cached;
  let total = m.content?.length ?? 0;
  if (m.role === "assistant" && m.toolCalls) {
    for (const tc of m.toolCalls) {
      total += JSON.stringify(tc.arguments).length + tc.name.length;
    }
  }
  rawCharCache.set(m, total);
  return total;
}

export function estimateTokens(messages: Message[]): number {
  let total = 0;
  for (const m of messages) {
    total += messageRawChars(m);
  }
  return Math.ceil(total / 4);
}

export function shouldCompact(
  messages: Message[],
  contextWindow: number,
  threshold?: number,
): boolean {
  const ratio = threshold ?? 0.7;
  const cutoff = contextWindow * ratio;
  const used = estimateTokens(messages);
  return used >= cutoff;
}
