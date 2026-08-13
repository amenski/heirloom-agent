# Provider Specification

**Status:** current · verified 2026-08-13 · covers `src/providers/{types,presets,aisdk,catalog,registry}.ts`, `src/providers/models.json`, `src/config/credentials.ts`

## 1. Overview

The providers layer abstracts LLM backends behind one contract. Wire formats
are handled by the **Vercel AI SDK v7** (`ai` + `@ai-sdk/openai` /
`@ai-sdk/anthropic`) in `src/providers/aisdk.ts`; heirloom layers presets, a
model catalog, and key resolution on top.

- **Provider** — a named config entry: an API (`openai-compatible` or
  `anthropic`), a base URL, a key environment variable, and a model list.
- **Catalog** — `src/providers/models.json` ships bundled presets
  (deepseek, openai, openrouter, groq, ollama). A user file
  `~/.heirloom/models.json` deep-merges over the bundled catalog
  (`src/providers/catalog.ts`) — add or override providers/models without
  touching code.
- **AI SDK** — `src/providers/aisdk.ts` maps `streamText` events to the
  canonical `StreamEvent` contract below. The old per-vendor adapter files
  (`deepseek.ts`, `openai-compatible.ts`) were deleted in the AI SDK
  migration — one wire layer serves all backends now.

## 2. Contract

`src/providers/types.ts`:

```typescript
interface Provider {
  readonly name: string;
  streamChat(
    messages: Message[],
    tools: ToolDef[],
    options?: { temperature?: number; maxTokens?: number;
                signal?: AbortSignal; effort?: string; thinkingEnabled?: boolean },
  ): AsyncGenerator<StreamEvent>;
}
```

`StreamEvent`:

```typescript
type StreamEvent =
  | { type: "text_delta"; content: string }
  | { type: "reasoning_delta"; content: string }
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_delta"; id: string; arguments: string }
  | { type: "usage"; inputTokens: number; outputTokens: number; cachedInputTokens?: number }
  | { type: "done"; finishReason: string };
```

Rules:

1. **No canonical type contamination.** The provider layer imports canonical
   types but never exports them; the agent loop only speaks canonical types
   (`src/types.ts`).
2. **Stateless.** Providers hold no conversation state — the agent loop owns
   the message array.
3. **Keys are injected, not discovered.** `createProvider` resolves the key
   and passes it in; providers never read `process.env` themselves.
4. **Retries are the loop's job.** The provider layer does not retry
   internally; the agent loop handles transient errors
   (`src/agent.ts` `isTransientNetworkError`; subsystems.md §6).

## 3. Key resolution

`createProvider(name, options)` (`src/providers/presets.ts:103`) resolves in
order:

1. `options.apiKey` (from settings.json `env.API_KEY`, provider-scoped)
2. `process.env[preset.keyEnv]` (e.g. `DEEPSEEK_API_KEY`)
3. `~/.heirloom/credentials.yaml` (`heirloom auth` writes it; file enforced
   `0600`, `src/config/credentials.ts`)

No key resolvable for a provider that requires one → thrown error naming the
env var and suggesting `heirloom auth`. Providers without `keyEnv` (ollama —
local) need none.

## 4. Bundled catalog

`src/providers/models.json` (5 providers):

| Provider | API | Key env | Default model |
|----------|-----|---------|---------------|
| deepseek | openai-compatible | `DEEPSEEK_API_KEY` | `deepseek-v4-pro` |
| openai | openai-compatible | `OPENAI_API_KEY` | `gpt-5.6-sol` |
| openrouter | openai-compatible | `OPENROUTER_API_KEY` | `anthropic/claude-sonnet-4.6` |
| groq | openai-compatible | `GROQ_API_KEY` | `llama-3.3-70b-versatile` |
| ollama | openai-compatible | — (local) | `llama3.2` |

Per-model capabilities (`ModelCapabilities`, `src/providers/types.ts`):
`contextWindow` (drives compaction), `effort.values` (drives `/effort`),
`pricing` (**approximate** — feeds only the status-bar cost estimate, never
billing or routing). `api: "anthropic"` is supported by `aisdk.ts` but has
no bundled preset — add one via `~/.heirloom/models.json`.

Selection precedence (`src/cli.tsx`): `--model` flag > settings.json
`model` > settings `env.MODEL`; provider: settings `provider` >
env/BASE_URL detection > `"deepseek"` default. `--model` takes
`provider/model`, split on the first slash.

### 4.1 Runtime model switching (`/model` is turn-granular)

Yes — the next call goes to the newly selected model, but not mid-turn. The
active model is resolved **per turn, not per session**:

- **The provider is resolved fresh each turn.** `runAgentTurnBridge`
  (`src/cli.tsx`) calls `getProvider()` when a turn starts
  (`provider: getProvider()`, cli.tsx:1161), and `getProvider()` reads
  `shared.activeModel` at that moment (`modelOverride: shared.activeModel`,
  cli.tsx:167). `/model` updates `shared.activeModel` and persists a `state`
  record via `appendState` (cli.tsx:1092–1102).
- **So the boundary is the turn.** Switching models mid-turn — mid-stream or
  between tool calls inside one `runAgent` invocation — leaves the current
  turn on the old model: the provider instance was already created with the
  old `modelOverride` when the turn started. The new model takes effect on
  the **next turn** (next prompt submission).
- **Sub-agents follow the switch too.** The orchestrator resolves its
  provider at sub-agent spawn time via the `provider()` factory (the comment
  in `src/orchestrator/index.ts` says so), so a mid-session `/model` change
  also applies to subsequently spawned sub-agents.
- **The session record keeps it honest.** The `state` record persisted on
  `/model` is folded back into `meta` on resume (`src/sessions/store.ts`), so
  a resumed session restores the last model you picked.

To apply a model change immediately, interrupt the current turn (Esc) and
re-prompt.

## 5. Adding a provider

**OpenAI-compatible service** (zero code):
1. Add a preset entry to `~/.heirloom/models.json` (or the bundled catalog).

**A provider the catalog can't express** (code change):
1. Add the preset to `src/providers/models.json` (+ `presets.ts` entry if the
   name needs registration) and a test in `presets.test.ts`.
2. If the wire format is new, extend `src/providers/aisdk.ts` — the AI SDK
   already covers OpenAI-compatible and Anthropic shapes.

`env.BASE_URL` overrides a built-in preset's base URL (proxy/gateway use).
`setConfigProviders` (`presets.ts:41`) registers config-supplied providers;
it is wired programmatically, not to a settings.json key.

## 6. Verified against

`src/providers/types.ts` · `src/providers/presets.ts` (createProvider,
BUILTIN_PRESETS) · `src/providers/aisdk.ts` · `src/providers/catalog.ts` ·
`src/providers/models.json` · `src/config/credentials.ts` · `src/cli.tsx`
(selection precedence)
