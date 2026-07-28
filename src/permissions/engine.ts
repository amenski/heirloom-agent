export type PermissionAction = "allow" | "ask" | "deny";

export interface PermissionRule {
  tool: string;
  pattern?: string;
  action: PermissionAction;
}

export class PermissionEngine {
  private rules: PermissionRule[] = [];

  constructor(rules: PermissionRule[]) {
    this.rules = rules;
  }

  check(tool: string, args: Record<string, unknown>): PermissionAction {
    let result: PermissionAction = "ask";
    for (const rule of this.rules) {
      if (!this.matchTool(rule.tool, tool)) continue;
      if (rule.pattern && !this.matchPattern(rule.pattern, args)) continue;
      result = rule.action;
    }
    return result;
  }

  private matchTool(ruleTool: string, tool: string): boolean {
    if (ruleTool === "*") return true;
    return ruleTool === tool;
  }

  private matchPattern(pattern: string, args: Record<string, unknown>): boolean {
    const target = (args.command as string) || (args.path as string) || (args.filePath as string) || JSON.stringify(args);
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

  static defaults(): PermissionEngine {
    return new PermissionEngine([
      { tool: "*", action: "ask" },
    ]);
  }
}
