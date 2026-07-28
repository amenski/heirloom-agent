# Provider Adapter Specification

Every provider adapter must implement the `Provider` interface defined in
`src/providers/types.ts`. This document defines the contract.

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

3. **Error surface.** Adapter errors are thrown as exceptions. The agent loop
   catches them. Adapters do not silently swallow errors.

4. **Stateless.** Providers hold no conversation state. The agent loop manages
   the message array.

5. **API key from environment.** Each adapter reads its own env var:
   - DeepSeek: `DEEPSEEK_API_KEY`
   - Anthropic: `ANTHROPIC_API_KEY`
   - OpenAI: `OPENAI_API_KEY`

6. **Tool call accumulation.** Streaming deltas may arrive in any order.
   `tool_call_start` must NOT be yielded until both `id` and `name` are known.
   `tool_call_delta` yields raw JSON fragments; the agent loop concatenates and
   parses.

## Adding a New Provider

1. Create `src/providers/<name>.ts`
2. Implement `create<Name>Provider(): Provider`
3. Map messages (canonical → native) and tools (canonical → native)
4. Stream and convert to `StreamEvent`
5. No changes to `src/types.ts`, `src/agent.ts`, or any other file

That's the test: a new provider is one file.
