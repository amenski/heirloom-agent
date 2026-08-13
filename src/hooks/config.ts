import type { HookEntry, HookEvent, HooksConfig } from "./types.js";
import { ALL_HOOK_EVENTS, TOOL_EVENTS } from "./types.js";

/**
 * Hook config parsing (docs/hooks-spec.md §1). Called from config/loader.ts
 * with the raw `hooks` values of the global and project settings files
 * *before* merge, so each entry keeps its origin for the TOFU trust model
 * (§6): global hooks are trusted implicitly, project hooks are not.
 *
 * Merge semantics mirror the loader's deepMerge for the rest of the file:
 * per event key, the project's array replaces the global's; events the
 * project doesn't mention keep the global entries. `disableAllHooks` is a
 * separate top-level key parsed by the loader itself.
 */

// `^[A-Za-z0-9_|,]+$` = exact-name list (`run_bash|edit`); anything else is an
// unanchored JS regex. Invalid regex → fail-fast config error naming the entry.
const EXACT_MATCHER_RE = /^[A-Za-z0-9_|,]+$/;

function compileMatcher(
  matcher: string,
  command: string,
  source: string,
  errors: string[],
): ((toolName: string) => boolean) | undefined {
  if (matcher === "*") return undefined;
  if (EXACT_MATCHER_RE.test(matcher)) {
    const names = new Set(matcher.split(/[|,]/).filter(Boolean));
    return (toolName: string) => names.has(toolName);
  }
  try {
    const regex = new RegExp(matcher);
    return (toolName: string) => regex.test(toolName);
  } catch (err) {
    errors.push(
      `${source}: hooks entry "${command}" has invalid matcher regex "${matcher}": ${(err as Error).message}`,
    );
    return undefined;
  }
}

function parseSource(
  raw: unknown,
  origin: "global" | "project",
  source: string,
  errors: string[],
): Map<HookEvent, HookEntry[]> {
  const result = new Map<HookEvent, HookEntry[]>();
  if (raw === undefined || raw === null) return result;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    errors.push(`${source}: hooks must be an object`);
    return result;
  }

  for (const [eventKey, list] of Object.entries(raw as Record<string, unknown>)) {
    const event = eventKey as HookEvent;
    if (!ALL_HOOK_EVENTS.includes(event)) {
      errors.push(`${source}: hooks contains unknown event "${eventKey}"`);
      continue;
    }
    if (!Array.isArray(list)) {
      errors.push(`${source}: hooks.${eventKey} must be an array`);
      continue;
    }
    const entries: HookEntry[] = [];
    for (const item of list) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        errors.push(`${source}: hooks.${eventKey} contains a non-object entry`);
        continue;
      }
      const e = item as Record<string, unknown>;
      if (typeof e.command !== "string" || e.command === "") {
        errors.push(`${source}: hooks.${eventKey} entry missing string "command"`);
        continue;
      }
      if (e.matcher !== undefined && typeof e.matcher !== "string") {
        errors.push(`${source}: hooks.${eventKey} entry "${e.command}" matcher must be a string`);
        continue;
      }
      const entry: HookEntry = { event, command: e.command, origin };
      if (typeof e.matcher === "string") {
        entry.matcher = e.matcher;
        // Matchers are tool-events-only (spec §1); accepted and ignored elsewhere.
        if (TOOL_EVENTS.includes(event)) {
          entry.matches = compileMatcher(e.matcher, e.command, source, errors);
        }
      }
      entries.push(entry);
    }
    result.set(event, entries);
  }
  return result;
}

export function parseHooksConfig(
  globalRaw: unknown,
  projectRaw: unknown,
  source: string,
  errors: string[],
): HooksConfig | undefined {
  if (globalRaw === undefined && projectRaw === undefined) return undefined;

  const globalEntries = parseSource(globalRaw, "global", source, errors);
  const projectEntries = parseSource(projectRaw, "project", source, errors);

  // Project wins per event; events the project doesn't mention keep global.
  const merged = new Map<HookEvent, HookEntry[]>(globalEntries);
  for (const [event, entries] of projectEntries) {
    merged.set(event, entries);
  }

  const byEvent = {} as Record<HookEvent, HookEntry[]>;
  const entries: HookEntry[] = [];
  for (const event of ALL_HOOK_EVENTS) {
    byEvent[event] = merged.get(event) ?? [];
    entries.push(...byEvent[event]);
  }

  return { entries, byEvent };
}
