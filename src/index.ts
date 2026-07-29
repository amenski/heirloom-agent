import * as readline from "node:readline/promises";
import { emitKeypressEvents } from "node:readline";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { initPresets, createProvider, setConfigProviders, getPreset } from "./providers/presets.js";
import { getProviderCapabilities } from "./providers/registry.js";
import { runAgent } from "./agent.js";
import { executeTool, TOOL_DEFS, registry, setSessionId, setCheckpointManager, setSignal } from "./tools/index.js";
import { PermissionEngine, type ApprovalMode, type PermissionAction } from "./permissions/index.js";
import { previewEdit } from "./permissions/diffpreview.js";
import { ModeLoader, type ModeConfig } from "./modes/loader.js";
import { Compactor } from "./compaction/compactor.js";
import { CheckpointManager } from "./checkpoints/index.js";
import { DiagnosticRunner } from "./diagnostics/index.js";
import { authWizard, authList, authLogout } from "./auth/wizard.js";
import { SessionStore } from "./sessions/store.js";
import { MemoryStore } from "./memory/store.js";
import { SkillLoader, createLoadSkillTool, type SkillDef } from "./skills/index.js";
import { loadConfig, type PermissionConfigValue } from "./config/loader.js";
import { readCredentialsFile } from "./config/credentials.js";
import { enableDebug } from "./debug/logger.js";
import { connectMCPServers } from "./mcp/connector.js";
import type { Message } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let pasteBuffer = "";
let inPaste = false;

