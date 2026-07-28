import * as readline from "node:readline/promises";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { initPresets, createProvider } from "./providers/presets.js";
import { runAgent } from "./agent.js";
import { executeTool, TOOL_DEFS, registry, setSessionId, setCheckpointManager, setSignal } from "./tools/index.js";
import { PermissionEngine, type ApprovalMode } from "./permissions/index.js";
import { ModeLoader, type ModeConfig } from "./modes/loader.js";
import { Compactor } from "./compaction/compactor.js";
import { CheckpointManager } from "./checkpoints/index.js";
import { DiagnosticRunner } from "./diagnostics/index.js";
import { authWizard, authList, authLogout } from "./auth/wizard.js";
import { SessionStore } from "./sessions/store.js";
import { MemoryStore } from "./memory/store.js";
import { SkillLoader, createLoadSkillTool, type SkillDef } from "./skills/index.js";
import type { Message } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface CliArgs {
  prompt?: string;
  continue_: boolean;
  sessionId?: string;
  approveMode?: "edits" | "all";
  mode?: string;
  model?: string;
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
    }
  }
  return result;
}

async function main() {
  initPresets();

  const args = parseArgs();

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

  const provider = createProvider(process.env.HEIRLOOM_PROVIDER || "deepseek");
  const modeLoader = new ModeLoader();
  const permissions = PermissionEngine.defaults();
  const compactor = new Compactor(provider);

  const sessionStore = new SessionStore();
  let sessionId: string;
  let sessionMessages: Message[] = [];

  if (args.sessionId) {
    try {
      const loaded = await sessionStore.loadEffective(args.sessionId);
      sessionId = args.sessionId;
      sessionMessages = loaded.messages;
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
      } catch (err) {
        console.error(`Failed to load session ${sessionId}: ${(err as Error).message}`);
        process.exit(1);
      }
    } else {
      sessionId = await sessionStore.create({
        cwd: process.cwd(),
        provider: process.env.HEIRLOOM_PROVIDER || "deepseek",
        model: args.model || "deepseek-chat",
        mode: args.mode || "code",
      });
    }
  } else {
    sessionId = await sessionStore.create({
      cwd: process.cwd(),
      provider: process.env.HEIRLOOM_PROVIDER || "deepseek",
      model: args.model || "deepseek-chat",
      mode: args.mode || "code",
    });
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

  const skillLoader = new SkillLoader();
  let skills = await skillLoader.load();
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

  let abortController = new AbortController();

  const headlessCallbacks = {
    onText: (c: string) => process.stdout.write(c),
    onToolStart: () => {},
    onDiagnostic: (m: string) => process.stderr.write(`[diagnostics: ${m}]\n`),
    onRetry: () => {},
    onCompacted: (m: string) => process.stderr.write(`[compacted: ${m}]\n`),
    onLoopDetected: () => process.stderr.write("[loop detected]\n"),
  };

  const interactiveCallbacks = {
    onText: (c: string) => process.stdout.write(c),
    onToolStart: (name: string, args: Record<string, unknown>) =>
      console.log(`  [${name}] ${JSON.stringify(args).slice(0, 120)}`),
    onDiagnostic: (m: string) => console.log(`  [diagnostics: ${m}]`),
    onRetry: (m: string) => console.log(`    [self-reflection: ${m}]`),
    onCompacted: (m: string) => console.log(`  [compacted: ${m}]`),
    onLoopDetected: (m: string) => console.log(`[${m}]`),
    onMaxTurns: () => console.log("[max turns reached. Session saved.]"),
  };

  if (args.prompt) {
    setSignal(abortController.signal);

    process.on("SIGINT", () => {
      abortController.abort();
    });

    try {
      const tools = activeMode?.groups ? registry.getByMode(activeMode.groups) : registry.getAllDefs();
      await runAgent(args.prompt, {
        provider,
        tools,
        executeTool,
        permissions,
        mode: activeMode,
        compactor,
        diagnostics,
        skills,
        memory: memoryInjection ?? undefined,
        memoryStore,
        signal: abortController.signal,
        ...headlessCallbacks,
        onMaxTurns: () => process.exit(2),
      });
      process.exit(0);
    } catch (err) {
      process.stderr.write(`Error: ${(err as Error).message}\n`);
      process.exit(1);
    }
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const prompt = () => {
    let p = activeMode ? `heirloom [${activeMode.name}` : "heirloom [";
    if (permissions.approvalMode !== "manual") {
      p += ` \u26A1${permissions.approvalMode}`;
    }
    p += activeMode ? "] > " : "] > ";
    return p;
  };
  console.log("heirloom — type /exit to quit, /help for help\n");

  process.on("SIGINT", () => {
    abortController.abort();
    abortController = new AbortController();
  });

  while (true) {
    setSignal(abortController.signal);

    const input = await rl.question(prompt());
    if (!input.trim()) continue;

    if (input === "/exit") {
      console.log("Bye.");
      break;
    }

    if (input === "/help") {
      console.log(
        "Commands: /exit, /help, /mode <name>, /clear, /modes, /sessions, /new, /approve [manual|edits|all], /checkpoint, /restore [files|full], /checkpoints, /skills, /skill <name>, /new\n" +
          "Set HEIRLOOM_PROVIDER to choose provider (default: deepseek). Set DEEPSEEK_API_KEY to use the default.",
      );
      continue;
    }

    if (input === "/skills") {
      if (skills.length === 0) {
        console.log("No skills available.");
      } else {
        for (const s of skills) {
          console.log(`  ${s.name} — ${s.description || "no description"}`);
        }
      }
      continue;
    }

    if (input.startsWith("/skill ")) {
      const name = input.slice(7).trim();
      const skill = skills.find(s => s.name === name);
      if (skill) {
        console.log(skill.content);
      } else {
        console.log(`Unknown skill: ${name}. Try /skills to list available skills.`);
      }
      continue;
    }

    if (input === "/clear") {
      console.log("[cleared]");
      continue;
    }

    if (input === "/modes") {
      const allModes = await modeLoader.listAll();
      for (const m of allModes) {
        console.log(`  ${m.slug} — ${m.description || m.roleDefinition.slice(0, 60)}`);
      }
      continue;
    }

    if (input.startsWith("/mode ")) {
      const slug = input.slice(6).trim();
      const mode = await modeLoader.load(slug);
      if (mode) {
        activeMode = mode;
        await sessionStore.appendState(sessionId, { mode: slug });
        console.log(`Switched to ${mode.name} mode.`);
      } else {
        console.log(`Unknown mode: ${slug}. Try /modes to list available modes.`);
      }
      continue;
    }

    if (input.startsWith("/approve")) {
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
      continue;
    }

    if (input === "/checkpoint") {
      const hash = await checkpoints.save("manual checkpoint");
      if (hash) {
        console.log(`Checkpoint saved: ${hash.slice(0, 7)}`);
      } else {
        console.log("No changes to save.");
      }
      continue;
    }

    if (input === "/restore files") {
      const result = await checkpoints.restore("files");
      if (result.restored) {
        console.log(`Workspace restored to checkpoint ${result.checkpointHash!.slice(0, 7)}.`);
      } else {
        console.log("No checkpoints to restore from.");
      }
      continue;
    }

    if (input === "/restore full --yes") {
      const result = await checkpoints.restore("full");
      if (result.restored) {
        console.log(`Workspace restored to checkpoint ${result.checkpointHash!.slice(0, 7)}.`);
      } else {
        console.log("No checkpoints to restore from.");
      }
      continue;
    }

    if (input === "/restore full") {
      console.log("Full restore is destructive. Use /restore full --yes to confirm.");
      continue;
    }

    if (input === "/checkpoints") {
      const entries = checkpoints.list();
      if (entries.length === 0) {
        console.log("No checkpoints recorded.");
      } else {
        for (const e of entries) {
          console.log(`  ${e.hash.slice(0, 7)}  ${e.message}  (${e.timestamp})`);
        }
      }
      continue;
    }

    if (input === "/sessions") {
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
      continue;
    }

    if (input === "/new") {
      sessionId = await sessionStore.create({
        cwd: process.cwd(),
        provider: process.env.HEIRLOOM_PROVIDER || "deepseek",
        model: args.model || "deepseek-chat",
        mode: activeMode?.slug || "code",
      });
      checkpoints = new CheckpointManager(sessionId);
      setCheckpointManager(checkpoints);
      setSessionId(sessionId);
      console.log("New session started.");
      continue;
    }

    try {
      const tools = activeMode?.groups ? registry.getByMode(activeMode.groups) : registry.getAllDefs();
      await sessionStore.appendMessage(sessionId, { role: "user", content: input });
      const result = await runAgent(input, {
        provider,
        tools,
        executeTool,
        permissions,
        mode: activeMode,
        compactor,
        diagnostics,
        skills,
        memory: memoryInjection ?? undefined,
        memoryStore,
        signal: abortController.signal,
        ...interactiveCallbacks,
      });
      for (const msg of result.slice(2)) {
        if (msg.role !== "system") {
          await sessionStore.appendMessage(sessionId, msg);
        }
      }

      await memoryStore.appendSession({
        date: new Date().toISOString().slice(0, 10),
        tasks: [input],
        decisions: [],
        files: [],
      });
    } catch (err) {
      console.error(`\nError: ${(err as Error).message}`);
    }
    console.log("");
  }
  rl.close();
}

main();
