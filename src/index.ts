import { createInterface } from "node:readline/promises";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { initPresets, createProvider, setConfigProviders, getPreset, getKnownProviderNames, getProviderModels, type ProviderOptions } from "./providers/presets.js";
import { getProviderCapabilities } from "./providers/registry.js";
import { runAgent } from "./agent.js";
import { executeTool, TOOL_DEFS, registry, setSessionId, setCheckpointManager, setSignal } from "./tools/index.js";
import { PermissionEngine, type PermissionScope } from "./permissions/index.js";
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
import { createElement } from "react";
import type { ModelEntry } from "./ui/ModelSelector.js";
import { render } from "ink";
import App from "./ui/App.js";
import type { Message } from "./types.js";
import type { ModelCapabilities } from "./providers/types.js";
import { resolveTheme, ThemeContextValue, type ThemeDefinition } from "./ui/theme.js";
import {
  resolveKeybindings,
  parseKeyCombo,
  type KeybindingMap,
  type KeybindingConfig as KeybindingSystemConfig,
} from "./ui/keybindings.js";
import type { WorkflowIntegrationConfig } from "./ui/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let knownModeSlugs: string[] = [];

interface CliArgs {
  prompt?: string;
  continue_: boolean;
  sessionId?: string;
  mode?: string;
  model?: string;
  debug?: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);

  if (args.includes("--help")) {
    console.log(
      "heirloom — AI coding assistant\n" +
      "\n" +
      "Usage:\n" +
      "  heirloom                  Interactive session\n" +
      "  heirloom -p \"<prompt>\"   Headless: run one task, print, exit\n" +
      "  heirloom auth             Interactive provider setup wizard\n" +
      "  heirloom auth list        Show configured providers\n" +
      "  heirloom auth logout <n>  Remove a credential\n" +
      "\n" +
      "Flags:\n" +
      "  -c, --continue         Resume the most recent session for this cwd\n" +
      "  --session <id>         Resume a specific session\n" +
      "  --mode <slug>          Start in the given mode\n" +
      "  --model <provider/model> Override config/mode model\n" +
      "  -p, --print <prompt>   Headless mode: run one task and exit\n" +
      "  --debug                Write redacted request/response JSONL\n" +
      "  --help                 Show this help\n" +
      "  --version              Show version\n"
    );
    process.exit(0);
  }

  if (args.includes("--version")) {
    try {
      const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));
      console.log(pkg.version);
    } catch {
      console.log("unknown");
    }
    process.exit(0);
  }

  const result: CliArgs = { continue_: false };

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "-p" || args[i] === "--print") && i + 1 < args.length) {
      result.prompt = args[++i];
    } else if (args[i] === "--mode" && i + 1 < args.length) {
      result.mode = args[++i];
    } else if (args[i] === "--model" && i + 1 < args.length) {
      result.model = args[++i];
    } else if (args[i] === "--continue" || args[i] === "-c") {
      result.continue_ = true;
    } else if (args[i] === "--session" && i + 1 < args.length) {
      result.sessionId = args[++i];
    } else if (args[i] === "--debug") {
      result.debug = true;
    }
  }
  return result;
}

function extractDecisions(summary: string | null): string[] {
  if (!summary) return [];
  const decisions: string[] = [];
  const sentences = summary.split(/(?<=[.!?])\s+/);
  for (const s of sentences) {
    if (/\b(decided|decision|chose|opted|selected|agreed|resolved|concluded|determined)\b/i.test(s)) {
      decisions.push(s.trim());
    }
  }
  return decisions;
}

async function runDoctor(): Promise<void> {
  console.log("heirloom doctor\n");

  try {
    const { execSync } = await import("node:child_process");
    const gitVersion = execSync("git --version", { encoding: "utf-8" }).trim();
    console.log(`  git               ${gitVersion}`);
  } catch {
    console.log(`  git               NOT FOUND (some features will be unavailable)`);
  }

  try {
    const configResult = loadConfig();
    const modelName = configResult.config.model || configResult.config.env?.MODEL || "(not set)";
    console.log(`  settings.json     model: ${modelName}`);
  } catch (e) {
    console.log(`  settings.json     ERROR: ${(e as Error).message}`);
  }

  const keySource = process.env.DEEPSEEK_API_KEY ? "DEEPSEEK_API_KEY env var"
    : process.env.OPENAI_API_KEY ? "OPENAI_API_KEY env var"
    : process.env.OPENROUTER_API_KEY ? "OPENROUTER_API_KEY env var"
    : process.env.ANTHROPIC_API_KEY ? "ANTHROPIC_API_KEY env var"
    : (() => {
        const names = Object.entries(readCredentialsFile()).filter(([, v]) => v).map(([k]) => k);
        if (names.length) return `credentials.json (${names.length} key(s): ${names.join(", ")})`;
        return "none";
      })();
  console.log(`  API key           ${keySource}`);

  try {
    const configResult = loadConfig();
    const issues = [...configResult.errors, ...configResult.warnings];
    if (issues.length === 0) {
      console.log(`  config            valid`);
    } else {
      console.log(`  config            ${issues.length} issue(s):`);
      for (const issue of issues) console.log(`                    - ${issue}`);
    }
  } catch (e) {
    console.log(`  config            ERROR: ${(e as Error).message}`);
  }

  console.log(`  node              ${process.version}`);
}

