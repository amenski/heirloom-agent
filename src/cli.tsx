import { render } from "ink";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { checkForNpmUpdate, promptForPendingUpdate } from "./common/update-check.js";
import { parseArguments } from "./cli-args.js";
import { runExecMode } from "./exec-runner.js";
import { initPresets, createProvider, setConfigProviders, getPreset, getKnownProviderNames, getProviderModels, type ProviderOptions } from "./providers/presets.js";
import { getProviderCapabilities } from "./providers/registry.js";
import { runAgent } from "./agent.js";
import { buildRepoMap, loadProjectResearch } from "./prompt.js";
import { fireNotify } from "./notify.js";
import { executeTool, TOOL_DEFS, registry, setSessionId, setCheckpointManager, setSignal } from "./tools/index.js";
import { PermissionEngine } from "./permissions/index.js";
import { previewEdit } from "./permissions/diffpreview.js";
import { ModeLoader, type ModeConfig } from "./modes/loader.js";
import { Compactor } from "./compaction/compactor.js";
import { CheckpointManager } from "./checkpoints/index.js";
import { DiagnosticRunner } from "./diagnostics/index.js";
import { ErrorReflector } from "./selfreflection/index.js";
import { ErrorRecovery } from "./errorrecovery/index.js";
import { authWizard, authList, authLogout, authSaveKey } from "./auth/wizard.js";
import { readHiddenLine } from "./auth/hidden-input.js";
import { SessionStore, type CompactionSummary } from "./sessions/store.js";
import { MemoryStore } from "./memory/store.js";
import { SkillLoader, createLoadSkillTool, type SkillDef } from "./skills/index.js";
import { loadConfig } from "./config/loader.js";
import { readCredentialsFile } from "./config/credentials.js";
import { enableDebug } from "./debug/logger.js";
import { connectMCPServers } from "./mcp/connector.js";
import type { ModelEntry } from "./ui/ModelSelector.js";
import App from "./ui/App.js";
import type { Message } from "./types.js";
import type { ModelCapabilities } from "./providers/types.js";
import { resolveTheme, ThemeContextValue } from "./ui/theme.js";
import { resolveKeybindings, parseKeyCombo, type KeybindingMap, type KeybindingConfig as KeybindingSystemConfig } from "./ui/keybindings.js";
import type { WorkflowIntegrationConfig } from "./ui/types.js";
import { StatusLineManager } from "./ui/statusline/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));

void main();

