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
import { loadProjectRules, buildStablePreamble, buildRepoMap, REPOMAP_BYTE_BUDGET } from "./prompt.js";

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

describe("buildRepoMap", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "heirloom-repomap-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns a map (no truncation note) for a small repo under budget", async () => {
    writeFileSync(join(dir, "a.ts"), "export function alpha() {}\n");
    writeFileSync(join(dir, "b.ts"), "export class Beta {}\n");

    const out = await buildRepoMap(dir);
    expect(out).not.toBeNull();
    expect(out).toContain("a.ts");
    expect(out).toContain("alpha");
    expect(Buffer.byteLength(out!, "utf-8")).toBeLessThanOrEqual(REPOMAP_BYTE_BUDGET + 128);
    expect(out).not.toContain("truncated");
  });

  it("caps at the byte budget and appends a truncation note when the corpus overflows", async () => {
    // Many files, each with several exported symbols — well over the 4KB cap.
    for (let i = 0; i < 200; i++) {
      const syms = Array.from({ length: 8 }, (_, j) => `export function fn_${i}_${j}() {}`).join("\n");
      writeFileSync(join(dir, `mod_${i}.ts`), syms + "\n");
    }

    const out = await buildRepoMap(dir);
    expect(out).not.toBeNull();
    expect(out).toContain("Repository map truncated");
    // The capped body (everything before the note) must respect the byte budget.
    const body = out!.split("*(Repository map truncated")[0];
    expect(Buffer.byteLength(body, "utf-8")).toBeLessThanOrEqual(REPOMAP_BYTE_BUDGET);
  });

  it("returns null for an empty repository (degrades to no map)", async () => {
    // Directory with no source files → nothing to map.
    writeFileSync(join(dir, "README.md"), "# no source here\n");
    expect(await buildRepoMap(dir)).toBeNull();
  });

  it("returns null (never throws) when the directory does not exist", async () => {
    const missing = join(dir, "does-not-exist");
    await expect(buildRepoMap(missing)).resolves.toBeNull();
  });
});

describe("buildStablePreamble — repository map injection", () => {
  it("injects the map under a '# Repository map' header, after project rules", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "heirloom-preamble-"));
    try {
      mkdirSync(join(projectDir, ".heirloom", "rules"), { recursive: true });
      writeFileSync(
        join(projectDir, ".heirloom", "rules", "naming.md"),
        "Use camelCase.",
      );

      const out = buildStablePreamble({
        workingDir: projectDir,
        repomap: "src/foo.ts: function foo",
      });

      expect(out).toContain("# Repository map");
      expect(out).toContain("src/foo.ts: function foo");
      // Ordering: rules block precedes the repository map.
      const rulesIdx = out.indexOf("# Project Rules");
      const mapIdx = out.indexOf("# Repository map");
      expect(rulesIdx).toBeGreaterThanOrEqual(0);
      expect(mapIdx).toBeGreaterThan(rulesIdx);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("omits the map header entirely when no map is provided", () => {
    const out = buildStablePreamble({ workingDir: process.cwd() });
    expect(out).not.toContain("# Repository map");
  });
});
