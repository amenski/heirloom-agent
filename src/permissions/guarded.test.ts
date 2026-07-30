import { describe, it, expect } from "vitest";
import { patternMatches } from "./rules.js";
import { BUILTIN_GUARDED_RULES } from "./guarded.js";

describe("BUILTIN_GUARDED_RULES", () => {
  it("every rule resolves to ask, not deny — reading your own secret file once is legitimate", () => {
    for (const rule of BUILTIN_GUARDED_RULES) {
      expect(rule.action).toBe("ask");
      expect(rule.origin).toBe("builtin-guarded");
    }
  });

  it("matches .env at the workspace root and nested", () => {
    const rule = BUILTIN_GUARDED_RULES.find((r) => r.pattern.includes(".env"))!;
    expect(patternMatches(rule, { tool: "read_file", text: "./.env", resolvedPath: "./.env" })).toBe(true);
    expect(patternMatches(rule, { tool: "read_file", text: "./.env.local", resolvedPath: "./.env.local" })).toBe(true);
    expect(patternMatches(rule, { tool: "read_file", text: "./config/.env", resolvedPath: "./config/.env" })).toBe(true);
  });

  it("matches ~/.ssh/* and ~/.aws/* (absolute, out-of-cwd form)", () => {
    const sshRule = BUILTIN_GUARDED_RULES.find((r) => r.pattern.includes(".ssh"))!;
    const awsRule = BUILTIN_GUARDED_RULES.find((r) => r.pattern.includes(".aws"))!;
    expect(patternMatches(sshRule, { tool: "read_file", text: "/home/user/.ssh/id_rsa", resolvedPath: "/home/user/.ssh/id_rsa" })).toBe(true);
    expect(patternMatches(awsRule, { tool: "read_file", text: "/home/user/.aws/credentials", resolvedPath: "/home/user/.aws/credentials" })).toBe(true);
  });

  it("matches id_rsa* and *.pem regardless of location", () => {
    const idRsaRule = BUILTIN_GUARDED_RULES.find((r) => r.pattern.includes("id_rsa"))!;
    const pemRule = BUILTIN_GUARDED_RULES.find((r) => r.pattern.includes(".pem"))!;
    expect(patternMatches(idRsaRule, { tool: "read_file", text: "./id_rsa.pub", resolvedPath: "./id_rsa.pub" })).toBe(true);
    expect(patternMatches(pemRule, { tool: "read_file", text: "./keys/server.pem", resolvedPath: "./keys/server.pem" })).toBe(true);
  });

  it("matches credentials* files", () => {
    const rule = BUILTIN_GUARDED_RULES.find((r) => r.pattern.includes("credentials"))!;
    expect(patternMatches(rule, { tool: "read_file", text: "./credentials.yaml", resolvedPath: "./credentials.yaml" })).toBe(true);
  });

  it("does not match unrelated files", () => {
    for (const rule of BUILTIN_GUARDED_RULES.filter((r) => r.tool === "read_file")) {
      expect(patternMatches(rule, { tool: "read_file", text: "./src/main.ts", resolvedPath: "./src/main.ts" })).toBe(false);
    }
  });

  it("also covers write_to_file and edit for .env (not just reads)", () => {
    const writeRule = BUILTIN_GUARDED_RULES.find((r) => r.tool === "write_to_file")!;
    const editRule = BUILTIN_GUARDED_RULES.find((r) => r.tool === "edit")!;
    expect(patternMatches(writeRule, { tool: "write_to_file", text: "./.env", resolvedPath: "./.env" })).toBe(true);
    expect(patternMatches(editRule, { tool: "edit", text: "./.env", resolvedPath: "./.env" })).toBe(true);
  });

  it("a read_file guarded rule does not match a write_to_file call to the same path (tool-scoped)", () => {
    const readRule = BUILTIN_GUARDED_RULES.find((r) => r.tool === "read_file" && r.pattern.includes(".env"))!;
    expect(patternMatches(readRule, { tool: "write_to_file", text: "./.env", resolvedPath: "./.env" })).toBe(false);
  });
});

describe("BUILTIN_GUARDED_RULES: network egress", () => {
  const NETWORK_TOOLS = ["curl", "wget", "nc", "ssh", "scp", "rsync"];

  it.each(NETWORK_TOOLS)("%s matches a realistic invocation", (tool) => {
    const rule = BUILTIN_GUARDED_RULES.find((r) => r.tool === "run_bash" && r.pattern === tool)!;
    expect(rule, `no guarded rule found for ${tool}`).toBeDefined();
    expect(patternMatches(rule, { tool: "run_bash", text: `${tool} https://example.com` })).toBe(true);
  });

  it("curl matches absolute-path and case-variant invocation (same hardening as the destructive tier)", () => {
    const rule = BUILTIN_GUARDED_RULES.find((r) => r.pattern === "curl")!;
    expect(patternMatches(rule, { tool: "run_bash", text: "/usr/bin/curl https://example.com" })).toBe(true);
    expect(patternMatches(rule, { tool: "run_bash", text: "CURL https://example.com" })).toBe(true);
  });

  it("curl does NOT match curl-config (a real, unrelated, harmless tool — regression for the boundary-extension false positive found during review)", () => {
    const rule = BUILTIN_GUARDED_RULES.find((r) => r.pattern === "curl")!;
    expect(patternMatches(rule, { tool: "run_bash", text: "curl-config --version" })).toBe(false);
  });

  it("nc does not match unrelated commands starting with the same letters", () => {
    const rule = BUILTIN_GUARDED_RULES.find((r) => r.pattern === "nc")!;
    expect(patternMatches(rule, { tool: "run_bash", text: "ncdu ." })).toBe(false);
  });

  it("does not match unrelated safe commands", () => {
    const safe = "git status";
    for (const rule of BUILTIN_GUARDED_RULES.filter((r) => r.tool === "run_bash")) {
      expect(patternMatches(rule, { tool: "run_bash", text: safe })).toBe(false);
    }
  });
});
