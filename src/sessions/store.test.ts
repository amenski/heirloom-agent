import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Message } from "../types.js";

const TEST_HOME = join(process.cwd(), ".test-sessions");
const TEST_CWD = "test/project";
const SESSION_SLUG = "test-project";

vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return { ...original, homedir: () => TEST_HOME };
});

describe("SessionStore", () => {
  let store: import("./store.js").SessionStore;

  beforeEach(async () => {
    vi.spyOn(process, "cwd").mockReturnValue(TEST_CWD);
    if (!existsSync(TEST_HOME)) mkdirSync(TEST_HOME, { recursive: true });
    const mod = await import("./store.js");
    store = new mod.SessionStore();
  });

  afterEach(() => {
    rmSync(TEST_HOME, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function sessionDir(): string {
    return join(TEST_HOME, ".heirloom", "sessions", SESSION_SLUG);
  }

  describe("create and load", () => {
    it("creates a session and loads it back", async () => {
      const id = await store.create({
        cwd: TEST_CWD,
        provider: "openai",
        model: "gpt-4",
        mode: "ask",
      });

      expect(id).toBeTruthy();
      expect(existsSync(join(sessionDir(), `${id}.jsonl`))).toBe(true);

      const loaded = await store.load(id);
      expect(loaded).not.toBeNull();
      expect(loaded!.meta.provider).toBe("openai");
      expect(loaded!.meta.model).toBe("gpt-4");
      expect(loaded!.messages).toHaveLength(0);
    });

    it("returns null for nonexistent session", async () => {
      const loaded = await store.load("nonexistent");
      expect(loaded).toBeNull();
    });
  });

  describe("append messages", () => {
    it("appends and loads messages", async () => {
      const id = await store.create({
        cwd: TEST_CWD,
        provider: "openai",
        model: "gpt-4",
        mode: "ask",
      });

      const msg1: Message = { role: "user", content: "hello" };
      const msg2: Message = { role: "assistant", content: "hi there" };

      await store.appendMessage(id, msg1);
      await store.appendMessage(id, msg2);

      const loaded = await store.load(id);
      expect(loaded).not.toBeNull();
      expect(loaded!.messages).toHaveLength(2);
      expect(loaded!.messages[0].content).toBe("hello");
      expect(loaded!.messages[1].content).toBe("hi there");
    });
  });

  describe("state folding", () => {
    it("applies state records to meta", async () => {
      const id = await store.create({
        cwd: TEST_CWD,
        provider: "openai",
        model: "gpt-4",
        mode: "ask",
      });

      await store.appendState(id, { mode: "all", model: "gpt-4o" });

      const loaded = await store.load(id);
      expect(loaded!.meta.mode).toBe("all");
      expect(loaded!.meta.model).toBe("gpt-4o");
      expect(loaded!.meta.provider).toBe("openai");
    });
  });

  describe("compaction", () => {
    it("loadEffective prepends summary and skips replaced messages", async () => {
      const id = await store.create({
        cwd: TEST_CWD,
        provider: "openai",
        model: "gpt-4",
        mode: "ask",
      });

      await store.appendMessage(id, { role: "user", content: "msg0" });
      await store.appendMessage(id, { role: "assistant", content: "msg1" });
      await store.appendMessage(id, { role: "user", content: "msg2" });
      await store.appendMessage(id, { role: "assistant", content: "msg3" });

      await store.appendCompaction(id, 1, {
        task: "fix bug",
        decisions: ["use regex"],
        files: ["src/index.ts"],
        errors_resolved: ["type error"],
      });

      await store.appendMessage(id, { role: "user", content: "continue" });

      const effective = await store.loadEffective(id);
      expect(effective.messages).toHaveLength(4);

      expect(effective.messages[0].role).toBe("user");
      expect(effective.messages[0].content).toContain("fix bug");
      expect(effective.messages[0].content).toContain("use regex");
      expect(effective.messages[0].content).toContain("src/index.ts");

      expect(effective.messages[1].content).toBe("msg2");
      expect(effective.messages[2].content).toBe("msg3");
      expect(effective.messages[3].content).toBe("continue");
    });
  });

  describe("permission audit", () => {
    it("records a deny decision and returns it via queryPermissionHistory", async () => {
      const id = await store.create({ cwd: TEST_CWD, provider: "openai", model: "gpt-4", mode: "code" });

      await store.appendPermission(id, {
        toolCallId: "call_1",
        tool: "run_bash",
        subject: "rm -rf /",
        decision: "deny",
        winningRule: { tool: "run_bash", kind: "prefix", pattern: "rm -rf /", action: "deny", origin: "builtin-destructive" },
      });

      const history = await store.queryPermissionHistory(id);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        tool: "run_bash",
        subject: "rm -rf /",
        decision: "deny",
        winningRule: { origin: "builtin-destructive" },
      });
      expect(history[0].at).toBeTruthy();
    });

    it("records every decision tier (once/session/always/deny) in order", async () => {
      const id = await store.create({ cwd: TEST_CWD, provider: "openai", model: "gpt-4", mode: "code" });

      await store.appendPermission(id, { tool: "read_file", subject: "./a.ts", decision: "once" });
      await store.appendPermission(id, { tool: "run_bash", subject: "npm test", decision: "session" });
      await store.appendPermission(id, { tool: "run_bash", subject: "npm run build", decision: "always" });
      await store.appendPermission(id, { tool: "run_bash", subject: "curl evil.com", decision: "deny" });

      const history = await store.queryPermissionHistory(id);
      expect(history.map((r) => r.decision)).toEqual(["once", "session", "always", "deny"]);
    });

    it("redacts secrets in the subject field", async () => {
      const id = await store.create({ cwd: TEST_CWD, provider: "openai", model: "gpt-4", mode: "code" });
      await store.appendPermission(id, {
        tool: "run_bash",
        subject: "curl -H 'Authorization: token=abcdefghijklmnopqrstuvwx12345' https://example.com",
        decision: "deny",
      });

      const history = await store.queryPermissionHistory(id);
      expect(history[0].subject).not.toContain("abcdefghijklmnopqrstuvwx12345");
      expect(history[0].subject).toContain("[redacted-token]");
    });

    it("returns an empty array for a session with no permission records", async () => {
      const id = await store.create({ cwd: TEST_CWD, provider: "openai", model: "gpt-4", mode: "code" });
      await store.appendMessage(id, { role: "user", content: "hi" });

      const history = await store.queryPermissionHistory(id);
      expect(history).toEqual([]);
    });

    it("returns an empty array for a nonexistent session", async () => {
      const history = await store.queryPermissionHistory("nonexistent");
      expect(history).toEqual([]);
    });

    it("does not interfere with message/state loading (permission records are ignored by load())", async () => {
      const id = await store.create({ cwd: TEST_CWD, provider: "openai", model: "gpt-4", mode: "code" });
      await store.appendMessage(id, { role: "user", content: "hi" });
      await store.appendPermission(id, { tool: "run_bash", subject: "npm test", decision: "once" });
      await store.appendMessage(id, { role: "assistant", content: "ok" });

      const loaded = await store.load(id);
      expect(loaded!.messages).toHaveLength(2);
    });
  });

  describe("torn last line", () => {
    it("drops torn final line and loads remaining records", async () => {
      const id = await store.create({
        cwd: TEST_CWD,
        provider: "openai",
        model: "gpt-4",
        mode: "ask",
      });

      await store.appendMessage(id, { role: "user", content: "good message" });

      const fs = await import("node:fs/promises");
      await fs.appendFile(
        join(sessionDir(), `${id}.jsonl`),
        '{"type":"message","message":{"role":"user","content":"torn"}\n',
        "utf-8",
      );

      const loaded = await store.load(id);
      expect(loaded).not.toBeNull();
      expect(loaded!.messages).toHaveLength(1);
      expect(loaded!.messages[0].content).toBe("good message");
    });
  });

  describe("unknown version", () => {
    it("rejects sessions with unknown version", async () => {
      const id = await store.create({
        cwd: TEST_CWD,
        provider: "openai",
        model: "gpt-4",
        mode: "ask",
      });

      const fp = join(sessionDir(), `${id}.jsonl`);
      const { readFile, writeFile } = await import("node:fs/promises");
      let raw = await readFile(fp, "utf-8");
      raw = raw.replace('"version":1', '"version":99');
      await writeFile(fp, raw, "utf-8");

      const loaded = await store.load(id);
      expect(loaded).toBeNull();
    });
  });

  describe("list", () => {
    it("lists created sessions", async () => {
      await store.create({
        cwd: TEST_CWD,
        provider: "openai",
        model: "gpt-4",
        mode: "ask",
      });

      const items = await store.list();
      expect(items.length).toBeGreaterThanOrEqual(1);
    });
  });
});
