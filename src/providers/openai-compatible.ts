import OpenAI from "openai";
import type { Message, ToolDef } from "../types.js";
import type { Provider, StreamEvent } from "./types.js";
import { isRetryableStatus } from "./retry.js";
import type { RetryableError } from "./retry.js";

function mapMessages(messages: Message[]): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  return messages.map((m) => {
    switch (m.role) {
      case "system":
        return { role: "system", content: m.content };
      case "user":
        return { role: "user", content: m.content };
      case "assistant": {
        const msg: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = {
          role: "assistant",
          content: m.content,
        };
        if (m.toolCalls && m.toolCalls.length > 0) {
          msg.tool_calls = m.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments),
            },
          }));
        }
        return msg;
      }
      case "tool":
        return {
          role: "tool",
          tool_call_id: m.toolCallId,
          content: m.content,
        };
    }
  });
}

function mapTools(tools: ToolDef[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

export function createOpenAICompatibleProvider(config: {
  baseUrl: string;
  apiKey: string;
  model?: string;
}): Provider {
  const model = config.model ?? "deepseek-chat";

  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
  });

  return {
    name: "openai-compatible",

    async *streamChat(
      messages: Message[],
      tools: ToolDef[],
      options?: { temperature?: number; maxTokens?: number; signal?: AbortSignal },
    ): AsyncGenerator<StreamEvent> {
      try {
        const stream = await client.chat.completions.create({
          model,
          messages: mapMessages(messages),
          tools: mapTools(tools),
          tool_choice: "auto",
          stream: true,
          temperature: options?.temperature,
          max_tokens: options?.maxTokens,
        }, {
          signal: options?.signal,
        });

        const toolCallAccum: Map<number, { id: string; name: string; args: string }> = new Map();
        const started: Set<number> = new Set();
        let finishReason = "stop";

        for await (const chunk of stream) {
          const choice = chunk.choices[0];
          if (choice?.finish_reason) {
            finishReason = choice.finish_reason;
          }

          const delta = choice?.delta;
          if (!delta) continue;

          if (delta.content) {
            yield { type: "text_delta", content: delta.content };
          }

          for (const tc of delta.tool_calls ?? []) {
            const idx = tc.index;
            if (!toolCallAccum.has(idx)) {
              toolCallAccum.set(idx, { id: tc.id ?? "", name: tc.function?.name ?? "", args: "" });
            }
            const entry = toolCallAccum.get(idx)!;
            if (tc.id) entry.id = tc.id;
            if (tc.function?.name) entry.name = tc.function.name;
            if (tc.function?.arguments) entry.args += tc.function.arguments;

            if (!started.has(idx) && entry.id && entry.name) {
              started.add(idx);
              yield { type: "tool_call_start", id: entry.id, name: entry.name };
            }

            if (tc.function?.arguments) {
              yield { type: "tool_call_delta", id: entry.id, arguments: tc.function.arguments };
            }
          }
        }

        yield { type: "done", finishReason };
      } catch (err: any) {
        const status = err.status;
        const retryable = status ? isRetryableStatus(status) : false;
        const error = new Error(err.message || "Unknown provider error") as RetryableError;
        error.status = status;
        error.retryable = retryable;
        throw error;
      }
    },
  };
}