const SLASH_COMMANDS = [
  "/help", "/exit", "/clear", "/mode", "/compact",
  "/checkpoint", "/restore", "/checkpoints", "/sessions", "/new",
  "/skills", "/skill", "/modes", "/model", "/effort"
];

function completer(line: string): [string[], string] {
  const modelArgMatch = line.match(/^\/model\s+(\S*)$/);
  if (modelArgMatch) {
    const partial = modelArgMatch[1];
    const all = listKnownModels().map(e => `${e.provider}/${e.model}`);
    const hits = all.filter(m => m.startsWith(partial));
    const prefixEnd = line.length - partial.length;
    return [hits, line.slice(0, prefixEnd)];
  }

  const modeArgMatch = line.match(/^\/mode\s+(\S*)$/);
  if (modeArgMatch) {
    const partial = modeArgMatch[1];
    const hits = knownModeSlugs.filter(s => s.startsWith(partial));
    const prefixEnd = line.length - partial.length;
    return [hits, line.slice(0, prefixEnd)];
  }

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
      const hits = entries
        .filter(e => !e.name.startsWith(".") && e.name.startsWith(prefix))
        .map(e => {
          const relPath = dir === "." ? e.name : `${dir}/${e.name}`;
          return `@${relPath}${e.isDirectory() ? "/" : ""}`;
        });
      return [hits, line.slice(0, line.lastIndexOf("@")) + "@" + (dir === "." ? "" : dir + "/")];
    } catch {
      return [[], line];
    }
  }

  return [[], line];
}

function truncateContent(content: string, maxLen: number): string {
  if (content.length <= maxLen) return content;
  return content.slice(0, maxLen) + `\n... (truncated at ${maxLen} chars)`;
}

const colorEnabled = !!process.stdout.isTTY && !process.env.NO_COLOR;
const ansi = {
  dim: (s: string) => (colorEnabled ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s: string) => (colorEnabled ? `\x1b[1m${s}\x1b[0m` : s),
  blue: (s: string) => (colorEnabled ? `\x1b[34m${s}\x1b[0m` : s),
  blueBold: (s: string) => (colorEnabled ? `\x1b[1;34m${s}\x1b[0m` : s),
  bright: (s: string) => (colorEnabled ? `\x1b[97m${s}\x1b[0m` : s),
  orange: (s: string) => (colorEnabled ? `\x1b[38;5;208m${s}\x1b[0m` : s),
  orangeBold: (s: string) => (colorEnabled ? `\x1b[1;38;5;208m${s}\x1b[0m` : s),
};

const PROVIDER_LABELS: Record<string, string> = {
  deepseek: "DeepSeek",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  groq: "Groq",
  ollama: "Ollama",
};

function getProviderLabel(name: string): string {
  return PROVIDER_LABELS[name] ?? name;
}

function listKnownModels(): ModelEntry[] {
  const entries: ModelEntry[] = [];
  for (const provName of getKnownProviderNames()) {
    const preset = getPreset(provName);
    const seen = new Set<string>();
    if (preset) {
      for (const [modelName, caps] of Object.entries(preset.models)) {
        entries.push({ provider: provName, model: modelName, contextWindow: caps.contextWindow });
        seen.add(modelName);
      }
    }
    const models = getProviderModels(provName);
    if (models) {
      for (const [modelName, info] of Object.entries(models)) {
        if (seen.has(modelName)) continue;
        entries.push({
          provider: provName,
          model: modelName,
          contextWindow: info.contextWindow,
        });
      }
    }
  }
  return entries;
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
      const truncated = truncateContent(content, 4000);
      result = result.replace(match[0], `\n--- ${filePath} ---\n${truncated}\n--- end ${filePath} ---\n`);
    } catch {
    }
  }

  return result;
}