async function main() {
  initPresets();

  const rawArgs = process.argv.slice(2);
  if (rawArgs.length > 0 && rawArgs[0] === "doctor") {
    await runDoctor();
    process.exit(0);
  }

  if (process.argv[2] === "auth") {
    process.exit(await runAuth(process.argv.slice(3)));
  }

  const parsed = await parseArguments();
  if (parsed.version || parsed.help) process.exit(0);

  const configResult = loadConfig();
  if (configResult.errors.length > 0) {
    for (const e of configResult.errors) process.stderr.write(`Error: ${e}\n`);
    process.exit(1);
  }
  for (const w of configResult.warnings) process.stderr.write(`Warning: ${w}\n`);

  const configEnv = configResult.config.env;

  if (configResult.config.mcpServers) {
    await connectMCPServers(configResult.config.mcpServers, { strictMcpConfig: configResult.config.strictMcpConfig });
  }

  let initialPrompt = parsed.prompt;
  let resumeSessionId: string | true | undefined = parsed.resume;

  if (parsed.exec) {
    process.exitCode = await runExecMode({
      prompt: parsed.prompt!,
      projectRoot: process.cwd(),
      resumeSessionId: typeof parsed.resume === "string" ? parsed.resume : undefined,
      mode: parsed.mode,
      debug: parsed.debug,
    });
    return;
  }

  if (!process.stdin.isTTY) {
    process.stderr.write("heirloom requires an interactive terminal (TTY). Re-run from a real terminal session.\n");
    process.exit(1);
  }

  const resolvedApiKey = configEnv?.API_KEY || undefined;
  const resolvedBaseUrl = configEnv?.BASE_URL || undefined;

  const detected = detectProvider(configEnv);
  let providerName = configResult.config.provider || detected || "deepseek";

  if (!detected && !configResult.config.provider && !resolvedApiKey) {
    const hasCreds = Object.values(readCredentialsFile()).some((v) => v);
    if (!hasCreds) {
      console.log("No API keys found. Set config.env.API_KEY, env var, or run `heirloom auth`.");
      if (!parsed.prompt) process.exit(0);
    }
  }

  const initialModel: string | undefined = parsed.model ?? configResult.config.model ?? configEnv?.MODEL ?? undefined;
  const thinkingEnabled = configResult.config.thinkingEnabled ?? true;
  const reasoningEffort = configResult.config.reasoningEffort;

  function getActiveModelCaps(): ModelCapabilities | undefined {
    const preset = getPreset(shared.providerName);
    if (!preset) return undefined;
    return preset.models[shared.activeModel ?? preset.defaultModel];
  }

  function getProvider() {
    return createProvider(shared.providerName, { modelOverride: shared.activeModel, baseUrl: resolvedBaseUrl, apiKey: resolvedApiKey });
  }

  const modeLoader = new ModeLoader();
  const permissions = new PermissionEngine(configResult.config.permissions, process.cwd());
  const contextWindow = configResult.config.contextWindow ?? 128000;

  let _compactor: Compactor | undefined;
  function getCompactor(): Compactor {
    if (!_compactor) _compactor = new Compactor(getProvider(), contextWindow, configResult.config.compaction?.threshold, configResult.config.compaction?.auto ?? true);
    return _compactor;
  }

  const sessionStore = new SessionStore();
  let sessionId: string;
  let sessionMessages: Message[] = [];
  let sessionLoaded = false;

  const sessionCreateBase = {
    cwd: process.cwd(),
    provider: providerName,
    model: initialModel || getPreset(providerName)?.defaultModel || "deepseek-chat",
    mode: parsed.mode || "code",
  };

  if (typeof resumeSessionId === "string") {
    try {
      const loaded = await sessionStore.loadEffective(resumeSessionId);
      sessionId = resumeSessionId;
      sessionMessages = loaded.messages;
      sessionLoaded = true;
    } catch {
      process.stderr.write(`Session not found: ${resumeSessionId}\n`);
      process.exit(1);
    }
  } else if (parsed.last) {
    const sessions = await sessionStore.list();
    if (sessions.length > 0) {
      sessionId = sessions[0].id;
      try {
        const loaded = await sessionStore.loadEffective(sessionId);
        sessionMessages = loaded.messages;
        sessionLoaded = true;
      } catch (err) {
        process.stderr.write(`Failed to load session ${sessionId}: ${(err as Error).message}\n`);
        process.exit(1);
      }
    } else {
      sessionId = await sessionStore.create(sessionCreateBase);
    }
  } else {
    sessionId = await sessionStore.create(sessionCreateBase);
  }

  if (parsed.debug) enableDebug(sessionId);

  let checkpoints = new CheckpointManager(sessionId);
  const diagnostics = new DiagnosticRunner();
  // Layered failure handling, constructed once per session so the reflector's
  // total-retry budget spans the whole conversation. Both engage only on error
  // paths inside runAgent (failed tool result / malformed tool JSON / fatal
  // turn exception), so the happy path pays nothing but a per-turn counter reset.
  const errorReflector = new ErrorReflector();
  const errorRecovery = new ErrorRecovery();
  setSessionId(sessionId);
  setCheckpointManager(checkpoints);

  const memoryStore = new MemoryStore();
  await memoryStore.init();
  const memoryInjection = await memoryStore.getInjection();

  // Repository map: computed once per session (symbol extraction + ranking is
  // ~150ms cold on this repo, negligible for startup) and injected into the
  // stable preamble as a byte-stable snapshot. buildRepoMap never throws — a
  // failure degrades to `undefined`, i.e. no map, never a startup crash.
  const repomapInjection = (await buildRepoMap(process.cwd())) ?? undefined;

  const shared = {
    conversationHistory: [] as Message[],
    sessionInput: 0,
    sessionOutput: 0,
    lastContextTokens: 0,
    sessionUserInputs: [] as string[],
    abort: new AbortController(),
    toolUsage: {} as Record<string, number>,
    modelUsage: {} as Record<string, { input: number; output: number; cached: number }>,
    posture: "normal" as "normal" | "autoApprove" | "plan",
    providerName,
    activeModel: initialModel as string | undefined,
    activeEffort: undefined as string | undefined,
    debug: parsed.debug as boolean | undefined,
  };
  shared.activeEffort = reasoningEffort || getActiveModelCaps()?.effort?.default;

  // A session resumed at startup (--resume/--last) must seed the live history so
  // the model actually sees the prior turns on the very first message. Without
  // this, runAgentTurnBridge gets `history: undefined` and the resume is
  // context-blind (the interactive /resume path does this via resumeSession()).
  if (sessionLoaded) {
    shared.conversationHistory = sessionMessages;
  }

  async function logSessionEnd() {
    try {
      const compactor = getCompactor();
      const { summary, files } = compactor.getLastCompaction();
      const decisions = extractDecisions(summary);
      if (shared.sessionUserInputs.length > 0 || files.length > 0 || summary) {
        await memoryStore.appendSession({
          date: new Date().toISOString().slice(0, 10),
          tasks: [...shared.sessionUserInputs],
          decisions, files, summary: summary ?? undefined,
        });
      }
    } catch {}
  }

  const skillLoader = new SkillLoader();
  let skills = await skillLoader.load({ headless: !!parsed.prompt, enabledSkills: configResult.config.enabledSkills });
  const { def: loadSkillDef, handler: loadSkillHandler } = createLoadSkillTool(skills);
  registry.register({ def: loadSkillDef, handler: loadSkillHandler, groups: ["read"], always: true });

  let activeMode: ModeConfig | undefined;
  if (parsed.mode) {
    const mode = await modeLoader.load(parsed.mode);
    if (mode) { activeMode = mode; await sessionStore.appendState(sessionId, { mode: parsed.mode }); }
  }

  // Shown inside the app's scrollback after mount — printing to stdout here
  // would get garbled by Ink's first render.
  const initialNotice = sessionLoaded
    ? `Resumed ${sessionId} · ${sessionMessages.length} messages · mode: ${activeMode?.slug || "code"}`
    : undefined;

  let knownModeSlugs: string[] = [];
  try { knownModeSlugs = (await modeLoader.listAll()).map(m => m.slug); } catch {}

  function buildStatusBar(): import("./ui/types.js").StatusSegment[] {
    const T = (id: string, text: string, props?: Partial<import("./ui/types.js").StatusSegment>): import("./ui/types.js").StatusSegment => ({ id, text, ...props });
    const dim = (id: string, text: string) => T(id, text, { dimColor: true });
    const segments: import("./ui/types.js").StatusSegment[] = [];
    let idCounter = 0;
    const nextId = () => `s${++idCounter}`;

    // Posture indicator (cycled by Shift+Tab), leading the bar.
    if (shared.posture === "autoApprove") {
      segments.push(T(nextId(), "⏵⏵ auto-approve (shift+tab)", { color: "yellow", bold: true }));
    } else if (shared.posture === "plan") {
      segments.push(T(nextId(), "⏸ plan mode (shift+tab)", { color: "cyan", bold: true }));
    } else {
      segments.push(dim(nextId(), "▶ normal (shift+tab)"));
    }

    const modelId = shared.activeModel ?? getPreset(shared.providerName)?.defaultModel ?? "unknown";
    segments.push(T(nextId(), `${getProviderLabel(shared.providerName)}/${modelId}`, { bold: true }));

    const ctxPercent = getContextPercent();
    if (ctxPercent !== null) {
      const filled = Math.round((Math.min(ctxPercent, 100) / 100) * 8);
      const bar = "█".repeat(filled) + "░".repeat(8 - filled);
      const ctxText = `${bar} ${Math.round(ctxPercent)}%`;
      const color = ctxPercent >= 95 ? "red" : ctxPercent >= 80 ? "yellow" : undefined;
      segments.push(T(nextId(), `ctx ${ctxText}`, color ? { color } : { dimColor: true }));
    }

    return segments;
  }

  function getContextPercent(): number | null {
    const preset = getPreset(shared.providerName);
    const caps = preset?.models[shared.activeModel ?? preset.defaultModel];
    if (!caps?.contextWindow) return null;
    const total = shared.lastContextTokens;
    if (total === 0) return null;
    return (total / caps.contextWindow) * 100;
  }

  function getCostStr(): string | null {
    const preset = getPreset(shared.providerName);
    const caps = preset?.models[shared.activeModel ?? preset.defaultModel];
    if (!caps?.pricing) return null;
    if (shared.sessionInput === 0 && shared.sessionOutput === 0) return null;
    return ((shared.sessionInput * caps.pricing.inputPerM + shared.sessionOutput * caps.pricing.outputPerM) / 1_000_000).toFixed(4);
  }

  const colorEnabled = !!process.stdout.isTTY && !process.env.NO_COLOR;

  const resolvedTheme = new ThemeContextValue(resolveTheme({ mode: configResult.config.theme?.mode ?? "dark", name: configResult.config.theme?.name, overrides: configResult.config.theme?.overrides }));

  let resolvedKeybindings: KeybindingMap | undefined;
  let resolvedKeybindingConfig: KeybindingSystemConfig | undefined;
  const rawKbConfig = configResult.config.keybindings;
  if (rawKbConfig && "overrides" in rawKbConfig) {
    const ext = rawKbConfig as any;
    const overrides: Record<string, any> = {};
    if (ext.overrides) {
      for (const [action, value] of Object.entries(ext.overrides)) {
        if (typeof value === "string") { const combo = parseKeyCombo(value); if (combo) overrides[action] = [combo]; }
        else if (Array.isArray(value)) { overrides[action] = value.map((v: string) => parseKeyCombo(v)).filter(Boolean); }
      }
    }
    resolvedKeybindingConfig = { overrides, disabled: ext.disabled };
  } else if (rawKbConfig && typeof rawKbConfig === "object") {
    resolvedKeybindingConfig = rawKbConfig as KeybindingSystemConfig;
  }
  resolvedKeybindings = resolveKeybindings(resolvedKeybindingConfig);

  const workflowConfig: WorkflowIntegrationConfig = {
    gitStatus: configResult.config.workflow?.gitStatus ?? true,
    gitPollInterval: configResult.config.workflow?.gitPollInterval ?? 30000,
    gitCommands: configResult.config.workflow?.gitCommands ?? true,
    detectBuildTools: configResult.config.workflow?.detectBuildTools ?? true,
  };

  // Config-driven status line providers (command/module). Built from settings;
  // App subscribes and starts/stops the async refresh loop.
  const statuslineConfig = configResult.config.statusline;
  const statusLineManager = statuslineConfig
    ? new StatusLineManager(statuslineConfig)
    : undefined;

  const restartRef: { current: (() => void) | null } = { current: null };

  function startApp(): void {
    let restarting = false;
    const appInitialPrompt = initialPrompt;
    initialPrompt = undefined;
    const showResumeChooserOnStart = resumeSessionId === true;
    resumeSessionId = undefined;

    const appCtx = {
      mutable: shared,
      getProvider,
      sessionId,
      activeMode,
      permissions,
      toolRegistry: registry,
      compactor: getCompactor(),
      diagnostics,
      skills,
      memoryInjection: memoryInjection ?? undefined,
      memoryStore,
      sessionStore,
      checkpoints,
      modeLoader,
      skillLoader,
      get providerName() { return shared.providerName; },
      get activeModel() { return shared.activeModel; },
      get activeEffort() { return shared.activeEffort; },
      effortValues: () => getActiveModelCaps()?.effort?.values ?? [],
      provideAbortController: () => shared.abort,
      renewAbortController: () => { shared.abort = new AbortController(); },
      processAtMentions,
      completer: (line: string) => completer(line, knownModeSlugs),
      buildStatusBar,
      statusLineManager,
      getPromptStr: () => (colorEnabled ? `\u001B[34m\u258C\u001B[0m \u001B[34m\u203A\u001B[0m ` : "heirloom > "),
      getColorEnabled: () => colorEnabled,
      logSessionEnd,
      onExit: () => logSessionEnd().then(() => process.exit(0)),
      handleSlash: async (input: string) => {
        const lines: string[] = [];
        const origLog = console.log;
        console.log = (...args) => lines.push(args.map(String).join(" "));
        try { await handleSlashCore(input, getProvider, configResult, modeLoader, permissions, sessionStore, sessionId, checkpoints, memoryStore, memoryInjection, getCompactor, diagnostics, skills, skillLoader, shared, activeMode, getActiveModelCaps, getCostStr, colorEnabled, reasoningEffort); } finally { console.log = origLog; }
        return lines;
      },
      getModelEntries: () => listKnownModels(),
      runAgentTurnCore: (input: string, cb: any, imageUrls?: string[], planMode?: boolean) => runAgentTurnBridge(input, cb, shared, permissions, getProvider, activeMode, getCompactor(), diagnostics, skills, memoryInjection, memoryStore, sessionStore, sessionId, modeLoader, skillLoader, imageUrls, planMode, checkpoints, configResult.config.notify, configResult.config.env, errorReflector, errorRecovery, repomapInjection),
      resumeSession: async (id: string) => {
        try {
          const loaded = await sessionStore.loadEffective(id);
          shared.conversationHistory = loaded.messages;
          sessionId = id;
          setSessionId(id);
          return loaded.messages;
        } catch {
          return null;
        }
      },
      restoreCheckpoint: async (hash: string, restoreCode: boolean) => {
        const ck = checkpoints;
        if (restoreCode) {
          const result = await ck.restoreFrom(hash);
          if (!result.restored) return { restored: false, promptDraft: "" };
        }
        const entries = ck.list();
        const found = entries.find((e) => e.hash === hash);
        if (found) {
          const convMatch = found.message.match(/\[convLen:(\d+)\]/);
          if (convMatch) {
            const len = parseInt(convMatch[1], 10);
            if (len >= 0 && len <= shared.conversationHistory.length) {
              shared.conversationHistory = shared.conversationHistory.slice(0, len);
            }
          }
        }
        const msgMatch = found?.message.match(/\]\s+(.+)/);
        return { restored: true, promptDraft: msgMatch ? msgMatch[1] : "" };
      },
      showResumeOnStart: showResumeChooserOnStart,
      initialNotice,
      initialMessages: sessionLoaded ? sessionMessages : undefined,
      compactResumed: async (): Promise<Message[] | null> => {
        // Explicit user request from the resume chooser — bypass the auto
        // threshold and compact whatever was loaded. Mirrors the persist path in
        // agent.ts: summarize old turns, write a non-destructive compaction
        // overlay (raw log stays on disk), and update the live history.
        const msgs = shared.conversationHistory;
        if (msgs.length === 0) return null;
        const compactor = getCompactor();
        const persistedCount = await sessionStore.getMessageCount(sessionId);
        // Drop the leading system prompt (if any) from the summarized span; it is
        // rebuilt per turn and shouldn't be baked into the summary.
        const withoutSystem = msgs[0]?.role === "system" ? msgs.slice(1) : msgs;
        const keepCount = Math.min(4, withoutSystem.length);
        const old = withoutSystem.slice(0, withoutSystem.length - keepCount);
        const recent = withoutSystem.slice(withoutSystem.length - keepCount);
        if (old.length === 0) return null;
        const summaryText = await compactor.summarizeForResume(old);
        const summaryMsg: Message = {
          role: "user",
          content: `[Previous conversation summary]\n${summaryText}`,
        };
        const compacted = [summaryMsg, ...recent];
        shared.conversationHistory = compacted;
        if (persistedCount > 0) {
          const summary: CompactionSummary = {
            task: summaryText,
            decisions: [],
            files: [],
            errors_resolved: [],
          };
          await sessionStore.appendCompaction(sessionId, persistedCount - 1, summary);
        }
        return compacted;
      },
      theme: resolvedTheme,
      keybindings: resolvedKeybindings,
      keybindingConfig: resolvedKeybindingConfig,
      tabState: undefined,
      workflowConfig,
    };

    const inkInstance = render(
      createElement(App, {
        ctx: appCtx,
        themeConfig: { mode: configResult.config.theme?.mode ?? "dark", name: configResult.config.theme?.name, overrides: configResult.config.theme?.overrides },
        keybindingConfig: resolvedKeybindingConfig,
      }),
      { exitOnCtrlC: false },
    );

    const exitPromise = inkInstance.waitUntilExit();
    restartRef.current = () => {
      restarting = true;
      process.stdout.write("\u001B[2J\u001B[3J\u001B[H");
      exitPromise.then(() => {
        if (!restarting) { restartRef.current = null; process.exit(0); }
      });
      startApp();
    };
  }

  const packageInfo = { name: pkg.name, version: pkg.version };

  if (!parsed.exec && !parsed.resume) {
    await promptForPendingUpdate(packageInfo);
  }

  startApp();

  checkForNpmUpdate(packageInfo).catch(() => {});
}

