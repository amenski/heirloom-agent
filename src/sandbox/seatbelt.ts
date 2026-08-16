import { existsSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ProfileLevel } from "../permissions/index.js";

/**
 * macOS Seatbelt (sandbox-exec) profile generation — the *mechanical* layer
 * under the PermissionProfile policy (permission-profile.md §8, phase (e)).
 *
 * The policy layer (ProfileEvaluator, src/permissions/profile.ts) decides
 * allow/deny per call; the Seatbelt layer makes the level's defaults hold in
 * the OS for bash children: strict-sandbox = read-only fs + no network,
 * workspace-write = write only workspace roots + network on, with two
 * deliberate, battery-proven carve-outs to the write boundary (ephemeral
 * temp: literal /tmp + the session $TMPDIR; npm cache: ~/.npm — see
 * {@link workspaceWriteCarveouts}). The .git always-denied set is
 * deliberately **not** expressed here — SBPL has no gitignore globs, and the
 * policy layer already enforces it (documented residual,
 * permission-profile.md §8).
 *
 * Two-layer network rationale (all-or-nothing): SBPL's
 * `(allow network-outbound (remote ip "*:443"))` matches IPs only — it
 * cannot express the profile's hostname allowlist (hostnames resolve after
 * the sandbox filter runs). So the Seatbelt layer gates network on/off per
 * level (strict-sandbox off, workspace-write on) and host-level
 * allowlisting stays with the policy layer, which sees the hostname. The
 * deny side is airtight (deny default denies every connect); the allow
 * side is intentionally coarser than the policy — a workspace-write bash
 * child can reach any host, though the policy layer still asks/denies
 * egress via the guarded tier and the profile's network rules.
 *
 * macOS-only. On any other platform `sandboxPrefix` returns null (plain
 * spawn args, policy-only) — the loader emits a one-time startup notice
 * when `sandbox.enabled` is set on a non-macOS host.
 */

/** Levels that get a Seatbelt profile. `unrestricted` never does (no prefix). */
export type SandboxLevel = "strict-sandbox" | "workspace-write";

export interface SandboxSpawn {
  /** Executable to spawn: /usr/bin/sandbox-exec on macOS. */
  file: string;
  /** Full argv: ["-p", "<profile>", "/bin/sh", "-c", command]. */
  args: string[];
}

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/**
 * Core every sandboxed level shares: deny default, then read-only fs plus
 * the plumbing a basic command needs (exec/map executable, sysctl). The
 * single write carve-out is `/dev/null` — `2>/dev/null` redirects are
 * ubiquitous (even the Xcode `git` shim does one internally) and the
 * write is a discard, not a filesystem write. Every other write stays
 * denied at this layer.
 */
const READ_ONLY_CORE = [
  "(allow process*)",
  "(allow file-read*)",
  "(allow file-map-executable)",
  "(allow sysctl-read)",
  '(allow file-write* (literal "/dev/null"))',
];

/** Escapes a path for embedding in an SBPL double-quoted string. */
function sbplQuote(path: string): string {
  return path.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * The workspace-write write carve-outs — the only deliberate exceptions to
 * the write boundary, both proven necessary by the 2026-08-15 dev-toolchain
 * battery (real `runBashTimed` under this profile; permission-profile.md §8):
 *
 * 1. Ephemeral temp — literal `/tmp` (realpath `/private/tmp` on macOS) and
 *    the session `$TMPDIR` (e.g. `/var/folders/…/T`). Battery evidence:
 *    `mktemp -d` failed with EPERM on `$TMPDIR`; a raw `echo > /tmp/x` and
 *    `env -u TMPDIR mktemp -d` (the /tmp fallback) also failed. Compilers,
 *    interpreters, `git`, `tar` and package managers all stage temp files
 *    here — SOTA-aligned (Codex ships the same `:tmpdir` option).
 * 2. The npm cache — `~/.npm`. Battery evidence: `npm install is-number`
 *    failed with EPERM on `~/.npm/_cacache/tmp/…` (and `~/.npm/_logs`).
 *
 * strict-sandbox gains none of these (read-only stays absolute). The
 * carve-outs are literal realpath'd subpaths, so a symlink planted in a
 * carve-out dir resolves to its target and the sandbox still denies writes
 * that land outside the subpath set.
 */
function workspaceWriteCarveouts(): string[] {
  const literalTmp = seatbeltWorkspaceRoot("/tmp");
  const sessionTmp = seatbeltWorkspaceRoot(tmpdir());
  const npmCache = seatbeltWorkspaceRoot(join(homedir(), ".npm"));
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const p of [literalTmp, sessionTmp, npmCache]) {
    if (seen.has(p)) continue; // TMPDIR unset on some hosts ⇒ tmpdir() === /tmp
    seen.add(p);
    lines.push(`(allow file-write* (subpath "${sbplQuote(p)}"))`);
  }
  return lines;
}

