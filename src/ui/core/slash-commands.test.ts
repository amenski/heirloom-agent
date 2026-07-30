import { describe, it, expect } from "vitest";
import {
  getSlashCommands,
  filterSlashCommands,
  findExactSlashCommand,
} from "./slash-commands.js";

describe("/theme slash command registration", () => {
  it("registers a /theme command", () => {
    const cmds = getSlashCommands();
    const theme = cmds.find((c) => c.name === "theme");
    expect(theme).toBeDefined();
    expect(theme!.kind).toBe("theme");
    expect(theme!.label).toBe("/theme");
    expect(theme!.description).toMatch(/theme/i);
  });

  it("is discoverable by prefix filtering", () => {
    const hits = filterSlashCommands(getSlashCommands(), "/the");
    expect(hits.map((h) => h.name)).toContain("theme");
  });

  it("resolves as an exact command", () => {
    const exact = findExactSlashCommand(getSlashCommands(), "/theme");
    expect(exact?.kind).toBe("theme");
  });

  it("keeps /model registered alongside /theme (sibling picker)", () => {
    const names = getSlashCommands().map((c) => c.name);
    expect(names).toContain("model");
    expect(names).toContain("theme");
  });
});
