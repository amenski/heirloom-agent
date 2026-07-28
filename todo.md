# Heirloom — AI Coding Agent

> Personal CLI coding agent. Canonical types, multi-provider, mode-gated tools, permissions, compaction, checkpoints. Target: opencode-quality CLI, ~1,880 lines total.

---

## Phase 1: Core Foundation

### 1.1 — Canonical type system

- [x] Create `src/types.ts` with `Message`, `ToolDef`, `ToolCall`, `ToolOutput`
- [x] Zero SDK imports — all types are provider-agnostic

**Acceptance criteria**
| # | Given | When | Then |
|---|-------|------|------|
| AC1 | A `Message` union | it is used in provider adapters | all 4 roles (`system`, `user`, `assistant`, `tool`) compile without SDK types |
| AC2 | A `ToolCall` with `arguments: Record<string,unknown>` | it is passed to `executeTool` | no JSON.stringify/parse needed in the domain layer |

**Edge cases**
- `AssistantMessage.content` can be `null` (when LLM responds with only tool calls and no text)
- `ToolCall.arguments` may contain `_raw` key when JSON.parse fails (malformed LLM output)

**Deps:** none | **Priority:** P0 | **Est:** 0.5h

---

### 1.2 — Provider interface + StreamEvent

- [x] Create `src/providers/types.ts` with `Provider` interface and `StreamEvent` union
- [x] `StreamEvent` covers: `text_delta`, `tool_call_start`, `tool_call_delta`, `done`

**Acceptance criteria**
| # | Given | When | Then |
|---|-------|------|------|
| AC1 | A provider adapter implementing `Provider` | `streamChat` is called | it yields `StreamEvent` objects in correct order |
| AC2 | A tool call stream | start/delta/done events fire | start yields before any deltas for the same tool call |

**Edge cases**
- Provider may yield `done` immediately if LLM responds with text only (no tool calls)
- `tool_call_start` must NOT yield until both `id` and `name` are available from streaming deltas
- `done.finishReason` must be `"stop"`, `"tool_calls"`, or `"length"`

**Deps:** 1.1 | **Priority:** P0 | **Est:** 0.5h

---

### 1.3 — DeepSeek provider adapter

- [x] Create `src/providers/deepseek.ts`
- [x] `mapMessages()` — canonical → OpenAI `ChatCompletionMessageParam[]`
- [x] `mapTools()` — canonical → OpenAI `ChatCompletionTool[]`
- [x] `streamChat()` — OpenAI streaming → `AsyncGenerator<StreamEvent>`

**Acceptance criteria**
| # | Given | When | Then |
|---|-------|------|------|
| AC1 | A conversation with `AssistantMessage` containing `toolCalls` | mapped to OpenAI format | each tool call has `type: "function"` and `function.arguments` as JSON string |
| AC2 | A streaming response from DeepSeek | deltas arrive out of order or missing fields | start/name gated on both id and name availability |
| AC3 | `DEEPSEEK_API_KEY` is unset | `createDeepSeekProvider()` is called | throws with clear error message |

**Edge cases**
- `tc.function?.arguments` may arrive before `tc.function?.name` in streaming — defer `tool_call_start` until both present
- Empty delta chunks (no content, no tool_calls) — skip silently

**Deps:** 1.1, 1.2 | **Priority:** P0 | **Est:** 1h

---

### 1.4 — ReAct agent loop

- [x] Create `src/agent.ts` — `runAgent(userMessage, options)`
- [x] `buildSystemPrompt(mode?)` — constructs system prompt with mode-specific prefix
- [x] Streaming consumption: accumulate text, track tool calls by ID, execute after `done`

**Acceptance criteria**
| # | Given | When | Then |
|---|-------|------|------|
| AC1 | User asks a question requiring no tools | agent runs | text streams to stdout, no tool execution, loop exits |
| AC2 | User asks to read a file | agent runs | tool call detected, executed, result fed back, LLM responds |
| AC3 | LLM produces malformed tool arguments | `JSON.parse` fails | arguments set to `{ _raw: rawString }`, agent continues |
| AC4 | Conversation reaches `maxTurns` | loop counter hits limit | agent exits gracefully without infinite loop |

**Edge cases**
- Empty user input — handled by CLI, not agent
- Tool call with empty arguments (`"{}"`) — parse to `{}`, execute normally
- LLM returns both text content AND tool calls — both processed (text displayed, tools executed)

**Deps:** 1.1, 1.2 | **Priority:** P0 | **Est:** 1h

---

### 1.5 — CLI entry point

- [x] Create `src/index.ts` — readline loop, `/exit`, `/help`, `/clear` commands
- [x] Wire provider + agent + tools together

**Acceptance criteria**
| # | Given | When | Then |
|---|-------|------|------|
| AC1 | User types `/exit` | command received | process exits cleanly |
| AC2 | User types `/clear` | command received | state resets (Phase 1: prints `[cleared]`, Phase 4: actually clears) |
| AC3 | Provider throws an error | agent crashes | error message displayed, CLI continues accepting input |

**Edge cases**
- SIGINT (Ctrl+C) — should exit cleanly, not leave terminal in raw mode
- Empty input line — skip, re-prompt

**Deps:** 1.4 | **Priority:** P0 | **Est:** 0.5h

---

### 1.6 — Basic tools (Phase 1 set)