/**
 * The SBPL profile source for a level, with the session workspace root
 * fixed at startup — never the per-call cwd (item 8.6) — as the
 * workspace-write write-set. `trustedRoot` is expected already
 * realpath-resolved (via {@link seatbeltWorkspaceRoot}); the sandbox
 * filters on resolved paths, so the subpath must be the physical form.
 * Verified empirically on macOS (2026-08-13): `ls`, `echo`, `git status`,
 * `node -e 'console.log(1)'` all run under the strict profile; writes and
 * network connects fail with EPERM-equivalent denials; the workspace-write
 * subpath is directory-boundary aware (a `(subpath "/a")` rule does not
 * match "/a2/..."). The carve-outs (temp + npm cache) are workspace-write
 * only, battery-proven 2026-08-15.
 */
export function buildSeatbeltProfile(level: SandboxLevel, trustedRoot: string): string {
  const lines = ["(version 1)", "(deny default)", ...READ_ONLY_CORE];
  if (level === "workspace-write") {
    lines.push(
      `(allow file-write* (subpath "${sbplQuote(trustedRoot)}"))`,
      ...workspaceWriteCarveouts(),
      "(allow network-outbound)",
    );
  }
  return lines.join("\n");
}

/**
 * Realpath-resolves a path via its nearest existing ancestor (the D1
 * pattern from security-spec T6): walk up to the deepest existing
 * component, resolve that with realpath, re-append the missing tail. The
 * physical form is what the kernel matches SBPL subpaths against, and it is
 * what the cwd containment check needs — a symlink escaping the trusted
 * root resolves to its target and is caught. A leading "~" expands to the
 * home directory (matching Node's spawn-cwd expansion), so a model-passed
 * `cwd: "~"` is checked against the home directory rather than treated as
 * a literal relative dir. Falls back to the lexical absolute when nothing
 * on the path exists — the spawn would fail anyway.
 */
export function seatbeltWorkspaceRoot(path: string): string {
  const abs = path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : resolve(path);
  let existing = abs;
  const missing: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return abs; // nothing on the path exists
    missing.unshift(basename(existing));
    existing = parent;
  }
  let real: string;
  try {
    real = realpathSync(existing);
  } catch {
    real = existing; // vanished between existsSync and realpathSync — keep the lexical form
  }
  return missing.length ? join(real, ...missing) : real;
}

/**
 * Whether a level would produce a Seatbelt prefix on this platform — the
 * same gate {@link sandboxPrefix} applies. The trusted-root cwd containment
 * check is gated on this too, so level absent/`unrestricted` or a non-macOS
 * host keeps today's spawn behavior exactly.
 */
export function isSandboxedLevel(level: ProfileLevel | undefined): level is SandboxLevel {
  return level !== undefined && level !== "unrestricted" && process.platform === "darwin";
}

/**
 * The trusted-root cwd containment check (item 8.6): the requested spawn
 * cwd, realpath-resolved via its nearest existing ancestor, must equal or
 * be a descendant of the trusted workspace root. A cwd outside the root —
 * or a symlink resolving outside it — is rejected before spawning (tool
 * error, no spawn, no profile).
 */
export function validateCwdWithinTrustedRoot(
  cwd: string,
  trustedRoot: string,
): { ok: true } | { ok: false; error: string } {
  const resolvedRoot = seatbeltWorkspaceRoot(trustedRoot);
  const resolvedCwd = seatbeltWorkspaceRoot(cwd);
  const rel = relative(resolvedRoot, resolvedCwd);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    return { ok: true };
  }
  return {
    ok: false,
    error: `Working directory escapes the sandbox workspace root: ${cwd} (root: ${trustedRoot}). Sandboxed commands must run inside the workspace.`,
  };
}

/**
 * The spawn-time prefix for a bash child. Returns null when no sandbox
 * applies — the caller keeps today's `spawn(command, { shell: true })`
 * exactly: level absent/`unrestricted` (flag off, no profile, or the level
 * is unrestricted), or a non-macOS platform (policy-only).
 *
 * `cwd` is the child's actual working directory (passed to spawn unchanged);
 * `trustedRoot` is the workspace-write profile's write-set root — the
 * session workspace root fixed at startup (`ctx.workingDir`), never the
 * per-call cwd. Callers run {@link validateCwdWithinTrustedRoot} (when
 * {@link isSandboxedLevel} says a profile applies) before spawning.
 */
export function sandboxPrefix(
  command: string,
  cwd: string,
  trustedRoot: string,
  level: ProfileLevel | undefined,
): SandboxSpawn | null {
  if (!isSandboxedLevel(level)) return null; // macOS-only; startup notice from the loader
  return {
    file: SANDBOX_EXEC,
    args: ["-p", buildSeatbeltProfile(level, seatbeltWorkspaceRoot(trustedRoot)), "/bin/sh", "-c", command],
  };
}