function detectProvider(configEnv: Record<string, string | undefined> | undefined): string | null {
  if (configEnv?.BASE_URL) {
    if (configEnv.BASE_URL.includes("deepseek")) return "deepseek";
    if (configEnv.BASE_URL.includes("openai")) return "openai";
    if (configEnv.BASE_URL.includes("openrouter")) return "openrouter";
    if (configEnv.BASE_URL.includes("groq")) return "groq";
  }
  const envProviders = [
    { name: "deepseek", key: "DEEPSEEK_API_KEY" },
    { name: "openai", key: "OPENAI_API_KEY" },
    { name: "openrouter", key: "OPENROUTER_API_KEY" },
    { name: "anthropic", key: "ANTHROPIC_API_KEY" },
    { name: "groq", key: "GROQ_API_KEY" },
    { name: "together", key: "TOGETHER_API_KEY" },
  ];
  for (const p of envProviders) { if (process.env[p.key]) return p.name; }
  return null;
}

const PROVIDER_LABELS: Record<string, string> = { deepseek: "DeepSeek", openai: "OpenAI", openrouter: "OpenRouter", groq: "Groq", ollama: "Ollama" };
function getProviderLabel(name: string): string { return PROVIDER_LABELS[name] ?? name; }

function listKnownModels(): ModelEntry[] {
  const entries: ModelEntry[] = [];
  for (const provName of getKnownProviderNames()) {
    const preset = getPreset(provName);
    const seen = new Set<string>();
    if (preset) { for (const [modelName, caps] of Object.entries(preset.models)) { entries.push({ provider: provName, model: modelName, contextWindow: caps.contextWindow }); seen.add(modelName); } }
    const models = getProviderModels(provName);
    if (models) { for (const [modelName, info] of Object.entries(models)) { if (seen.has(modelName)) continue; entries.push({ provider: provName, model: modelName, contextWindow: info.contextWindow }); } }
  }
  return entries;
}

