import { resolve, relative, dirname, basename } from "node:path";
import { realpathSync, existsSync, lstatSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";

export type PermissionAction = "allow" | "ask" | "deny";

export interface PermissionRule {
  tool: string;
  pattern?: string;
  action: PermissionAction;
}

export type ApprovalMode = "manual" | "edits" | "all";

// Command names that are always guarded (never silently allowed by `all`
// mode), matched against the BASENAME of every command-position token in a
// bash invocation — case-insensitively. See normalizeCommandTokens().
const EGRESS_COMMANDS = new Set([
  "curl", "wget", "nc", "ssh", "scp", "ftp", "sftp", "telnet", "rsync", "nmap",
]);

// Wrappers/builtins that don't themselves do anything guarded — the token(s)
// after them are what matter, so they're skipped rather than treated as the
// invoked command.
const COMMAND_WRAPPERS = new Set(["command", "builtin", "exec", "xargs", "sudo"]);

// Secret-adjacent filename suffixes/exact-names, matched against the
// normalized basename (see normalizePath()).
const SECRET_BASENAME_PATTERNS = [
  /^\.env([.\w]*)?$/,
  /^id_rsa[.\w]*$/,
  /\.pem$/,
  /^credentials\.yaml$/,
  /^credentials\.json$/,
];

const GUARDED_PATTERNS = [
  { tool: "run_bash", pattern: /\bsudo\b/ },
  { tool: "run_bash", pattern: /git\s+(push\s+--force|reset\s+--hard)/ },
  { tool: "read_file", pattern: /\.ssh\// },
  { tool: "read_file", pattern: /\.aws\// },
  { tool: "run_bash", pattern: /cat\s+.*\/\.ssh\// },
  { tool: "run_bash", pattern: /cat\s+.*\/\.aws\// },
];

const CHAIN_OPERATORS = /(\n|&&|\|\||&(?!&)|[;|](?![=|>]))/;

function splitCommands(command: string): string[] {
  return command
    .split(CHAIN_OPERATORS)
    .map((s) => s.trim())
    .filter(Boolean);
}

function hasSubshell(command: string): boolean {
  return (
    /\$\(.*?\)/.test(command) ||
    /`[^`]+`/.test(command) ||
    /[<>]\(/.test(command)
  );
}

// Splits a bash command into whitespace-separated tokens and returns the
// basenames of every "command position" token: the first token, plus the
// token immediately following a wrapper/builtin (command/builtin/exec/xargs/
// sudo) or a leading env-assignment (FOO=bar). This lets a single unanchored
// scan catch `curl`, `/usr/bin/curl`, `FOO=bar curl`, `\curl`, `command curl`,
// and `echo x | xargs curl` alike.
//
// KNOWN LIMITATION (documented, not chased): this is static, pre-execution
// token inspection. Runtime shell variable expansion (`cat $AWS_DIR/credentials`,
// `$CMD arg`) is invisible here — the guarded name never appears as a literal
// token. That's an inherent limit of matching before the shell evaluates the
// command; catching it would require actually running (or emulating) the shell.
function normalizeCommandTokens(command: string): string[] {
  const rawTokens = command.trim().split(/\s+/).filter(Boolean);
  const commandTokens: string[] = [];
  let expectCommand = true;

  for (const raw of rawTokens) {
    let tok = raw;
    if (tok.startsWith("\\")) tok = tok.slice(1);

    if (expectCommand) {
      // Leading env-assignment: FOO=bar, FOO=, FOO="bar baz"
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) continue;

      const base = basename(tok).toLowerCase();
      if (COMMAND_WRAPPERS.has(base)) {
        // Wrapper itself isn't the invoked command; next token is.
        continue;
      }

      commandTokens.push(base);
      expectCommand = false;
      continue;
    }

    // After the first real command token, only wrapper tokens (e.g. xargs
    // mid-pipeline handled per-segment already, but `xargs curl` within the
    // same segment) put us back into "expect command" state.
    const base = basename(tok).toLowerCase();
    if (COMMAND_WRAPPERS.has(base)) {
      expectCommand = true;
    }
  }

  return commandTokens;
}

function hasEgressCommand(command: string): boolean {
  return normalizeCommandTokens(command).some((t) => EGRESS_COMMANDS.has(t));
}

// Trims whitespace, expands a leading ~, and returns the basename for
// suffix/exact-name matching against SECRET_BASENAME_PATTERNS.
function normalizePath(path: string): { full: string; base: string } {
  let p = path.trim();
  if (p === "~" || p.startsWith("~/")) {
    p = homedir() + p.slice(1);
  }
  return { full: p, base: basename(p) };
}

function isSecretPath(path: string): boolean {
  const { full, base } = normalizePath(path);
  if (full.includes(".ssh/") || full.includes(".aws/")) return true;
  return SECRET_BASENAME_PATTERNS.some((re) => re.test(base));
}

// Matches `rm` invoked with recursive deletion, regardless of flag order or
// splitting (-rf, -fr, -r -f, --recursive --force, -rfv, or bare -r/--recursive
// alone — recursive deletion is guarded on its own per existing intent).
function isRmRecursive(command: string): boolean {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  const rmIdx = tokens.findIndex((t) => basename(t).toLowerCase() === "rm");
  if (rmIdx === -1) return false;

  for (const tok of tokens.slice(rmIdx + 1)) {
    if (tok === "--recursive") return true;
    if (/^-\w+$/.test(tok) && /[rR]/.test(tok)) return true;
  }
  return false;
}

function realpathUpToExisting(absPath: string): string {
  if (existsSync(absPath)) return realpathSync(absPath);

  // Walk up looking for the nearest existing ancestor. `existsSync` follows
  // symlinks, so it reports false for a *dangling* symlink component too —
  // which would otherwise let the walk skip straight past it to its parent,
  // never noticing the symlink was there. Detect that case with `lstatSync`
  // (which does not follow the link) independent of target existence: if the
  // first non-existing path component is itself a symlink, resolve its
  // (possibly broken) target instead of silently continuing the walk.
  let current = absPath;
  while (!existsSync(current)) {
    try {
      if (lstatSync(current).isSymbolicLink()) {
        const target = resolveDanglingSymlink(current);
        return target + absPath.slice(current.length);
      }
    } catch {
      // current doesn't exist at all (not even as a broken symlink); keep walking up.
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const ancestorReal = realpathSync(current);
  return ancestorReal + absPath.slice(current.length);
}

// Resolves a dangling symlink's target to an absolute path, following
// intermediate ancestor symlinks where possible but without requiring the
// final target to exist.
function resolveDanglingSymlink(linkPath: string): string {
  const target = readlinkSync(linkPath);
  const parentReal = realpathUpToExisting(dirname(linkPath));
  return resolve(parentReal, target);
}

export class PermissionEngine {
  private rules: PermissionRule[] = [];
  private _approvalMode: ApprovalMode = "manual";
  private _sessionRules: PermissionRule[] = [];
  private _workingDir: string;
  private _isHeadless: boolean;

  constructor(workingDir?: string, isHeadless = false) {
    this._workingDir = workingDir ?? process.cwd();
    this._isHeadless = isHeadless;
  }

  clone(): PermissionEngine {
    const engine = new PermissionEngine(this._workingDir, this._isHeadless);
    engine.rules = [...this.rules];
    engine._approvalMode = this._approvalMode;
    engine._sessionRules = [...this._sessionRules];
    return engine;
  }

  get approvalMode(): ApprovalMode {
    return this._approvalMode;
  }

  setApprovalMode(mode: ApprovalMode): void {
    this._approvalMode = mode;
  }

  addRule(rule: PermissionRule): void {
    this.rules.push(rule);
  }

  addSessionRule(rule: PermissionRule): void {
    this._sessionRules.push(rule);
  }

  getSessionRules(): PermissionRule[] {
    return [...this._sessionRules];
  }

  check(tool: string, args?: Record<string, unknown>): PermissionAction {
    if (tool === "run_bash") {
      return this.checkBashCommand(String(args?.command ?? ""));
    }

    const action = this.matchRules(tool, args);

    if (action === "deny") return "deny";

    if (this.isGuarded(tool, args)) {
      if (action === "allow") return "allow";
      if (this._isHeadless) return "deny";
      return "ask";
    }

    return this.applyApprovalMode(tool, args, action);
  }

  private matchRules(
    tool: string,
    args?: Record<string, unknown>,
  ): PermissionAction {
    const allRules = [...this.rules, ...this._sessionRules];
    let action: PermissionAction = "ask";
    for (const rule of allRules) {
      if (!this.matchTool(rule.tool, tool)) continue;
      if (rule.pattern && args && !this.matchPattern(rule.pattern, args))
        continue;
      action = rule.action;
    }
    return action;
  }

  private applyApprovalMode(
    tool: string,
    args: Record<string, unknown> | undefined,
    action: PermissionAction,
  ): PermissionAction {
    if (action === "ask" && this._approvalMode !== "manual") {
      if (this._approvalMode === "all") {
        return "allow";
      }
      if (this._approvalMode === "edits") {
        if (this.isEditToolInWorkspace(tool, args)) {
          return "allow";
        }
      }
    }
    return action;
  }

  private checkBashCommand(command: string): PermissionAction {
    if (hasSubshell(command)) return "ask";

    const segments = splitCommands(command);

    if (segments.length <= 1) {
      const action = this.matchRules("run_bash", { command });

      if (action === "deny") return "deny";

      if (this.isGuarded("run_bash", { command })) {
        if (action === "allow") return "allow";
        if (this._isHeadless) return "deny";
        return "ask";
      }

      return this.applyApprovalMode("run_bash", { command }, action);
    }

    for (const segment of segments) {
      if (/^(&&|\|\||&|[;|])$/.test(segment)) continue;

      const segmentAction = this.matchRules("run_bash", {
        command: segment,
      });

      if (segmentAction === "deny") return "deny";

      if (this.isGuarded("run_bash", { command: segment })) {
        if (segmentAction === "allow") continue;
        if (this._isHeadless) return "deny";
        return "ask";
      }

      if (segmentAction !== "allow") {
        if (this._approvalMode === "all") continue;
        return "ask";
      }
    }

    return "allow";
  }

  private isGuarded(tool: string, args?: Record<string, unknown>): boolean {
    if (!args) return false;
    const path = String(args.path || args.filePath || "");
    const cmd = String(args.command || "");

    if (tool === "run_bash" && cmd) {
      if (hasEgressCommand(cmd)) return true;
      if (isRmRecursive(cmd)) return true;
      // `cat`/similar reads of secret-adjacent files inside a bash command:
      // check every token's normalized basename, not just literal `cat .env`.
      const tokens = cmd.trim().split(/\s+/).filter(Boolean);
      if (tokens.some((t) => isSecretPath(t))) return true;
    }

    if (tool === "read_file" && path) {
      if (isSecretPath(path)) return true;
    }

    for (const guard of GUARDED_PATTERNS) {
      if (guard.tool !== tool) continue;
      const target = guard.tool === "run_bash" ? cmd : path;
      if (guard.pattern.test(target)) return true;
    }
    return false;
  }

  private matchTool(ruleTool: string, tool: string): boolean {
    if (ruleTool === "*") return true;
    return ruleTool === tool;
  }

  private matchPattern(pattern: string, args: Record<string, unknown>): boolean {
    const target =
      (args.command as string) ||
      (args.path as string) ||
      (args.filePath as string) ||
      JSON.stringify(args);
    const regex = this.globToRegex(pattern);
    return regex.test(target);
  }

  private globToRegex(glob: string): RegExp {
    let re = glob
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".");
    return new RegExp(`^${re}$`);
  }

  private isEditToolInWorkspace(
    tool: string,
    args?: Record<string, unknown>,
  ): boolean {
    const editTools = [
      "edit",
      "edit_file",
      "write_to_file",
      "search_replace",
      "apply_diff",
      "apply_patch",
    ];
    if (!editTools.includes(tool)) return false;
    const path = args?.path as string;
    if (!path) return false;
    const absPath = resolve(this._workingDir, path);
    let targetReal: string;
    try {
      targetReal = realpathUpToExisting(absPath);
    } catch {
      return false;
    }
    let workspaceReal: string;
    try {
      workspaceReal = realpathUpToExisting(this._workingDir);
    } catch {
      return false;
    }
    const rel = relative(workspaceReal, targetReal);
    return rel !== "" && !rel.startsWith("..");
  }

  static defaults(workingDir?: string, isHeadless = false): PermissionEngine {
    const engine = new PermissionEngine(workingDir, isHeadless);
    engine.addRule({ tool: "*", action: "ask" });
    return engine;
  }
}
