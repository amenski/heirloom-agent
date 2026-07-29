/** Escape regex special characters. */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Read-only tools that just gather context — hide these from the output to
// keep the chat focused on what the agent actually *changes*.
export const SILENT_TOOLS = new Set(["list_files", "read_file", "glob", "search", "load_skill"]);

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Return a compact human-readable description of a tool call (no ANSI).
 * Paths are relativized to cwd.
 */
export function describeToolCall(name: string, args: Record<string, unknown>): string {
  const cwd = process.cwd();
  const firstStr = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = args[k];
      if (typeof v === "string" && v.length > 0) return v;
    }
    return undefined;
  };
  const short = (p: string): string => {
    const prefix = cwd + "/";
    if (p.startsWith(prefix)) return p.slice(prefix.length);
    if (p === cwd) return ".";
    return p;
  };
  const trunc = (s: string, max: number) => s.length > max ? s.slice(0, max) + "…" : s;

  switch (name) {
    case "list_files": {
      const p = firstStr("path");
      return p ? `list_files ${short(p)}/` : "list_files";
    }
    case "read_file": {
      const p = firstStr("path");
      if (!p) return "read_file";
      const o = typeof args.offset === "number" ? args.offset : null;
      const l = typeof args.limit === "number" ? args.limit : null;
      const range =
        o !== null && l !== null ? `:${o}-${o + l}`
        : o !== null ? `:${o}`
        : "";
      return `read_file ${short(p)}${range}`;
    }
    case "write_to_file": {
      const p = firstStr("path", "filePath");
      return p ? `write_to_file ${short(p)}` : "write_to_file";
    }
    case "edit":
    case "edit_file": {
      const p = firstStr("path", "filePath");
      return p ? `${name} ${short(p)}` : name;
    }
    case "search_replace": {
      const p = firstStr("path", "filePath");
      return p ? `search_replace ${short(p)}` : "search_replace";
    }
    case "apply_diff":
    case "apply_patch": {
      const p = firstStr("path", "filePath");
      return p ? `${name} ${short(p)}` : name;
    }
    case "run_bash": {
      const c = firstStr("command");
      if (!c) return "run_bash";
      // Strip `cd <cwd> && ` prefix — it's implicit context, not the real command
      let t = c.replace(/\n/g, " ").trim();
      t = t.replace(new RegExp(`^cd ${escapeRegex(cwd)}(?:/)?\\s*&&\\s*`), "");
      return `run_bash ${trunc(t, 60)}`;
    }
    case "glob": {
      const p = firstStr("pattern");
      return p ? `glob ${p}` : "glob";
    }
    case "search": {
      const p = firstStr("pattern");
      const d = firstStr("dir");
      let out = p ? `search ${trunc(p, 60)}` : "search";
      if (d && d !== ".") out += `  in ${short(d)}`;
      return out;
    }
    default: {
      // first meaningful string arg
      for (const [k, v] of Object.entries(args)) {
        if (typeof v === "string" && v.length > 0) return `${name} ${trunc(v, 60)}`;
      }
      return name;
    }
  }
}
