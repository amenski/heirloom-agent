import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { ProfileEvaluator, authorize, compileGlob } from "./profile.js";
import type { PermissionProfileConfig } from "./profile.js";
import { PermissionEngine, type PermissionRule } from "./engine.js";
import { SessionStore, type PermissionDecision } from "../sessions/store.js";

const CWD = "/workspace";
const HOME = homedir();

function evaluator(
  level: PermissionProfileConfig["level"],
  config?: Partial<Omit<PermissionProfileConfig, "level">>,
): ProfileEvaluator {
  return new ProfileEvaluator({ level, ...config }, CWD);
}

function rule(partial: Partial<PermissionRule>): PermissionRule {
  return { tool: "run_bash", kind: "any", pattern: "", action: "allow", origin: "config", ...partial };
}

describe("ProfileEvaluator.decide — level defaults (§3 table)", () => {
  it("strict-sandbox: read-only any path, network denied", () => {
    const ev = evaluator("strict-sandbox");
    expect(ev.decide("read_file", { path: "/workspace/src/main.ts" })).toBe("allow");
    expect(ev.decide("read_file", { path: "/etc/passwd" })).toBe("allow");
    expect(ev.decide("read_file", { path: join(HOME, "notes", "a.txt") })).toBe("allow");
    expect(ev.decide("edit", { filePath: "/workspace/src/main.ts" })).toBe("deny");
    expect(ev.decide("write_to_file", { path: "/tmp/x" })).toBe("deny");
    expect(ev.decide("web_fetch", { url: "https://api.deepseek.com/v1" })).toBe("deny");
    expect(ev.decide("web_fetch", { url: "not-a-url" })).toBe("deny");
    expect(ev.decide("web_search", { query: "hello" })).toBe("deny");
  });

  it("workspace-write: read anywhere, write only inside workspace roots, network default-deny", () => {
    const ev = evaluator("workspace-write");
    expect(ev.decide("read_file", { path: "/etc/passwd" })).toBe("allow");
    expect(ev.decide("write_to_file", { path: "/workspace/src/main.ts" })).toBe("allow");
    expect(ev.decide("edit", { filePath: "/workspace/src/main.ts" })).toBe("allow");
    expect(ev.decide("write_to_file", { path: "/tmp/x" })).toBe("deny");
    expect(ev.decide("write_to_file", { path: join(HOME, "x") })).toBe("deny");
    expect(ev.decide("web_fetch", { url: "https://api.deepseek.com/v1" })).toBe("deny");
    expect(ev.decide("web_search", { query: "hello" })).toBe("deny"); // bing not allowlisted
  });

  it("unrestricted: read + write anywhere, network default-allow", () => {
    const ev = evaluator("unrestricted");
    expect(ev.decide("read_file", { path: "/etc/passwd" })).toBe("allow");
    expect(ev.decide("write_to_file", { path: "/tmp/x" })).toBe("allow");
    expect(ev.decide("edit", { filePath: "/workspace/src/main.ts" })).toBe("allow");
    expect(ev.decide("web_fetch", { url: "https://api.deepseek.com/v1" })).toBe("allow");
    expect(ev.decide("web_search", { query: "hello" })).toBe("allow");
  });

  it("tools outside the §7 map pass through at every level", () => {
    const ev = evaluator("strict-sandbox");
    expect(ev.decide("run_bash", { command: "rm -rf /" })).toBe("allow");
    expect(ev.decide("mcp__something", {})).toBe("allow");
    expect(ev.decide("attempt_completion", { result: "x" })).toBe("allow");
  });

  it("a file tool called with no path has nothing to gate", () => {
    const ev = evaluator("strict-sandbox");
    expect(ev.decide("glob", { pattern: "**/*.ts" })).toBe("allow");
    expect(ev.decide("edit", {})).toBe("allow");
  });
});

