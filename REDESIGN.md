# Heirloom → Deep Code CLI Redesign — Implementation Plan

> **Target:** Redesign Heirloom to match Deep Code CLI behavior.
> **Phase:** Config system + permissions first (foundation for everything else).
> **Status:** Phase 1.1–1.3 DONE. Phase 2 onward TODO.

---

## Files Already Completed

| File | What Changed |
|------|-------------|
| `src/config/loader.ts` | YAML→JSON, paths `~/.heirloom/settings.json` + `.heirloom/settings.json`, full Deep Code schema |
| `src/config/credentials.ts` | YAML→JSON, path `~/.heirloom/credentials.json` |
| `src/config/credentials.test.ts` | JSON format tests (was YAML) |

---

## Task 1: Rewrite Permissions Engine

**File:** `src/permissions/engine.ts`

Replace the current tool+pattern rule engine with Deep Code's 10-scope model.

### Current vs Target

| Aspect | Current (Heirloom) | Target (Deep Code) |
|--------|-------------------|-------------------|
| Model | `PermissionRule[]` — tool/pattern/action triples, last-match-wins | 10 scopes with `allow[]`/`deny[]`/`ask[]` arrays + `defaultMode` |
| Check | `check(toolName, args)` → `PermissionAction` | Same signature, but internally classifies into scopes first |
| Config | `Record<string, PermissionConfigValue>` | `PermissionConfig { allow, deny, ask, defaultMode }` |
| Approval modes | `manual` / `edits` / `all` overlay | Removed — scopes replace this |
| Guards | Built-in (egress commands, secret paths, rm -r) | Removed — user configures via `deny` scopes |
| Session rules | `addSessionRule()` persists in-memory | `persistAllow(scope)` writes to `.heirloom/settings.json` |

### Implementation Steps

**1.1 Create the new `PermissionEngine` class:**

```typescript
import { resolve, relative } from "node:path";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";

export type PermissionAction = "allow" | "ask" | "deny";

export type PermissionScope =
  | "read-in-cwd"
  | "read-out-cwd"
  | "write-in-cwd"
  | "write-out-cwd"
  | "delete-in-cwd"
  | "delete-out-cwd"
  | "query-git-log"
  | "mutate-git-log"
  | "network"
  | "mcp";

export interface PermissionConfig {
  allow?: PermissionScope[];
  deny?: PermissionScope[];
  ask?: PermissionScope[];
  defaultMode?: "allowAll" | "askAll";
}

export class PermissionEngine {
  private allow: Set<PermissionScope>;
  private deny: Set<PermissionScope>;
  private ask: Set<PermissionScope>;
  private defaultMode: "allowAll" | "askAll";
  private workingDir: string;
  private projectConfigPath: string;

  constructor(config?: PermissionConfig, workingDir?: string) {
    this.allow = new Set(config?.allow ?? []);
    this.deny = new Set(config?.deny ?? []);
    this.ask = new Set(config?.ask ?? []);
    this.defaultMode = config?.defaultMode ?? "allowAll";
    this.workingDir = workingDir ?? process.cwd();
    this.projectConfigPath = join(this.workingDir, ".heirloom", "settings.json");
  }
}
```

**1.2 Implement `classifyScopes(toolName, args)`:**
Map each tool call to one or more scopes:

| Tool | Scopes |
|------|--------|
| `read_file` | `read-in-cwd` if path inside workspace, else `read-out-cwd` |
| `write_file`, `write`, `write_to_file` | `write-in-cwd` if path inside workspace, else `write-out-cwd` |
| `edit`, `edit_file`, `apply_diff`, `apply_patch`, `search_replace` | `write-in-cwd` if path inside workspace, else `write-out-cwd` |
| `list_files`, `glob`, `search` | `read-in-cwd` (always workspace-scoped) |
| `run_bash` | Parse command tokens: `curl`/`wget`/`npm install` → `network`; `git log`/`git show` → `query-git-log`; `git commit`/`git push`/`git rebase` → `mutate-git-log`; `rm`/`rmdir` → `delete-in-cwd` or `delete-out-cwd`; `cat`/`head` → `read-in-cwd`/`read-out-cwd`; `>`/`>>` redirect → `write-in-cwd`/`write-out-cwd`; unknown → `[]` (triggers ask) |
| `mcp__*` | `mcp` |
| `load_skill` | `read-in-cwd` |