function completer(line: string, knownModeSlugs: string[]): [string[], string] {
  const modelArgMatch = line.match(/^\/model\s+(\S*)$/);
  if (modelArgMatch) {
    const partial = modelArgMatch[1];
    const all = listKnownModels().map(e => `${e.provider}/${e.model}`);
    const hits = all.filter(m => m.startsWith(partial));
    return [hits, line.slice(0, line.length - partial.length)];
  }
  const modeArgMatch = line.match(/^\/mode\s+(\S*)$/);
  if (modeArgMatch) {
    const partial = modeArgMatch[1];
    const hits = knownModeSlugs.filter(s => s.startsWith(partial));
    return [hits, line.slice(0, line.length - partial.length)];
  }
  const SLASH_COMMANDS = ["/help", "/exit", "/clear", "/mode", "/compact", "/checkpoint", "/restore", "/checkpoints", "/sessions", "/new", "/skills", "/skill", "/modes", "/model", "/effort"];
  if (line.startsWith("/")) {
    const hits = SLASH_COMMANDS.filter(c => c.startsWith(line));
    if (hits.length === 1) return [hits.map(h => h + " "), line];
    return [hits, line];
  }
  const atMatch = line.match(/@(\S*)$/);
  if (atMatch) {
    const partial = atMatch[1];
    const dir = partial.includes("/") ? dirname(partial) : ".";
    const prefix = partial.includes("/") ? partial.split("/").pop()! : partial;
    try {
      const base = resolve(process.cwd(), dir);
      const entries = readdirSync(base, { withFileTypes: true });
      const hits = entries.filter(e => !e.name.startsWith(".") && e.name.startsWith(prefix)).map(e => {
        const relPath = dir === "." ? e.name : `${dir}/${e.name}`;
        return `@${relPath}${e.isDirectory() ? "/" : ""}`;
      });
      return [hits, line.slice(0, line.lastIndexOf("@")) + "@" + (dir === "." ? "" : dir + "/")];
    } catch { return [[], line]; }
  }
  return [[], line];
}

