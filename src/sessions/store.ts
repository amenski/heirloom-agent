import { appendFile, mkdir, readFile, readdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Message } from "../types.js";
import { redactSecrets } from "./redact.js";

const KNOWN_VERSION = 1;

export interface SessionMeta {
  version: 1;
  id: string;
  cwd: string;
  createdAt: string;
  provider: string;
  model: string;
  mode: string;
}

export interface CompactionSummary {
  task: string;
  decisions: string[];
  files: string[];
  errors_resolved: string[];
}

/**
 * Canonical agent-emitted decision vocabulary (one per resolution path in
 * src/agent.ts). Each value names exactly how a tool call was resolved:
 *   allow-by-rule    — a user/config allow rule matched, no prompt shown
 *   allow-by-posture — auto-approve posture let an ordinary ask through (UI-side; agent-side approximation, see note)
 *   ask-approved     — an interactive prompt was answered yes
 *   ask-denied       — an interactive prompt was answered no
 *   deny-by-rule     — a deny rule matched (destructive/guarded/config)
 *   headless-deny    — resolved to ask but no interactive prompter was available
 *   unresolved-ask   — a bash segment couldn't be safely classified (fail-closed ask)
 *
 * The four legacy values ("once" | "session" | "always" | "deny") are still
 * accepted for backward compatibility: the TUI (src/ui/App.tsx) writes those
 * finer-grained values for interactively-answered prompts, and old sessions on
 * disk carry them. Readers must tolerate both sets.
 */
export type PermissionDecision =
  | "allow-by-rule"
  | "allow-by-posture"
  | "ask-approved"
  | "ask-denied"
  | "deny-by-rule"
  | "headless-deny"
  | "unresolved-ask"
  // legacy / UI-side fine-grained values, still valid on read + write:
  | "deny"
  | "once"
  | "session"
  | "always";

export interface PermissionAuditRecord {
  toolCallId?: string;
  tool: string;
  /** The literal command/path text the decision was made against, redacted. */
  subject: string;
  decision: PermissionDecision;
  /** The rule that produced this outcome, if any (absent for a fallthrough-to-defaultMode ask/allow). */
  winningRule?: { tool: string; kind: string; pattern: string; action: string; origin: string };
  /** Human-readable note on why this decision was reached (e.g. "denied by user at prompt"). */
  reason?: string;
}

export interface TokenUsageRecord {
  /** Tokens attributable to this turn (input + output from the provider usage event). */
  turnTokens: number;
  /** Current context occupancy, matching what compaction measures (estimateTokens of live messages). */
  totalUsed: number;
  /** The context-window ceiling this session is budgeted against. */
  budgetMax: number;
}

export interface SessionRecord {
  type: "meta" | "message" | "state" | "compaction" | "permission" | "token";
  at: string;
  [key: string]: unknown;
}

export interface LoadedSession {
  meta: SessionMeta;
  messages: Message[];
}

export interface SessionListItem {
  id: string;
  firstMessage: string;
  messageCount: number;
  createdAt: string;
}

function generateId(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
  const hex = Math.random().toString(16).slice(2, 6);
  return `${ts}-${hex}`;
}

function slugify(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-");
}

function formatCompactionText(summary: CompactionSummary): string {
  const parts: string[] = [];
  parts.push(`[Earlier in this conversation]\nTask: ${summary.task}`);
  if (summary.decisions.length > 0) {
    parts.push(
      `\nDecisions:\n${summary.decisions.map((d) => "- " + d).join("\n")}`,
    );
  }
  if (summary.files.length > 0) {
    parts.push(
      `\nFiles:\n${summary.files.map((f) => "- " + f).join("\n")}`,
    );
  }
  if (summary.errors_resolved.length > 0) {
    parts.push(
      `\nErrors resolved:\n${summary.errors_resolved
        .map((e) => "- " + e)
        .join("\n")}`,
    );
  }
  return parts.join("\n");
}

export class SessionStore {
  private _cwd: string;

  constructor() {
    this._cwd = process.cwd();
  }

  private get slug(): string {
    return slugify(this._cwd);
  }

  private get sessionDir(): string {
    return join(homedir(), ".heirloom", "sessions", this.slug);
  }

  private filePath(sessionId: string): string {
    return join(this.sessionDir, `${sessionId}.jsonl`);
  }

