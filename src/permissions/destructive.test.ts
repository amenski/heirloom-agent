import { describe, it, expect } from "vitest";
import { patternMatches } from "./rules.js";
import { BUILTIN_DESTRUCTIVE_RULES } from "./destructive.js";

const REALISTIC_INVOCATIONS: Record<string, string> = {
  "rm -rf /": "rm -rf / --no-preserve-root",
  "rm -rf ~": "rm -rf ~/Documents",
  "git push --force": "git push --force origin main",
  "git push -f": "git push -f origin main",
  "git reset --hard": "git reset --hard HEAD~1",
  "git clean -fdx": "git clean -fdx",
  "mkfs": "mkfs.ext4 /dev/sda1",
  "dd if=": "dd if=/dev/zero of=/dev/sda",
  ":(){ :|:& };:": ":(){ :|:& };:",
};

describe("BUILTIN_DESTRUCTIVE_RULES: every seed rule matches a realistic invocation", () => {
  for (const rule of BUILTIN_DESTRUCTIVE_RULES) {
    it(`"${rule.pattern}" matches a realistic real-world invocation`, () => {
      const invocation = REALISTIC_INVOCATIONS[rule.pattern];
      expect(invocation, `no realistic invocation fixture defined for pattern "${rule.pattern}"`).toBeDefined();
      expect(patternMatches(rule, { tool: "run_bash", text: invocation })).toBe(true);
    });
  }

  it("does not accidentally match unrelated safe commands", () => {
    const safe = "git status";
    for (const rule of BUILTIN_DESTRUCTIVE_RULES) {
      expect(patternMatches(rule, { tool: "run_bash", text: safe })).toBe(false);
    }
  });

  it("git reset --hard does not false-positive on git reset (soft/mixed)", () => {
    const rule = BUILTIN_DESTRUCTIVE_RULES.find((r) => r.pattern === "git reset --hard")!;
    expect(patternMatches(rule, { tool: "run_bash", text: "git reset HEAD~1" })).toBe(false);
  });

  it("git push --force does not false-positive on a plain git push", () => {
    const rule = BUILTIN_DESTRUCTIVE_RULES.find((r) => r.pattern === "git push --force")!;
    expect(patternMatches(rule, { tool: "run_bash", text: "git push origin main" })).toBe(false);
  });

  it("dd if= does not false-positive on dd without an input file", () => {
    const rule = BUILTIN_DESTRUCTIVE_RULES.find((r) => r.pattern === "dd if=")!;
    expect(patternMatches(rule, { tool: "run_bash", text: "dd of=/dev/sda" })).toBe(false);
  });

  it("dd if= does not false-positive on ddrescue (a different, unrelated tool)", () => {
    const rule = BUILTIN_DESTRUCTIVE_RULES.find((r) => r.pattern === "dd if=")!;
    expect(patternMatches(rule, { tool: "run_bash", text: "ddrescue if=/dev/sda of=/dev/sdb" })).toBe(false);
  });

  it("git reset --hard does not false-positive on git reset --soft", () => {
    const rule = BUILTIN_DESTRUCTIVE_RULES.find((r) => r.pattern === "git reset --hard")!;
    expect(patternMatches(rule, { tool: "run_bash", text: "git reset --soft HEAD~1" })).toBe(false);
  });
});

describe("fork bomb literal is not shredded before exact match", () => {
  it("the seed rule is kind exact and equals the literal fork-bomb string", () => {
    const rule = BUILTIN_DESTRUCTIVE_RULES.find((r) => r.pattern.includes(":|:"))!;
    expect(rule.kind).toBe("exact");
    expect(rule.pattern).toBe(":(){ :|:& };:");
  });
});

