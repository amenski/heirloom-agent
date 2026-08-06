import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

export interface CheckpointEntry {
  hash: string;
  message: string;
  timestamp: string;
}

// Explicit `-c` overrides applied to every shadow-repo git invocation so the
// checkpoint machinery never depends on — and can never be subverted by — the
// ambient global/system git config. Without an explicit identity, `git commit`
// aborts on any machine lacking a global user.name/user.email (e.g. CI), which
// silently broke checkpointing. The remaining overrides neutralize hostile or
// exotic global config that could otherwise block commits (commit.gpgsign),
// execute arbitrary code (core.hooksPath), or corrupt content (autocrlf).
const GIT_CONFIG_OVERRIDES = [
  "-c", "user.name=heirloom",
  "-c", "user.email=heirloom@local",
  "-c", "commit.gpgsign=false",
  "-c", "tag.gpgsign=false",
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.autocrlf=false",
  "-c", "core.fileMode=false",
  "-c", "init.defaultBranch=main",
];

const execFileAsync = promisify(execFile);

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

  private async initialize(): Promise<void> {
    if (this.initialized) return;

    if (!existsSync(this.shadowDir)) {
      mkdirSync(this.shadowDir, { recursive: true });
      await execFileAsync("git", [...GIT_CONFIG_OVERRIDES, "init"], { cwd: this.shadowDir });

      const exclude = [
        ".git",
        "node_modules/",
        "*.bin", "*.exe", "*.dll", "*.so", "*.dylib",
        "*.zip", "*.tar", "*.gz", "*.7z", "*.rar",
        "*.png", "*.jpg", "*.jpeg", "*.gif", "*.ico", "*.webp",
        "*.mp3", "*.mp4", "*.avi", "*.mov",
        "*.ttf", "*.otf", "*.woff", "*.woff2",
        // Secret-adjacent backstop: excluded regardless of the workspace's own
        // .gitignore (which the shadow repo otherwise relies on via
        // --work-tree). Defense-in-depth only — this reduces but does not
        // eliminate T3 (session transcripts are still plaintext elsewhere).
        ".env", ".env.*", "*.pem", "*.key", "id_rsa", "id_rsa.*",
        "id_dsa*", "id_ecdsa*", "id_ed25519*",
        "credentials.yaml", "credentials.json",
        ".aws/**", ".ssh/**", "*.p12", "*.pfx",
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

  // Async by hard-won necessity, not style. The 2026-08-06 stall profile
  // (FOLLOWUPS §0) caught execSync here blocking the main thread for 475ms
  // during a mid-turn checkpoint — the "dots freeze / input stalls / catches
  // up" symptom that survived three earlier wrong diagnoses. Same disease the
  // git-status poll had before 08-04, in the organ nobody checked.
  //
  // execFile with an args ARRAY (no shell) also closes an injection hole the
  // shell string had: the commit message derives from raw prompt text, and the
  // old escaping handled `"` but not `$(…)` or backticks.
  private async git(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync(
      "git",
      [
        ...GIT_CONFIG_OVERRIDES,
        `--work-tree=${this.workspaceDir}`,
        `--git-dir=${join(this.shadowDir, ".git")}`,
        ...args,
      ],
      { maxBuffer: 10 * 1024 * 1024 },
    );
    return stdout.trim();
  }

  private async gitSilent(args: string[]): Promise<string | null> {
    try {
      return await this.git(args);
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
      await this.initialize();

      const status = await this.gitSilent(["status", "--porcelain"]);
      if (!status) return null;

      await this.git(["add", "-A"]);

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const commitMsg = message ?? `checkpoint ${timestamp}`;
      // Passed verbatim as ONE argv entry — no shell, no escaping, no injection.
      await this.git(["commit", "-m", commitMsg]);

      return await this.git(["rev-parse", "HEAD"]);
    } catch {
      return null;
    } finally {
      release!();
    }
  }

  async restore(type: "files" | "full"): Promise<{ restored: boolean; checkpointHash?: string }> {
    await this.initialize();

    const hash = await this.gitSilent(["rev-parse", "HEAD"]);
    if (!hash) {
      return { restored: false };
    }

    try {
      await this.git(["checkout", "HEAD", "--", "."]);
    } catch {
      return { restored: false };
    }

    return { restored: true, checkpointHash: hash };
  }

  async restoreFrom(hash: string): Promise<{ restored: boolean; checkpointHash?: string }> {
    await this.initialize();

    try {
      await this.git(["checkout", hash, "--", "."]);
    } catch {
      return { restored: false };
    }

    return { restored: true, checkpointHash: hash };
  }

  async list(): Promise<CheckpointEntry[]> {
    await this.initialize();

    const output = await this.gitSilent(["log", "--format=%H|||%s|||%ci"]);
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
