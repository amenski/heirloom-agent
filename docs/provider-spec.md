# Provider Adapter Specification

Every provider adapter must implement the `Provider` interface defined in
`src/providers/types.ts`. This document defines the contract.

## Adapters vs Providers

An **adapter** implements a wire format: `openai-compatible`, `anthropic`.
A **provider** is a config entry binding an adapter to a base URL, API key,
and model list (config-spec.md, `providers:` map).

DeepSeek is not its own adapter — it's the `openai-compatible` adapter plus
a base URL, shipped as a built-in config preset. (`src/providers/deepseek.ts`
already is the OpenAI SDK with a base URL; the rename to
`openai-compatible.ts` makes the reality explicit.) Consequences:

- New OpenAI-compatible service (OpenRouter, Groq, Ollama, …): **zero code**,
  config only.
- New wire format (a genuinely different API shape): one adapter file — the
  rule below.

## Interface

```typescript
interface Provider {
  readonly name: string;
  streamChat(
    messages: Message[],
    tools: ToolDef[],
    options?: { temperature?: number; maxTokens?: number }
  ): AsyncGenerator<StreamEvent>;
}
```

## StreamEvent Order

Events must be yielded in this order:

```
text_delta* → (tool_call_start → tool_call_delta*)* → done
```

- Zero or more `text_delta` events (LLM's text response)
- Zero or more tool call groups, each: one `tool_call_start` followed by zero or more `tool_call_delta`
- Exactly one `done` event to signal stream completion

## Message Mapping

Adapters must convert canonical `Message` types to the provider's native format:

| Canonical | OpenAI | Anthropic |
|-----------|--------|-----------|
| `SystemMessage` | `{ role: "system", content }` | System param or first `user` turn |
| `UserMessage` | `{ role: "user", content }` | `{ role: "user", content: [{ type: "text", text: content }] }` |
| `AssistantMessage` (text) | `{ role: "assistant", content }` | `{ role: "assistant", content: [{ type: "text", text: content }] }` |
| `AssistantMessage` (tool calls) | `{ role: "assistant", tool_calls: [...] }` | `{ role: "assistant", content: [{ type: "tool_use", ... }] }` |
| `ToolResultMessage` | `{ role: "tool", tool_call_id, content }` | `{ role: "user", content: [{ type: "tool_result", ... }] }` |

## Requirements

1. **No canonical type contamination.** Adapters import canonical types but
   never export them. The agent loop only speaks canonical types.

2. **Idempotent.** Calling `streamChat` with the same inputs produces the same
   sequence of StreamEvents (modulo LLM non-determinism).

3. **Error surface.** Adapter errors are thrown as exceptions carrying
   `{ status?: number, retryable: boolean }` so the agent loop can apply its
   retry policy (subsystems.md §6): 429/5xx/network → `retryable: true`;
   auth/bad-model/invalid-request → `retryable: false`. Adapters never retry
   internally and never silently swallow errors — retries are the loop's
   job, once, in one place.

4. **Stateless.** Providers hold no conversation state. The agent loop manages
   the message array.

5. **Keys are injected, not discovered.** The config layer resolves the key
   (env var named by `apiKeyEnv`, else `~/.heirloom/credentials.yaml` —
   config-spec.md) and passes key + baseUrl to the adapter factory:
   `createOpenAICompatibleProvider({ baseUrl, apiKey })`. Adapters never
   read `process.env` and never hardcode env-var names — that's what keeps
   one adapter serving many providers.

6. **Tool call accumulation.** Streaming deltas may arrive in any order.
   `tool_call_start` must NOT be yielded until both `id` and `name` are known.
   `tool_call_delta` yields raw JSON fragments; the agent loop concatenates and
   parses.

## Adding a New Provider

**OpenAI-compatible service:** add a `providers:` entry in config
(config-spec.md). No code.

**New wire format (new adapter):**
1. Create `src/providers/<api-name>.ts`
2. Implement `create<ApiName>Provider(opts): Provider` (opts: baseUrl, apiKey)
3. Map messages (canonical → native) and tools (canonical → native)
4. Stream and convert to `StreamEvent`
5. Register the `api:` name in the adapter registry — the only shared file
   that changes. Nothing in `src/types.ts` or `src/agent.ts` moves.

That's the test: a new adapter is one file plus one registry line.
