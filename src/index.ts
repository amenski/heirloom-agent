import * as readline from "node:readline/promises";
import { createDeepSeekProvider } from "./providers/deepseek.js";
import { runAgent } from "./agent.js";
import { executeTool, TOOL_DEFS, registry, setSessionId, setCheckpointManager } from "./tools/index.js";
import { PermissionEngine } from "./permissions/index.js";
import { ModeLoader, type ModeConfig } from "./modes/loader.js";
import { Compactor } from "./compaction/compactor.js";
import { CheckpointManager } from "./checkpoints/index.js";

async function main() {
  const provider = createDeepSeekProvider();
  const modeLoader = new ModeLoader();
  const permissions = PermissionEngine.defaults();
  const compactor = new Compactor(provider);

  const sessionId = `session-${Date.now()}`;
  const checkpoints = new CheckpointManager(sessionId);
  setSessionId(sessionId);
  setCheckpointManager(checkpoints);

  let activeMode: ModeConfig | undefined;

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const prompt = () => activeMode ? `heirloom [${activeMode.name}] > ` : "heirloom > ";
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
        "Commands: /exit, /help, /mode <name>, /clear, /modes, /checkpoint, /restore [files|full], /checkpoints\n" +
          "Set DEEPSEEK_API_KEY to use.",
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
        console.log(`Switched to ${mode.name} mode.`);
      } else {
        console.log(`Unknown mode: ${slug}. Try /modes to list available modes.`);
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

    try {
      const tools = activeMode?.groups ? registry.getByMode(activeMode.groups) : TOOL_DEFS;
      await runAgent(input, {
        provider,
        tools,
        executeTool,
        permissions,
        mode: activeMode,
        compactor,
      });
    } catch (err) {
      console.error(`\nError: ${(err as Error).message}`);
    }
    console.log("");
  }
  rl.close();
}

main();