Path containment: resolve both the path and workingDir with `realpathSync`, then `relative(workDir, path)` must not start with `..`. Catch nonexistent paths gracefully.

**1.3 Implement `check(toolName, args)`:**
```
1. scopes = classifyScopes(toolName, args)
2. If scopes is empty → return "ask"
3. If ANY scope in deny → return "deny"
4. If ANY scope in ask → return "ask"
5. If ALL scopes in allow → return "allow"
6. Otherwise → return defaultMode === "allowAll" ? "allow" : "ask"
```

**1.4 Implement `persistAllow(scopes)`:** (for "Yes, and always allow")
```
1. Read existing .heirloom/settings.json (if exists)
2. Add scopes to permissions.allow array
3. Remove from permissions.deny and permissions.ask if present
4. Write back (create .heirloom/ dir if needed)
```

**1.5 Remove all old code:**
- Delete: `PermissionRule`, `ApprovalMode`, `matchTool`, `matchPattern`, `globToRegex`
- Delete: `addRule`, `addSessionRule`, `getSessionRules`, `clone`
- Delete: `setApprovalMode`, `approvalMode`, `applyApprovalMode`
- Delete: `GUARDED_PATTERNS`, `EGRESS_COMMANDS`, `COMMAND_WRAPPERS`, `SECRET_BASENAME_PATTERNS`
- Delete: `hasEgressCommand`, `isRmRecursive`, `isSecretPath`, `normalizeCommandTokens`, `splitCommands`, `hasSubshell`
- Delete: `isEditToolInWorkspace`, `realpathUpToExisting`, `resolveDanglingSymlink`, `normalizePath`
- Delete: `isHeadless`, `static defaults()` → replace with constructor taking `PermissionConfig`

**1.6 Export:**
`src/permissions/index.ts` should export: `{ PermissionEngine, PermissionAction, PermissionScope, PermissionConfig }`

---

## Task 2: Update `src/index.ts` — Config + Permissions Integration

**File:** `src/index.ts`

### 2.1 Config loading changes (lines ~320-338)

Current code:
```typescript
const configResult = loadConfig();
if (configResult.config.providers) {
  setConfigProviders(configResult.config.providers);
}
if (configResult.config.mcp) {
  await connectMCPServers(configResult.config.mcp);
}
```

Changes needed:
- `loadConfig()` return type is now `DeepCodeSettings` instead of `HeirloomConfig`
- No more `configResult.config.providers` — providers use env.BASE_URL/env.API_KEY
- `configResult.config.mcp` → `configResult.config.mcpServers`
- `connectMCPServers` takes `Record<string, McpServerConfig>` instead of old `MCPEntry` type

### 2.2 Provider initialization (lines ~365-413)

Current: reads `configResult.config.provider`, `configResult.config.model` from config + env var detection.

Changes:
- Model: `args.model ?? config.model ?? config.env?.MODEL`
- Base URL: `config.env?.BASE_URL ?? "https://api.deepseek.com"`
- API Key: `config.env?.API_KEY` or detected from env vars
- `thinkingEnabled` and `reasoningEffort` read from config, passed to provider

### 2.3 Permissions (lines ~431-434)

Replace:
```typescript
const permissions = PermissionEngine.defaults(undefined, !!args.prompt);
if (configResult.config.permissions) {
  feedPermissions(permissions, configResult.config.permissions);
}
```

With:
```typescript
const permissions = new PermissionEngine(configResult.config.permissions, process.cwd());
```

Remove the `feedPermissions` function entirely (lines ~339-349).

### 2.4 Status bar — remove approval mode (lines ~755-819)

Remove:
- `cycleApprovalMode` function
- Approval mode display in `buildStatusBar` (lines ~766-770)
- The `permissions.approvalMode` reference

Add:
- Show `defaultMode` if it's `askAll` (compact indicator like `🔒askAll`)

### 2.5 Keybinding — remove approval cycle

Remove the `cycleApproval` keybinding handler (lines ~628-636 in App.tsx or index.ts key handler).
Remove `cycleApprovalMode` calls.

---

## Task 3: Update PermissionPrompt UI

**File:** `src/ui/PermissionPrompt.tsx`

### Current behavior:
Shows tool name + args, options: Y/N/A