- [x] Create `src/tools/index.ts` — 5 tools: `read_file`, `write_file`, `run_bash`, `list_files`, `search`
- [x] `executeTool(call)` — dispatches by name, returns `ToolOutput`

**Acceptance criteria**
| # | Given | When | Then |
|---|-------|------|------|
| AC1 | `read_file` with valid path | executed | returns file content with line numbers |
| AC2 | `read_file` with nonexistent path | executed | returns error message, does not throw |
| AC3 | `run_bash` with failing command | executed | returns exit code + stdout + stderr |
| AC4 | `write_file` to new path | executed | creates file, returns line count |
| AC5 | `search` with no matches | executed | returns "No matches found." |

**Edge cases**
- File > 2000 lines — truncate with notice
- Bash command timeout (120s) — process killed, output captured
- Concurrent bash commands — each runs in its own child process
- Shell injection via `search` pattern — grep handles safely, but review needed

**Deps:** 1.1 | **Priority:** P0 | **Est:** 1h

---

## Phase 2: ToolRegistry + 11 Tools

### 2.1 — ToolRegistry class

- [x] Create `src/tools/registry.ts` — `ToolRegistry` with `register()`, `getByMode()`, `execute()`
- [x] Tool handlers receive `ToolContext` (workingDir, sessionId, askUser, signal)

**Acceptance criteria**
| # | Given | When | Then |
|---|-------|------|------|
| AC1 | Tool registered with mode gates | `getByMode("code")` called | returns only tools allowed in "code" mode |
| AC2 | Tool registered without mode restriction | `getByMode("architect")` called | always-available tools included |
| AC3 | Unknown tool name in `execute()` | dispatched | returns error ToolOutput, does not throw |

**Edge cases**
- Duplicate tool registration — last registration wins (or throw, pick one)
- Mode name with no matching tools — return empty array, not undefined

**Deps:** 1.1 | **Priority:** P1 | **Est:** 1h

---

### 2.2 — Edit tools (6 strategies)

- [x] Create `src/tools/edit.ts` — `apply_diff`, `apply_patch`, `search_replace`, `edit_file`, `write_to_file`, `edit`
- [x] `apply_diff` — surgical first-occurrence patch using unified diff format
- [x] `apply_patch` — multi-file unified diff application
- [x] `search_replace` — global find-and-replace across file
- [x] `edit_file` — search-and-replace with occurrence count validation
- [x] `write_to_file` — full file rewrite
- [x] `edit` — exact string match → replacement (opencode-style)

**Acceptance criteria**
| # | Given | When | Then |
|---|-------|------|------|
| AC1 | `apply_diff` with a diff that matches exactly | applied | file updated, success returned |
| AC2 | `apply_diff` with a diff that doesn't match | applied | error returned with context (surrounding lines) |
| AC3 | `search_replace` with 5 occurrences | applied | all 5 replaced, count returned |
| AC4 | `edit_file` with expected count 3 and 4 actual matches | applied | error returned, no changes made |
| AC5 | `edit` with exact string not found | applied | error with "string not found" |
| AC6 | `write_to_file` to existing file | applied | file overwritten, line count returned |

**Edge cases**
- Empty diff — no-op, return success
- Diff with incorrect line endings (CRLF vs LF) — normalize before matching
- Search pattern contains regex special chars — treat as literal string
- File not found for any edit tool — return clear error
- Binary file detected — refuse to edit, return error

**Deps:** 2.1 | **Priority:** P1 | **Est:** 3h

---

### 2.3 — File tools

- [x] Extract `read_file`, `list_files` into `src/tools/files.ts`
- [x] Add `glob` tool for pattern-based file search

**Acceptance criteria**
| # | Given | When | Then |
|---|-------|------|------|
| AC1 | `glob` with `**/*.ts` pattern | executed | returns all matching files |
| AC2 | `glob` with no matches | executed | returns "(no matches)" |

**Edge cases**
- Symlinks — follow or not? Decision: do not follow by default
- `.git` directory — exclude from glob results
- Large directories (>10k files) — limit results to first 500

**Deps:** 2.1 | **Priority:** P1 | **Est:** 1h

---

### 2.4 — Bash + Search tools

- [x] Extract `run_bash`, `search` into `src/tools/bash.ts` and `src/tools/search.ts`
- [x] `run_bash` — add `timeout` parameter, capture stderr
- [x] `search` — add `fileTypes` filter, return file:line:content format

**Acceptance criteria**
| # | Given | When | Then |
|---|-------|------|------|
| AC1 | Bash command exceeds timeout | executed | killed, timeout error returned |
| AC2 | Bash command writes to stderr only | executed | stderr captured and returned |
| AC3 | `search` with `fileTypes: ".ts"` | executed | only .ts files searched |

**Edge cases**
- Interactive commands (vim, nano, less) — detect and refuse (like SWE-agent blocklist)
- Command with `&&` or `||` — allowed, handle multi-step exit codes
- Search pattern with spaces — quote properly in grep call

**Deps:** 2.1 | **Priority:** P1 | **Est:** 1h

---

## Phase 3: Permission System + Modes

### 3.1 — Permission engine

- [x] Create `src/permissions/engine.ts` — `PermissionEngine` class
- [x] Pattern-based rules: `{ tool, pattern?, action }` with last-match-wins
- [x] Actions: `allow`, `ask`, `deny`
- [x] Default: `ask` for all tools