interface CliArgs {
  prompt?: string;
  continue_: boolean;
  sessionId?: string;
  approveMode?: "edits" | "all";
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
      "  --approve <edits|all>  Set approval mode (for headless runs)\n" +
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
    } else if (args[i] === "--approve" && i + 1 < args.length) {
      const mode = args[++i];
      if (mode === "edits" || mode === "all") result.approveMode = mode;
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
    const providers = Object.keys(configResult.config.providers || {});
    console.log(`  config.yaml       ${providers.length} provider(s): ${providers.join(", ") || "none"}`);
  } catch (e) {
    console.log(`  config.yaml       ERROR: ${(e as Error).message}`);
  }

  const keySource = process.env.DEEPSEEK_API_KEY ? "DEEPSEEK_API_KEY env var"
    : process.env.OPENAI_API_KEY ? "OPENAI_API_KEY env var"
    : process.env.OPENROUTER_API_KEY ? "OPENROUTER_API_KEY env var"
    : process.env.ANTHROPIC_API_KEY ? "ANTHROPIC_API_KEY env var"
    : (() => {
        const names = Object.entries(readCredentialsFile()).filter(([, v]) => v).map(([k]) => k);
        if (names.length) return `credentials.yaml (${names.length} key(s): ${names.join(", ")})`;
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
  "/help", "/exit", "/clear", "/mode", "/approve", "/compact",
  "/checkpoint", "/restore", "/checkpoints", "/sessions", "/new",
  "/skills", "/skill", "/modes", "/model"
];

function completer(line: string): [string[], string] {
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

// Colors are only ever emitted on an interactive TTY with NO_COLOR unset — piped/headless
// output must stay byte-for-byte plain (tests and pipelines grep it).
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
  deepseek_reasoner: "DeepSeek",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  groq: "Groq",
  ollama: "Ollama",
};

function getProviderLabel(name: string): string {
  return PROVIDER_LABELS[name] ?? name;
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
      // File doesn't exist — leave the @mention as-is
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

  if (configResult.config.providers) {
    setConfigProviders(configResult.config.providers);
  }

  if (configResult.config.mcp) {
    await connectMCPServers(configResult.config.mcp);
  }

  function feedPermissions(engine: PermissionEngine, perms: Record<string, PermissionConfigValue>): void {
    for (const [tool, value] of Object.entries(perms)) {
      if (typeof value === "string") {
        engine.addRule({ tool, action: value as PermissionAction });
      } else if (typeof value === "object") {
        for (const [pattern, action] of Object.entries(value)) {
          engine.addRule({ tool, pattern, action: action as PermissionAction });
        }
      }
    }
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

  function hasAnyKey(): boolean {
    if (detectProvider()) return true;
    return Object.values(readCredentialsFile()).some((v) => v);
  }

  const detected = detectProvider();
  let providerName =
    process.env.HEIRLOOM_PROVIDER ||
    configResult.config.provider ||
    detected ||
    "deepseek";

  if (!detected && !configResult.config.provider && !process.env.HEIRLOOM_PROVIDER && !hasAnyKey()) {
    console.log("No API keys found. Run `heirloom auth` to configure a provider, or set an API key env var.");
    console.log("Supported keys: DEEPSEEK_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY, ANTHROPIC_API_KEY, GROQ_API_KEY, TOGETHER_API_KEY\n");
    if (!args.prompt) {
      process.exit(0);
    }
  }
  let activeModel: string | undefined = args.model ?? configResult.config.model ?? undefined;

  function getProvider() {
    return createProvider(providerName, activeModel);
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
  const permissions = PermissionEngine.defaults(undefined, !!args.prompt);
  if (configResult.config.permissions) {
    feedPermissions(permissions, configResult.config.permissions);
  }

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

  async function interactiveAskUser(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<boolean> {
    const editTools = ["edit", "edit_file", "write_to_file", "write", "search_replace", "apply_diff", "apply_patch"];
    if (editTools.includes(toolName)) {
      const preview = previewEdit(toolName, args);
      if (preview) {
        process.stderr.write(preview + "\n\n");
      }
    }

    const rlAsk = readline.createInterface({ input: process.stdin, output: process.stdout });
    const argStr = JSON.stringify(args);
    const promptStr = `  ${toolName} ${argStr}\n  Allow? (y)es once · (a)llow for session · (n)o  `;
    const answer = (await rlAsk.question(promptStr)).trim().toLowerCase();
    rlAsk.close();

    if (answer === "n" || answer === "no") {
      return false;
    }

    if (answer === "a" || answer === "allow") {
      let pattern = "*";
      if (toolName === "run_bash" && typeof args.command === "string") {
        const firstWord = args.command.split(/\s+/)[0];
        pattern = firstWord ? `${firstWord} *` : "*";
      } else if (typeof args.filePath === "string") {
        const dir = dirname(args.filePath);
        pattern = dir === "." || dir === "/" ? "*" : `${dir}/*`;
      } else if (typeof args.path === "string") {
        const dir = dirname(args.path);
        pattern = dir === "." || dir === "/" ? "*" : `${dir}/*`;
      }
      permissions.addSessionRule({ tool: toolName, pattern, action: "allow" });
      console.log(`  (added session rule: ${toolName} ${pattern})`);
      return true;
    }

    return true;
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

  if (args.approveMode) {
    permissions.setApprovalMode(args.approveMode);
  }

  let checkpoints = new CheckpointManager(sessionId);
  const diagnostics = new DiagnosticRunner();
  setSessionId(sessionId);
  setCheckpointManager(checkpoints);

  const memoryStore = new MemoryStore();
  await memoryStore.init();
  const memoryInjection = await memoryStore.getInjection();
  const sessionUserInputs: string[] = [];
  let sessionInput = 0;
  let sessionOutput = 0;

  async function logSessionEnd() {
    try {
      const compactor = getCompactor();
      const { summary, files } = compactor.getLastCompaction();
      const decisions = extractDecisions(summary);
      if (sessionUserInputs.length > 0 || files.length > 0 || summary) {
        await memoryStore.appendSession({
          date: new Date().toISOString().slice(0, 10),
          tasks: [...sessionUserInputs],
          decisions,
          files,
          summary: summary ?? undefined,
        });
      }
    } catch {
      // Session logging is best-effort; ignore errors on exit
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

  let abortController = new AbortController();
  let agentRunning = false;

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
      sessionInput += input;
      sessionOutput += output;
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
      sessionInput += input;
      sessionOutput += output;
      const inK = (input / 1000).toFixed(1);
      const outK = (output / 1000).toFixed(1);
      process.stderr.write(`  [${inK}k in / ${outK}k out]\n`);
      sessionStore.appendState(sessionId, { inputTokens: input, outputTokens: output, cumulativeInput: sessionInput, cumulativeOutput: sessionOutput });
    },
  };

  if (args.prompt) {
    setSignal(abortController.signal);

    process.on("SIGINT", () => {
      abortController.abort();
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
        signal: abortController.signal,
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

  if (process.stdin.isTTY) {
    process.stdin.on("data", (chunk: Buffer) => {
      const str = chunk.toString();

      if (str.startsWith("\x1b[200~")) {
        inPaste = true;
        pasteBuffer = "";
        process.stdin.pause();
        const rest = str.slice(6);
        if (rest) pasteBuffer += rest;
        return;
      }

      if (inPaste) {
        const endIdx = str.indexOf("\x1b[201~");
        if (endIdx >= 0) {
          inPaste = false;
          pasteBuffer += str.slice(0, endIdx);
          const combined = pasteBuffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimEnd();
          rl.write(combined + "\n");
          process.stdin.resume();
          pasteBuffer = "";
        } else {
          pasteBuffer += str;
        }
        return;
      }
    });
  }

  if (process.stdin.isTTY) process.stdout.write("\x1b[?2004h");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, completer });

  // Accent-rail prompt: mode/model/approval info now lives in renderPromptHeader(),
  // not the prompt line itself (readline needs a single-line prompt for correct
  // backspace/history behavior).
  function getPrompt(): string {
    if (!colorEnabled) return "heirloom > ";
    return `${ansi.blue("\u258C")} ${ansi.blue("\u203A")} `;
  }

  let shownTip = false;

  function renderPromptHeader(): void {
    if (!colorEnabled) return;

    const modeName = activeMode?.name ?? "chat";
    const modelName = activeModel ?? getPreset(providerName)?.defaultModel ?? "unknown";
    const providerLabel = getProviderLabel(providerName);
    console.log(
      `  ${ansi.blueBold(modeName)} ${ansi.dim("\u00B7")} ${ansi.bright(modelName)} ${ansi.dim("\u00B7")} ${ansi.dim(providerLabel)}`,
    );

    const hints: string[] = [
      `${ansi.bright("shift+tab")} ${ansi.dim("approve")}`,
      `${ansi.bright("esc")} ${ansi.dim("abort")}`,
      `${ansi.bright("/help")}`,
    ];
    console.log(`  ${hints.join(`  ${ansi.dim("\u00B7")}  `)}`);
    console.log("");

    if (!shownTip) {
      shownTip = true;
      console.log(`  ${ansi.orange("\u25CF")} ${ansi.orange("Tip")} ${ansi.dim("/help for commands")}`);
      console.log("");
    }
  }
  console.log("heirloom — type /exit to quit, /help for help\n");

  process.on("SIGINT", () => {
    abortController.abort();
    abortController = new AbortController();
  });

  process.on("SIGTERM", () => {
    logSessionEnd().finally(() => process.exit(0));
  });

  process.on("exit", () => process.stdout.write("\x1b[?2004l"));

  emitKeypressEvents(process.stdin);
  function onKeypress(str: string, key: { name?: string; ctrl?: boolean; shift?: boolean }) {
    if (key.name === "escape") {
      if (agentRunning) abortController.abort();
    }
    if (key.name === "c" && key.ctrl) {
      if (agentRunning) abortController.abort();
    }
    if (key.name === "tab" && key.shift) {
      if (!agentRunning) {
        const modes: ApprovalMode[] = ["manual", "edits", "all"];
        const idx = modes.indexOf(permissions.approvalMode);
        permissions.setApprovalMode(modes[(idx + 1) % modes.length]);
        // onKeypress is only attached while an agent turn is running (see
        // process.stdin.on("keypress", ...) below), so there is no live rl.question
        // prompt line to repaint here — the status line header is redrawn on the next
        // rl.question call instead. Keep the in-place line redraw as a harmless no-op
        // fallback for the line readline is tracking.
        process.stdout.write(`\r${getPrompt()}${(rl as any).line}`);
      }
    }
  }

  rl.on("SIGINT", () => {
    console.log("(use /exit or Ctrl+D to quit)");
    rl.prompt();
  });

  async function handleSlash(input: string): Promise<boolean> {
    const cmd = input.trim().split(/\s+/)[0];
    switch (cmd) {
      case "/help": {
        console.log(
          "Commands: /exit, /help, /mode <name>, /clear, /modes, /sessions, /new, /approve [manual|edits|all], /checkpoint, /restore [files|full], /checkpoints, /skills, /skill <name>, /compact, /model <provider/model>, /cost\n" +
            "Use `heirloom auth` to configure a provider, or set a *_API_KEY env var.",
        );
        return true;
      }
      case "/cost": {
        console.log(`Session totals: ${(sessionInput / 1000).toFixed(1)}k in / ${(sessionOutput / 1000).toFixed(1)}k out`);
        const estCost = (sessionInput * 0.14 + sessionOutput * 0.28) / 1_000_000;
        console.log(`Estimated cost: $${estCost.toFixed(4)}`);
        return true;
      }
      case "/skills": {
        if (skills.length === 0) {
          console.log("No skills available.");
        } else {
          for (const s of skills) {
            console.log(`  ${s.name} — ${s.description || "no description"}`);
          }
        }
        return true;
      }
      case "/skill": {
        const name = input.slice(7).trim();
        const skill = skills.find(s => s.name === name);
        if (skill) {
          console.log(skill.content);
        } else {
          console.log(`Unknown skill: ${name}. Try /skills to list available skills.`);
        }
        return true;
      }
      case "/clear": {
        console.log("[cleared]");
        conversationHistory = [];
        return true;
      }
      case "/modes": {
        const allModes = await modeLoader.listAll();
        for (const m of allModes) {
          console.log(`  ${m.slug} — ${m.description || m.roleDefinition.slice(0, 60)}`);
        }
        return true;
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
        return true;
      }
      case "/approve": {
        const mode = input.slice(8).trim();
        if (mode === "manual" || mode === "edits" || mode === "all") {
          permissions.setApprovalMode(mode);
          if (mode === "all") {
            console.log(`All edit tool calls will auto-approve within ${process.cwd()}. Deny rules still hold.`);
          } else {
            console.log(`Approval mode set to: ${mode}`);
          }
        } else if (mode === "") {
          console.log(`Current approval mode: ${permissions.approvalMode}`);
          const sessionRules = permissions.getSessionRules();
          if (sessionRules.length > 0) {
            console.log("Session rules:");
            for (const r of sessionRules) {
              console.log(`  ${r.tool} ${r.pattern || "*"} → ${r.action}`);
            }
          }
        } else {
          console.log("Usage: /approve [manual|edits|all]");
        }
        return true;
      }
      case "/compact": {
        console.log("Not yet implemented. Compaction runs automatically.");
        return true;
      }
      case "/model": {
        const modelArg = input.slice(7).trim();
        if (!modelArg) {
          console.log(`Current: ${providerName}/${activeModel ?? getPreset(providerName)?.defaultModel ?? "unknown"}`);
          console.log("Usage: /model <provider/model>");
          return true;
        }
        const slashIdx = modelArg.indexOf("/");
        if (slashIdx < 0) {
          console.log("Invalid format. Use: /model <provider/model>");
          return true;
        }
        const provName = modelArg.slice(0, slashIdx);
        const modelName = modelArg.slice(slashIdx + 1);
        try {
          const capabilities = getProviderCapabilities(provName);
          if (!capabilities.supportsTools) {
            console.log(`Error: '${modelName}' does not support tool calls.`);
            return true;
          }
          providerName = provName;
          activeModel = modelName;
          _compactor = undefined;
          sessionStore.appendState(sessionId, {
            model: modelName,
            provider: provName,
            changedAt: Date.now(),
          });
          console.log(`Model changed to ${provName}/${modelName}`);
        } catch (e) {
          console.log(`Error: ${(e as Error).message}`);
        }
        return true;
      }
      case "/checkpoint": {
        const hash = await checkpoints.save("manual checkpoint");
        if (hash) {
          console.log(`Checkpoint saved: ${hash.slice(0, 7)}`);
        } else {
          console.log("No changes to save.");
        }
        return true;
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
        return true;
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
        return true;
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
        return true;
      }
      case "/new": {
        await logSessionEnd();
        sessionUserInputs.length = 0;
        conversationHistory = [];
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
        return true;
      }
      default:
        console.log(`Unknown command: ${cmd}\nType /help for available commands.`);
        return true;
    }
  }

  let conversationHistory: Message[] = [];

  while (true) {
    setSignal(abortController.signal);

    let input: string | null = null;
    try {
      renderPromptHeader();
      input = await rl.question(getPrompt());
    } catch {
      // Ctrl+D (EOF) — rl.question rejects when interface closes
    }
    if (input === null || input === undefined) {
      await logSessionEnd();
      console.log("Bye.");
      break;
    }
    if (!input.trim()) continue;

    if (input === "/exit") {
      await logSessionEnd();
      console.log("Bye.");
      break;
    }

    if (input.startsWith("/")) {
      const handled = await handleSlash(input);
      if (handled) continue;
    }

    try {
      agentRunning = true;
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
        process.stdin.on("keypress", onKeypress);
      }

      const tools = activeMode?.groups ? registry.getByMode(activeMode.groups) : registry.getAllDefs();
      sessionUserInputs.push(input);
      const processed = await processAtMentions(input);

      firstTokenReceived = false;
      const loadingChars = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
      let loadingCharIdx = 0;
      activeSpinner = setInterval(() => {
        process.stderr.write(`\r  \x1b[2m${loadingChars[loadingCharIdx]}\x1b[0m`);
        loadingCharIdx = (loadingCharIdx + 1) % loadingChars.length;
      }, 100);

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
        signal: abortController.signal,
        history: conversationHistory.length > 0 ? conversationHistory : undefined,
        ...interactiveCallbacks,
        askUser: interactiveAskUser,
      });
      conversationHistory = result.messages;
      if (result.stopReason === "done") {
        await sessionStore.appendMessage(sessionId, { role: "user", content: input });
        for (const msg of result.newMessages) {
          if (msg.role !== "system") {
            await sessionStore.appendMessage(sessionId, msg);
          }
        }
      }
    } catch (err) {
      console.error(`\nError: ${(err as Error).message}`);
    } finally {
      agentRunning = false;
      if (activeSpinner) { clearInterval(activeSpinner); activeSpinner = null; }
      if (!firstTokenReceived) process.stderr.write("\r\x1b[K");
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
        process.stdin.off("keypress", onKeypress);
      }
    }
    console.log("");
  }
  rl.close();
}

main();
