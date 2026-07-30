import { render } from "ink";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { parseArguments } from "./cli-args.js";
import { runExecMode } from "./exec-runner.js";
import { initPresets, createProvider, setConfigProviders, getPreset, getKnownProviderNames, getProviderModels, type ProviderOptions } from "./providers/presets.js";
import { getProviderCapabilities } from "./providers/registry.js";
import { runAgent } from "./agent.js";
import { executeTool, TOOL_DEFS, registry, setSessionId, setCheckpointManager, setSignal } from "./tools/index.js";
import { PermissionEngine } from "./permissions/index.js";
import { previewEdit } from "./permissions/diffpreview.js";
import { ModeLoader, type ModeConfig } from "./modes/loader.js";
import { Compactor } from "./compaction/compactor.js";
import { CheckpointManager } from "./checkpoints/index.js";
import { DiagnosticRunner } from "./diagnostics/index.js";
import { authWizard, authList, authLogout } from "./auth/wizard.js";
import { SessionStore } from "./sessions/store.js";
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

const __dirname = dirname(fileURLToPath(import.meta.url));

void main();

async function main() {
  initPresets();

  const rawArgs = process.argv.slice(2);
  if (rawArgs.length > 0 && rawArgs[0] === "doctor") {
    await runDoctor();
    process.exit(0);
  }

  if (process.argv[2] === "auth") {
    const sub = process.argv[3];
    if (sub === "list") { await authList(); }
    else if (sub === "logout" && process.argv[4]) { await authLogout(process.argv[4]); }
    else if (sub === "logout") { console.log("Usage: heirloom auth logout <provider>"); }
    else { await authWizard(); }
    process.exit(0);
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
    await connectMCPServers(configResult.config.mcpServers);
  }

  let initialPrompt = parsed.prompt;
  let resumeSessionId: string | true | undefined = parsed.resume;

  if (parsed.exec) {
    process.exitCode = await runExecMode({
      prompt: parsed.prompt!,
      projectRoot: process.cwd(),
      resumeSessionId: typeof parsed.resume === "string" ? parsed.resume : undefined,
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

  let activeModel: string | undefined = parsed.model ?? configResult.config.model ?? configEnv?.MODEL ?? undefined;
  const thinkingEnabled = configResult.config.thinkingEnabled ?? true;
  const reasoningEffort = configResult.config.reasoningEffort;

  function getActiveModelCaps(): ModelCapabilities | undefined {
    const preset = getPreset(providerName);
    if (!preset) return undefined;
    return preset.models[activeModel ?? preset.defaultModel];
  }

  let activeEffort: string | undefined = reasoningEffort || getActiveModelCaps()?.effort?.default;

  function getProvider() {
    return createProvider(providerName, { modelOverride: activeModel, baseUrl: resolvedBaseUrl, apiKey: resolvedApiKey });
  }

  const modeLoader = new ModeLoader();
  const permissions = new PermissionEngine(configResult.config.permissions, process.cwd());
  const contextWindow = configResult.config.contextWindow ?? 128000;

  let _compactor: Compactor | undefined;
  function getCompactor(): Compactor {
    if (!_compactor) _compactor = new Compactor(getProvider(), contextWindow, configResult.config.compaction?.threshold);
    return _compactor;
  }

  const sessionStore = new SessionStore();
  let sessionId: string;
  let sessionMessages: Message[] = [];
  let sessionLoaded = false;

  const sessionCreateBase = {
    cwd: process.cwd(),
    provider: providerName,
    model: activeModel || getPreset(providerName)?.defaultModel || "deepseek-chat",
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
  setSessionId(sessionId);
  setCheckpointManager(checkpoints);

  const memoryStore = new MemoryStore();
  await memoryStore.init();
  const memoryInjection = await memoryStore.getInjection();

  const shared = {
    conversationHistory: [] as Message[],
    sessionInput: 0,
    sessionOutput: 0,
    lastContextTokens: 0,
    sessionUserInputs: [] as string[],
    abort: new AbortController(),
    toolUsage: {} as Record<string, number>,
  };

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
  let skills = await skillLoader.load({ headless: !!parsed.prompt });
  const { def: loadSkillDef, handler: loadSkillHandler } = createLoadSkillTool(skills);
  registry.register({ def: loadSkillDef, handler: loadSkillHandler, groups: ["read"], always: true });

  let activeMode: ModeConfig | undefined;
  if (parsed.mode) {
    const mode = await modeLoader.load(parsed.mode);
    if (mode) { activeMode = mode; await sessionStore.appendState(sessionId, { mode: parsed.mode }); }
  }

  if (sessionLoaded) {
    console.log(`Resumed ${sessionId} · ${sessionMessages.length} messages · mode: ${activeMode?.slug || "code"}`);
  }

  let knownModeSlugs: string[] = [];
  try { knownModeSlugs = (await modeLoader.listAll()).map(m => m.slug); } catch {}

  function buildStatusBar(): import("./ui/types.js").StatusSegment[] {
    const T = (id: string, text: string, props?: Partial<import("./ui/types.js").StatusSegment>): import("./ui/types.js").StatusSegment => ({ id, text, ...props });
    const dim = (id: string, text: string) => T(id, text, { dimColor: true });
    const segments: import("./ui/types.js").StatusSegment[] = [];
    let idCounter = 0;
    const nextId = () => `s${++idCounter}`;

    segments.push(dim(nextId(), activeMode?.name ?? "chat"));

    if (permissions.getDefaultMode() === "askAll") {
      segments.push(T(nextId(), "🔒askAll", { color: "yellow", bold: true }));
    }

    const modelId = activeModel ?? getPreset(providerName)?.defaultModel ?? "unknown";
    segments.push(T(nextId(), `${getProviderLabel(providerName)}/${modelId}`, { bold: true }));

    let cwd = process.cwd();
    const home = process.env.HOME || process.env.USERPROFILE || "";
    if (home && cwd.startsWith(home)) cwd = "~" + cwd.slice(home.length);
    if (cwd.length > 30) { const parts = cwd.split("/"); cwd = "…/" + parts.slice(-2).join("/"); }
    segments.push(dim(nextId(), cwd));

    const ctxPercent = getContextPercent();
    if (ctxPercent !== null) {
      const filled = Math.round((Math.min(ctxPercent, 100) / 100) * 8);
      const bar = "█".repeat(filled) + "░".repeat(8 - filled);
      const ctxText = `${bar} ${Math.round(ctxPercent)}%`;
      const color = ctxPercent >= 95 ? "red" : ctxPercent >= 80 ? "yellow" : undefined;
      segments.push(T(nextId(), `ctx ${ctxText}`, color ? { color } : { dimColor: true }));
    }

    const costStr = getCostStr();
    if (costStr) segments.push(dim(nextId(), `$${costStr}`));
    if (activeEffort) segments.push(T(nextId(), activeEffort, { bold: true }));

    const toolNames = Object.keys(shared.toolUsage);
    if (toolNames.length > 0) {
      const top = toolNames.sort((a, b) => (shared.toolUsage[b] ?? 0) - (shared.toolUsage[a] ?? 0)).slice(0, 4);
      segments.push(dim(nextId(), top.map(t => `${t}×${shared.toolUsage[t]}`).join(" ")));
    }

    return segments;
  }

  function getContextPercent(): number | null {
    const preset = getPreset(providerName);
    const caps = preset?.models[activeModel ?? preset.defaultModel];
    if (!caps?.contextWindow) return null;
    const total = shared.lastContextTokens;
    if (total === 0) return null;
    return (total / caps.contextWindow) * 100;
  }

  function getCostStr(): string | null {
    const preset = getPreset(providerName);
    const caps = preset?.models[activeModel ?? preset.defaultModel];
    if (!caps?.pricing) return null;
    if (shared.sessionInput === 0 && shared.sessionOutput === 0) return null;
    return ((shared.sessionInput * caps.pricing.inputPerM + shared.sessionOutput * caps.pricing.outputPerM) / 1_000_000).toFixed(4);
  }

  const colorEnabled = !!process.stdout.isTTY && !process.env.NO_COLOR;

  const resolvedTheme = new ThemeContextValue(resolveTheme({ mode: configResult.config.theme?.mode ?? "dark", overrides: configResult.config.theme?.overrides }));

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

  const restartRef: { current: (() => void) | null } = { current: null };

  function startApp(): void {
    let restarting = false;
    const appInitialPrompt = initialPrompt;
    initialPrompt = undefined;
    const appResumeSessionId = typeof resumeSessionId === "string" ? resumeSessionId : undefined;
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
      providerName,
      activeModel,
      provideAbortController: () => shared.abort,
      renewAbortController: () => { shared.abort = new AbortController(); },
      processAtMentions,
      completer: (line: string) => completer(line, knownModeSlugs),
      buildStatusBar,
      getPromptStr: () => (colorEnabled ? `\u001B[34m\u258C\u001B[0m \u001B[34m\u203A\u001B[0m ` : "heirloom > "),
      getColorEnabled: () => colorEnabled,
      logSessionEnd,
      onExit: () => logSessionEnd().then(() => process.exit(0)),
      handleSlash: async (input: string) => {
        const lines: string[] = [];
        const origLog = console.log;
        console.log = (...args) => lines.push(args.map(String).join(" "));
        try { await handleSlashCore(input, getProvider, providerName, activeModel, configResult, modeLoader, permissions, sessionStore, sessionId, checkpoints, memoryStore, memoryInjection, getCompactor, diagnostics, skills, skillLoader, shared, activeMode, getActiveModelCaps, getCostStr, colorEnabled, reasoningEffort, activeEffort); } finally { console.log = origLog; }
        return lines;
      },
      getModelEntries: () => listKnownModels(),
      runAgentTurnCore: (input: string, cb: any, imageUrls?: string[], planMode?: boolean) => runAgentTurnBridge(input, cb, shared, permissions, getProvider, activeMode, getCompactor(), diagnostics, skills, memoryInjection, memoryStore, sessionStore, sessionId, modeLoader, skillLoader, providerName, activeModel, activeEffort, imageUrls, planMode),
      resumeSession: async (id: string) => {
        try {
          const loaded = await sessionStore.loadEffective(id);
          shared.conversationHistory = loaded.messages;
          sessionId = id;
          setSessionId(id);
          return true;
        } catch {
          return false;
        }
      },
      showResumeOnStart: resumeSessionId === true,
      theme: resolvedTheme,
      keybindings: resolvedKeybindings,
      keybindingConfig: resolvedKeybindingConfig,
      tabState: undefined,
      workflowConfig,
    };

    const inkInstance = render(
      createElement(App, {
        ctx: appCtx,
        themeConfig: { mode: configResult.config.theme?.mode ?? "dark", overrides: configResult.config.theme?.overrides },
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

  startApp();
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

async function runDoctor(): Promise<void> {
  console.log("heirloom doctor\n");
  try { const { execSync } = await import("node:child_process"); console.log(`  git               ${execSync("git --version", { encoding: "utf-8" }).trim()}`); }
  catch { console.log(`  git               NOT FOUND`); }
  try { const configResult = loadConfig(); console.log(`  settings.json     model: ${configResult.config.model || configResult.config.env?.MODEL || "(not set)"}`); }
  catch (e) { console.log(`  settings.json     ERROR: ${(e as Error).message}`); }
  const keySource = process.env.DEEPSEEK_API_KEY ? "DEEPSEEK_API_KEY env var" : process.env.OPENAI_API_KEY ? "OPENAI_API_KEY env var" : (() => { const names = Object.entries(readCredentialsFile()).filter(([, v]) => v).map(([k]) => k); return names.length ? `credentials.json (${names.join(", ")})` : "none"; })();
  console.log(`  API key           ${keySource}`);
  const configResult = loadConfig();
  const issues = [...configResult.errors, ...configResult.warnings];
  console.log(`  config            ${issues.length === 0 ? "valid" : `${issues.length} issue(s):\n${issues.map(i => `                    - ${i}`).join("\n")}`}`);
  console.log(`  node              ${process.version}`);
}

async function handleSlashCore(
  input: string, getProvider: any, providerName: string, activeModel: string | undefined,
  configResult: any, modeLoader: ModeLoader, permissions: PermissionEngine, sessionStore: SessionStore,
  sessionId: string, checkpoints: CheckpointManager, memoryStore: MemoryStore, memoryInjection: string | null | undefined,
  getCompactor: () => Compactor, diagnostics: DiagnosticRunner, skills: SkillDef[], skillLoader: SkillLoader,
  shared: any, activeMode: ModeConfig | undefined, getActiveModelCaps: () => ModelCapabilities | undefined,
  getCostStr: () => string | null, colorEnabled: boolean, reasoningEffort: string | undefined,
  activeEffort: string | undefined,
): Promise<void> {
  const cmd = input.trim().split(/\s+/)[0];
  switch (cmd) {
    case "/help": {
      console.log("Commands: /exit, /help, /mode <name>, /clear, /modes, /sessions, /new, /checkpoint, /restore, /checkpoints, /skills, /skill <name>, /compact, /model <p/m>, /cost, /effort\nUse `heirloom auth` to configure a provider.");
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
        const currentModel = activeModel ?? getPreset(providerName)?.defaultModel ?? "unknown";
        console.log(`Current: ${providerName}/${currentModel}`);
        for (const entry of listKnownModels()) {
          console.log(`  ${entry.provider}/${entry.model}`);
        }
        return;
      }
      const slashIdx = modelArg.indexOf("/");
      if (slashIdx < 0) { console.log("Use /model <provider/model>"); return; }
      providerName = modelArg.slice(0, slashIdx);
      activeModel = modelArg.slice(slashIdx + 1);
      console.log(`Model changed to ${providerName}/${activeModel}`);
      return;
    }
    case "/effort": {
      const arg = input.slice(7).trim();
      const caps = getActiveModelCaps();
      if (!caps?.effort) { console.log("Current model does not support reasoning effort."); return; }
      if (!arg) { console.log(`Effort: ${activeEffort ?? caps.effort.default}\nValid: ${caps.effort.values.join(", ")}`); return; }
      if (!caps.effort.values.includes(arg)) { console.log(`Invalid effort. Valid: ${caps.effort.values.join(", ")}`); return; }
      console.log(`Effort set to ${arg}.`);
      return;
    }
    default: console.log(`Unknown: ${cmd}\nType /help.`); return;
  }
}

async function runAgentTurnBridge(input: string, cb: any, shared: any, permissions: PermissionEngine, getProvider: any, activeMode: any, compactor: Compactor, diagnostics: DiagnosticRunner, skills: SkillDef[], memoryInjection: string | null | undefined, memoryStore: MemoryStore, sessionStore: SessionStore, sessionId: string, modeLoader: ModeLoader, skillLoader: SkillLoader, providerName: string, activeModel: string | undefined, activeEffort: string | undefined, imageUrls?: string[], planMode?: boolean): Promise<any> {
  shared.sessionUserInputs.push(input);
  const processed = await processAtMentions(input);
  const tools = activeMode?.groups ? registry.getByMode(activeMode.groups) : registry.getAllDefs();

  const result = await runAgent(processed, {
    provider: getProvider(),
    tools, executeTool, permissions, mode: activeMode, compactor, diagnostics, skills,
    memory: memoryInjection ?? undefined, memoryStore, sessionStore, sessionId,
    signal: shared.abort.signal, effort: activeEffort,
    history: shared.conversationHistory.length > 0 ? shared.conversationHistory : undefined,
    imageUrls,
    planMode,
    onText: cb.onText, onReasoning: cb.onReasoning, onToolStart: (name, args) => { shared.toolUsage[name] = (shared.toolUsage[name] || 0) + 1; cb.onToolStart(name, args); }, onToolResult: cb.onToolResult,
    onDiagnostic: cb.onDiagnostic, onRetry: cb.onRetry, onCompacted: cb.onCompacted,
    onLoopDetected: cb.onLoopDetected, onMaxTurns: cb.onMaxTurns,
    onUsage: (input: number, output: number) => {
      shared.sessionInput += input; shared.sessionOutput += output; shared.lastContextTokens = input + output;
      sessionStore.appendState(sessionId, { inputTokens: input, outputTokens: output, cumulativeInput: shared.sessionInput, cumulativeOutput: shared.sessionOutput });
      cb.onUsage(input, output);
    },
    askUser: cb.askUser,
  });
  return result;
}