**Acceptance criteria**
| # | Given | When | Then |
|---|-------|------|------|
| AC1 | Rule `{ tool: "*", action: "ask" }` followed by `{ tool: "read_file", action: "allow" }` | `check("read_file")` | returns `"allow"` (last match wins) |
| AC2 | Rule `{ tool: "run_bash", pattern: "rm *", action: "deny" }` | `check("run_bash", { command: "rm -rf /" })` | returns `"deny"` |
| AC3 | Rule `{ tool: "run_bash", pattern: "git *", action: "allow" }` | `check("run_bash", { command: "git status" })` | returns `"allow"` |
| AC4 | No matching rules for a tool | `check("unknown_tool")` | returns `"ask"` (default) |

**Edge cases**
- Overlapping patterns — last defined rule wins (insertion order matters)
- Pattern with glob syntax — `git *` matches `git status`, `git commit -m "msg"`
- Empty ruleset — all tools default to "ask"
- Pattern is `"*"` — matches everything for that tool
- Allowlisting conflicts with denylist — denylist must take precedence for destructive patterns regardless of order? Decision: stick to last-match-wins for simplicity and document ordering requirements clearly.

**Deps:** none | **Priority:** P1 | **Est:** 1.5h

---

### 3.2 — Mode system

- [x] YAML-defined mode files in `~/.heirloom/modes/` and project `.heirloom/modes/`
- [x] Mode schema: `slug`, `name`, `roleDefinition`, `groups`, `fileRegex`, `customInstructions`
- [x] Built-in modes: `code`, `ask`, `architect`, `debug`, `orchestrator`
- [x] Tool gating by mode groups: `read`, `edit`, `command`, `mcp`, `workflow`

**Acceptance criteria**
| # | Given | When | Then |
|---|-------|------|------|
| AC1 | Mode `code` loaded | tools queried | `read`, `edit`, `command` tools available |
| AC2 | Mode `ask` loaded | tools queried | only `read` tools available, no write/edit tools |
| AC3 | Mode `architect` with `fileRegex: "\\.md$"` | agent writes to `src/index.ts` | operation blocked by file restriction |
| AC4 | Project mode overrides global mode | same slug in both | project mode wins |
| AC5 | Unknown mode slug requested | loaded | falls back to `code` with warning |

**Edge cases**
- Corrupted YAML file — skip with error, don't crash
- Mode with no groups defined — treat as no tool access
- `fileRegex` is empty or `"*"` — allow all files
- Mode name collision between built-in and custom — custom wins (project > global > built-in)

**Deps:** 3.1 | **Priority:** P1 | **Est:** 2h

---

### 3.3 — Mode CLI integration

- [x] `/mode <slug>` command switches active mode
- [x] Mode name shown in prompt: `heirloom [code] >`
- [x] Sticky model per mode — each mode remembers last-used provider/model

**Acceptance criteria**
| # | Given | When | Then |
|---|-------|------|------|
| AC1 | User types `/mode architect` | command received | mode switches, tools re-gated, prompt updates |
| AC2 | Mode switched mid-conversation | next message sent | system prompt includes new mode's roleDefinition |
| AC3 | Invalid mode slug | `/mode nonexistent` | error message, current mode unchanged |

**Edge cases**
- Switching mode while agent is running — queue or reject? Decision: reject with message.
- Mode-specific model not configured — fall back to default model

**Deps:** 3.2, 1.5 | **Priority:** P1 | **Est:** 1h

---

## Phase 4: Context Compaction

### 4.1 — Token estimation + budget

- [x] Create `src/compaction/budget.ts` — estimate tokens from `Message[]`
- [x] Budget: 70% conversation, 20% output reserve, 10% safety buffer
- [x] `shouldCompact(messages, contextWindow)` — returns boolean

**Acceptance criteria**
| # | Given | When | Then |
|---|-------|------|------|
| AC1 | Messages at 60% of context window | `shouldCompact` called | returns false |
| AC2 | Messages at 75% of context window | `shouldCompact` called | returns true |
| AC3 | Empty message array | estimated | returns 0 tokens |

**Edge cases**
- Token estimation is approximate (char/4 heuristic) — acceptable for Phase 4
- Different models have different context windows — read from provider config
- Very long tool outputs — count separately, may be pruned independently

**Deps:** 1.1 | **Priority:** P1 | **Est:** 1h

---

### 4.2 — Summarization engine

- [x] Create `src/compaction/compactor.ts` — `Compactor` class
- [x] `compact(messages)` — summarize old messages, keep recent ones
- [x] Uses same provider (or cheaper model) to generate summary
- [x] Summary includes: files changed, decisions made, key observations

**Acceptance criteria**
| # | Given | When | Then |
|---|-------|------|------|
| AC1 | 50 messages, threshold at 30 | compacted | returns ~5 messages: 1 summary + 4 most recent |
| AC2 | 5 messages, below threshold | compacted | returns unchanged messages |
| AC3 | Summary generated | LLM receives compacted context | summary appears as system message, recent messages follow |

**Edge cases**
- All messages are system/tool — keep at least the last 2 user-assistant pairs
- Compaction fails (provider error) — return messages unchanged, log warning
- Empty summary from LLM — use fallback: "Previous conversation summarized."
- Very large tool outputs in old messages — prune from summary, note "tool outputs omitted"