async function processAtMentions(input: string): Promise<string> {
  const atRegex = /@([^\s]+)/g;
  let result = input;
  let match;
  while ((match = atRegex.exec(input)) !== null) {
    const filePath = match[1];
    if (filePath.endsWith("/") || (!filePath.includes(".") && !filePath.includes("/"))) continue;
    const fullPath = resolve(process.cwd(), filePath);
    try {
      const content = readFileSync(fullPath, "utf-8");
      const truncated = content.length > 4000 ? content.slice(0, 4000) + `\n... (truncated at 4000 chars)` : content;
      result = result.replace(match[0], `\n--- ${filePath} ---\n${truncated}\n--- end ${filePath} ---\n`);
    } catch {}
  }
  return result;
}

function extractDecisions(summary: string | null): string[] {
  if (!summary) return [];
  return summary.split(/(?<=[.!?])\s+/).filter(s => /\b(decided|decision|chose|opted|selected|agreed|resolved|concluded|determined)\b/i.test(s)).map(s => s.trim());
}

// Dispatch for `heirloom auth ...`. Returns the process exit code.
//   auth                          → interactive wizard (masked key prompt)
//   auth list                     → list configured providers
//   auth logout <provider>        → remove a credential
//   auth <provider> --api-key <k> → non-interactive save (alias -k), no prompt
//   auth <provider>               → save key for <provider>: masked prompt on a
//                                   TTY, or one line read verbatim from a pipe
//                                   (e.g. `echo KEY | heirloom auth <provider>`)
async function runAuth(args: string[]): Promise<number> {
  const sub = args[0];

  if (sub === "list") { await authList(); return 0; }
  if (sub === "logout") {
    if (args[1]) { await authLogout(args[1]); return 0; }
    console.log("Usage: heirloom auth logout <provider>");
    return 0;
  }
  if (sub === undefined) { await authWizard(); return 0; }

  // A provider name was given: `auth <provider> [--api-key <key>]`.
  const provider = sub;
  let apiKey: string | undefined;
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === "--api-key" || a === "-k") {
      apiKey = args[++i];
    } else if (a.startsWith("--api-key=")) {
      apiKey = a.slice("--api-key=".length);
    } else {
      console.error(`Unknown argument: ${a}`);
      console.error("Usage: heirloom auth <provider> [--api-key <key>]");
      return 1;
    }
  }

  if (apiKey !== undefined) {
    const trimmed = apiKey.trim();
    if (!trimmed) { console.error("API key cannot be empty."); return 1; }
    await authSaveKey(provider, trimmed);
    return 0;
  }

  // No flag: read the key from the masked TTY prompt, or verbatim from a pipe.
  const key = await readHiddenLine(`Paste your API key for ${provider}: `);
  if (key === null) { console.log("Cancelled. No credentials saved."); return 0; }
  const trimmed = key.trim();
  if (!trimmed) { console.error("API key cannot be empty."); return 1; }
  await authSaveKey(provider, trimmed);
  return 0;
}

