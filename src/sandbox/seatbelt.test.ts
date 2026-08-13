import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, existsSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildSeatbeltProfile,
  sandboxPrefix,
  seatbeltWorkspaceRoot,
  validateCwdWithinTrustedRoot,
} from "./seatbelt.js";
import { runBashTimed } from "../tools/bash.js";
import { jobManager } from "../tools/jobs.js";

const onDarwin = process.platform === "darwin";
const itOnDarwin = it.skipIf(!onDarwin);

// ── helpers ──

interface RunResult {
  exit: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Spawn a command the same way the tools layer does (sandboxPrefix →
 * explicit argv, else shell:true) and capture the result. A 20s cap keeps a
 * broken profile from hanging the suite.
 */
function runCommand(command: string, cwd: string, level?: "strict-sandbox" | "workspace-write" | "unrestricted"): Promise<RunResult> {
  return new Promise((resolve) => {
    // cwd doubles as the trusted root here — the enforcement fixtures run
    // the child in the directory whose writes they assert on.
    const sandbox = sandboxPrefix(command, cwd, cwd, level);
    const child = sandbox
      ? spawn(sandbox.file, sandbox.args, { cwd })
      : spawn(command, { cwd, shell: true });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => { stdout += d; });
    child.stderr?.on("data", (d: Buffer) => { stderr += d; });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ exit: null, stdout, stderr: stderr + "\n(timed out)" });
    }, 20_000);
    child.on("error", (err) => { clearTimeout(timer); resolve({ exit: null, stdout, stderr: stderr + `\n${err.message}` }); });
    child.on("exit", (code) => { clearTimeout(timer); resolve({ exit: code, stdout, stderr }); });
  });
}

/** A hermetic local HTTP server: sandboxed network connects never reach it. */
function startHttpServer(): Promise<{ server: Server; port: number; connections: () => number }> {
  return new Promise((resolve) => {
    let conns = 0;
    const server = createServer((_req, res) => { res.end("ok"); });
    server.on("connection", () => { conns += 1; });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, port, connections: () => conns });
    });
  });
}

const FETCH_OK = (port: number) =>
  `node -e 'fetch("http://127.0.0.1:${port}").then(r=>{console.log("NETOK", r.status);process.exit(0)}).catch(e=>{console.log("NETFAIL", e.cause?.code ?? e.message);process.exit(1)})'`;

// ── profile construction (platform-independent) ──

describe("buildSeatbeltProfile", () => {
  it("strict-sandbox: deny default, read-only, no network, no write-set", () => {
    const p = buildSeatbeltProfile("strict-sandbox", "/ws");
    expect(p).toContain("(version 1)");
    expect(p).toContain("(deny default)");
    expect(p).toContain("(allow file-read*)");
    expect(p).toContain('(allow file-write* (literal "/dev/null"))');
    expect(p).not.toContain("network-outbound");
    expect(p).not.toContain("(subpath");
  });

  it("workspace-write: strict core plus the workspace write-set and network", () => {
    const p = buildSeatbeltProfile("workspace-write", "/private/tmp/ws");
    expect(p).toContain('(allow file-write* (subpath "/private/tmp/ws"))');
    expect(p).toContain("(allow network-outbound)");
    expect(p).toContain("(deny default)");
  });

  it("escapes quotes/backslashes in the workspace root for SBPL", () => {
    const p = buildSeatbeltProfile("workspace-write", '/a"b\\c');
    expect(p).toContain('(allow file-write* (subpath "/a\\"b\\\\c"))');
  });

  it("seatbeltWorkspaceRoot realpath-resolves the cwd (symlink-safe subpath)", () => {
    expect(seatbeltWorkspaceRoot("/tmp")).toBe(realpathSync("/tmp"));
  });
});