async function main() {
  initPresets();

  const rawArgs = process.argv.slice(2);
  if (rawArgs.length > 0 && rawArgs[0] === "doctor") {
    await runDoctor();
    process.exit(0);
  }

  const args = parseArgs();

  const configResult = loadConfig();
  if (configResult.errors.length > 0) {
    for (const e of configResult.errors) {
      process.stderr.write(`Error: ${e}\n`);
    }
    process.exit(1);
  }
  for (const w of configResult.warnings) {
    process.stderr.write(`Warning: ${w}\n`);
  }

  const configEnv = configResult.config.env;

  if (configResult.config.mcpServers) {
    await connectMCPServers(configResult.config.mcpServers);
  }

  if (process.argv[2] === "auth") {
    const sub = process.argv[3];
    if (sub === "list") {
      await authList();
    } else if (sub === "logout" && process.argv[4]) {
      await authLogout(process.argv[4]);
    } else if (sub === "logout") {
      console.log("Usage: heirloom auth logout <provider>");
    } else {
      await authWizard();
    }
    process.exit(0);
  }

  function detectProvider(): string | null {
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
    for (const p of envProviders) {
      if (process.env[p.key]) return p.name;
    }
    return null;
  }

  const resolvedApiKey = configEnv?.API_KEY || undefined;
  const resolvedBaseUrl = configEnv?.BASE_URL || undefined;

  const detected = detectProvider();
  let providerName = configResult.config.provider || detected || "deepseek";

  if (!detected && !configResult.config.provider && !resolvedApiKey) {
    const hasCreds = Object.values(readCredentialsFile()).some((v) => v);
    if (!hasCreds) {
      console.log("No API keys found. Set config.env.API_KEY, env var, or run `heirloom auth`.");
      if (!args.prompt) {
        process.exit(0);
      }
    }
  }

  let activeModel: string | undefined = args.model ?? configResult.config.model ?? configEnv?.MODEL ?? undefined;

  const thinkingEnabled = configResult.config.thinkingEnabled ?? true;
  const reasoningEffort = configResult.config.reasoningEffort;

  function getActiveModelCaps(): ModelCapabilities | undefined {
    const preset = getPreset(providerName);
    if (!preset) return undefined;
    return preset.models[activeModel ?? preset.defaultModel];
  }

  let activeEffort: string | undefined = reasoningEffort || getActiveModelCaps()?.effort?.default;

  function getProvider() {
    const opts: ProviderOptions = {
      modelOverride: activeModel,
      baseUrl: resolvedBaseUrl,
      apiKey: resolvedApiKey,
    };
    return createProvider(providerName, opts);
  }

  function checkCapabilities() {
    const capabilities = getProviderCapabilities(providerName);
    if (!capabilities.supportsTools) {
      const model = args.model ?? configResult.config.model ?? providerName;
      console.error(`Error: '${model}' does not support tool calls.`);
      console.error(`Use a tool-capable model (e.g., deepseek-chat, gpt-4o, claude-sonnet-4).`);
      process.exit(1);
    }
  }

  const modeLoader = new ModeLoader();
  try {
    knownModeSlugs = (await modeLoader.listAll()).map(m => m.slug);
  } catch {
  }
  const permissions = new PermissionEngine(configResult.config.permissions, process.cwd());

  const contextWindow =
    configResult.config.contextWindow ?? 128000;

  let _compactor: Compactor | undefined;
  function getCompactor(): Compactor {
    if (!_compactor) {
      _compactor = new Compactor(
        getProvider(),
        contextWindow,
        configResult.config.compaction?.threshold,
      );
    }
    return _compactor;
  }



  const sessionStore = new SessionStore();
  let sessionId: string;
  let sessionMessages: Message[] = [];
  let sessionLoaded = false;

  if (args.sessionId) {
    try {
      const loaded = await sessionStore.loadEffective(args.sessionId);
      sessionId = args.sessionId;
      sessionMessages = loaded.messages;
      sessionLoaded = true;
    } catch {
      console.error(`Session not found: ${args.sessionId}`);
      process.exit(1);
    }
  } else if (args.continue_) {
    const sessions = await sessionStore.list();
    if (sessions.length > 0) {
      sessionId = sessions[0].id;
      try {
        const loaded = await sessionStore.loadEffective(sessionId);
        sessionMessages = loaded.messages;
        sessionLoaded = true;
      } catch (err) {
        console.error(`Failed to load session ${sessionId}: ${(err as Error).message}`);
        process.exit(1);
      }
    } else {
      sessionId = await sessionStore.create({
        cwd: process.cwd(),
        provider: providerName,
        model: activeModel || getPreset(providerName)?.defaultModel || "deepseek-chat",
        mode: args.mode || "code",
      });
    }
  } else {
    sessionId = await sessionStore.create({
      cwd: process.cwd(),
      provider: providerName,
      model: activeModel || getPreset(providerName)?.defaultModel || "deepseek-chat",
      mode: args.mode || "code",
    });
  }

  if (args.debug) {
    enableDebug(sessionId);
  }

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
          decisions,
          files,
          summary: summary ?? undefined,
        });
      }
    } catch {
    }
  }

  const skillLoader = new SkillLoader();
  let skills = await skillLoader.load({ headless: !!args.prompt });
  const { def: loadSkillDef, handler: loadSkillHandler } = createLoadSkillTool(skills);
  registry.register({ def: loadSkillDef, handler: loadSkillHandler, groups: ["read"], always: true });

  let activeMode: ModeConfig | undefined;
  if (args.mode) {
    const mode = await modeLoader.load(args.mode);
    if (mode) {
      activeMode = mode;
      await sessionStore.appendState(sessionId, { mode: args.mode });
    }
  }

  if (sessionLoaded) {
    const modeLabel = activeMode?.slug || "code";
    console.log(`Resumed ${sessionId} · ${sessionMessages.length} messages · mode: ${modeLabel}`);
  }

  let firstTokenReceived = false;
  let activeSpinner: ReturnType<typeof setInterval> | null = null;

  const headlessCallbacks = {
    onText: (c: string) => process.stdout.write(c),
    onToolStart: () => {},
    onToolResult: () => {},
    onDiagnostic: (m: string) => process.stderr.write(`[diagnostics: ${m}]\n`),
    onRetry: () => {},
    onCompacted: (m: string) => process.stderr.write(`[compacted: ${m}]\n`),
    onLoopDetected: () => process.stderr.write("[loop detected]\n"),
    onUsage: (input: number, output: number) => {
      shared.sessionInput += input;
      shared.sessionOutput += output;
      shared.lastContextTokens = input + output;
    },
  };

  const interactiveCallbacks = {
    onText: (c: string) => {
      if (!firstTokenReceived) {
        if (activeSpinner) { clearInterval(activeSpinner); activeSpinner = null; }
        process.stderr.write("\r\x1b[K");
        firstTokenReceived = true;
      }
      process.stdout.write(c);
    },
    onToolStart: (name: string, args: Record<string, unknown>) =>
      process.stderr.write(`\x1b[2m  [${name}] ${JSON.stringify(args).slice(0, 120)}\x1b[0m\n`),
    onToolResult: (name: string, result: { content: string; error?: string }) => {
      if (result.error) {
        process.stderr.write(`\x1b[31m  ${name} error: ${result.error}\x1b[0m\n`);
        return;
      }
      if (result.content?.startsWith("PERMISSION_DENIED")) {
        process.stderr.write(`\x1b[31m  Permission denied\x1b[0m\n`);
      }
      if (result.content?.startsWith("COMMAND_FAILED")) {
        const detail = result.content.slice(16);
        process.stderr.write(`\x1b[31m  Command failed: ${detail}\x1b[0m\n`);
      }
    },
    onDiagnostic: (m: string) => console.log(`  [diagnostics: ${m}]`),
    onRetry: (m: string) => console.log(`    [self-reflection: ${m}]`),
    onCompacted: (m: string) => console.log(`  [compacted: ${m}]`),
    onLoopDetected: (m: string) => console.log(`[${m}]`),
    onMaxTurns: () => console.log("[max turns reached. Session saved.]"),
    onUsage: (input: number, output: number) => {
      shared.sessionInput += input;
      shared.sessionOutput += output;
      shared.lastContextTokens = input + output;
      const inK = (input / 1000).toFixed(1);
      const outK = (output / 1000).toFixed(1);
      process.stderr.write(`  [${inK}k in / ${outK}k out]\n`);
      sessionStore.appendState(sessionId, { inputTokens: input, outputTokens: output, cumulativeInput: shared.sessionInput, cumulativeOutput: shared.sessionOutput });
    },
  };

  if (args.prompt) {
    setSignal(shared.abort.signal);

    process.on("SIGINT", () => {
      shared.abort.abort();
    });

    try {
      const tools = activeMode?.groups ? registry.getByMode(activeMode.groups) : registry.getAllDefs();
      const result = await runAgent(args.prompt, {
        provider: getProvider(),
        tools,
        executeTool,
        permissions,
        mode: activeMode,
        compactor: getCompactor(),
        diagnostics,
        skills,
        memory: memoryInjection ?? undefined,
        memoryStore,
        sessionStore,
        sessionId,
        signal: shared.abort.signal,
        effort: activeEffort,
        ...headlessCallbacks,
      });
      await logSessionEnd();
      const exitCode = result.stopReason === "done" ? 0 : result.stopReason === "max_turns" ? 2 : 1;
      process.exit(exitCode);
    } catch (err) {
      try { await logSessionEnd(); } catch {}
      process.stderr.write(`Error: ${(err as Error).message}\n`);
      process.exit(1);
    }
  }

  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin });
    let pipedConversationHistory: Message[] = [];
    for await (const line of rl) {
      if (!line.trim()) continue;
      if (line.trim() === "/exit") break;
      if (line.startsWith("/")) {
        await handleSlashCore(line);
        continue;
      }
      setSignal(shared.abort.signal);
      firstTokenReceived = false;
      try {
        const tools = activeMode?.groups ? registry.getByMode(activeMode.groups) : registry.getAllDefs();
        const processed = await processAtMentions(line);
        const result = await runAgent(processed, {
          provider: getProvider(),
          tools,
          executeTool,
          permissions,
          mode: activeMode,
          compactor: getCompactor(),
          diagnostics,
          skills,
          memory: memoryInjection ?? undefined,
          memoryStore,
          sessionStore,
          sessionId,
          signal: shared.abort.signal,
          effort: activeEffort,
          history: pipedConversationHistory.length > 0 ? pipedConversationHistory : undefined,
          ...interactiveCallbacks,
        });
        pipedConversationHistory = result.messages;
        if (result.stopReason === "done") {
          await sessionStore.appendMessage(sessionId, { role: "user", content: line });
          for (const msg of result.newMessages) {
            if (msg.role !== "system") {
              await sessionStore.appendMessage(sessionId, msg);
            }
          }
        }
      } catch (err) {
        process.stderr.write(`Error: ${(err as Error).message}\n`);
      }
    }
    await logSessionEnd();
    return;
  }

  console.log("heirloom — AI coding assistant");
  if (colorEnabled) {
    console.log(`  ${ansi.bright("shift+tab")} ${ansi.dim("approve")}  ${ansi.dim("·")}  ${ansi.bright("esc")} ${ansi.dim("abort")}  ${ansi.dim("·")}  ${ansi.bright("ctrl+shift+p")} ${ansi.dim("commands")}  ${ansi.dim("·")}  ${ansi.bright("ctrl+shift+/")} ${ansi.dim("help")}`);
    console.log(`  ${ansi.orange("\u25CF")} ${ansi.orange("Tip")} ${ansi.dim("/help for commands, Ctrl+Shift+P for command palette")}`);
  }
  console.log("");

  setSignal(shared.abort.signal);

  process.on("SIGINT", () => {
    shared.abort.abort();
    shared.abort = new AbortController();
  });
  process.on("SIGTERM", () => {
    logSessionEnd().finally(() => process.exit(0));
  });

  function crashExit(label: string, err: unknown) {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stderr.write(`\n${label}: ${(err as Error)?.message ?? err}\n`);
    logSessionEnd().finally(() => process.exit(1));
  }
  process.on("uncaughtException", (err) => crashExit("Fatal error", err));
  process.on("unhandledRejection", (err) => crashExit("Unhandled rejection", err));

  const promptStr = colorEnabled ? `${ansi.blue("\u258C")} ${ansi.blue("\u203A")} ` : "heirloom > ";

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

  function buildStatusBar(): import("./ui/types.js").StatusSegment[] {
    const T = (text: string, props?: Partial<import("./ui/types.js").StatusSegment>): import("./ui/types.js").StatusSegment => ({ text, ...props });
    const dim = (text: string) => T(text, { dimColor: true });
    const sep = () => T(" │ ", { dimColor: true });
    const segments: import("./ui/types.js").StatusSegment[] = [];

    segments.push(dim(activeMode?.name ?? "chat"));

    if (permissions.getDefaultMode() === "askAll") {
      segments.push(T(" ", {}));
      segments.push(T("\u{1F512}askAll", { color: "yellow", bold: true }));
    }

    segments.push(T(" · ", { dimColor: true }));
    const modelId = activeModel ?? getPreset(providerName)?.defaultModel ?? "unknown";
    const providerLabel = getProviderLabel(providerName);
    segments.push(T(`${providerLabel}/${modelId}`, { bold: true }));

    segments.push(T(" · ", { dimColor: true }));
    let cwd = process.cwd();
    const home = process.env.HOME || process.env.USERPROFILE || "";
    if (home && cwd.startsWith(home)) cwd = "~" + cwd.slice(home.length);
    if (cwd.length > 30) { const parts = cwd.split("/"); cwd = "…/" + parts.slice(-2).join("/"); }
    segments.push(dim(cwd));

    const ctxPercent = getContextPercent();
    if (ctxPercent !== null) {
      segments.push(sep());
      segments.push(dim("ctx "));
      const filled = Math.round((Math.min(ctxPercent, 100) / 100) * 8);
      const bar = "█".repeat(filled) + "░".repeat(8 - filled);
      const ctxText = `${bar} ${Math.round(ctxPercent)}%`;
      if (ctxPercent >= 95) segments.push(T(ctxText, { color: "red" }));
      else if (ctxPercent >= 80) segments.push(T(ctxText, { color: "yellow" }));
      else segments.push(dim(ctxText));
    }

    const costStr = getCostStr();
    if (costStr) {
      segments.push(sep());
      segments.push(dim(`$${costStr}`));
    }

    if (activeEffort) {
      segments.push(sep());
      segments.push(T(activeEffort, { bold: true }));
    }

    return segments;
  }

  const handleSlash = async (input: string): Promise<string[]> => {
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...args) => lines.push(args.map(String).join(" "));
    try {
      await handleSlashCore(input);
    } finally {
      console.log = origLog;
    }
    return lines;
  };

  async function handleSlashCore(input: string): Promise<void> {
    const cmd = input.trim().split(/\s+/)[0];
    switch (cmd) {
      case "/help": {
        console.log(
          "Commands: /exit, /help, /mode <name>, /clear, /modes, /sessions, /new, /checkpoint, /restore [files|full], /checkpoints, /skills, /skill <name>, /compact, /model <provider/model>, /cost, /effort\n" +
            "Use `heirloom auth` to configure a provider, or set a *_API_KEY env var.",
        );
        return;
      }
      case "/cost": {
        console.log(`Session totals: ${(shared.sessionInput / 1000).toFixed(1)}k in / ${(shared.sessionOutput / 1000).toFixed(1)}k out`);
        const preset = getPreset(providerName);
        const caps = preset?.models[activeModel ?? preset.defaultModel];
        if (caps?.pricing) {
          console.log(`Estimated cost: $${getCostStr() ?? "0.0000"}`);
        } else {
          console.log("Estimated cost: unknown (no pricing data for this model)");
        }
        return;
      }
      case "/skills": {
        if (skills.length === 0) {
          console.log("No skills available.");
        } else {
          for (const s of skills) {
            console.log(`  ${s.name} — ${s.description || "no description"}`);
          }
        }
        return;
      }
      case "/skill": {
        const name = input.slice(7).trim();
        const skill = skills.find((s: SkillDef) => s.name === name);
        if (skill) {
          console.log(skill.content);
        } else {
          console.log(`Unknown skill: ${name}. Try /skills to list available skills.`);
        }
        return;
      }
      case "/clear": {
        console.log("[cleared]");
        shared.conversationHistory = [];
        return;
      }
      case "/modes": {
        const allModes = await modeLoader.listAll();
        for (const m of allModes) {
          console.log(`  ${m.slug} — ${m.description || m.roleDefinition.slice(0, 60)}`);
        }
        return;
      }
      case "/mode": {
        const slug = input.slice(6).trim();
        const mode = await modeLoader.load(slug);
        if (mode) {
          activeMode = mode;
          await sessionStore.appendState(sessionId, { mode: slug });
          console.log(`Switched to ${mode.name} mode.`);
        } else {
          console.log(`Unknown mode: ${slug}. Try /modes to list available modes.`);
        }
        return;
      }
      case "/compact": {
        console.log("Not yet implemented. Compaction runs automatically.");
        return;
      }
      case "/model": {
        const modelArg = input.slice(7).trim();
        if (!modelArg) {
          const currentModel = activeModel ?? getPreset(providerName)?.defaultModel ?? "unknown";
          console.log(`Current: ${providerName}/${currentModel}`);
          console.log("");
          const byProvider = new Map<string, ModelEntry[]>();
          for (const entry of listKnownModels()) {
            const list = byProvider.get(entry.provider) ?? [];
            list.push(entry);
            byProvider.set(entry.provider, list);
          }
          const modelColWidth = Math.max(
            ...[...byProvider.values()].flat().map(e => e.model.length),
          );
          for (const [provName, entries] of byProvider) {
            console.log(provName);
            for (const entry of entries) {
              const isActive = entry.provider === providerName && entry.model === currentModel;
              const suffix = entry.contextWindow ? `   ctx ${Math.round(entry.contextWindow / 1000)}k` : "";
              const marker = isActive ? "> " : "  ";
              const line = `  ${marker}${entry.model.padEnd(modelColWidth)}${suffix}`;
              console.log(isActive && colorEnabled ? ansi.bright(line) : line);
            }
          }
          console.log("");
          console.log("Switch: /model <provider/model>");
          return;
        }
        const slashIdx = modelArg.indexOf("/");
        if (slashIdx < 0) {
          console.log("Invalid format. Use: /model <provider/model>");
          return;
        }
        const provName = modelArg.slice(0, slashIdx);
        const modelName = modelArg.slice(slashIdx + 1);
        try {
          providerName = provName;
          activeModel = modelName;
          _compactor = undefined;
          activeEffort = reasoningEffort || getActiveModelCaps()?.effort?.default;
          sessionStore.appendState(sessionId, {
            model: modelName,
            provider: provName,
            changedAt: Date.now(),
          });
          const effortNote = activeEffort ? ` (effort: ${activeEffort})` : "";
          console.log(`Model changed to ${provName}/${modelName}${effortNote}`);
        } catch (e) {
          console.log(`Error: ${(e as Error).message}`);
        }
        return;
      }
      case "/checkpoint": {
        const hash = await checkpoints.save("manual checkpoint");
        if (hash) {
          console.log(`Checkpoint saved: ${hash.slice(0, 7)}`);
        } else {
          console.log("No changes to save.");
        }
        return;
      }
      case "/restore": {
        if (input === "/restore files") {
          const result = await checkpoints.restore("files");
          if (result.restored) {
            console.log(`Workspace restored to checkpoint ${result.checkpointHash!.slice(0, 7)}.`);
          } else {
            console.log("No checkpoints to restore from.");
          }
        } else if (input === "/restore full --yes") {
          const result = await checkpoints.restore("full");
          if (result.restored) {
            console.log(`Workspace restored to checkpoint ${result.checkpointHash!.slice(0, 7)}.`);
          } else {
            console.log("No checkpoints to restore from.");
          }
        } else if (input === "/restore full") {
          console.log("Full restore is destructive. Use /restore full --yes to confirm.");
        } else {
          console.log("Usage: /restore [files|full]");
        }
        return;
      }
      case "/checkpoints": {
        const entries = checkpoints.list();
        if (entries.length === 0) {
          console.log("No checkpoints recorded.");
        } else {
          for (const e of entries) {
            console.log(`  ${e.hash.slice(0, 7)}  ${e.message}  (${e.timestamp})`);
          }
        }
        return;
      }
      case "/sessions": {
        const sessions = await sessionStore.list();
        if (sessions.length === 0) {
          console.log("No sessions for this project.");
        } else {
          for (const s of sessions) {
            const date = new Date(s.createdAt).toISOString().slice(0, 10);
            const msgs = `${s.messageCount} msg${s.messageCount !== 1 ? "s" : ""}`;
            const excerpt = s.firstMessage ? `  "${s.firstMessage}"` : "";
            console.log(`  ${s.id}${excerpt}  ${msgs}  created ${date}`);
          }
        }
        return;
      }
      case "/new": {
        await logSessionEnd();
        shared.sessionUserInputs.length = 0;
        shared.conversationHistory = [];
        sessionId = await sessionStore.create({
          cwd: process.cwd(),
          provider: providerName,
          model: activeModel || getPreset(providerName)?.defaultModel || "deepseek-chat",
          mode: activeMode?.slug || "code",
        });
        checkpoints = new CheckpointManager(sessionId);
        setCheckpointManager(checkpoints);
        setSessionId(sessionId);
        console.log("New session started.");
        return;
      }
      case "/effort": {
        const arg = input.slice(7).trim();
        const caps = getActiveModelCaps();
        if (!caps?.effort) {
          console.log("Current model does not support reasoning effort.");
          return;
        }
        if (!arg) {
          console.log(`Effort: ${activeEffort ?? caps.effort.default}`);
          console.log(`Valid values: ${caps.effort.values.join(", ")}`);
          return;
        }
        if (!caps.effort.values.includes(arg)) {
          console.log(`Invalid effort value. Valid: ${caps.effort.values.join(", ")}`);
          return;
        }
        activeEffort = arg;
        console.log(`Effort set to ${arg}.`);
        return;
      }
      default:
        console.log(`Unknown command: ${cmd}\nType /help for available commands.`);
        return;
    }
  }

  const runAgentTurnBridge = async (
    input: string,
    cb: {
      onText: (c: string) => void;
      onToolStart: (name: string, args: Record<string, unknown>) => void;
      onToolResult: (name: string, result: { content: string; error?: string }) => void;
      onDiagnostic: (m: string) => void;
      onRetry: (m: string) => void;
      onCompacted: (m: string) => void;
      onLoopDetected: (m: string) => void;
      onMaxTurns: () => void;
      onUsage: (input: number, output: number) => void;
      onNewMessages: (userInput: string, newMessages: Message[]) => Promise<void>;
      onHistoryUpdate: (messages: Message[]) => void;
      askUser: (toolName: string, args: Record<string, unknown>) => Promise<boolean>;
    },
  ): Promise<any> => {
    shared.sessionUserInputs.push(input);
    const processed = await processAtMentions(input);

    const tools = activeMode?.groups ? registry.getByMode(activeMode.groups) : registry.getAllDefs();

    const result = await runAgent(processed, {
      provider: getProvider(),
      tools,
      executeTool,
      permissions,
      mode: activeMode,
      compactor: getCompactor(),
      diagnostics,
      skills,
      memory: memoryInjection ?? undefined,
      memoryStore,
      sessionStore,
      sessionId,
      signal: shared.abort.signal,
      effort: activeEffort,
      history: shared.conversationHistory.length > 0 ? shared.conversationHistory : undefined,
      onText: cb.onText,
      onToolStart: cb.onToolStart,
      onToolResult: cb.onToolResult,
      onDiagnostic: cb.onDiagnostic,
      onRetry: cb.onRetry,
      onCompacted: cb.onCompacted,
      onLoopDetected: cb.onLoopDetected,
      onMaxTurns: cb.onMaxTurns,
      onUsage: (input: number, output: number) => {
        shared.sessionInput += input;
        shared.sessionOutput += output;
        shared.lastContextTokens = input + output;
        sessionStore.appendState(sessionId, { inputTokens: input, outputTokens: output, cumulativeInput: shared.sessionInput, cumulativeOutput: shared.sessionOutput });
        cb.onUsage(input, output);
      },
      askUser: cb.askUser,
    });

    return result;
  };

  const resolvedTheme = new ThemeContextValue(
    resolveTheme({
      mode: configResult.config.theme?.mode ?? "dark",
      overrides: configResult.config.theme?.overrides,
    }),
  );

  let resolvedKeybindings: KeybindingMap | undefined;
  let resolvedKeybindingConfig: KeybindingSystemConfig | undefined;

  const rawKbConfig = configResult.config.keybindings;
  if (rawKbConfig && "overrides" in rawKbConfig) {
    const ext = rawKbConfig as any;
    const overrides: Record<string, any> = {};
    if (ext.overrides) {
      for (const [action, value] of Object.entries(ext.overrides)) {
        if (typeof value === "string") {
          const combo = parseKeyCombo(value);
          if (combo) overrides[action] = [combo];
        } else if (Array.isArray(value)) {
          overrides[action] = value.map((v: string) => parseKeyCombo(v)).filter(Boolean);
        }
      }
    }
    resolvedKeybindingConfig = {
      overrides,
      disabled: ext.disabled,
    };
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
    completer,
    buildStatusBar,
    getPromptStr: () => promptStr,
    getColorEnabled: () => colorEnabled,
    logSessionEnd,
    onExit: () => logSessionEnd().then(() => process.exit(0)),
    handleSlash,
    getModelEntries: () => listKnownModels(),
    runAgentTurnCore: runAgentTurnBridge,

    theme: resolvedTheme,
    keybindings: resolvedKeybindings,
    keybindingConfig: resolvedKeybindingConfig,

    tabState: undefined,

    workflowConfig,
  };

  const themeConfig = {
    mode: (configResult.config as any)?.theme?.mode ?? "dark",
    overrides: (configResult.config as any)?.theme?.overrides,
  };

  const keybindingConfig = {
    overrides: (configResult.config as any)?.keybindings,
  };

  const { waitUntilExit } = render(
    createElement(App, {
      ctx: appCtx,
      themeConfig,
      keybindingConfig,
    }),
  );
  await waitUntilExit();
}
void main();