describe("ProfileEvaluator.decide — explicit fs rules narrow only (§3)", () => {
  it("a deny rule blocks reads and writes at any level", () => {
    const ev = evaluator("workspace-write", { fs: [{ path: "**/*.env", action: "deny" }] });
    expect(ev.decide("read_file", { path: "/workspace/.env" })).toBe("deny");
    expect(ev.decide("read_file", { path: "/workspace/src/.env" })).toBe("deny");
    expect(ev.decide("write_to_file", { path: "/workspace/src/.env" })).toBe("deny");
    expect(ev.decide("read_file", { path: "/workspace/src/main.ts" })).toBe("allow");
  });

  it("a deny rule beats the level default allowance (narrowing)", () => {
    const ev = evaluator("workspace-write", { fs: [{ path: "src/**", action: "deny" }] });
    // Level default would allow this write; the deny rule narrows it away.
    expect(ev.decide("write_to_file", { path: "/workspace/src/a.ts" })).toBe("deny");
    expect(ev.decide("write_to_file", { path: "/workspace/lib/b.ts" })).toBe("allow");
  });

  it("a read rule grants nothing beyond the level default — it never enables a write", () => {
    const fs = [{ path: "~/notes/**", action: "read" as const }];
    expect(evaluator("workspace-write", { fs }).decide("write_to_file", { path: join(HOME, "notes", "a.txt") })).toBe("deny");
    expect(evaluator("strict-sandbox", { fs }).decide("write_to_file", { path: join(HOME, "notes", "a.txt") })).toBe("deny");
    // and it never restricts either — reads stay allowed everywhere
    expect(evaluator("strict-sandbox", { fs }).decide("read_file", { path: "/etc/passwd" })).toBe("allow");
  });

  it("a write rule is honored where the level permits writes (it carves within the default)", () => {
    const ev = evaluator("workspace-write", { fs: [{ path: "src/**", action: "write" }] });
    expect(ev.decide("write_to_file", { path: "/workspace/src/a.ts" })).toBe("allow");
    expect(evaluator("unrestricted", { fs: [{ path: "/tmp/**", action: "write" }] }).decide("write_to_file", { path: "/tmp/x" })).toBe("allow");
  });

  it("home-relative deny rules match home paths but not workspace paths", () => {
    const ev = evaluator("strict-sandbox", { fs: [{ path: "~/notes/**", action: "deny" }] });
    expect(ev.decide("read_file", { path: join(HOME, "notes", "a.txt") })).toBe("deny");
    expect(ev.decide("read_file", { path: "/workspace/notes/a.txt" })).toBe("allow");
  });

  it("an absolute deny rule matches absolute canonical paths only", () => {
    const ev = evaluator("strict-sandbox", { fs: [{ path: "/tmp/**", action: "deny" }] });
    expect(ev.decide("read_file", { path: "/tmp/x" })).toBe("deny");
    expect(ev.decide("read_file", { path: "/workspace/tmp/x" })).toBe("allow");
  });
});

describe("ProfileEvaluator.decide — always denied by construction (§3)", () => {
  for (const level of ["strict-sandbox", "workspace-write", "unrestricted"] as const) {
    it(`denies .git/** at level ${level}`, () => {
      const ev = evaluator(level);
      expect(ev.decide("read_file", { path: "/workspace/.git/config" })).toBe("deny");
      expect(ev.decide("read_file", { path: "/workspace/vendor/.git/HEAD" })).toBe("deny");
      expect(ev.decide("write_to_file", { path: "/workspace/.git/config" })).toBe("deny");
      expect(ev.decide("read_file", { path: "/workspace/.gitignore" })).toBe("allow");
    });

    it(`denies the profile file at level ${level}`, () => {
      const ev = evaluator(level);
      expect(ev.decide("read_file", { path: "/workspace/.heirloom/settings.json" })).toBe("deny");
      expect(ev.decide("read_file", { path: join(HOME, ".heirloom", "settings.json") })).toBe("deny");
    });
  }
});