async function runDoctor(): Promise<void> {
  console.log("heirloom doctor\n");
  try { const { execSync } = await import("node:child_process"); console.log(`  git               ${execSync("git --version", { encoding: "utf-8" }).trim()}`); }
  catch { console.log(`  git               NOT FOUND`); }
  try { const configResult = loadConfig(); console.log(`  settings.json     model: ${configResult.config.model || configResult.config.env?.MODEL || "(not set)"}`); }
  catch (e) { console.log(`  settings.json     ERROR: ${(e as Error).message}`); }
  const keySource = process.env.DEEPSEEK_API_KEY ? "DEEPSEEK_API_KEY env var" : process.env.OPENAI_API_KEY ? "OPENAI_API_KEY env var" : (() => { const names = Object.entries(readCredentialsFile()).filter(([, v]) => v).map(([k]) => k); return names.length ? `credentials.yaml (${names.join(", ")})` : "none"; })();
  console.log(`  API key           ${keySource}`);
  const configResult = loadConfig();
  const issues = [...configResult.errors, ...configResult.warnings];
  console.log(`  config            ${issues.length === 0 ? "valid" : `${issues.length} issue(s):\n${issues.map(i => `                    - ${i}`).join("\n")}`}`);
  console.log(`  node              ${process.version}`);
}

