## 4. Token Optimization Strategies

### 4a. Immutable Prefix Caching

The system prompt, tool definitions, and mode definition don't change between
turns. Mark them as cacheable so the provider reuses computation.

**DeepSeek/OpenAI:** Not supported in the base API (only Anthropic has native
prompt caching). Workaround: keep prefix identical across turns so the
provider's internal cache hits.

**Anthropic:** Native prompt caching via `cache_control` breakpoints:
```typescript
messages: [
  { role: "user", content: [
    { type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }
  ]},
  // ... rest of conversation (not cached)
]
```

### 4b. Mode-Gated Tool Definitions

Don't send all 11 tools. Only send tools in the active mode's groups:

| Mode | Tools Sent | Tool Tokens Saved |
|------|-----------|-------------------|
| code | 9 tools (read + edit + command) | ~20% vs all |
| ask | 4 tools (read only) | ~65% vs all |
| architect | 5 tools (read + edit, docs only) | ~55% vs all |
| orchestrator | 1 tool (new_task) | ~90% vs all |

### 4c. Parallel Tool Execution

When the LLM issues multiple independent tool calls, execute them concurrently.
Already implemented in the agent loop (`Promise.all`).

### 4d. Concise System Prompt

Every token in the system prompt costs every turn. Optimize:
- Remove fluff ("You are a helpful AI assistant...")
- Remove rules the model already follows
- Use shorthand where the model understands it
- Test: remove a sentence, does quality drop? If not, keep it removed.

Aider's system prompt is remarkably terse — that's intentional.

### 4e. Tool Output Compression

Large tool outputs (1000+ lines) should be summarized before feeding back:
- `read_file`: Return first 500 lines + "file truncated at line 500"
- `search`: Return first 50 matches + "search truncated"
- `run_bash`: Return last 200 lines of output + exit code

The agent can always request more detail with a follow-up tool call.

### 4f. RepoMap Budgeting

Aider's binary search approach: given a fixed token budget (e.g., 1024 tokens
for repo context), include as many high-rank files as fit, then stop. Don't
exceed the budget.

---

---

_Part of the [subsystems deep dive](../subsystems.md)._
