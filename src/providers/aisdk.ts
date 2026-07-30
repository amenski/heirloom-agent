import { streamText, tool, jsonSchema, stepCountIs } from "ai";
import type { JSONSchema7, ModelMessage } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import type { Message, ToolDef } from "../types.js";
import type { Provider, StreamEvent } from "./types.js";
import type { ProviderPreset } from "./presets.js";
import { logRequest, logResponse } from "../debug/logger.js";

function mapMessages(messages: Message[]): ModelMessage[] {
  const toolNameByCallId = new Map<string, string>();
  for (const m of messages) {
    if (m.role === "assistant" && m.toolCalls) {
      for (const tc of m.toolCalls) {
        toolNameByCallId.set(tc.id, tc.name);
      }
    }
  }

  return messages.filter((m) => !(m.role === "assistant" && m.meta?.asThinking)).map((m) => {
    switch (m.role) {
      case "system":
        return { role: "system", content: m.content };

      case "user": {
        if (!m.imageUrls || m.imageUrls.length === 0) {
          return { role: "user", content: m.content };
        }
        const parts: Array<
          | { type: "text"; text: string }
          | { type: "file"; mediaType: string; data: string }
        > = [];
        if (m.content) {
          parts.push({ type: "text", text: m.content });
        }
        for (const url of m.imageUrls) {
          parts.push({ type: "file", mediaType: "image", data: url });
        }
        return { role: "user", content: parts };
      }

      case "assistant": {
        const parts: Array<
          | { type: "text"; text: string }
          | { type: "tool-call"; toolCallId: string; toolName: string; input: Record<string, unknown> }
        > = [];
        if (m.content) {
          parts.push({ type: "text", text: m.content });
        }
        if (m.toolCalls) {
          for (const tc of m.toolCalls) {
            parts.push({
              type: "tool-call",
              toolCallId: tc.id,
              toolName: tc.name,
              input: tc.arguments,
            });
          }
        }
        return { role: "assistant", content: parts };
      }

      case "tool":
        return {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: m.toolCallId,
              toolName: toolNameByCallId.get(m.toolCallId) ?? "unknown",
              output: { type: "text" as const, value: m.content },
            },
          ],
        };
    }
  });
}

function mapTools(tools: ToolDef[]): Record<string, ReturnType<typeof tool>> {
  const result: Record<string, ReturnType<typeof tool>> = {};
  for (const t of tools) {
    result[t.name] = tool({
      description: t.description,
      inputSchema: jsonSchema(t.parameters as unknown as JSONSchema7),
    });
  }
  return result;
}

function createAIInstance(apiType: string, baseUrl: string, apiKey: string, model: string) {
  if (apiType === "anthropic") {
    return createAnthropic({ apiKey })(model);
  }
  return createOpenAI({ baseURL: baseUrl, apiKey }).chat(model);
}

export function createAISDKProvider(preset: ProviderPreset, model: string, apiKey: string): Provider {
  return {
    name: model,

    async *streamChat(
      messages: Message[],
      tools: ToolDef[],
      options?: { temperature?: number; maxTokens?: number; signal?: AbortSignal; effort?: string; thinkingEnabled?: boolean },
    ): AsyncGenerator<StreamEvent> {
      const baseUrl = preset.baseUrl;
      const modelInstance = createAIInstance(preset.api, baseUrl, apiKey, model);

      logRequest({
        model,
        messages,
        tools,
        max_tokens: options?.maxTokens,
        temperature: options?.temperature,
        effort: options?.effort,
        thinking_enabled: options?.thinkingEnabled,
      });

      const result = streamText({
        model: modelInstance,
        messages: mapMessages(messages),
        tools: tools.length > 0 ? mapTools(tools) : undefined,
        temperature: options?.temperature,
        maxOutputTokens: options?.maxTokens,
        abortSignal: options?.signal,
        maxRetries: 3,
        ...(options?.effort && preset.api === "openai-compatible" ? { reasoningEffort: options.effort } : {}),
        ...(options?.thinkingEnabled && preset.api === "openai-compatible" ? { body: { thinking: { type: "enabled" } } as any } : {}),
        stopWhen: stepCountIs(1),
        allowSystemInMessages: true,
      });

      const toolCallAccum = new Map<string, { id: string; name: string; args: string }>();
      const started = new Set<string>();

      for await (const event of result.fullStream) {
        switch (event.type) {
          case "text-delta":
            yield { type: "text_delta", content: event.text };
            break;

          case "reasoning-delta":
            yield { type: "reasoning_delta", content: event.text };
            break;

          case "tool-input-start": {
            const id = event.id;
            toolCallAccum.set(id, { id, name: event.toolName, args: "" });
            if (!started.has(id)) {
              started.add(id);
              yield { type: "tool_call_start", id, name: event.toolName };
            }
            break;
          }

          case "tool-input-delta": {
            const id = event.id;
            const entry = toolCallAccum.get(id);
            if (entry) {
              entry.args += event.delta;
            }
            if (!started.has(id)) {
              started.add(id);
              yield { type: "tool_call_start", id, name: entry?.name ?? "unknown" };
            }
            yield { type: "tool_call_delta", id, arguments: event.delta };
            break;
          }

          case "tool-input-end":
            break;

          case "tool-call": {
            if (!started.has(event.toolCallId)) {
              yield { type: "tool_call_start", id: event.toolCallId, name: event.toolName };
              yield {
                type: "tool_call_delta",
                id: event.toolCallId,
                arguments: JSON.stringify(event.input),
              };
            }
            break;
          }

          case "finish-step":
            yield {
              type: "usage",
              inputTokens: event.usage.inputTokens ?? 0,
              outputTokens: event.usage.outputTokens ?? 0,
              cachedInputTokens: event.usage.inputTokenDetails?.cacheReadTokens ?? undefined,
            };
            logResponse(event.usage, Array.from(toolCallAccum.values()));
            break;

          case "finish":
            yield { type: "done", finishReason: event.finishReason };
            break;

          case "error":
            throw event.error;
        }
      }
    },
  };
}
