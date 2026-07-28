import type { ModeConfig } from "../modes/loader.js";

export function validateModeYaml(mode: ModeConfig, source: string): string[] {
  const errors: string[] = [];
  if (!mode.slug) errors.push(`${source}: missing "slug"`);
  if (!mode.name) errors.push(`${source}: missing "name"`);
  if (!mode.roleDefinition) errors.push(`${source}: missing "roleDefinition"`);
  if (mode.groups) {
    const validGroups = ["read", "edit", "command", "mcp", "workflow"];
    for (const g of mode.groups) {
      if (!validGroups.includes(g)) errors.push(`${source}: unknown group "${g}"`);
    }
  }
  return errors;
}