  async create(
    meta: Omit<SessionMeta, "id" | "createdAt" | "version">,
  ): Promise<string> {
    const id = generateId();
    const createdAt = new Date().toISOString();
    await mkdir(this.sessionDir, { recursive: true });
    const record = { type: "meta" as const, version: 1, id, createdAt, ...meta };
    await appendFile(this.filePath(id), JSON.stringify(record) + "\n");
    return id;
  }

  async append(
    sessionId: string,
    record: Omit<SessionRecord, "at">,
  ): Promise<void> {
    await mkdir(this.sessionDir, { recursive: true });
    const full: SessionRecord = {
      ...record,
      at: new Date().toISOString(),
    } as SessionRecord;
    await appendFile(this.filePath(sessionId), JSON.stringify(full) + "\n");
  }

  async appendMessage(sessionId: string, message: Message): Promise<void> {
    const safeContent =
      typeof message.content === "string"
        ? redactSecrets(message.content)
        : message.content;
    const safeMessage = { ...message, content: safeContent };
    await this.append(sessionId, { type: "message", message: safeMessage });
  }

  async appendState(
    sessionId: string,
    state: Record<string, unknown>,
  ): Promise<void> {
    await this.append(sessionId, { type: "state", ...state });
  }

  async appendCompaction(
    sessionId: string,
    replacesThrough: number,
    summary: CompactionSummary,
  ): Promise<void> {
    const safeSummary: CompactionSummary = {
      task: redactSecrets(summary.task),
      decisions: summary.decisions.map((d) => redactSecrets(d)),
      files: summary.files.map((f) => redactSecrets(f)),
      errors_resolved: summary.errors_resolved.map((e) => redactSecrets(e)),
    };
    await this.append(sessionId, {
      type: "compaction",
      replacesThrough,
      summary: safeSummary,
    });
  }

  async appendPermission(sessionId: string, record: PermissionAuditRecord): Promise<void> {
    await this.append(sessionId, {
      type: "permission",
      ...record,
      subject: redactSecrets(record.subject),
      ...(record.reason !== undefined ? { reason: redactSecrets(record.reason) } : {}),
    });
  }

  /** Returns every permission decision recorded for a session, in chronological order. */
  async queryPermissionHistory(sessionId: string): Promise<(PermissionAuditRecord & { at: string })[]> {
    const records = await this.readRecords(sessionId);
    if (!records) return [];
    return records
      .filter((r) => r.type === "permission")
      .map((r) => r as unknown as PermissionAuditRecord & { at: string });
  }

  async appendToken(sessionId: string, record: TokenUsageRecord): Promise<void> {
    await this.append(sessionId, { type: "token", ...record });
  }

  /**
   * Returns every per-turn token-usage row for a session, in chronological
   * order. `remaining` is computed here (budgetMax - totalUsed), never stored.
   */
  async queryTokenUsage(
    sessionId: string,
  ): Promise<(TokenUsageRecord & { at: string; remaining: number })[]> {
    const records = await this.readRecords(sessionId);
    if (!records) return [];
    return records
      .filter((r) => r.type === "token")
      .map((r) => {
        const rec = r as unknown as TokenUsageRecord & { at: string };
        return { ...rec, remaining: rec.budgetMax - rec.totalUsed };
      });
  }

  private async readRecords(sessionId: string): Promise<SessionRecord[] | null> {
    const fp = this.filePath(sessionId);
    let raw: string;
    try {
      raw = await readFile(fp, "utf-8");
    } catch {
      return null;
    }

    const lines = raw.split("\n").filter((l) => l.trim() !== "");
    if (lines.length === 0) return null;

    const records: SessionRecord[] = [];
    for (let i = 0; i < lines.length; i++) {
      try {
        records.push(JSON.parse(lines[i]));
      } catch {
        if (i === lines.length - 1) {
          console.warn(
            `[session] Torn final line in ${sessionId}, dropping`,
          );
        }
      }
    }

    return records.length > 0 ? records : null;
  }

