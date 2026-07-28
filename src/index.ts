import * as readline from "node:readline/promises";
import { createDeepSeekProvider } from "./providers/deepseek.js";
import { runAgent } from "./agent.js";
import { executeTool, TOOL_DEFS } from "./tools/index.js";

async function main() {
  const provider = createDeepSeekProvider();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log("heirloom — type /exit to quit, /help for help\n");

  while (true) {
    const input = await rl.question("> ");
    if (!input.trim()) continue;
    if (input === "/exit") {
      console.log("Bye.");
      break;
    }
    if (input === "/help") {
      console.log(
        "Commands: /exit, /help, /mode <name>, /clear\n" +
          "Set DEEPSEEK_API_KEY to use.",
      );
      continue;
    }
    if (input === "/clear") {
      console.log("[cleared]");
      continue;
    }

    try {
      await runAgent(input, { provider, tools: TOOL_DEFS, executeTool });
    } catch (err) {
      console.error(`\nError: ${(err as Error).message}`);
    }
    console.log("");
  }
  rl.close();
}

main();
