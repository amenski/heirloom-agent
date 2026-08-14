import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SkillLoader, isSkillEnabled } from "./index.js";
import { trustSkill } from "./trust.js";

describe("isSkillEnabled", () => {
  it("returns true when the map is undefined (default enabled)", () => {
    expect(isSkillEnabled("foo", undefined)).toBe(true);
  });

  it("returns true when the skill is absent from the map (default enabled)", () => {
    expect(isSkillEnabled("foo", { bar: false })).toBe(true);
  });

  it("returns true when explicitly enabled", () => {
    expect(isSkillEnabled("foo", { foo: true })).toBe(true);
  });

  it("returns false only when explicitly disabled", () => {
    expect(isSkillEnabled("foo", { foo: false })).toBe(false);
  });
});

describe("SkillLoader.load honors enabledSkills", () => {
  let projectDir: string;
  let homeDir: string;
  let prevCwd: string;
  let prevHome: string | undefined;

  function writeSkill(name: string) {
    const dir = join(projectDir, ".heirloom", "skills", name);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "SKILL.md");
    writeFileSync(
      path,
      `---\nname: ${name}\ndescription: test ${name}\n---\nBody of ${name}`,
      "utf-8",
    );
    // Pre-trust, as a previous interactive session's ask would have.
    trustSkill(path, name);
  }

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "skills-proj-"));
    homeDir = mkdtempSync(join(tmpdir(), "skills-home-"));
    prevCwd = process.cwd();
    prevHome = process.env.HOME;
    process.env.HOME = homeDir; // isolate the trust store write
    process.chdir(projectDir);
    writeSkill("alpha");
    writeSkill("beta");
  });

  afterEach(() => {
    process.chdir(prevCwd);
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("indexes all skills when no enabledSkills map is given", async () => {
    const skills = await new SkillLoader().load();
    expect(skills.map((s) => s.name).sort()).toEqual(["alpha", "beta"]);
  });

  it("omits a skill explicitly set false and leaves others unaffected", async () => {
    const skills = await new SkillLoader().load({ enabledSkills: { alpha: false } });
    const names = skills.map((s) => s.name);
    expect(names).not.toContain("alpha");
    expect(names).toContain("beta");
  });

  it("keeps a skill explicitly set true", async () => {
    const skills = await new SkillLoader().load({ enabledSkills: { alpha: true } });
    expect(skills.map((s) => s.name).sort()).toEqual(["alpha", "beta"]);
  });
});