  async load(sessionId: string): Promise<LoadedSession | null> {
    const records = await this.readRecords(sessionId);
    if (!records) return null;

    const first = records[0];
    if (first.type !== "meta") {
      console.error(
        `[session] ${sessionId}: first record is not meta, got ${first.type}`,
      );
      return null;
    }

    if (first.version !== KNOWN_VERSION) {
      console.error(
        `[session] ${sessionId}: unknown version ${first.version} (known: ${KNOWN_VERSION})`,
      );
      return null;
    }

    let meta: SessionMeta = {
      version: first.version as 1,
      id: first.id as string,
      cwd: first.cwd as string,
      createdAt: first.createdAt as string,
      provider: first.provider as string,
      model: first.model as string,
      mode: first.mode as string,
    };

    for (const rec of records) {
      if (rec.type === "state") {
        if (rec.mode !== undefined) meta = { ...meta, mode: rec.mode as string };
        if (rec.model !== undefined)
          meta = { ...meta, model: rec.model as string };
        if (rec.provider !== undefined)
          meta = { ...meta, provider: rec.provider as string };
      }
    }

    const messages: Message[] = [];
    for (const rec of records) {
      if (rec.type === "message" && rec.message) {
        messages.push(rec.message as Message);
      }
    }

    return { meta, messages };
  }

  async loadEffective(
    sessionId: string,
  ): Promise<{ meta: SessionMeta; messages: Message[] }> {
    const loaded = await this.load(sessionId);
    if (!loaded) throw new Error(`Session not found: ${sessionId}`);

    const records = await this.readRecords(sessionId);
    if (!records) throw new Error(`Session not found: ${sessionId}`);

    let lastCompaction: {
      replacesThrough: number;
      summary: CompactionSummary;
    } | null = null;
    for (const rec of records) {
      if (rec.type === "compaction") {
        lastCompaction = rec as unknown as {
          replacesThrough: number;
          summary: CompactionSummary;
        };
      }
    }

    if (!lastCompaction) {
      return loaded;
    }

    const summaryMsg: Message = {
      role: "user",
      content: formatCompactionText(lastCompaction.summary),
    };

    const effectiveMessages = [
      summaryMsg,
      ...loaded.messages.slice(lastCompaction.replacesThrough + 1),
    ];

    return { meta: loaded.meta, messages: effectiveMessages };
  }

  async getMessageCount(sessionId: string): Promise<number> {
    const records = await this.readRecords(sessionId);
    if (!records) return 0;
    let count = 0;
    for (const rec of records) {
      if (rec.type === "message") count++;
    }
    return count;
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    try {
      await unlink(this.filePath(sessionId));
      return true;
    } catch {
      return false;
    }
  }

  async getSummary(sessionId: string): Promise<string | undefined> {
    const records = await this.readRecords(sessionId);
    if (!records) return undefined;
    for (const rec of records) {
      if (rec.type === "state" && typeof rec.summary === "string") {
        return rec.summary as string;
      }
    }
    return undefined;
  }

  async list(): Promise<SessionListItem[]> {
    let entries: string[];
    try {
      entries = await readdir(this.sessionDir);
    } catch {
      return [];
    }

    const results: SessionListItem[] = [];

    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) continue;
      const sessionId = entry.replace(/\.jsonl$/, "");
      const fp = this.filePath(sessionId);

      let raw: string;
      try {
        raw = await readFile(fp, "utf-8");
      } catch {
        continue;
      }

      const lines = raw.split("\n").filter((l) => l.trim() !== "");
      if (lines.length === 0) continue;

      let meta: SessionMeta | null = null;
      let firstMessage = "";
      let messageCount = 0;

      for (const line of lines) {
        let rec: SessionRecord;
        try {
          rec = JSON.parse(line);
        } catch {
          continue;
        }

        if (rec.type === "meta" && !meta) {
          meta = {
            version: rec.version as 1,
            id: rec.id as string,
            cwd: rec.cwd as string,
            createdAt: rec.createdAt as string,
            provider: rec.provider as string,
            model: rec.model as string,
            mode: rec.mode as string,
          };
        } else if (rec.type === "message") {
          messageCount++;
          if (!firstMessage && rec.message) {
            const msg = rec.message as Message;
            if (msg.role === "user") {
              firstMessage = (msg.content || "").slice(0, 60);
            }
          }
        }
      }

      if (!meta) continue;

      results.push({
        id: meta.id,
        firstMessage,
        messageCount,
        createdAt: meta.createdAt,
      });
    }

    results.sort((a, b) => b.id.localeCompare(a.id));
    return results;
  }
}
