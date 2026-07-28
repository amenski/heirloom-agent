import { execSync } from "node:child_process";
import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

export interface CheckpointEntry {
  hash: string;
  message: string;
  timestamp: string;
}

export class CheckpointManager {
  private shadowDir: string;
  private workspaceDir: string;
  private initialized = false;
  private _lock: Promise<void> = Promise.resolve();

  constructor(sessionId: string, workspaceDir?: string) {
    this.workspaceDir = resolve(workspaceDir ?? process.cwd());
    this.shadowDir = join(homedir(), ".heirloom", "checkpoints", sessionId);
  }

  get workspace(): string {
    return this.workspaceDir;
  }

  private initialize(): void {
    if (this.initialized) return;

    if (!existsSync(this.shadowDir)) {
      mkdirSync(this.shadowDir, { recursive: true });
      execSync("git init", { cwd: this.shadowDir, stdio: "pipe" });

      const exclude = [
        ".git",
        "node_modules/",
        "*.bin", "*.exe", "*.dll", "*.so", "*.dylib",
        "*.zip", "*.tar", "*.gz", "*.7z", "*.rar",
        "*.png", "*.jpg", "*.jpeg", "*.gif", "*.ico", "*.webp",
        "*.mp3", "*.mp4", "*.avi", "*.mov",
        "*.ttf", "*.otf", "*.woff", "*.woff2",
        "",
      ].join("\n");

      try {
        appendFileSync(join(this.shadowDir, ".git", "info", "exclude"), exclude);
      } catch {
        // info/exclude might not exist after git init; skip silently
      }
    }

    this.initialized = true;
  }

  private git(args: string): string {
    return execSync(
      `git --work-tree="${this.workspaceDir}" --git-dir="${this.shadowDir}/.git" ${args}`,
      { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, stdio: "pipe" },
    ).trim();
  }

  private gitSilent(args: string): string | null {
    try {
      return this.git(args);
    } catch {
      return null;
    }
  }

  async save(message?: string): Promise<string | null> {
    const prev = this._lock;
    let release: () => void;
    this._lock = new Promise<void>((r) => { release = r; });
    await prev;

    try {
      this.initialize();

      const status = this.gitSilent("status --porcelain");
      if (!status) return null;

      this.git("add -A");

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const commitMsg = message ?? `checkpoint ${timestamp}`;
      this.git(`commit -m "${commitMsg.replace(/"/g, '\\"')}"`);

      return this.git("rev-parse HEAD");
    } catch {
      return null;
    } finally {
      release!();
    }
  }

  async restore(type: "files" | "full"): Promise<{ restored: boolean; checkpointHash?: string }> {
    this.initialize();

    const hash = this.gitSilent("rev-parse HEAD");
    if (!hash) {
      return { restored: false };
    }

    try {
      this.git("checkout HEAD -- .");
    } catch {
      return { restored: false };
    }

    return { restored: true, checkpointHash: hash };
  }

  list(): CheckpointEntry[] {
    this.initialize();

    const output = this.gitSilent('log --format="%H|||%s|||%ci"');
    if (!output) return [];

    return output.split("\n").map((line) => {
      const [hash, message, timestamp] = line.split("|||");
      return {
        hash: hash ?? "",
        message: message ?? "",
        timestamp: timestamp ?? "",
      };
    });
  }
}
