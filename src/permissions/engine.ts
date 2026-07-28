import { resolve } from "node:path";

export type PermissionAction = "allow" | "ask" | "deny";

export interface PermissionRule {
  tool: string;
  pattern?: string;
  action: PermissionAction;
}

export type ApprovalMode = "manual" | "edits" | "all";

export class PermissionEngine {
  private rules: PermissionRule[] = [];
  private _approvalMode: ApprovalMode = "manual";
  private _sessionRules: PermissionRule[] = [];
  private _workingDir: string;

  constructor(workingDir?: string) {
    this._workingDir = workingDir ?? process.cwd();
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
    const allRules = [...this.rules, ...this._sessionRules];
    let action: PermissionAction = "ask";
    for (const rule of allRules) {
      if (!this.matchTool(rule.tool, tool)) continue;
      if (rule.pattern && args && !this.matchPattern(rule.pattern, args)) continue;
      action = rule.action;
    }

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
    const resolved = resolve(path);
    return resolved.startsWith(this._workingDir);
  }

  static defaults(workingDir?: string): PermissionEngine {
    const engine = new PermissionEngine(workingDir);
    engine.addRule({ tool: "*", action: "ask" });
    return engine;
  }
}