describe("ProfileEvaluator.decide — network allow/deny semantics", () => {
  it("deny beats allow when a domain is in both lists", () => {
    const ev = evaluator("workspace-write", {
      network: { allow: ["api.deepseek.com"], deny: ["api.deepseek.com"] },
    });
    expect(ev.decide("web_fetch", { url: "https://api.deepseek.com/v1" })).toBe("deny");
  });

  it('"*" matches any host (allowlist mode)', () => {
    const ev = evaluator("workspace-write", {
      network: { allow: ["api.deepseek.com"], deny: ["*"] },
    });
    expect(ev.decide("web_fetch", { url: "https://api.deepseek.com/v1" })).toBe("allow");
    expect(ev.decide("web_fetch", { url: "https://evil.com/x" })).toBe("deny");
  });

  it("matching is exact and case-insensitive; subdomains are not implied", () => {
    const ev = evaluator("workspace-write", { network: { allow: ["API.Deepseek.COM"] } });
    expect(ev.decide("web_fetch", { url: "https://api.deepseek.com/v1" })).toBe("allow");
    const sub = evaluator("workspace-write", { network: { allow: ["deepseek.com"] } });
    expect(sub.decide("web_fetch", { url: "https://api.deepseek.com/v1" })).toBe("deny");
  });

  it("deny entries narrow at unrestricted; allow entries are inert there", () => {
    const ev = evaluator("unrestricted", { network: { deny: ["evil.com"] } });
    expect(ev.decide("web_fetch", { url: "https://evil.com/x" })).toBe("deny");
    expect(ev.decide("web_fetch", { url: "https://ok.com/x" })).toBe("allow");
    expect(evaluator("unrestricted", { network: { allow: ["x.com"] } }).decide("web_fetch", { url: "https://y.com" })).toBe("allow");
  });

  it("allow entries are inert under strict-sandbox (level denies all network)", () => {
    const ev = evaluator("strict-sandbox", { network: { allow: ["api.deepseek.com"] } });
    expect(ev.decide("web_fetch", { url: "https://api.deepseek.com/v1" })).toBe("deny");
  });

  it("web_search is evaluated against the pinned search host (web-search-spec.md §2)", () => {
    expect(evaluator("strict-sandbox").decide("web_search", { query: "x" })).toBe("deny");
    expect(evaluator("workspace-write").decide("web_search", { query: "x" })).toBe("deny");
    expect(
      evaluator("workspace-write", { network: { allow: ["www.bing.com"] } }).decide("web_search", { query: "x" }),
    ).toBe("allow");
    expect(evaluator("unrestricted").decide("web_search", { query: "x" })).toBe("allow");
  });

  it("an unparsable web_fetch URL fails closed below unrestricted", () => {
    expect(evaluator("strict-sandbox").decide("web_fetch", { url: "not-a-url" })).toBe("deny");
    expect(evaluator("workspace-write", { network: { allow: ["*"] } }).decide("web_fetch", { url: "not-a-url" })).toBe("deny");
    expect(evaluator("unrestricted").decide("web_fetch", { url: "not-a-url" })).toBe("allow");
  });
});

describe("compileGlob", () => {
  it("rejects empty and character-class patterns", () => {
    expect(() => compileGlob("")).toThrow("empty");
    expect(() => compileGlob("foo[bar")).toThrow("character classes");
    expect(() => compileGlob("foo[ab]")).toThrow("character classes");
  });

  it("matches workspace-relative patterns against the ./rel canonical form", () => {
    expect(compileGlob("**/*.env").test("./.env")).toBe(true);
    expect(compileGlob("**/*.env").test("./src/.env")).toBe(true);
    expect(compileGlob("**/*.env").test("./src/main.ts")).toBe(false);
    expect(compileGlob("src/**").test("./src/a.ts")).toBe(true);
    expect(compileGlob("./src/**").test("./src/a.ts")).toBe(true);
    expect(compileGlob("src/**").test("~/src/a.ts")).toBe(false);
  });

  it("keeps ~-relative and absolute patterns in their own addressing spaces", () => {
    expect(compileGlob("~/notes/**").test("~/notes/a.txt")).toBe(true);
    expect(compileGlob("~/notes/**").test("./notes/a.txt")).toBe(false);
    expect(compileGlob("/tmp/**").test("/tmp/x")).toBe(true);
    expect(compileGlob("/tmp/**").test("./tmp/x")).toBe(false);
  });
});

