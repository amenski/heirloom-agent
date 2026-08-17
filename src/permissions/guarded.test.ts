import { describe, it, expect } from "vitest";
import { patternMatches, extractToolSubject } from "./rules.js";
import { BUILTIN_GUARDED_RULES } from "./guarded.js";
import { PermissionEngine } from "./engine.js";

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

describe("BUILTIN_GUARDED_RULES: search secret-path dir globs", () => {
  it("matches search dir pointing at a file under .ssh/.aws and at the directory itself", () => {
    const sshRule = BUILTIN_GUARDED_RULES.find((r) => r.tool === "search" && r.pattern === "**/.ssh/*")!;
    const sshDirRule = BUILTIN_GUARDED_RULES.find((r) => r.tool === "search" && r.pattern === "**/.ssh")!;
    const awsRule = BUILTIN_GUARDED_RULES.find((r) => r.tool === "search" && r.pattern === "**/.aws/*")!;
    const awsDirRule = BUILTIN_GUARDED_RULES.find((r) => r.tool === "search" && r.pattern === "**/.aws")!;
    expect(patternMatches(sshRule, { tool: "search", text: "/home/user/.ssh/id_rsa", resolvedPath: "/home/user/.ssh/id_rsa" })).toBe(true);
    expect(patternMatches(sshDirRule, { tool: "search", text: "/home/user/.ssh", resolvedPath: "/home/user/.ssh" })).toBe(true);
    expect(patternMatches(awsRule, { tool: "search", text: "/home/user/.aws/credentials", resolvedPath: "/home/user/.aws/credentials" })).toBe(true);
    expect(patternMatches(awsDirRule, { tool: "search", text: "/home/user/.aws", resolvedPath: "/home/user/.aws" })).toBe(true);
  });

  it("matches search dir pointing at .env/credentials/id_rsa/.pem paths", () => {
    const envRule = BUILTIN_GUARDED_RULES.find((r) => r.tool === "search" && r.pattern === "**/.env*")!;
    const credRule = BUILTIN_GUARDED_RULES.find((r) => r.tool === "search" && r.pattern === "**/credentials*")!;
    expect(patternMatches(envRule, { tool: "search", text: "./.env", resolvedPath: "./.env" })).toBe(true);
    expect(patternMatches(credRule, { tool: "search", text: "./credentials.yaml", resolvedPath: "./credentials.yaml" })).toBe(true);
  });

  it("does not match an ordinary in-repo search dir", () => {
    for (const rule of BUILTIN_GUARDED_RULES.filter((r) => r.tool === "search")) {
      expect(patternMatches(rule, { tool: "search", text: "./src", resolvedPath: "./src" })).toBe(false);
    }
  });

  it("a search guarded rule does not match a read_file call to the same path (tool-scoped)", () => {
    const searchSshRule = BUILTIN_GUARDED_RULES.find((r) => r.tool === "search" && r.pattern === "**/.ssh/*")!;
    expect(patternMatches(searchSshRule, { tool: "read_file", text: "/home/user/.ssh/id_rsa", resolvedPath: "/home/user/.ssh/id_rsa" })).toBe(false);
  });

  it("engine resolves a search into .ssh to ask with isGuarded=true, even under defaultMode: allowAll", () => {
    const engine = new PermissionEngine({ defaultMode: "allowAll" }, "/repo");
    const result = engine.resolve("search", { pattern: "x", dir: "/repo/.ssh" });
    expect(result.action).toBe("ask");
    expect(result.isGuarded).toBe(true);
    expect(result.winningRule?.origin).toBe("builtin-guarded");
  });

  it("engine still allows ordinary in-repo searches (no secret-path false positive)", () => {
    const engine = new PermissionEngine({ defaultMode: "allowAll" }, "/repo");
    const result = engine.resolve("search", { pattern: "x", dir: "/repo/src" });
    expect(result.action).toBe("allow");
  });
});

