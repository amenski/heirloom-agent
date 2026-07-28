import * as readline from "node:readline/promises";
import { initPresets, createProvider } from "./providers/presets.js";
import { runAgent } from "./agent.js";
import { executeTool, TOOL_DEFS, registry, setSessionId, setCheckpointManager } from "./tools/index.js";
import { PermissionEngine } from "./permissions/index.js";
import { ModeLoader, type ModeConfig } from "./modes/loader.js";
import { Compactor } from "./compaction/compactor.js";
import { CheckpointManager } from "./checkpoints/index.js";
import { DiagnosticRunner } from "./diagnostics/index.js";
import { authWizard, authList, authLogout } from "./auth/wizard.js";
import { SessionStore } from "./sessions/store.js";
import type { Message } from "./types.js";

function parseArgs(): { continue: boolean; sessionId?: string } {
  const args = process.argv.slice(2);
  let continue_ = false;
  let sessionId: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--continue" || args[i] === "-c") continue_ = true;
    if (args[i] === "--session" && i + 1 < args.length) sessionId = args[++i];
  }
  return { continue: continue_, sessionId };
}

async function main() {
  initPresets();

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

  const cliArgs = parseArgs();

  if (cliArgs.sessionId) {
    try {
      const loaded = await sessionStore.loadEffective(cliArgs.sessionId);
      sessionId = cliArgs.sessionId;
      sessionMessages = loaded.messages;
      console.log(`Resumed ${sessionId} · ${sessionMessages.length} messages · mode: ${loaded.meta.mode}`);
    } catch {
      console.error(`Session not found: ${cliArgs.sessionId}`);
      process.exit(1);
    }
  } else if (cliArgs.continue) {
    const sessions = await sessionStore.list();
    if (sessions.length > 0) {
      sessionId = sessions[0].id;
      try {
        const loaded = await sessionStore.loadEffective(sessionId);
        sessionMessages = loaded.messages;
        console.log(`Resumed ${sessionId} · ${sessionMessages.length} messages · mode: ${loaded.meta.mode}`);
      } catch (err) {
        console.error(`Failed to load session ${sessionId}: ${(err as Error).message}`);
        process.exit(1);
      }
    } else {
      console.log("No sessions found for this project. Starting new.");
      sessionId = await sessionStore.create({ 
        cwd: process.cwd(), 
        provider: process.env.HEIRLOOM_PROVIDER || "deepseek",
        model: "deepseek-chat",
        mode: "code"
      });
    }
  } else {
    sessionId = await sessionStore.create({
      cwd: process.cwd(),
      provider: process.env.HEIRLOOM_PROVIDER || "deepseek",
      model: "deepseek-chat",
      mode: "code",
    });
  }

  let checkpoints = new CheckpointManager(sessionId);
  const diagnostics = new DiagnosticRunner();
  setSessionId(sessionId);
  setCheckpointManager(checkpoints);

  let activeMode: ModeConfig | undefined;

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

  while (true) {
    const input = await rl.question(prompt());
    if (!input.trim()) continue;

    if (input === "/exit") {
      console.log("Bye.");
      break;
    }

    if (input === "/help") {
      console.log(
        "Commands: /exit, /help, /mode <name>, /clear, /modes, /sessions, /new, /approve [manual|edits|all], /checkpoint, /restore [files|full], /checkpoints\n" +
          "Set HEIRLOOM_PROVIDER to choose provider (default: deepseek). Set DEEPSEEK_API_KEY to use the default.",
      );
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
        model: "deepseek-chat",
        mode: activeMode?.slug || "code",
      });
      checkpoints = new CheckpointManager(sessionId);
      setCheckpointManager(checkpoints);
      setSessionId(sessionId);
      console.log("New session started.");
      continue;
    }

    try {
      const tools = activeMode?.groups ? registry.getByMode(activeMode.groups) : TOOL_DEFS;
      await sessionStore.appendMessage(sessionId, { role: "user", content: input });
      const result = await runAgent(input, {
        provider,
        tools,
        executeTool,
        permissions,
        mode: activeMode,
        compactor,
        diagnostics,
      });
      for (const msg of result.slice(2)) {
        if (msg.role !== "system") {
          await sessionStore.appendMessage(sessionId, msg);
        }
      }
    } catch (err) {
      console.error(`\nError: ${(err as Error).message}`);
    }
    console.log("");
  }
  rl.close();
}

main();
