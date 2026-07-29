import { resolve, relative, dirname } from "node:path";
import { realpathSync, existsSync } from "node:fs";

export type PermissionAction = "allow" | "ask" | "deny";

export interface PermissionRule {
  tool: string;
  pattern?: string;
  action: PermissionAction;
}

export type ApprovalMode = "manual" | "edits" | "all";

const GUARDED_PATTERNS = [
  { tool: "run_bash", pattern: /^(curl|wget|nc|ssh|scp|ftp|sftp|telnet|rsync|nmap)\b/ },
  { tool: "run_bash", pattern: /rm\s+(-\w*r\w*f\w*|--recursive)/ },
  { tool: "run_bash", pattern: /\bsudo\b/ },
  { tool: "run_bash", pattern: /git\s+(push\s+--force|reset\s+--hard)/ },
  { tool: "read_file", pattern: /\.env[.\w]*$/ },
  { tool: "read_file", pattern: /id_rsa[.\w]*$/ },
  { tool: "read_file", pattern: /\.pem$/ },
  { tool: "read_file", pattern: /\.ssh\// },
  { tool: "read_file", pattern: /\.aws\// },
  { tool: "read_file", pattern: /credentials\.yaml$/ },
  { tool: "read_file", pattern: /credentials\.json$/ },
  { tool: "run_bash", pattern: /cat\s+.*\.env/ },
  { tool: "run_bash", pattern: /cat\s+.*\/\.ssh\// },
  { tool: "run_bash", pattern: /cat\s+.*\/\.aws\// },
];

const CHAIN_OPERATORS = /(\n|&&|\|\||[;|](?![=|>]))/;

function splitCommands(command: string): string[] {
  return command
    .split(CHAIN_OPERATORS)
    .map((s) => s.trim())
    .filter(Boolean);
}

function hasSubshell(command: string): boolean {
  return /\$\(.*?\)/.test(command) || /`[^`]+`/.test(command);
}

function realpathUpToExisting(absPath: string): string {
  if (existsSync(absPath)) return realpathSync(absPath);
  let current = absPath;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const ancestorReal = realpathSync(current);
  return ancestorReal + absPath.slice(current.length);
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
      if (/^(&&|\|\||[;|])$/.test(segment)) continue;

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
