import type { Argv } from "yargs";
import Yargs from "yargs";
import { hideBin } from "yargs/helpers";

const SESSION_ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidSessionId(value: string): boolean {
  return SESSION_ID_REGEX.test(value);
}

export type ResumeArg = string | true | undefined;

export interface ParsedCliArgs {
  prompt: string | undefined;
  exec: boolean;
  resume: ResumeArg;
  version: boolean;
  help: boolean;
  last: boolean;
  model: string | undefined;
  mode: string | undefined;
  debug: boolean;
}

const EPILOG = [
  "Configuration:",
  "  ~/.deepcode/settings.json    User-level API key, model, base URL",
  "  ./.deepcode/settings.json    Project-level settings",
  "",
  "Inside the TUI:",
  "  enter            Send the prompt",
  "  shift+enter      Insert a newline",
  "  shift+tab        Toggle askAll mode",
  "  home/end         Move within the current line",
  "  alt+left/right   Move by word",
  "  ctrl+w           Delete the previous word",
  "  esc              Interrupt the current model turn",
  "  /                Open the commands menu",
  "  /skills          List available skills",
  "  /model           Select model, thinking mode and effort control",
  "  /new             Start a fresh conversation",
  "  /resume          Pick a previous conversation to continue",
  "  /continue        Continue the active conversation, or resume one if empty",
  "  /undo            Restore code and/or conversation to a previous point",
  "  /mcp             Show MCP server status and available tools",
  "  /exit            Quit",
  "  ctrl+d twice     Quit",
].join("\n");

async function configureYargs(argv?: string[]) {
  const rawArgv = argv ?? hideBin(process.argv);
  return Yargs(rawArgv)
    .locale("en")
    .scriptName("heirloom")
    .usage("Usage: $0 [options] [command]\n\nHeirloom - Launch the interactive CLI or run one prompt with --exec")
    .command("$0 [query..]", "Launch Heirloom CLI", (yargsInstance: Argv) =>
      yargsInstance
        .option("prompt", { alias: "p", type: "string", describe: "Submit a prompt on launch" })
        .option("exec", { alias: "x", type: "boolean", default: false, describe: "Run one prompt non-interactively (requires --prompt)" })
        .option("resume", { alias: "r", type: "string", describe: "Resume a specific session by its ID. Use without an ID to show session picker." })
        .option("last", { alias: "l", type: "boolean", default: false, describe: "Resume the most recent session for the current project directory." })
        .option("model", { type: "string", describe: "Override config model (provider/model)" })
        .option("mode", { type: "string", describe: "Start in the given mode" })
        .option("debug", { type: "boolean", default: false, describe: "Write redacted request/response JSONL" })
        .check((argv: Record<string, unknown>) => {
          const query = argv["query"] as string | string[] | undefined;
          const hasPositionalQuery = Array.isArray(query) ? query.length > 0 : !!query;
          const prompt = argv["prompt"] as string | undefined;
          const exec = argv["exec"] === true;

          if (prompt && hasPositionalQuery) return "Cannot use both a positional prompt and the --prompt (-p) flag together";
          if (argv["resume"] === "" && prompt) return "Cannot use --resume without a session ID together with --prompt.";
          if (argv["last"] === true && argv["resume"] !== undefined) return "Cannot use --last together with --resume.";
          if (argv["resume"] && argv["resume"] !== "" && !isValidSessionId(argv["resume"] as string))
            return `Invalid session ID: "${argv["resume"]}". Must be a valid UUID.`;
          if (prompt !== undefined && prompt.trim() === "") return "--prompt / -p requires a non-empty value.";
          if (exec && (prompt === undefined || prompt.trim() === "")) return "--exec / -x requires a non-empty --prompt / -p value.";
          return true;
        })
    )
    .example("heirloom", "Launch the interactive TUI")
    .example("heirloom -p <prompt>", "Launch and submit a prompt")
    .example("heirloom -x -p <prompt>", "Run one prompt without launching the TUI")
    .example("heirloom -r [sessionId]", "Resume a session or show session picker")
    .example('cat error.log | heirloom -x -p "Explain this error"', "Use piped stdin as additional context")
    .epilog(EPILOG)
    .strict()
    .demandCommand(0, 0)
    .wrap(Math.min(process.stdout.columns || 80, 120));
}

export async function parseArguments(argv?: string[]): Promise<ParsedCliArgs> {
  const y = (await configureYargs(argv))
    .exitProcess(false)
    .fail((msg, err, yargs) => {
      process.stderr.write((msg || err?.message || "Unknown error") + "\n");
      yargs.showHelp();
      process.exit(1);
    })
    .version("1.0.0")
    .alias("v", "version")
    .help()
    .alias("h", "help");

  const parsed = y.parseSync() as Record<string, unknown>;

  const resumeRaw = parsed.resume as string | undefined;
  let resume: ResumeArg;
  if (resumeRaw === undefined) resume = undefined;
  else if (resumeRaw === "") resume = true;
  else resume = resumeRaw;

  return {
    prompt: parsed.prompt as string | undefined,
    exec: parsed.exec === true,
    resume,
    version: parsed.version === true,
    help: parsed.help === true,
    last: parsed.last === true,
    model: parsed.model as string | undefined,
    mode: parsed.mode as string | undefined,
    debug: parsed.debug === true,
  };
}