**Deps:** 4.1 | **Priority:** P1 | **Est:** 1.5h

---

### 4.3 — Auto-compaction trigger

- [x] Integrate compaction into agent loop
- [x] After each tool execution, check budget
- [x] If over threshold, compact before next LLM call

**Acceptance criteria**
| # | Given | When | Then |
|---|-------|------|------|
| AC1 | Agent in a long conversation | token budget exceeded mid-loop | compaction runs automatically before next LLM call |
| AC2 | Compaction completes | agent continues | conversation continues without context overflow error |
| AC3 | Manual `/compact` command | user triggers | forces compaction regardless of budget |

**Edge cases**
- Compaction during a tool call chain — wait until current turn completes
- Back-to-back compactions — don't compact again within 3 turns of last compaction
- Context still over budget after compaction — prune oldest tool outputs

**Deps:** 4.2, 1.4 | **Priority:** P1 | **Est:** 1h

---

## Phase 5: Checkpoint/Restore

### 5.1 — Shadow Git repository

- [x] Create `src/checkpoints/index.ts` — `CheckpointManager` class
- [x] Shadow Git repo at `~/.heirloom/checkpoints/{sessionId}/`
- [x] `save()` — `git add -A && git commit` before every file modification
- [x] `restore(type)` — `"files"` (revert workspace only) or `"full"` (revert + purge conversation)

**Acceptance criteria**
| # | Given | When | Then |
|---|-------|------|------|
| AC1 | File about to be modified by write_file | `save()` called | snapshot committed in shadow repo |
| AC2 | User requests `restore("files")` | executed | workspace files reverted to last checkpoint |
| AC3 | User requests `restore("full")` | executed | files reverted AND conversation messages after checkpoint removed |
| AC4 | No checkpoints exist | `restore()` called | error message, no action taken |

**Edge cases**
- Shadow repo doesn't exist yet — `git init` on first save
- Nested `.git` directories in workspace — warn, operate at root level only
- File deleted between checkpoint and restore — restore recreates it
- Concurrent checkpoint saves — queue, serialize via lock
- Large binary files — exclude via `.gitignore` in shadow repo
- Empty commit (no changes) — skip, don't create empty checkpoint

**Deps:** none | **Priority:** P2 | **Est:** 2h

---

### 5.2 — Checkpoint CLI integration

- [x] `/checkpoint` — manual checkpoint
- [x] `/restore [files|full]` — restore to last checkpoint
- [x] `/checkpoints` — list checkpoints with timestamps and file counts

**Acceptance criteria**
| # | Given | When | Then |
|---|-------|------|------|
| AC1 | User types `/checkpoint` | command received | manual checkpoint created, confirmation shown |
| AC2 | User types `/restore files` | confirmed | workspace reverted, message shown |
| AC3 | User types `/restore full` | confirmed | workspace AND conversation reverted |

**Edge cases**
- Restore without confirmation — require explicit `/restore full --yes`
- Restore while agent is running — reject with message

**Deps:** 5.1, 1.5 | **Priority:** P2 | **Est:** 0.5h

---

## Phase 6: Write-Delay Diagnostics

### 6.1 — Post-write diagnostic check

- [x] After every `write_file` / edit tool execution, wait 500ms
- [x] Run language-appropriate linter: `tsc --noEmit` for TS, `cargo check` for Rust, etc.
- [x] Compare diagnostics before vs after write
- [x] Feed only NEW errors back to LLM

**Acceptance criteria**
| # | Given | When | Then |
|---|-------|------|------|
| AC1 | TS file written with type error | 500ms after write | `tsc --noEmit` runs, new error detected |
| AC2 | New errors found | diagnostic check complete | error injected as system message: "Your last edit introduced these errors: ..." |
| AC3 | No new errors | diagnostic check complete | no feedback injected |
| AC4 | Pre-existing errors unchanged | diagnostic check complete | no feedback injected (only new errors reported) |

**Edge cases**
- Linter not installed for language — skip diagnostic check, log info
- Linter times out (30s) — skip, don't block the agent
- Multiple files modified in one turn — run diagnostic once for all modified files
- Linter output is empty (clean) — no feedback

**Deps:** 2.2, 2.3 | **Priority:** P2 | **Est:** 1.5h

---

## Phase 7: RepoMap

### 7.1 — Tree-sitter symbol extraction

- [x] Create `src/repomap/index.ts` — `RepoMap` class
- [x] Parse codebase with tree-sitter, extract symbol definitions + references
- [x] Build symbol→reference graph
- [x] Cache per-file tags by mtime

**Acceptance criteria**
| # | Given | When | Then |
|---|-------|------|------|
| AC1 | TypeScript codebase with 50 files | parsed | symbols extracted for each file |
| AC2 | File hasn't changed since last parse | re-parsed | cached results used (no re-parse) |
| AC3 | File changed (mtime updated) | re-parsed | tags re-extracted |

**Edge cases**
- Unsupported language — skip, no symbols for that file
- Binary file detected — skip
- File deleted between parse attempts — remove from cache
- Nested node_modules — exclude by default
- Very large file (>10k lines) — parse but warn, may be slow

**Deps:** none | **Priority:** P3 | **Est:** 3h

---

### 7.2 — PageRank ranking + context injection