async function handleSlashCore(
  input: string, getProvider: any,
  configResult: any, modeLoader: ModeLoader, permissions: PermissionEngine, sessionStore: SessionStore,
  sessionId: string, checkpoints: CheckpointManager, memoryStore: MemoryStore, memoryInjection: string | null | undefined,
  getCompactor: () => Compactor, diagnostics: DiagnosticRunner, skills: SkillDef[], skillLoader: SkillLoader,
  shared: any, activeMode: ModeConfig | undefined, getActiveModelCaps: () => ModelCapabilities | undefined,
  getCostStr: () => string | null, colorEnabled: boolean, reasoningEffort: string | undefined,
): Promise<void> {
  const cmd = input.trim().split(/\s+/)[0];
  switch (cmd) {
    case "/help": {
      console.log("Commands: /exit, /help, /mode <name>, /clear, /modes, /sessions, /new, /skills, /skill <name>, /model <p/m>, /cost, /effort\nUse `heirloom auth` to configure a provider.");
      return;
    }
    case "/cost": {
      console.log(`Session: ${(shared.sessionInput / 1000).toFixed(1)}k in / ${(shared.sessionOutput / 1000).toFixed(1)}k out`);
      const cost = getCostStr(); console.log(`Estimated cost: $${cost ?? "0.0000"}`);
      return;
    }
    case "/skills": {
      if (skills.length === 0) console.log("No skills available.");
      else for (const s of skills) console.log(`  ${s.name} — ${s.description || "no description"}`);
      return;
    }
    case "/skill": {
      const name = input.slice(7).trim();
      const skill = skills.find((s: SkillDef) => s.name === name);
      if (skill) console.log(skill.content); else console.log(`Unknown skill: ${name}`);
      return;
    }
    case "/clear": shared.conversationHistory = []; console.log("[cleared]"); return;
    case "/modes": for (const m of await modeLoader.listAll()) console.log(`  ${m.slug} — ${m.description || m.roleDefinition.slice(0, 60)}`); return;
    case "/mode": {
      const slug = input.slice(6).trim();
      const mode = await modeLoader.load(slug);
      if (mode) { activeMode = mode; await sessionStore.appendState(sessionId, { mode: slug }); console.log(`Switched to ${mode.name} mode.`); }
      else console.log(`Unknown mode: ${slug}.`);
      return;
    }
    case "/model": {
      const modelArg = input.slice(7).trim();
      if (!modelArg) {
        const currentModel = shared.activeModel ?? getPreset(shared.providerName)?.defaultModel ?? "unknown";
        console.log(`Current: ${shared.providerName}/${currentModel}`);
        for (const entry of listKnownModels()) {
          console.log(`  ${entry.provider}/${entry.model}`);
        }
        return;
      }
      const slashIdx = modelArg.indexOf("/");
      if (slashIdx < 0) { console.log("Use /model <provider/model>"); return; }
      shared.providerName = modelArg.slice(0, slashIdx);
      shared.activeModel = modelArg.slice(slashIdx + 1);
      console.log(`Model changed to ${shared.providerName}/${shared.activeModel}`);
      return;
    }
    case "/effort": {
      const arg = input.slice(7).trim();
      const caps = getActiveModelCaps();
      if (!caps?.effort) { console.log("Current model does not support reasoning effort."); return; }
      if (!arg) { console.log(`Effort: ${shared.activeEffort ?? caps.effort.default}\nValid: ${caps.effort.values.join(", ")}`); return; }
      if (!caps.effort.values.includes(arg)) { console.log(`Invalid effort. Valid: ${caps.effort.values.join(", ")}`); return; }
      shared.activeEffort = arg;
      console.log(`Effort set to ${arg}.`);
      return;
    }
    default: console.log(`Unknown: ${cmd}\nType /help.`); return;
  }
}

