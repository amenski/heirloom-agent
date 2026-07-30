import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadProjectRules } from "./prompt.js";

describe("loadProjectRules", () => {
  let projectDir: string;

  function rulesDir(): string {
    return join(projectDir, ".heirloom", "rules");
  }

  function writeRule(relPath: string, content: string): void {
    const full = join(rulesDir(), relPath);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "heirloom-rules-"));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("returns null when the rules dir is absent", () => {
    expect(loadProjectRules(projectDir)).toBeNull();
  });

  it("returns null when the rules dir has no usable content", () => {
    mkdirSync(rulesDir(), { recursive: true });
    expect(loadProjectRules(projectDir)).toBeNull();
  });

  it("scopes a nested file by its path relative to the rules dir", () => {
    writeRule("api/naming.md", "Use camelCase for functions.");

    const out = loadProjectRules(projectDir);
    expect(out).toContain("# Project Rules");
    expect(out).toContain("### Rule: api/naming");
    expect(out).toContain("Use camelCase for functions.");
  });

  it("orders files before subdirectories, alphabetical within each group", () => {
    // Deliberately interleaved: top-level files, plus nested dirs.
    writeRule("zeta.md", "Z rule.");
    writeRule("alpha.md", "A rule.");
    writeRule("api/naming.md", "API naming.");
    writeRule("api/errors.md", "API errors.");
    writeRule("db/schema.md", "DB schema.");

    const out = loadProjectRules(projectDir)!;
    const scopes = [...out.matchAll(/### Rule: (\S+)/g)].map((m) => m[1]);

    // Files (alpha, zeta) come before subdirectories (api/*, db/*).
    // Within api/, errors < naming. db/ comes after api/.
    expect(scopes).toEqual([
      "alpha",
      "zeta",
      "api/errors",
      "api/naming",
      "db/schema",
    ]);
  });

  it("skips empty (and whitespace-only) files", () => {
    writeRule("kept.md", "Real content.");
    writeRule("empty.md", "");
    writeRule("blank.md", "   \n\t\n  ");

    const out = loadProjectRules(projectDir)!;
    expect(out).toContain("### Rule: kept");
    expect(out).not.toContain("### Rule: empty");
    expect(out).not.toContain("### Rule: blank");
  });

  it("skips symlinked files that resolve outside the project directory", () => {
    // A secret file living entirely outside the project.
    const outside = mkdtempSync(join(tmpdir(), "heirloom-outside-"));
    const secret = join(outside, "secret.md");
    writeFileSync(secret, "SHOULD NOT BE INJECTED");

    mkdirSync(rulesDir(), { recursive: true });
    writeRule("legit.md", "Legit rule.");
    symlinkSync(secret, join(rulesDir(), "escape.md"));

    const out = loadProjectRules(projectDir)!;
    expect(out).toContain("### Rule: legit");
    expect(out).not.toContain("SHOULD NOT BE INJECTED");
    expect(out).not.toContain("### Rule: escape");

    rmSync(outside, { recursive: true, force: true });
  });

  it("truncates with a note when the size cap is exceeded", () => {
    // Each rule ~8KB; three of them blow past the 20KB cap.
    const big = "x".repeat(8 * 1024);
    writeRule("a.md", big);
    writeRule("b.md", big);
    writeRule("c.md", big);

    const out = loadProjectRules(projectDir)!;
    expect(out).toContain("Project rules truncated");
    // First two fit; the third pushes over and is dropped.
    expect(out).toContain("### Rule: a");
    expect(out).toContain("### Rule: b");
    expect(out).not.toContain("### Rule: c");
  });
});
