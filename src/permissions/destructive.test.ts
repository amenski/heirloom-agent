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
});

describe("fork bomb literal is not shredded before exact match", () => {
  it("the seed rule is kind exact and equals the literal fork-bomb string", () => {
    const rule = BUILTIN_DESTRUCTIVE_RULES.find((r) => r.pattern.includes(":|:"))!;
    expect(rule.kind).toBe("exact");
    expect(rule.pattern).toBe(":(){ :|:& };:");
  });
});
