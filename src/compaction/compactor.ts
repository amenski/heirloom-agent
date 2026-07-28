import type { Message } from "../types.js";
import type { Provider } from "../providers/types.js";
import { shouldCompact } from "./budget.js";

const COMPACTION_PROMPT = `Summarize the following conversation between an AI agent and a user.
Extract and preserve:
- The user's original task and goals
- Key decisions made and why
- Files that were read, modified, or created (with paths)
- Errors encountered and how they were resolved
- Any unfinished work or pending items

Format your summary as a single paragraph that captures the essential context.
Be concise. Omit tool output details — just note what was done and the outcome.`;

export class Compactor {
  constructor(
    private provider: Provider,
    private contextWindow: number = 128000,
  ) {}

  needsCompaction(messages: Message[]): boolean {
    return shouldCompact(messages, this.contextWindow);
  }

  async compact(messages: Message[]): Promise<Message[]> {
    if (!this.needsCompaction(messages)) return messages;

    const keepCount = Math.min(4, messages.length);
    const recent = messages.slice(-keepCount);
    const old = messages.slice(0, messages.length - keepCount);

    if (old.length === 0) return messages;

    const summaryContent = await this.summarize(old);

    const summary: Message = {
      role: "system",
      content: `[Previous conversation summary]\n${summaryContent}`,
    };

    return [summary, ...recent];
  }

  private async summarize(messages: Message[]): Promise<string> {
    const conversation = messages.map(m => {
      if (m.role === "tool") {
        return `[tool result: ${m.content.slice(0, 200)}]`;
      }
      if (m.role === "assistant" && m.toolCalls) {
        const calls = m.toolCalls.map(tc => tc.name).join(", ");
        return `[assistant called tools: ${calls}]`;
      }
      return `${m.role}: ${m.content || ""}`;
    }).join("\n");

    const summaryMessages: Message[] = [
      { role: "system", content: COMPACTION_PROMPT },
      { role: "user", content: conversation },
    ];

    let result = "";

    for await (const event of this.provider.streamChat(summaryMessages, [])) {
      if (event.type === "text_delta") {
        result += event.content;
      }
    }

    return result || "Conversation summarized.";
  }
}