- [x] Rank files/symbols by relevance to current conversation
- [x] Weight: mentioned identifiers ×10, chat files ×50, private symbols ×0.1
- [x] Binary search to fit ranked results within token budget
- [x] Inject top-N ranked files into system prompt

**Acceptance criteria**
| # | Given | When | Then |
|---|-------|------|------|
| AC1 | User asks about "authenticate function" | ranking computed | file containing `authenticate` ranks highest |
| AC2 | Token budget is 1024 | binary search runs | maximizes file count within budget |
| AC3 | Empty codebase (no files) | `getMap()` called | returns "(empty repository)" |

**Edge cases**
- Conversation has no file mentions — return top-level entry points (index.ts, main.ts)
- All files equally ranked — prioritize files already in conversation
- Token budget too small for even one file — return empty map

**Deps:** 7.1 | **Priority:** P3 | **Est:** 2h

---

## Phase 8: Self-Reflection + Error Recovery

### 8.1 — Self-reflection loop

- [x] After tool execution fails, feed error back to LLM for one retry
- [x] Retry count: max 1 per turn, max 3 total per conversation
- [x] Error format: `"Your {tool_name} call failed: {error_message}. Try a different approach."`

**Acceptance criteria**
| # | Given | When | Then |
|---|-------|------|------|
| AC1 | `apply_diff` fails (no match) | error fed back | LLM tries alternative approach in same turn |
| AC2 | Second attempt also fails | max retries reached | error shown to user, agent exits turn |
| AC3 | `read_file` fails (file not found) | error fed back | LLM corrects the path and retries |