// Regression tests for evasions verified against the pre-hardening engine
// during the security-spec.md review pass. Each of these previously bypassed
// the destructive deny rule (or, for the escape/quote case, bypassed BOTH the
// destructive rule AND the unresolved-ask fail-closed net).
describe("destructive-rule matching: evasion resistance", () => {
  const rmRf = BUILTIN_DESTRUCTIVE_RULES.find((r) => r.pattern === "rm -rf /")!;
  const gitClean = BUILTIN_DESTRUCTIVE_RULES.find((r) => r.pattern === "git clean -fdx")!;

  it("absolute-path invocation still matches (/usr/bin/rm -rf /)", () => {
    expect(patternMatches(rmRf, { tool: "run_bash", text: "/usr/bin/rm -rf /" })).toBe(true);
    expect(patternMatches(rmRf, { tool: "run_bash", text: "/usr/local/bin/rm -rf /" })).toBe(true);
  });

  it("relative-path invocation still matches (./rm -rf /)", () => {
    expect(patternMatches(rmRf, { tool: "run_bash", text: "./rm -rf /" })).toBe(true);
  });

  it("case variation still matches (RM -RF /, Rm -Rf /)", () => {
    expect(patternMatches(rmRf, { tool: "run_bash", text: "RM -RF /" })).toBe(true);
    expect(patternMatches(rmRf, { tool: "run_bash", text: "Rm -Rf /" })).toBe(true);
  });

  it("flag reordering still matches (rm -fr /, rm -r -f /, rm -f -r /)", () => {
    expect(patternMatches(rmRf, { tool: "run_bash", text: "rm -fr /" })).toBe(true);
    expect(patternMatches(rmRf, { tool: "run_bash", text: "rm -r -f /" })).toBe(true);
    expect(patternMatches(rmRf, { tool: "run_bash", text: "rm -f -r /" })).toBe(true);
  });

  it("combined evasion (absolute path + case + flag reorder) still matches", () => {
    expect(patternMatches(rmRf, { tool: "run_bash", text: "/USR/BIN/RM -fr /" })).toBe(true);
  });

  it("long-form flags fold to their short equivalent (rm --recursive --force /)", () => {
    expect(patternMatches(rmRf, { tool: "run_bash", text: "rm --recursive --force /" })).toBe(true);
    expect(patternMatches(rmRf, { tool: "run_bash", text: "rm --force --recursive /" })).toBe(true);
  });

  it("mixed short and long-form flags still match (rm -r --force /, rm --recursive -f /)", () => {
    expect(patternMatches(rmRf, { tool: "run_bash", text: "rm -r --force /" })).toBe(true);
    expect(patternMatches(rmRf, { tool: "run_bash", text: "rm --recursive -f /" })).toBe(true);
  });

  it("git clean -fdx flag reordering still matches (git clean -xfd, git clean -d -f -x)", () => {
    expect(patternMatches(gitClean, { tool: "run_bash", text: "git clean -xfd" })).toBe(true);
    expect(patternMatches(gitClean, { tool: "run_bash", text: "git clean -d -f -x" })).toBe(true);
  });

  it("the trailing path argument still has to match — flag normalization doesn't loosen the target", () => {
    // "rm -rf /" and "rm -rf ~" are deliberately separate seed rules with
    // different targets; flag-cluster normalization must not blur that.
    const rmRfHome = BUILTIN_DESTRUCTIVE_RULES.find((r) => r.pattern === "rm -rf ~")!;
    expect(patternMatches(rmRf, { tool: "run_bash", text: "rm -fr /home/user/project" })).toBe(false);
    expect(patternMatches(rmRfHome, { tool: "run_bash", text: "rm -fr /home/user/project" })).toBe(false);
  });

  it("long-form --force folds to -f for git (--force matched literally by the seed rule)", () => {
    const gitPushForce = BUILTIN_DESTRUCTIVE_RULES.find((r) => r.pattern === "git push --force")!;
    expect(patternMatches(gitPushForce, { tool: "run_bash", text: "git push --force origin main" })).toBe(true);
    expect(patternMatches(gitPushForce, { tool: "run_bash", text: "git push origin main" })).toBe(false);
  });

  it("git clean with long-form --force -dx folds to the canonical short cluster", () => {
    expect(patternMatches(gitClean, { tool: "run_bash", text: "git clean --force -dx" })).toBe(true);
  });

  it("git clean with all long-form flags (--force --directory --ignored) folds to the canonical short cluster", () => {
    expect(patternMatches(gitClean, { tool: "run_bash", text: "git clean --force --directory --ignored" })).toBe(true);
  });

  it("git push --force-with-lease does NOT match the --force destructive seed rule (different flag)", () => {
    const gitPushForce = BUILTIN_DESTRUCTIVE_RULES.find((r) => r.pattern === "git push --force")!;
    expect(patternMatches(gitPushForce, { tool: "run_bash", text: "git push --force-with-lease origin main" })).toBe(false);
  });

  it("ordinary user-authored (non-destructive-origin) prefix rules are NOT hardened — literal order/case still required", () => {
    const userRule = { tool: "run_bash" as const, kind: "prefix" as const, pattern: "git commit -m", action: "allow" as const, origin: "config" as const };
    expect(patternMatches(userRule, { tool: "run_bash", text: "GIT COMMIT -m test" })).toBe(false);
    expect(patternMatches(userRule, { tool: "run_bash", text: "/usr/bin/git commit -m test" })).toBe(false);
  });
});