describe("authorize — composition matrix (§10(c), decision L)", () => {
  it("profile-deny × rule-allow still denies (layer 1 first)", () => {
    const engine = new PermissionEngine(
      { rules: [rule({ tool: "read_file", kind: "glob", pattern: "./**", action: "allow" })] },
      CWD,
    );
    const profile = evaluator("strict-sandbox", { fs: [{ path: "**/*.env", action: "deny" }] });
    const r = authorize({ tool: "read_file", arguments: { path: "/workspace/.env" } }, engine, profile);
    expect(r.action).toBe("deny");
    expect(r.reason).toBe("deny-by-profile");
    expect(r.winningRule).toBeUndefined();
    expect(r.wasUnresolved).toBe(false);
    expect(r.isGuarded).toBe(false);
  });

  it("profile-deny × posture-autoApprove still denies (a deny is never posture-bypassed)", () => {
    const engine = new PermissionEngine(undefined, CWD);
    const profile = evaluator("strict-sandbox", { fs: [{ path: "**/*.env", action: "deny" }] });
    const r = authorize({ tool: "read_file", arguments: { path: "/workspace/.env" } }, engine, profile);
    // The posture overlay (App.tsx) bypasses only ordinary asks — a deny,
    // unresolved, or guarded result always surfaces. Reproduce that check:
    const postureBypasses = (res: { action: string; wasUnresolved: boolean; isGuarded: boolean }) =>
      res.action !== "deny" && !res.wasUnresolved && !res.isGuarded;
    expect(postureBypasses(r)).toBe(false);
  });

  it("guarded run_bash × unrestricted level still asks (layer 2 unchanged)", () => {
    const engine = new PermissionEngine(undefined, CWD);
    const profile = evaluator("unrestricted");
    const r = authorize({ tool: "run_bash", arguments: { command: "curl -s https://example.com" } }, engine, profile);
    expect(r.action).toBe("ask");
    expect(r.isGuarded).toBe(true);
    expect(r.reason).toBeUndefined();
  });

  it("profile-allow × rule-deny still denies (layer 2 deny intact)", () => {
    const engine = new PermissionEngine(
      { rules: [rule({ tool: "run_bash", kind: "prefix", pattern: "rm", action: "deny" })] },
      CWD,
    );
    const profile = evaluator("unrestricted");
    const r = authorize({ tool: "run_bash", arguments: { command: "rm -rf /tmp/x" } }, engine, profile);
    expect(r.action).toBe("deny");
    expect(r.reason).toBeUndefined();
  });

  it("no profile → layer 1 skipped, engine result byte-for-byte (§9)", () => {
    const engine = new PermissionEngine(undefined, CWD);
    const cases: [string, Record<string, unknown>][] = [
      ["read_file", { path: "/workspace/src/main.ts" }],
      ["read_file", { path: "/etc/passwd" }],
      ["run_bash", { command: "git status" }],
      ["web_fetch", { url: "https://example.com" }],
    ];
    for (const [tool, args] of cases) {
      const viaAuthorize = authorize({ tool, arguments: args }, engine);
      expect(viaAuthorize).toEqual(engine.resolve(tool, args));
      expect(viaAuthorize.reason).toBeUndefined();
    }
  });
});

describe("editTargetInWriteSet — consolidation M.1 (§5)", () => {
  it("workspace-write: an edit inside the workspace roots is in the write-set, outside is not", () => {
    const profile = evaluator("workspace-write");
    expect(profile.editTargetInWriteSet("edit", { path: "/workspace/src/a.ts" })).toBe(true);
    expect(profile.editTargetInWriteSet("write_to_file", { filePath: "/workspace/out.txt" })).toBe(true);
    expect(profile.editTargetInWriteSet("edit", { path: "/etc/hosts" })).toBe(false);
  });

  it("strict-sandbox has no write-set — no edit target is in it", () => {
    const profile = evaluator("strict-sandbox");
    expect(profile.editTargetInWriteSet("edit", { path: "/workspace/src/a.ts" })).toBe(false);
    expect(profile.editTargetInWriteSet("edit", { path: "/etc/hosts" })).toBe(false);
  });

  it("unrestricted: any write target is in the write-set", () => {
    const profile = evaluator("unrestricted");
    expect(profile.editTargetInWriteSet("edit", { path: "/etc/hosts" })).toBe(true);
  });

  it("an explicit fs deny rule excludes the target even inside the level's write-set", () => {
    const profile = evaluator("workspace-write", { fs: [{ path: "**/*.env", action: "deny" }] });
    expect(profile.editTargetInWriteSet("edit", { path: "/workspace/.env" })).toBe(false);
    expect(profile.editTargetInWriteSet("edit", { path: "/workspace/src/a.ts" })).toBe(true);
  });

  it("only edit-group tools qualify; a path-less call has nothing to gate", () => {
    const profile = evaluator("workspace-write");
    expect(profile.editTargetInWriteSet("read_file", { path: "/workspace/a.ts" })).toBe(false);
    expect(profile.editTargetInWriteSet("edit", {})).toBe(false);
    expect(profile.editTargetInWriteSet("run_bash", { command: "echo hi" })).toBe(false);
  });
});

describe("deny-by-profile audit value", () => {
  it("is a member of the PermissionDecision union", () => {
    const decision: PermissionDecision = "deny-by-profile";
    expect(decision).toBe("deny-by-profile");
  });

  it("round-trips through the session store as a permission record", async () => {
    const home = mkdtempSync(join(tmpdir(), "profile-store-"));
    try {
      const store = new SessionStore(home);
      const id = await store.create({ cwd: "/workspace", provider: "test", model: "test", mode: "normal" });
      await store.appendPermission(id, {
        tool: "read_file",
        subject: "./.env",
        decision: "deny-by-profile",
        reason: "deny-by-profile",
      });
      const rows = await store.queryPermissionHistory(id);
      expect(rows).toHaveLength(1);
      expect(rows[0].decision).toBe("deny-by-profile");
      expect(rows[0].reason).toBe("deny-by-profile");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
