import { resolve, relative } from "node:path";
import { realpathSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";

export type PermissionAction = "allow" | "ask" | "deny";

export type PermissionScope =
  | "read-in-cwd"
  | "read-out-cwd"
  | "write-in-cwd"
  | "write-out-cwd"
  | "delete-in-cwd"
  | "delete-out-cwd"
  | "query-git-log"
  | "mutate-git-log"
  | "network"
  | "mcp"
  | "scan";

export interface PermissionConfig {
  allow?: PermissionScope[];
  deny?: PermissionScope[];
  ask?: PermissionScope[];
  defaultMode?: "allowAll" | "askAll";
}

export class PermissionEngine {
  private allow: Set<PermissionScope>;
  private deny: Set<PermissionScope>;
  private ask: Set<PermissionScope>;
  private defaultMode: "allowAll" | "askAll";
  private workingDir: string;
  private projectConfigDir: string;
  /** Session-only override: when true, any scope that would "ask" is auto-allowed. Explicit deny still wins. */
  private autoApprove = false;

  constructor(config?: PermissionConfig, workingDir?: string) {
    // No config at all, or a config that omits `allow`, means the user never
    // stated an allow list: seed a safe default (read-in-cwd only) rather than
    // leaving everything to ask. If the user explicitly provided `allow`
    // (even `[]`), honor it verbatim — don't inject anything.
    this.allow = new Set(config?.allow ?? ["read-in-cwd"]);
    this.deny = new Set(config?.deny ?? []);
    this.ask = new Set(config?.ask ?? []);
    // Same precedence for defaultMode: only fall back to "askAll" when the
    // user didn't set one. An explicit defaultMode is always honored.
    this.defaultMode = config?.defaultMode ?? "askAll";
    this.workingDir = workingDir ?? process.cwd();
    this.projectConfigDir = join(this.workingDir, ".deepcode");
  }

  getDefaultMode(): "allowAll" | "askAll" {
    return this.defaultMode;
  }

  setAutoApprove(on: boolean): void {
    this.autoApprove = on;
  }

  isAutoApprove(): boolean {
    return this.autoApprove;
  }

  classifyScopes(toolName: string, args: Record<string, unknown>): PermissionScope[] {
    const pathArg = String(args?.path ?? args?.filePath ?? "");
    const cmd = String(args?.command ?? "");

    switch (toolName) {
      case "read_file":
      case "read": {
        if (!pathArg) return ["read-in-cwd"];
        return this.isInsideCwd(pathArg) ? ["read-in-cwd"] : ["read-out-cwd"];
      }

      case "write_to_file":
      case "write":
      case "edit":
      case "edit_file":
      case "search_replace":
      case "apply_diff":
      case "apply_patch": {
        if (!pathArg) return ["write-in-cwd"];
        return this.isInsideCwd(pathArg) ? ["write-in-cwd"] : ["write-out-cwd"];
      }

      case "list_files":
        return ["read-in-cwd"];

      case "glob":
      case "search":
        return ["scan"];

      case "run_bash":
        return this.classifyBashScopes(cmd);

      case "load_skill":
        return ["read-in-cwd"];

      default:
        if (toolName.startsWith("mcp__")) return ["mcp"];
        return [];
    }
  }

  private classifyBashScopes(command: string): PermissionScope[] {
    if (!command) return [];

    const scopes: PermissionScope[] = [];
    const tokens = command.trim().split(/\s+/).filter(Boolean);
    const baseTokens = tokens.map(t => basename(t).toLowerCase());

    if (tokens.some(t => t.includes("..") || t.startsWith("/") || t.startsWith("~"))) {
      const pathTokens = tokens.filter(t => t.includes("/") || t === ".." || t.startsWith("~"));
      for (const pt of pathTokens) {
        if (this.isInsideCwd(pt)) {
          if (!scopes.includes("read-in-cwd")) scopes.push("read-in-cwd");
        } else {
          if (!scopes.includes("read-out-cwd")) scopes.push("read-out-cwd");
        }
      }
    }

    if (baseTokens.some(t => ["cat", "head", "tail", "less", "more", "nl", "od", "xxd", "strings"].includes(t))) {
      scopes.push(this.isInsideCwdArg(command) ? "read-in-cwd" : "read-out-cwd");
    }

    if (baseTokens.some(t => ["rm", "rmdir", "unlink"].includes(t))) {
      scopes.push(this.isInsideCwdArg(command) ? "delete-in-cwd" : "delete-out-cwd");
    }

    const redirectMatch = command.match(/[>]{1,2}\s*(\S+)/);
    if (redirectMatch) {
      const target = redirectMatch[1];
      scopes.push(this.isInsideCwd(target) ? "write-in-cwd" : "write-out-cwd");
    }

    if (baseTokens.some(t => ["curl", "wget", "nc", "ssh", "scp", "sftp", "ftp", "telnet", "rsync", "nmap"].includes(t))) {
      scopes.push("network");
    }

    if (baseTokens.some(t => t.startsWith("git"))) {
      const hasLog = /\bgit\s+(log|show|diff|blame|reflog)\b/.test(command);
      const hasMutate = /\bgit\s+(commit|push|rebase|merge|reset|revert|fetch|pull|checkout\s+-b|branch\s+-[dD])\b/.test(command);
      if (hasLog) scopes.push("query-git-log");
      if (hasMutate) scopes.push("mutate-git-log");
    }

    if (baseTokens.some(t => ["npm", "npx", "yarn", "pnpm", "pip", "pip3", "cargo", "go"].includes(t))) {
      scopes.push("network");
    }

    const hasInstall = /\b(npm\s+(install|add|i)\b|yarn\s+add|pip\s+install|pip3\s+install|cargo\s+install|go\s+get)\b/.test(command);
    if (hasInstall) {
      if (!scopes.includes("write-in-cwd")) scopes.push("write-in-cwd");
      if (!scopes.includes("network")) scopes.push("network");
    }

    return scopes;
  }

  check(toolName: string, args?: Record<string, unknown>): PermissionAction {
    const scopes = this.classifyScopes(toolName, args ?? {});
    // Explicit deny always wins, even in auto-approve mode.
    for (const s of scopes) {
      if (this.deny.has(s)) return "deny";
    }
    // Auto-approve turns every non-denied call into an allow.
    if (this.autoApprove) return "allow";

    // scan (glob/search) always asks unless explicitly allowed
    if (scopes.includes("scan") && !this.allow.has("scan")) return "ask";

    if (scopes.length === 0) return "ask";
    for (const s of scopes) {
      if (this.ask.has(s)) return "ask";
    }
    for (const s of scopes) {
      if (!this.allow.has(s)) {
        return this.defaultMode === "allowAll" ? "allow" : "ask";
      }
    }
    return "allow";
  }

  persistAllow(scopes: PermissionScope[]): void {
    const settingsPath = join(this.projectConfigDir, "settings.json");
    let config: Record<string, unknown> = {};
    if (existsSync(settingsPath)) {
      try {
        config = JSON.parse(readFileSync(settingsPath, "utf-8"));
      } catch {}
    }
    const perms = (config.permissions as Record<string, unknown>) ?? {};
    const allow: string[] = [...(perms.allow as string[] ?? [])];
    const deny: string[] = [...(perms.deny as string[] ?? [])];
    const ask: string[] = [...(perms.ask as string[] ?? [])];

    for (const scope of scopes) {
      if (!allow.includes(scope)) allow.push(scope);
      const denyIdx = deny.indexOf(scope);
      if (denyIdx >= 0) deny.splice(denyIdx, 1);
      const askIdx = ask.indexOf(scope);
      if (askIdx >= 0) ask.splice(askIdx, 1);
      this.allow.add(scope);
      this.deny.delete(scope);
      this.ask.delete(scope);
    }

    config.permissions = { allow, deny, ask, defaultMode: this.defaultMode };

    if (!existsSync(this.projectConfigDir)) {
      mkdirSync(this.projectConfigDir, { recursive: true });
    }
    writeFileSync(settingsPath, JSON.stringify(config, null, 2), "utf-8");
  }

  private isInsideCwd(path: string): boolean {
    try {
      const abs = resolve(this.workingDir, path);
      const real = existsSync(abs) ? realpathSync(abs) : abs;
      const rel = relative(this.workingDir, real);
      return !rel.startsWith("..") && rel !== "";
    } catch {
      return false;
    }
  }

  private isInsideCwdArg(command: string): boolean {
    const tokens = command.trim().split(/\s+/).filter(Boolean);
    for (const t of tokens) {
      if (t.startsWith("-")) continue;
      if (t.startsWith("/") || t.startsWith("~")) return false;
      if (t.includes("..")) return false;
    }
    return true;
  }
}