### New behavior:
Shows **scopes** being requested:
```
┌─ Permission Required ──────────────────────────────┐
│ run_bash: npm install react                        │
│ Scopes: network, write-in-cwd                      │
│                                                    │
│ [Y] Yes, just this once                            │
│ [A] Yes, and always allow these scopes             │
│ [N] No                                             │
└────────────────────────────────────────────────────┘
```

The `PermissionPrompt` component needs to:
1. Accept scopes as a prop (not just toolName + args)
2. Display scopes clearly
3. On "A", call `permissions.persistAllow(scopes)`

### Update App.tsx (lines ~89-93, 568-606)

The `askPrompt` state needs to carry scopes:
```typescript
const [askPrompt, setAskPrompt] = useState<{
  resolve: (v: boolean) => void;
  toolName: string;
  args: Record<string, unknown>;
  scopes: PermissionScope[];  // NEW
} | null>(null);
```

In the `askUser` callback (lines ~371-392), classify scopes before showing prompt:
```typescript
askUser: async (toolName, args) => {
  const scopes = permissions.classifyScopes(toolName, args);
  // ... show permission prompt with scopes
}
```

On "A" (always allow), replace the old `addSessionRule` logic with `persistAllow`:
```typescript
if (isAlways) {
  permissions.persistAllow(scopes);
}
```

---

## Task 4: Update Provider Layer

**Files:** `src/providers/presets.ts`, `src/providers/aisdk.ts`, `src/providers/types.ts`

### 4.1 Provider creation

The `createProvider` function needs to accept:
- `baseUrl` from config
- `apiKey` from config
- `thinkingEnabled` boolean
- `reasoningEffort` string

### 4.2 AI SDK provider

For DeepSeek V4 models, the API call should include:
- `thinking: { type: "enabled" }` when `thinkingEnabled: true`
- `reasoning_effort: "max"` or `"high"` per config

### 4.3 Model detection

Default model: `deepseek-v4-pro` (align with Deep Code).
If `config.env?.MODEL` is set, use that.
If `config.model` is set, that takes precedence.

---

## Task 5: Filesystem Operations — MCP Connector Update

**File:** `src/mcp/connector.ts`

Update `connectMCPServers` signature:
- Old: `Record<string, MCPEntry>` where `MCPEntry = { enabled?, command, args?, env? }`
- New: `Record<string, McpServerConfig>` from `DeepCodeSettings.mcpServers`

`McpServerConfig` has: `{ command, args?, env? }` (no `enabled` field — all configured servers are enabled).

---

## Task 6: Cleanup

### 6.1 Remove js-yaml dependency
**File:** `package.json`

Check if `js-yaml` is still used anywhere:
```bash
rg "from \"js-yaml\"" src/ --no-ignore
rg "from 'js-yaml'" src/ --no-ignore
rg 'require\("js-yaml"\)' src/ --no-ignore
```

If only used in `config/loader.ts` and `config/credentials.ts` (both already rewritten), remove from package.json:
```bash
npm uninstall js-yaml @types/js-yaml
```

### 6.2 Update mode loader
**File:** `src/modes/loader.ts`

Check if it still uses `js-yaml` to parse YAML mode files. Mode files are YAML by design — keep this dependency only for modes.

### 6.3 Run TypeScript check
```bash
npx tsc --noEmit
```
Fix all type errors.

### 6.4 Run tests
```bash
npm test
```
Fix any failing tests.

---

## Verification Checklist

After all tasks complete, verify:

- [ ] `~/.heirloom/settings.json` is read on startup (create a test file)
- [ ] `.heirloom/settings.json` overrides user settings
- [ ] `env.MODEL`, `env.BASE_URL`, `env.API_KEY` are used for API calls
- [ ] `thinkingEnabled: true` sends `thinking` param to DeepSeek V4
- [ ] `permissions.allow` / `deny` / `ask` arrays control tool access
- [ ] `permissions.defaultMode: "askAll"` prompts for every unlisted scope
- [ ] Permission prompt shows scopes and Y/N/A options
- [ ] "Yes, and always allow" persists scopes to `.heirloom/settings.json`
- [ ] `mcpServers` connects MCP servers and registers tools
- [ ] Status bar no longer shows approval modes (manual/edits/all)
- [ ] `/model` switching still works
- [ ] `/mcp` command works (or is stubbed)
- [ ] `npx tsc --noEmit` passes
- [ ] `npm test` passes
