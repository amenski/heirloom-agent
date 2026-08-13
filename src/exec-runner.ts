import { APICallError, RetryError } from "ai";
import { buildExecPrompt, type ExecInputStream } from "./exec-input.js";
import { runAgent } from "./agent.js";
import { buildRepoMap } from "./prompt.js";
import { executeTool, registry, setSessionId, setSignal, setTimeoutToBackground } from "./tools/index.js";
import { todoStore } from "./tools/todo.js";
import { initPresets, createProvider, getPreset } from "./providers/presets.js";
import { PermissionEngine } from "./permissions/index.js";
import { ErrorRecovery } from "./errorrecovery/index.js";
import { ErrorReflector } from "./selfreflection/index.js";
import { fireNotify } from "./notify.js";
import { HookRunner, fireNotificationHooks } from "./hooks/index.js";
import { Orchestrator } from "./orchestrator/index.js";
import { ModeLoader } from "./modes/loader.js";

export interface ExecRunnerOptions {
  prompt: string;
  projectRoot: string;
  resumeSessionId?: string;
  mode?: string;
  debug?: boolean;
  input?: ExecInputStream;
}

// All headless diagnostics go straight to process.stderr as single lines — never
// through console.error, which the AI SDK also uses for its full-object dump.
function writeErr(line: string): void {
  process.stderr.write(`${line}\n`);
}

// Turn an AI SDK / provider error into a single concise line: status code and the
// provider's own message when present, unwrapping the retry wrapper. The full
// object (stack, request body, headers) is only useful with --debug (B6).
function conciseProviderError(err: unknown): string {
  let e = err;
  if (RetryError.isInstance(e) && e.lastError) e = e.lastError;
  if (APICallError.isInstance(e)) {
    const status = e.statusCode ? `HTTP ${e.statusCode}: ` : "";
    return `${status}${e.message}`;
  }
  if (e instanceof Error) return e.message;
  return String(e);
}

