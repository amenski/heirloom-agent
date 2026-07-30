import { buildExecPrompt, type ExecInputStream } from "./exec-input.js";
import { runAgent } from "./agent.js";
import { executeTool, registry, setSessionId, setSignal } from "./tools/index.js";
import { initPresets, createProvider, getPreset } from "./providers/presets.js";

export interface ExecRunnerOptions {
  prompt: string;
  projectRoot: string;
  resumeSessionId?: string;
  input?: ExecInputStream;
}

export async function runExecMode(options: ExecRunnerOptions): Promise<number> {
  initPresets();
  let interrupted = false;

  const handleSigint = () => {
    interrupted = true;
  };
  process.on("SIGINT", handleSigint);

  try {
    const { loadConfig } = await import("./config/loader.js");
    const configResult = loadConfig(options.projectRoot);
    const configEnv = configResult.config.env;

    const resolvedApiKey = configEnv?.API_KEY || undefined;
    const resolvedBaseUrl = configEnv?.BASE_URL || undefined;

    let providerName = configResult.config.provider || "deepseek";
    let activeModel: string | undefined = configResult.config.model ?? configEnv?.MODEL ?? undefined;

    if (options.resumeSessionId) {
      activeModel = undefined;
    }

    const provider = createProvider(providerName, {
      modelOverride: activeModel,
      baseUrl: resolvedBaseUrl,
      apiKey: resolvedApiKey,
    });

    const prompt = await buildExecPrompt(options.prompt, options.input ?? process.stdin);
    if (interrupted) return 130;

    const abortController = new AbortController();
    setSignal(abortController.signal);

    try {
      const result = await runAgent(prompt, {
        provider,
        tools: registry.getAllDefs(),
        executeTool,
        signal: abortController.signal,
      });

      if (interrupted) return 130;

      process.stdout.write(result.messages[result.messages.length - 1]?.content ?? "");
      return result.stopReason === "done" ? 0 : 1;
    } catch (err) {
      if (interrupted) return 130;
      process.stderr.write(`Error: ${(err as Error).message}\n`);
      return 1;
    }
  } finally {
    process.off("SIGINT", handleSigint);
  }
}