describe("sandboxPrefix", () => {
  it("unrestricted (or absent level) returns no prefix — spawn args unchanged", () => {
    expect(sandboxPrefix("echo hi", process.cwd(), process.cwd(), undefined)).toBeNull();
    expect(sandboxPrefix("echo hi", process.cwd(), process.cwd(), "unrestricted")).toBeNull();
  });

  itOnDarwin("levels below unrestricted produce a sandbox-exec prefix on macOS", () => {
    const p = sandboxPrefix("echo hi", process.cwd(), process.cwd(), "strict-sandbox");
    expect(p).not.toBeNull();
    expect(p!.file).toBe("/usr/bin/sandbox-exec");
    expect(p!.args[0]).toBe("-p");
    expect(p!.args[2]).toBe("/bin/sh");
    expect(p!.args[3]).toBe("-c");
    expect(p!.args[4]).toBe("echo hi");
  });

  it.skipIf(onDarwin)("non-macOS: levels below unrestricted are policy-only (no prefix)", () => {
    expect(sandboxPrefix("echo hi", process.cwd(), process.cwd(), "strict-sandbox")).toBeNull();
    expect(sandboxPrefix("echo hi", process.cwd(), process.cwd(), "workspace-write")).toBeNull();
  });

  itOnDarwin("the write-set subpath is the trusted root, not the per-call cwd", () => {
    const root = mkdtempSync(join(tmpdir(), "seatbelt-root-"));
    const sub = join(root, "sub");
    mkdirSync(sub, { recursive: true });
    try {
      const p = sandboxPrefix("echo hi", sub, root, "workspace-write");
      expect(p).not.toBeNull();
      expect(p!.args[1]).toContain(`(subpath "${realpathSync(root)}")`);
      expect(p!.args[1]).not.toContain(`(subpath "${realpathSync(sub)}")`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── trusted-root cwd containment (item 8.6, platform-independent) ──

describe("validateCwdWithinTrustedRoot", () => {
  it("allows the trusted root itself and any subdirectory of it", () => {
    const root = mkdtempSync(join(tmpdir(), "seatbelt-root-"));
    const sub = join(root, "sub");
    mkdirSync(sub, { recursive: true });
    try {
      expect(validateCwdWithinTrustedRoot(root, root)).toEqual({ ok: true });
      expect(validateCwdWithinTrustedRoot(sub, root)).toEqual({ ok: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a cwd outside the trusted root (/tmp-adjacent and ~)", () => {
    const root = mkdtempSync(join(tmpdir(), "seatbelt-root-"));
    try {
      const outside = validateCwdWithinTrustedRoot(join(tmpdir(), "seatbelt-elsewhere"), root);
      expect(outside.ok).toBe(false);
      if (!outside.ok) expect(outside.error).toContain("sandbox workspace root");

      // ~ expands to the home directory — rejected unless the home dir is
      // inside the trusted root.
      const home = validateCwdWithinTrustedRoot("~", root);
      expect(home.ok).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a cwd whose symlink escapes the trusted root", () => {
    const root = mkdtempSync(join(tmpdir(), "seatbelt-root-"));
    const outside = mkdtempSync(join(tmpdir(), "seatbelt-out-"));
    const link = join(root, "escape");
    try {
      symlinkSync(outside, link, "dir");
      const result = validateCwdWithinTrustedRoot(link, root);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain(link);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("allows a cwd symlinked to another path inside the trusted root", () => {
    const root = mkdtempSync(join(tmpdir(), "seatbelt-root-"));
    const inner = join(root, "inner");
    mkdirSync(inner, { recursive: true });
    const link = join(root, "alias");
    try {
      symlinkSync(inner, link, "dir");
      expect(validateCwdWithinTrustedRoot(link, root)).toEqual({ ok: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── real sandbox behavior (macOS only) ──

describe("seatbelt enforcement (macOS)", () => {
  const workspace = process.cwd();

  itOnDarwin("strict-sandbox: basic commands work — ls, echo, git status, node", async () => {
    const ls = await runCommand("ls", workspace, "strict-sandbox");
    expect(ls.exit).toBe(0);
    expect(ls.stdout).toContain("src");

    const echo = await runCommand("echo seatbelt-echo-ok", workspace, "strict-sandbox");
    expect(echo.exit).toBe(0);
    expect(echo.stdout).toContain("seatbelt-echo-ok");

    const git = await runCommand("git status", workspace, "strict-sandbox");
    expect(git.exit).toBe(0);
    expect(git.stdout).toContain("On branch");

    const node = await runCommand("node -e 'console.log(1)'", workspace, "strict-sandbox");
    expect(node.exit).toBe(0);
    expect(node.stdout.trim()).toBe("1");
  });

  itOnDarwin("strict-sandbox: writes fail everywhere (read-only)", async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "seatbelt-strict-"));
    const outside = join(outsideDir, "write.txt");
    try {
      const result = await runCommand(`touch "${outside}"`, workspace, "strict-sandbox");
      expect(result.exit).not.toBe(0);
      expect(result.stderr).toMatch(/Operation not permitted|not permitted/i);
      expect(existsSync(outside)).toBe(false);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  itOnDarwin("strict-sandbox: network attempts are denied (server never reached)", async () => {
    const { server, port, connections } = await startHttpServer();
    try {
      const result = await runCommand(FETCH_OK(port), workspace, "strict-sandbox");
      expect(result.exit).not.toBe(0);
      expect(result.stdout).toContain("NETFAIL");
      expect(connections()).toBe(0);
    } finally {
      server.close();
    }
  });

  itOnDarwin("workspace-write: writes inside the workspace succeed, outside fail", async () => {
    const ws = mkdtempSync(join(tmpdir(), "seatbelt-ws-"));
    const outsideDir = mkdtempSync(join(tmpdir(), "seatbelt-out-"));
    const outside = join(outsideDir, "write.txt");
    try {
      const inside = await runCommand(`touch "${join(ws, "inside.txt")}"`, ws, "workspace-write");
      expect(inside.exit).toBe(0);
      expect(existsSync(join(ws, "inside.txt"))).toBe(true);

      const out = await runCommand(`touch "${outside}"`, ws, "workspace-write");
      expect(out.exit).not.toBe(0);
      expect(out.stderr).toMatch(/Operation not permitted|not permitted/i);
      expect(existsSync(outside)).toBe(false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  itOnDarwin("workspace-write: network is allowed (server reached)", async () => {
    const { server, port, connections } = await startHttpServer();
    try {
      const result = await runCommand(FETCH_OK(port), process.cwd(), "workspace-write");
      expect(result.exit).toBe(0);
      expect(result.stdout).toContain("NETOK 200");
      expect(connections()).toBeGreaterThan(0);
    } finally {
      server.close();
    }
  });

  itOnDarwin("workspace-write: git status works in the workspace", async () => {
    const result = await runCommand("git status", process.cwd(), "workspace-write");
    expect(result.exit).toBe(0);
    expect(result.stdout).toContain("On branch");
  });
});

// ── tools-layer wiring (macOS only — exercises the real spawn paths) ──

describe("sandbox wiring into run_bash and background jobs", () => {
  const workspace = process.cwd();

  afterEach(() => {
    jobManager.killAll();
  });

  itOnDarwin("runBashTimed sandboxes the child when a level is passed", async () => {
    const denied = await runBashTimed(
      "touch /tmp/heirloom-seatbelt-bash-probe.txt",
      workspace,
      workspace,
      5000,
      true,
      "strict-sandbox",
    );
    expect(denied.content).toContain("Exit code:");
    expect(denied.content).not.toContain("Exit code: 0");

    const allowed = await runBashTimed("echo seatbelt-wired-ok", workspace, workspace, 5000, true, "strict-sandbox");
    expect(allowed.content).toContain("seatbelt-wired-ok");
  });

  itOnDarwin("no level passed → spawn behavior unchanged", async () => {
    const result = await runBashTimed("echo seatbelt-off-ok", workspace, workspace, 5000, true, undefined);
    expect(result.content).toContain("seatbelt-off-ok");
  });

  itOnDarwin("background jobs inherit the sandbox level (write denied in a strict job)", async () => {
    const started = jobManager.start(
      "touch /tmp/heirloom-seatbelt-job-probe.txt",
      workspace,
      10_000,
      { stream: false, sandboxLevel: "strict-sandbox", trustedRoot: workspace },
    );
    expect(started.ok).toBe(true);
    const id = started.ok ? started.id : "";
    await new Promise((r) => setTimeout(r, 800));
    const report = jobManager.check(id);
    expect(report?.status).toBe("failed");
    expect(report?.exitCode).not.toBe(0);
    expect(existsSync("/tmp/heirloom-seatbelt-job-probe.txt")).toBe(false);
  });

  // ── trusted-root containment through the tools layer (item 8.6) ──

  itOnDarwin("runBashTimed rejects a cwd outside the trusted root — tool error, no spawn", async () => {
    const result = await runBashTimed("echo should-not-run", "/tmp", workspace, 5000, true, "workspace-write");
    expect(result.content).toBe("");
    expect(result.error).toContain("Working directory escapes the sandbox workspace root");
    expect(result.error).toContain("/tmp");
  });

  itOnDarwin("runBashTimed rejects a cwd symlinked outside the trusted root", async () => {
    const root = mkdtempSync(join(tmpdir(), "seatbelt-root-"));
    const outside = mkdtempSync(join(tmpdir(), "seatbelt-out-"));
    const link = join(root, "escape");
    try {
      symlinkSync(outside, link, "dir");
      const result = await runBashTimed("echo should-not-run", link, root, 5000, true, "workspace-write");
      expect(result.content).toBe("");
      expect(result.error).toContain("Working directory escapes the sandbox workspace root");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("runBashTimed allows a subdirectory cwd inside the trusted root (write-set stays the root)", async () => {
    const root = mkdtempSync(join(tmpdir(), "seatbelt-root-"));
    const sub = join(root, "sub");
    mkdirSync(sub, { recursive: true });
    try {
      const result = await runBashTimed("pwd", sub, root, 5000, true, "workspace-write");
      expect(result.error).toBeUndefined();
      expect(result.content).toContain("sub");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  itOnDarwin("background jobs reject a cwd escaping the trusted root the same way", async () => {
    const started = jobManager.start("echo should-not-run", "/tmp", 10_000, {
      stream: true,
      sandboxLevel: "workspace-write",
      trustedRoot: workspace,
    });
    expect(started.ok).toBe(false);
    if (!started.ok) expect(started.error).toContain("Working directory escapes the sandbox workspace root");
  });
});