describe("BUILTIN_GUARDED_RULES: node_modules", () => {
  it("matches reads anywhere under node_modules (workspace-root and nested)", () => {
    const rule = BUILTIN_GUARDED_RULES.find((r) => r.tool === "read_file" && r.pattern.includes("node_modules"))!;
    expect(patternMatches(rule, { tool: "read_file", text: "./node_modules/ink/build/index.js", resolvedPath: "./node_modules/ink/build/index.js" })).toBe(true);
    expect(patternMatches(rule, { tool: "read_file", text: "./node_modules/ink/package.json", resolvedPath: "./node_modules/ink/package.json" })).toBe(true);
    expect(patternMatches(rule, { tool: "read_file", text: "/repo/vendor/node_modules/lodash/index.d.ts", resolvedPath: "/repo/vendor/node_modules/lodash/index.d.ts" })).toBe(true);
  });

  it("matches list_files on the node_modules directory itself and below", () => {
    const rootRule = BUILTIN_GUARDED_RULES.find((r) => r.tool === "list_files" && r.pattern === "**/node_modules")!;
    const deepRule = BUILTIN_GUARDED_RULES.find((r) => r.tool === "list_files" && r.pattern === "**/node_modules/**")!;
    expect(patternMatches(rootRule, { tool: "list_files", text: "./node_modules", resolvedPath: "./node_modules" })).toBe(true);
    expect(patternMatches(deepRule, { tool: "list_files", text: "./node_modules/ink", resolvedPath: "./node_modules/ink" })).toBe(true);
  });

  it("a read_file node_modules rule does not match a plain write_to_file call into node_modules (tool-scoped)", () => {
    const readRule = BUILTIN_GUARDED_RULES.find((r) => r.tool === "read_file" && r.pattern.includes("node_modules"))!;
    expect(patternMatches(readRule, { tool: "write_to_file", text: "./node_modules/x/out.js", resolvedPath: "./node_modules/x/out.js" })).toBe(false);
  });

  it("engine resolves an explicit node_modules read to ask with isGuarded=true, even under defaultMode: allowAll", () => {
    const engine = new PermissionEngine({ defaultMode: "allowAll" }, "/repo");
    const result = engine.resolve("read_file", { path: "/repo/node_modules/ink/package.json" });
    expect(result.action).toBe("ask");
    expect(result.isGuarded).toBe(true);
    expect(result.winningRule?.origin).toBe("builtin-guarded");
  });

  it("engine resolves list_files on node_modules to ask (not silently allowed by the ./** builtin fallback)", () => {
    const engine = new PermissionEngine(undefined, "/repo");
    const result = engine.resolve("list_files", { path: "/repo/node_modules/ink" });
    expect(result.action).toBe("ask");
    expect(result.isGuarded).toBe(true);
  });

  it("engine still allows ordinary reads inside the working tree (no node_modules false positive)", () => {
    const engine = new PermissionEngine({ defaultMode: "allowAll" }, "/repo");
    const result = engine.resolve("read_file", { path: "/repo/src/main.ts" });
    expect(result.action).toBe("allow");
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

describe("BUILTIN_GUARDED_RULES: web_search", () => {
  it("matches any web_search call regardless of query text", () => {
    const rule = BUILTIN_GUARDED_RULES.find((r) => r.tool === "web_search")!;
    expect(rule).toBeDefined();
    expect(rule.kind).toBe("any");
    expect(patternMatches(rule, { tool: "web_search", text: "claude code hooks" })).toBe(true);
    expect(patternMatches(rule, { tool: "web_search", text: "" })).toBe(true);
  });

  it("engine resolves web_search to ask with isGuarded=true, exempt from posture bypass", () => {
    const engine = new PermissionEngine(undefined, "/tmp");
    const result = engine.resolve("web_search", { query: "latest stable node version" });
    expect(result.action).toBe("ask");
    expect(result.isGuarded).toBe(true);
    expect(result.winningRule?.origin).toBe("builtin-guarded");
  });

  it("engine resolves web_search to ask even under defaultMode: allowAll", () => {
    const engine = new PermissionEngine({ defaultMode: "allowAll" }, "/tmp");
    const result = engine.resolve("web_search", { query: "react 19 release notes" });
    expect(result.action).toBe("ask");
    expect(result.isGuarded).toBe(true);
  });

  it("uses the query string as the permission subject text", () => {
    expect(extractToolSubject("web_search", { query: "how to fix segfault" })).toBe("how to fix segfault");
    expect(extractToolSubject("web_search", {})).toBe("");
  });
});