async function runAgentTurnBridge(input: string, cb: any, shared: any, permissions: PermissionEngine, getProvider: any, activeMode: any, compactor: Compactor, diagnostics: DiagnosticRunner, skills: SkillDef[], memoryInjection: string | null | undefined, memoryStore: MemoryStore, sessionStore: SessionStore, sessionId: string, modeLoader: ModeLoader, skillLoader: SkillLoader, imageUrls?: string[], planMode?: boolean, checkpoints?: CheckpointManager, notifyScript?: string, notifyEnv?: Record<string, string | undefined>, errorReflector?: ErrorReflector, errorRecovery?: ErrorRecovery, repomapInjection?: string): Promise<any> {
  if (checkpoints) {
    const convLen = shared.conversationHistory.length;
    await checkpoints.save(`[convLen:${convLen}] ${input.slice(0, 80)}`);
  }
  shared.sessionUserInputs.push(input);
  const processed = await processAtMentions(input);
  const tools = activeMode?.groups ? registry.getByMode(activeMode.groups) : registry.getAllDefs();

  // Research notes are plan-mode-only context: load them lazily when in plan
  // mode so the per-turn file walk costs nothing in normal conversation.
  const researchInjection = planMode ? (loadProjectResearch(process.cwd()) ?? undefined) : undefined;

  // Notify hook: fires from this interactive completion boundary once the
  // turn's outcome is known (mirrors the headless site in exec-runner.ts).
  // TITLE is the session's first user prompt prefix. Fire-and-forget — see
  // src/notify.ts. No-op when `notify` is unconfigured.
  const notifyStart = Date.now();
  const notifyTitle = String(shared.sessionUserInputs[0] ?? input).slice(0, 120);

  let result;
  try {
    result = await runAgent(processed, {
    provider: getProvider(),
    tools, executeTool, permissions, mode: activeMode, compactor, diagnostics, skills,
    errorReflector, errorRecovery,
    repomap: repomapInjection,
    research: researchInjection,
    memory: memoryInjection ?? undefined, memoryStore, sessionStore, sessionId,
    signal: shared.abort.signal, effort: shared.activeEffort,
    history: shared.conversationHistory.length > 0 ? shared.conversationHistory : undefined,
    imageUrls,
    planMode,
    onText: cb.onText, onReasoning: cb.onReasoning, onToolStart: (name, args) => { shared.toolUsage[name] = (shared.toolUsage[name] || 0) + 1; cb.onToolStart(name, args); }, onToolResult: cb.onToolResult,
    onDiagnostic: cb.onDiagnostic, onRetry: cb.onRetry, onCompacted: cb.onCompacted,
    onLoopDetected: cb.onLoopDetected, onMaxTurns: cb.onMaxTurns,
    onUsage: (input: number, output: number, cached?: number) => {
      shared.sessionInput += input; shared.sessionOutput += output; shared.lastContextTokens = input + output;
      const modelKey = `${shared.providerName}/${shared.activeModel ?? getPreset(shared.providerName)?.defaultModel ?? "unknown"}`;
      const existing = shared.modelUsage[modelKey] || { input: 0, output: 0, cached: 0 };
      shared.modelUsage[modelKey] = { input: existing.input + input, output: existing.output + output, cached: existing.cached + (cached ?? 0) };
      sessionStore.appendState(sessionId, { inputTokens: input, outputTokens: output, cumulativeInput: shared.sessionInput, cumulativeOutput: shared.sessionOutput });
      cb.onUsage(input, output);
    },
    askUser: cb.askUser,
    });
  } catch (err) {
    fireNotify(
      notifyScript,
      {
        status: "failed",
        durationMs: Date.now() - notifyStart,
        body: "",
        title: notifyTitle,
        failReason: err instanceof Error ? err.message : String(err),
        passthroughEnv: notifyEnv,
      },
      { debug: shared.debug },
    );
    throw err;
  }

  const lastReply = result.messages[result.messages.length - 1]?.content ?? "";
  fireNotify(
    notifyScript,
    {
      status: "completed",
      durationMs: Date.now() - notifyStart,
      body: lastReply,
      title: notifyTitle,
      passthroughEnv: notifyEnv,
    },
    { debug: shared.debug },
  );
  return result;
}