**Edge cases**
- Same error on retry (LLM didn't change approach) — don't retry again, show to user
- Permission denial — not an "error," don't trigger self-reflection
- Network/provider error — retry with backoff, not self-reflection
- Retry causes context overflow — compact first, then retry

**Deps:** 1.4 | **Priority:** P3 | **Est:** 1h

---

### 8.2 — Layered error recovery

- [x] Layer 1: Parse error → requery with format correction template
- [x] Layer 2: Tool execution error → self-reflection (8.1)
- [x] Layer 3: Fatal error → save state, notify user

**Acceptance criteria**
| # | Given | When | Then |
|---|-------|------|------|
| AC1 | LLM returns malformed tool call (bad JSON) | detected | requery with format error template |
| AC2 | Bash command times out | detected | timeout feedback sent to LLM |
| AC3 | Fatal error (crash, OOM) | detected | session state saved, user notified |

**Edge cases**
- Multiple format errors in a row — give up after 2 requeries, show raw output to user
- Timeout cascade (3+ consecutive timeouts) — exit agent turn, notify user

**Deps:** 8.1 | **Priority:** P3 | **Est:** 1h

---

## Phase 9: Extensibility

### 9.1 — MCP client

- [x] Create `src/mcp/client.ts` — MCP client for tool discovery
- [x] `listTools(serverConfig)` — connect to MCP server, fetch tool list
- [x] Convert MCP tools to heirloom `ToolDef[]`
- [x] `callTool(serverConfig, toolName, args)` — execute MCP tool

**Acceptance criteria**
| # | Given | When | Then |
|---|-------|------|------|
| AC1 | MCP server at localhost:3000 | `listTools` called | tools fetched and converted to ToolDef[] |
| AC2 | `callTool` with valid args | executed | tool result returned as ToolOutput |
| AC3 | MCP server unreachable | any call | graceful error, agent continues |

**Edge cases**
- MCP server returns non-JSON — parse error, report
- Tool discovery timeout — 10s timeout, skip server
- Duplicate tool names across servers — namespaced: `serverName/toolName`

**Deps:** 1.1 | **Priority:** P3 | **Est:** 2h

---

### 9.2 — Skill loader

- [x] Progressive disclosure: skills indexed by description, loaded on demand
- [x] Skill format: `SKILL.md` with frontmatter (name, description, triggers)
- [x] `~/.heirloom/skills/` and `.heirloom/skills/` scanned at startup

**Acceptance criteria**
| # | Given | When | Then |
|---|-------|------|------|
| AC1 | Skill matches user request | agent about to process | skill content injected into system prompt |
| AC2 | Skill doesn't match | agent processes | skill content NOT injected (progressive disclosure) |
| AC3 | Invalid SKILL.md (bad frontmatter) | scanned | skipped with warning, other skills still load |

**Edge cases**
- Two skills match the same request — inject both, order by specificity
- Skill file is empty — skip
- Circular skill references — detect and break

**Deps:** 1.4 | **Priority:** P3 | **Est:** 1.5h

---

### 9.3 — Orchestrator mode (Boomerang Tasks)

- [x] Orchestrator mode has only `new_task` tool
- [x] `new_task` spawns sub-agent with isolated context
- [x] Sub-agent completes → summary bubbles back to orchestrator
- [x] Parent never sees sub-agent file diffs or tool outputs

**Acceptance criteria**
| # | Given | When | Then |
|---|-------|------|------|
| AC1 | Orchestrator delegates "fix auth" to code mode | subtask runs | code agent works in isolated context |
| AC2 | Sub-agent completes | summary returned | orchestrator sees only summary, not raw output |
| AC3 | Sub-agent fails | error returned | orchestrator can retry or revise plan |

**Edge cases**
- Recursive task spawning (sub-agent spawns sub-sub-agent) — limit depth to 3
- Sub-agent context overflow — compact independently
- Sub-agent gets stuck — timeout after N turns, return partial summary

**Deps:** 3.2 | **Priority:** P3 | **Est:** 2h

---

## Phase 10: Session Persistence

> From session-spec.md. Contract changes from the same spec pass also touch
> earlier phases: adapter error shape (1.3), FILE_MODIFIED on edit tools
> (2.2), approval overlay in the permission engine (3.1), per-model context
> windows (4.1), system prompt (1.4).

### 10.1 — Session store (JSONL)

- [ ] Create `src/sessions/store.ts` — append-only JSONL at `~/.heirloom/sessions/<project-slug>/<id>.jsonl`
- [ ] Record types: `meta` (first line, versioned), `message`, `state`, `compaction`
- [ ] Session ID: `<compact ISO UTC>-<4 hex>`; filename is the ID
- [ ] Append only after a message/turn completes — never mid-stream

**Acceptance criteria**
| # | Given | When | Then |
|---|-------|------|------|
| AC1 | A completed turn | appended | file is valid JSONL, one record per line |
| AC2 | Crash mid-turn | session reloaded | in-flight turn absent, all prior turns intact |
| AC3 | Torn final line (incomplete JSON) | loaded | dropped with warning, rest loads |
| AC4 | `meta.version` higher than known | loaded | refuses with clear error, no misparse |

**Edge cases**
- `/mode` or model switch mid-session — append `state` record, last wins on load
- System prompt is never persisted — rebuilt on load from current config
- Project-slug collision — tolerated; true `cwd` lives in `meta`

**Deps:** 1.4 | **Priority:** P1 | **Est:** 2h

---

### 10.2 — Resume + session CLI

- [ ] `--continue`/`-c` (most recent for cwd), `--session <id>`
- [ ] `/sessions` (id, 60-char first-message excerpt, age, count), `/new`
- [ ] Effective conversation: last `compaction` marker → summary + messages after `replacesThrough`
- [ ] One-line recap on resume

**Acceptance criteria**
| # | Given | When | Then |
|---|-------|------|------|
| AC1 | Two sessions for this cwd | `-c` | newer one loads (string-sorted ID) |
| AC2 | Session with a compaction record | resumed | LLM sees summary + tail, full transcript untouched on disk |
| AC3 | `/new` mid-session | invoked | current session saved, fresh one started |

**Edge cases**
- No sessions for cwd + `-c` — start new with notice, not an error
- `restore full` (Phase 5) — appends `{"truncateAt": N}` state record, never deletes lines

**Deps:** 10.1, 1.5 | **Priority:** P1 | **Est:** 1.5h

---

## Phase 11: System Prompt Assembly

### 11.1 — Implement system-prompt.md

- [ ] Replace placeholder `buildSystemPrompt` with the 9-section assembly (role → base → tool guide → mode custom → environment → project → skills → memory → repomap)
- [ ] Base rules, edit-tool guide, shell guide verbatim from the spec
- [ ] Environment block: cwd, platform, date, git branch/state
- [ ] Project instructions: `.heirloom/instructions.md`, `AGENTS.md` fallback

**Acceptance criteria**
| # | Given | When | Then |
|---|-------|------|------|
| AC1 | `ask` mode | prompt built | no edit/shell guides — ~40% smaller than `code` |
| AC2 | Empty sections (no memory, no repomap) | prompt built | omitted entirely, no empty headers |
| AC3 | Both instruction files exist | prompt built | `.heirloom/instructions.md` wins |
| AC4 | Same mode, same session | two turns | identical prefix (sections 1–7) for provider caching |

**Edge cases**
- Not a git repo — `git: not a git repository`, no error
- Spec/code divergence — treated as a bug in one of them (doc's contract)

**Deps:** 3.2 | **Priority:** P1 | **Est:** 1.5h

---

## Phase 12: Provider Registry + Auth

### 12.1 — Providers map + adapter registry

- [ ] Rename `deepseek.ts` → `openai-compatible.ts`; factory takes `{ baseUrl, apiKey }`
- [ ] Adapter registry: `api: openai-compatible | anthropic`; unknown → startup config error
- [ ] Merge built-in presets (deepseek, openai, anthropic) with config `providers:`
- [ ] Key resolution: env var (`apiKeyEnv`) → `~/.heirloom/credentials.yaml`; injected — adapters never read `process.env`
- [ ] Per-model `contextWindow` feeds compaction budget; global fallback warns
- [ ] Model refs split on first slash: `openrouter/anthropic/claude-x` → provider `openrouter`

**Acceptance criteria**
| # | Given | When | Then |
|---|-------|------|------|
| AC1 | OpenRouter entry in config + key set | used | works with zero code changes |
| AC2 | Key unset everywhere | first LLM call | error names the missing env var / auth command |
| AC3 | Model with slashes in ID | `--model` parsed | first-slash split, rest is model ID |
| AC4 | Model without `contextWindow` | budget computed | global fallback used, warning printed |

**Edge cases**
- `apiKeyEnv: null` (Ollama) — no key required, no warning
- Config overrides a built-in preset — override wins (config precedence chain)

**Deps:** 1.3 | **Priority:** P1 | **Est:** 2h

---

### 12.2 — `heirloom auth` wizard

- [ ] `heirloom auth` (wizard), `auth list`, `auth logout <name>`
- [ ] Presets: DeepSeek, OpenRouter, Groq, Together, Ollama, OpenAI, Anthropic; "custom" asks baseUrl and writes provider entry to config
- [ ] Writes `~/.heirloom/credentials.yaml` with mode `0600`

**Acceptance criteria**
| # | Given | When | Then |
|---|-------|------|------|
| AC1 | Preset chosen | wizard completes | only the key was typed; provider usable |
| AC2 | `auth list` | run | shows each provider + key source (env / credentials / none) |
| AC3 | `auth logout openrouter` | run | credentials entry removed, config entry untouched |

**Edge cases**
- Credentials file exists world-readable — warn and chmod 600
- Pasted key with surrounding whitespace — trim

**Deps:** 12.1 | **Priority:** P2 | **Est:** 1.5h

---

## Phase 13: Approval Modes

### 13.1 — Permission overlay (permission-spec.md)

- [ ] Overlay `manual | edits | all` on rule resolution; only upgrades `ask` → `allow`; `deny` absolute in every mode
- [ ] `edits`: auto-allow only edit-group tools targeting paths inside workingDir
- [ ] `/approve [mode]` — show/set + list session rules; prompt indicator `heirloom [code ⚡edits] >`
- [ ] Ask prompt answers `y / a / n`; `a` appends generalized in-memory session rule
- [ ] `--approve <edits|all>` flag; headless `ask` → deny unless set

**Acceptance criteria**
| # | Given | When | Then |
|---|-------|------|------|
| AC1 | `rm *: deny` + approval `all` | `rm -rf` attempted | denied — deny survives every overlay |
| AC2 | Approval `edits` | `edit` inside cwd / `run_bash` | edit runs silently, bash still prompts |
| AC3 | `a` answered on `npm install x` | third `npm install` call | no prompt (session rule `npm install *`) |
| AC4 | New session | started | approval mode is `manual`, no session rules |

**Edge cases**
- Edit tool targeting a path outside workingDir in `edits` — prompts anyway
- Entering `all` — one-line warning naming the workingDir
- Session rules die with the session — never written to config

**Deps:** 3.1 | **Priority:** P1 | **Est:** 2h

---

## Phase 14: Robustness Hardening

### 14.1 — Provider retry policy

- [ ] Adapters throw typed errors `{ status?, retryable }` (429/5xx/network → retryable)
- [ ] Loop retries: backoff 1s → 2s → 4s, max 3, visible `[provider error, retry n/3]`
- [ ] Mid-stream failure discards partial turn, retries whole call
- [ ] Fatal (401/403/404) fails immediately naming the config to fix

**Acceptance criteria**
| # | Given | When | Then |
|---|-------|------|------|
| AC1 | 429 then success | streamed | retry notice shown, turn completes |
| AC2 | Stream cut at 50% | retried | no duplicate text in final conversation; session has no partial turn |
| AC3 | Bad API key | first call | immediate failure naming provider + key source |

**Deps:** 12.1 | **Priority:** P1 | **Est:** 1.5h

---

### 14.2 — Loop detection + maxTurns pause

- [ ] Identical tool+arguments 3× per turn → corrective system message; recurrence → end turn
- [ ] 5 consecutive failed tool calls → same escalation
- [ ] `maxTurns` hit → print progress (todo list if present), persist session, return to prompt; next input continues with fresh budget

**Acceptance criteria**
| # | Given | When | Then |
|---|-------|------|------|
| AC1 | Same failing `edit` 3× | detected | system message names repetition + last error |
| AC2 | Still repeating after warning | detected | turn ends, user informed |
| AC3 | `maxTurns` reached mid-task | hit | session persisted, "continue?" prompt, no work lost |

**Deps:** 8.2 | **Priority:** P2 | **Est:** 1h

---

### 14.3 — Stale-file detection, compaction fidelity, config validation

- [ ] Track mtime per file at `read_file`; edit tools return `FILE_MODIFIED` when target changed since read or never read
- [ ] Compaction fidelity check (subsystems §2): files/pending/task verified mechanically; regenerate once; then defer compaction
- [ ] Startup schema validation of config + mode YAML: invalid value → fail fast naming file+field; unknown fields → warn

**Acceptance criteria**
| # | Given | When | Then |
|---|-------|------|------|
| AC1 | User edits file in own editor after agent read it | agent edits | `FILE_MODIFIED`, no write, hint to re-read |
| AC2 | Summary missing a changed file | fidelity check | regenerated once; second miss → compaction deferred |
| AC3 | `api: grpc` in providers | startup | exits naming file and field |
| AC4 | Unknown config field | startup | warning only, boots normally |

**Deps:** 2.2, 4.2 | **Priority:** P1 | **Est:** 2h

---

## Phase 15: CLI Hardening

### 15.1 — Headless mode, interrupts, I/O decoupling (cli-spec.md)

- [ ] `-p "<prompt>"`: stream to stdout, exit on completion; `ask` → deny; `ask_followup_question` → print + exit 2
- [ ] Exit codes 0/1/2; errors and warnings to stderr
- [ ] Ctrl+C mid-turn: AbortSignal → stream closed, tool aborted, partial turn not persisted, prompt returns; idle Ctrl+C prints hint; Ctrl+D exits
- [ ] Agent loop I/O decoupling: no `process.stdout` in `agent.ts` — output via injected callbacks (architecture tradeoff 6)
- [ ] `bin` entry + `--help`/`--version`

**Acceptance criteria**
| # | Given | When | Then |
|---|-------|------|------|
| AC1 | `-p` with sufficient allow rules | run | completes, exit 0, output pipeable |
| AC2 | `-p` needing user input | run | question printed, exit 2 |
| AC3 | Ctrl+C during tool execution | pressed | child process killed, session has no partial turn |
| AC4 | Unknown `/command` | typed | error + `/help` hint, never sent to LLM |

**Deps:** 10.1, 13.1 | **Priority:** P2 | **Est:** 2h

---

## Phase 16: Skills Alignment

### 16.1 — Cross-tool skill loading (skill-spec.md)

- [ ] Search paths in precedence: `.heirloom/skills` → `.agents/skills` → `~/.heirloom/skills` → `~/.agents/skills`; first name-match wins
- [ ] Skills index in system prompt section [7]; `mode`-restricted skills filtered per mode
- [ ] `load_skill` tool — body as tool output; unknown name → `FILE_NOT_FOUND` listing available skills
- [ ] `/skills`, `/skill <name>` commands
- [ ] Unknown frontmatter fields ignored (`license`, `metadata`, …)

**Acceptance criteria**
| # | Given | When | Then |
|---|-------|------|------|
| AC1 | Skill installed via `npx skills add` into `~/.agents` | startup | appears in `/skills` and index, loads unchanged |
| AC2 | Same slug in project and global | loaded | project wins |
| AC3 | `load_skill("nope")` | called | error lists available names |

**Edge cases**
- Missing `description` — skip with warning, others load
- `.skill-lock.json` — never read or written by heirloom

**Deps:** 9.2, 11.1 | **Priority:** P2 | **Est:** 1.5h

---

## Phase 17: Test Harness

### 17.1 — Vitest + golden tasks (conventions.md)

- [ ] Vitest; `npm test` = `vitest run`
- [ ] Unit targets: 6 edit strategies, permission engine + approval overlay, registry mode-gating, compaction budget + fidelity check, session loader (torn line / state folding / compaction reconstruction)
- [ ] `fixtures/` projects + golden tasks G1–G6; runnable via `-p --approve all`

**Acceptance criteria**
| # | Given | When | Then |
|---|-------|------|------|
| AC1 | `npm test` | run | green; covers the five unit targets |
| AC2 | G2 (planted failing test) | run headless | agent fixes it, exit 0, no out-of-scope file touched |

**Edge cases**
- Provider adapters and agent loop deliberately not unit-tested — golden tasks cover them
- Golden tasks manual until harness scripted

**Deps:** 15.1 | **Priority:** P1 | **Est:** 3h

---

## Phase 18: Memory

### 18.1 — Persistent memory (subsystems §1)

- [ ] `~/.heirloom/memory/` layout: `MEMORY.md` index, `_global/`, `<project-slug>/` (sessions.md, decisions.md, patterns.md, pitfalls.md)
- [ ] Session-end write: compaction `decisions[]` → candidate facts through the derivability filter; `sessions.md` append
- [ ] Session-start injection ≤ 1,024 tokens (index-first budget fill)
- [ ] "remember X" → immediate write, bypasses filter

**Acceptance criteria**
| # | Given | When | Then |
|---|-------|------|------|
| AC1 | Session with 2 decisions ends | memory written | decision files updated, sessions.md prepended |
| AC2 | Fact derivable from repo (code structure) | filtered | not written to memory |
| AC3 | 60 memory files | session starts | injection stays ≤ 1,024 tokens, index always included |

**Deps:** 10.1, 4.2 | **Priority:** P3 | **Est:** 2h

---

## Non-Functional Requirements

### NFR1: Performance
| # | Given | When | Then |
|---|-------|------|------|
| AC1 | Provider streaming 100 tokens/sec | text displayed | no visible lag, characters appear smoothly |
| AC2 | Tool execution (read_file 500KB) | executed | returns in < 1s |
| AC3 | RepoMap on 1000-file codebase | computed | returns in < 5s (cached: < 100ms) |

### NFR2: Security
| # | Given | When | Then |
|---|-------|------|------|
| AC1 | Bash command with `${var@P}` injection | permission check | blocked regardless of allowlist |
| AC2 | File write to `/etc/passwd` | permission check | denied by path allowlist |
| AC3 | API key logged accidentally | any component | never appears in console output or logs |

### NFR3: Reliability
| # | Given | When | Then |
|---|-------|------|------|
| AC1 | Provider API returns 429 (rate limit) | retry with backoff | succeeds within 3 retries |
| AC2 | Provider API returns 5xx | retry with backoff | succeeds or fails gracefully |
| AC3 | Network disconnection mid-stream | detected | error surfaced, conversation state preserved |

---

## Definition of Done

For every task, all of the following must be true:

- [ ] Code compiles with `npx tsc --noEmit` (zero errors)
- [ ] All acceptance criteria manually verified
- [ ] Edge cases documented in code or test cases
- [ ] No `any` types without explicit justification
- [ ] No SDK imports in canonical types or agent loop
- [ ] Commit message follows `feat:` / `fix:` / `refactor:` convention
- [ ] Git tree is clean (no stray files, no leftover debug logs)