export async function runExecMode(options: ExecRunnerOptions): Promise<number> {
  initPresets();
  let interrupted = false;

  const handleSigint = () => {
    interrupted = true;
  };
  process.on("SIGINT", handleSigint);

  // The AI SDK's streamText installs a default onError that does
  // `console.error(error)`, dumping the entire error object (stack, request
  // body, headers) before the failure surfaces through our own catch (B6). In
  // headless mode we want a single concise line, so we suppress that dump unless
  // --debug is set. Our own output uses process.stderr directly, so silencing
  // console.error does not touch it. Restored in `finally`.
  const originalConsoleError = console.error;
  if (!options.debug) {
    console.error = () => {};
  }

  try {
    const { loadConfig } = await import("./config/loader.js");
    const configResult = loadConfig(options.projectRoot);
    const configEnv = configResult.config.env;
    const notifyScript = configResult.config.notify;
    // commands.timeoutToBackground (plan §3, default ON) — same default
    // resolution the TUI uses; run_bash migration works identically headless.
    setTimeoutToBackground(configResult.config.commands?.timeoutToBackground ?? true);

    const resolvedApiKey = configEnv?.API_KEY || undefined;
    const resolvedBaseUrl = configEnv?.BASE_URL || undefined;

    let providerName = configResult.config.provider || "deepseek";
    let activeModel: string | undefined = configResult.config.model ?? configEnv?.MODEL ?? undefined;

    if (options.resumeSessionId) {
      activeModel = undefined;
    }

    // Validate the requested mode before touching the provider so a typo fails
    // with a clear "unknown mode" message instead of silently proceeding or
    // crashing later (B1/D7). Loaded lazily to avoid the cost when no --mode.
    if (options.mode) {
      const modeLoader = new ModeLoader();
      const resolved = await modeLoader.load(options.mode, options.projectRoot);
      if (!resolved) {
        const available = (await modeLoader.listAll(options.projectRoot)).map((m) => m.slug).sort();
        writeErr(`Error: unknown mode "${options.mode}", available: ${available.join(", ")}`);
        return 1;
      }
    }

    // createProvider throws for an unknown provider or a missing API key. In
    // headless mode that must be a clean one/two-line message telling the user
    // what to do (run `heirloom auth`), not a raw Node stack trace (B1).
    let provider;
    try {
      provider = createProvider(providerName, {
        modelOverride: activeModel,
        baseUrl: resolvedBaseUrl,
        apiKey: resolvedApiKey,
      });
    } catch (err) {
      writeErr(`Error: ${(err as Error).message}`);
      return 1;
    }

    let prompt: string;
    try {
      prompt = await buildExecPrompt(options.prompt, options.input ?? process.stdin);
    } catch (err) {
      writeErr(`Error: ${(err as Error).message}`);
      return 1;
    }
    if (interrupted) return 130;

    const abortController = new AbortController();
    setSignal(abortController.signal);

    // Same construction the TUI uses (cli.tsx). Headless mode does not remove
    // the permission engine — explicit allow rules and defaultMode still apply,
    // and the destructive-tier deny stays absolute. It only removes the human:
    // any rule resolving to `ask` (including the guarded tier and unresolved
    // bash segments) has no one to prompt, so the askUser below fails closed —
    // it denies and prints one stderr line so a scripted user knows why a run
    // did less than expected. See docs/permission-spec.md § Headless Interaction.
    const permissions = new PermissionEngine(
      configResult.config.permissions,
      options.projectRoot,
      Object.keys(configResult.config.mcpServers ?? {}).length > 0,
    );

    // Lifecycle hooks (hooks-spec.md): headless mode skips untrusted project
    // hooks with a stderr warning at startup (fail closed, like skills).
    const hooks = new HookRunner({
      config: configResult.config.hooks,
      disableAllHooks: configResult.config.disableAllHooks,
      headless: true,
      debug: options.debug,
      cwd: options.projectRoot,
      sessionId: () => options.resumeSessionId,
      getPermissionMode: () => "headless",
    });
    hooks.verifyTrust();
    const askUser = async (toolName: string, args: Record<string, unknown>): Promise<boolean> => {
      const subject =
        toolName === "run_bash"
          ? String(args?.command ?? "")
          : String(args?.path ?? args?.filePath ?? args?.query ?? "");
      writeErr(`permission denied (headless): ${toolName} ${subject}`);
      return false;
    };

    // Orchestrator mode (9.3): register once per headless run so `-p` prompts
    // can use new_task too. Sub-agents inherit this run's provider, permission
    // engine (rules + approval posture — no escalation, 24.3), and the
    // fail-closed headless askUser above. getSignal forwards the run's
    // AbortController so SIGINT/Ctrl+C cancels an in-flight sub-agent.
    const orchestrator = new Orchestrator({
      provider: () => provider,
      registry,
      modeLoader: new ModeLoader(),
      permissions,
      askUser,
      getSignal: () => abortController.signal,
      hooks,
    });
    orchestrator.register(registry);

    // Notify hook fires from this completion boundary (turn outcome is
    // definitively known here) for headless `-x` runs, mirroring the
    // interactive site in cli.tsx. Fire-and-forget — see src/notify.ts.
    const notifyStart = Date.now();
    const notifyTitle = options.prompt.slice(0, 120);
    // Repository map: computed once per headless run, injected into the stable
    // preamble. Degrades to undefined (no map) on any failure — never crashes.
    const repomapInjection = (await buildRepoMap(options.projectRoot)) ?? undefined;

    // SessionStart fires once at startup, after the trust check, before the
    // first turn (hooks-spec.md §2).
    await hooks.dispatch("SessionStart", {});

    // UserPromptSubmit fires before the message enters the agent; a block
    // means the message is not sent and the user is notified (headless: one
    // stderr line + non-zero exit). Exit-0 stdout appends to the prompt.
    const ups = await hooks.dispatch("UserPromptSubmit", { prompt });
    if (ups.blocked) {
      writeErr("UserPromptSubmit hook blocked the message");
      return 1;
    }
    const finalPrompt = ups.stdout.trim() !== "" ? `${prompt}\n\n${ups.stdout.trimEnd()}` : prompt;

    try {
      // Layered failure handling (self-reflection + error recovery). Both
      // engage only on error paths inside runAgent — a failed tool result
      // triggers one reflection retry, malformed tool-call JSON or a fatal
      // turn exception triggers recovery — so the happy path is unaffected.
      // Constructed once per headless run so the reflector's total-retry
      // budget spans the whole session.
      const result = await runAgent(finalPrompt, {
        provider,
        tools: registry.getAllDefs(),
        executeTool,
        permissions,
        askUser,
        repomap: repomapInjection,
        signal: abortController.signal,
        errorReflector: new ErrorReflector(),
        errorRecovery: new ErrorRecovery(),
        getTodos: () => todoStore.getTodos(),
        hooks,
      });

      if (interrupted) return 130;

      const lastReply = result.messages[result.messages.length - 1]?.content ?? "";
      process.stdout.write(lastReply);
      const completedNotifyInput = {
        status: "completed" as const,
        durationMs: Date.now() - notifyStart,
        body: lastReply,
        title: notifyTitle,
      };
      fireNotify(
        notifyScript,
        { ...completedNotifyInput, passthroughEnv: configEnv },
        { debug: options.debug },
      );
      // Notification hooks fire alongside the notify script (hooks-spec.md §7);
      // SessionEnd fires immediately after, before teardown.
      fireNotificationHooks(hooks, completedNotifyInput);
      await hooks.dispatch("SessionEnd", {});
      return result.stopReason === "done" ? 0 : 1;
    } catch (err) {
      if (interrupted) return 130;
      if (options.debug) {
        originalConsoleError(err);
      }
      const reason = conciseProviderError(err);
      writeErr(`Error: ${reason}`);
      const failedNotifyInput = {
        status: "failed" as const,
        durationMs: Date.now() - notifyStart,
        body: "",
        title: notifyTitle,
        failReason: reason,
      };
      fireNotify(
        notifyScript,
        { ...failedNotifyInput, passthroughEnv: configEnv },
        { debug: options.debug },
      );
      fireNotificationHooks(hooks, failedNotifyInput);
      await hooks.dispatch("SessionEnd", {});
      return 1;
    }
  } finally {
    console.error = originalConsoleError;
    process.off("SIGINT", handleSigint);
  }
}
