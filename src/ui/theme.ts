/**
 * Heirloom Theme System
 *
 * Fully offline, config-driven color scheme engine.
 * Supports light, dark, and custom themes with 20+ semantic color slots.
 * All colors use 8-bit ANSI codes (0-255) for maximum terminal compatibility.
 *
 * No external dependencies — pure TypeScript.
 */

import { execSync } from "node:child_process";

// ── ANSI 8-bit color palette helpers ──

/** Named ANSI 8-bit colors for easy reference. */
export const ANSI: Record<string, number> = {
  // Standard 16
  black: 0,
  red: 1,
  green: 2,
  yellow: 3,
  blue: 4,
  magenta: 5,
  cyan: 6,
  white: 7,
  brightBlack: 8,
  brightRed: 9,
  brightGreen: 10,
  brightYellow: 11,
  brightBlue: 12,
  brightMagenta: 13,
  brightCyan: 14,
  brightWhite: 15,

  // Extended greys
  grey0: 16,
  grey7: 232,
  grey15: 233,
  grey23: 234,
  grey31: 235,
  grey39: 236,
  grey47: 237,
  grey55: 238,
  grey63: 239,
  grey71: 240,
  grey79: 241,
  grey87: 242,
  grey95: 243,
  grey103: 244,
  grey111: 245,
  grey119: 246,
  grey127: 247,
  grey135: 248,
  grey143: 249,
  grey151: 250,
  grey159: 251,
  grey167: 252,
  grey175: 253,
  grey183: 254,
  grey191: 255,

  // Common semantic aliases
  orange: 208,
  purple: 93,
  pink: 205,
  teal: 37,
  coral: 203,
  gold: 220,
  lime: 154,
  sky: 117,
  indigo: 63,
  rose: 175,
};

export type AnsiColor = number | string;

export interface HexColor {
  r: number;
  g: number;
  b: number;
}

/** Convert an ANSI 8-bit code to a dimmed version (lower luminance). */
export function dimAnsi(code: number): number {
  // For bright colors (8-15), map to their dim counterparts
  if (code >= 8 && code <= 15) return code - 8;
  // For grey tones, darken by moving toward 0
  if (code >= 232) return Math.max(232, code - 8);
  // For regular colors, use a dimmer variant
  return code;
}

/** Apply ANSI escape codes for foreground color. */
export function ansiFg(code: number): string {
  return `\x1b[38;5;${code}m`;
}

/** Apply ANSI escape codes for background color. */
export function ansiBg(code: number): string {
  return `\x1b[48;5;${code}m`;
}

/** Reset ANSI formatting. */
export const ANSI_RESET = "\x1b[0m";

/**
 * Bridge an ANSI 8-bit theme slot (0–255) to an Ink `<Text color>` string.
 * Ink parses `ansi256(N)` and routes it to `chalk.ansi256(N)` — this is the
 * canonical way to feed a numeric theme slot into a `color` prop.
 */
export function ansi256(code: number): string {
  return `ansi256(${code})`;
}

/**
 * Apply ANSI codes to text for a given color code.
 * Respects NO_COLOR environment variable.
 */
export function colorize(text: string, fg?: number, bg?: number, bold = false): string {
  if (!process.stdout.isTTY || process.env.NO_COLOR) return text;
  let codes = "";
  if (bold) codes += "\x1b[1m";
  if (fg !== undefined) codes += ansiFg(fg);
  if (bg !== undefined) codes += ansiBg(bg);
  if (!codes) return text;
  return `${codes}${text}${ANSI_RESET}`;
}

// ── Semantic Theme Definition ──

export interface SyntaxColors {
  keyword: number;
  string: number;
  number: number;
  comment: number;
  type: number;
  function: number;
  variable: number;
  constant: number;
  operator: number;
  punctuation: number;
  tag: number;
  attribute: number;
  regexp: number;
  builtin: number;
  className: number;
  property: number;
  boolean: number;
  nullish: number;
  decorator: number;
}

export interface ThemeDefinition {
  /** Theme identifier */
  name: string;
  /** Base mode */
  type: "light" | "dark" | "custom";

  // ── Core UI colors ──
  primary: number;
  secondary: number;
  accent: number;
  error: number;
  warning: number;
  success: number;
  info: number;

  // ── Text colors ──
  text: number;
  textDim: number;
  textBright: number;
  textInverse: number;
  link: number;

  // ── Background / chrome ──
  background: number;
  surface: number;
  border: number;
  selection: number;

  // ── Prompt ──
  promptFg: number;
  promptBg?: number;

  // ── Status bar ──
  statusBar: {
    text: number;
    dim: number;
    background: number;
    separator: number;
    modeFg: number;
    modelFg: number;
    warningFg: number;
    errorFg: number;
  };

  // ── Syntax highlighting ──
  syntax: SyntaxColors;

  // ── Spinner ──
  spinner: number;
}

// ── Built-in themes ──

export const DARK_THEME: ThemeDefinition = {
  name: "dark",
  type: "dark",

  primary: ANSI.blue,
  secondary: ANSI.cyan,
  // accent doubles as the secondary gutter/ask emphasis — a bright blue that
  // stays legible on a black background (see theme-spec.md "Gutter & prompt
  // contrast"). Distinct from promptFg so the two accents don't collide.
  accent: 33,
  error: ANSI.red,
  warning: ANSI.orange,
  success: ANSI.green,
  info: ANSI.sky,

  text: ANSI.white,
  textDim: ANSI.grey103,
  textBright: ANSI.brightWhite,
  textInverse: ANSI.black,
  link: ANSI.sky,

  background: ANSI.black,
  surface: ANSI.grey23,
  border: ANSI.grey47,
  selection: ANSI.blue,

  // Bright blue gutter/prompt accent, readable on black.
  promptFg: 39,
  promptBg: undefined,

  statusBar: {
    text: ANSI.white,
    dim: ANSI.grey103,
    background: ANSI.grey23,
    separator: ANSI.grey55,
    modeFg: ANSI.cyan,
    modelFg: ANSI.brightWhite,
    warningFg: ANSI.orange,
    errorFg: ANSI.red,
  },

  syntax: {
    keyword: ANSI.purple,
    string: ANSI.green,
    number: ANSI.lime,
    comment: ANSI.grey111,
    type: ANSI.teal,
    function: ANSI.yellow,
    variable: ANSI.white,
    constant: ANSI.orange,
    operator: ANSI.cyan,
    punctuation: ANSI.grey135,
    tag: ANSI.red,
    attribute: ANSI.yellow,
    regexp: ANSI.coral,
    builtin: ANSI.cyan,
    className: ANSI.yellow,
    property: ANSI.sky,
    boolean: ANSI.orange,
    nullish: ANSI.grey111,
    decorator: ANSI.teal,
  },

  spinner: ANSI.cyan,
};

export const LIGHT_THEME: ThemeDefinition = {
  name: "light",
  type: "light",

  primary: ANSI.blue,
  secondary: ANSI.teal,
  // Deep indigo accent — high contrast on white, off the washed-out mid-tones
  // (see theme-spec.md "Gutter & prompt contrast"). Distinct from promptFg.
  accent: 27,
  error: ANSI.red,
  warning: ANSI.orange,
  success: ANSI.green,
  info: ANSI.blue,

  text: ANSI.grey23,
  textDim: ANSI.grey111,
  textBright: ANSI.black,
  textInverse: ANSI.brightWhite,
  link: ANSI.blue,

  background: ANSI.white,
  surface: ANSI.grey191,
  border: ANSI.grey151,
  selection: ANSI.sky,

  // Deep blue gutter/prompt accent — legible on white (not the old mid-cyan,
  // which washed out).
  promptFg: 26,
  promptBg: undefined,

  statusBar: {
    text: ANSI.grey23,
    dim: ANSI.grey111,
    background: ANSI.grey191,
    separator: ANSI.grey151,
    modeFg: ANSI.teal,
    modelFg: ANSI.black,
    warningFg: ANSI.orange,
    errorFg: ANSI.red,
  },

  syntax: {
    keyword: ANSI.purple,
    string: ANSI.green,
    number: ANSI.lime,
    comment: ANSI.grey111,
    type: ANSI.teal,
    function: ANSI.blue,
    variable: ANSI.grey23,
    constant: ANSI.orange,
    operator: ANSI.cyan,
    punctuation: ANSI.grey87,
    tag: ANSI.red,
    attribute: ANSI.blue,
    regexp: ANSI.coral,
    builtin: ANSI.teal,
    className: ANSI.blue,
    property: ANSI.sky,
    boolean: ANSI.orange,
    nullish: ANSI.grey111,
    decorator: ANSI.teal,
  },

  spinner: ANSI.blue,
};

export const HIGH_CONTRAST_THEME: ThemeDefinition = {
  name: "high-contrast",
  type: "custom",

  primary: ANSI.brightCyan,
  secondary: ANSI.brightGreen,
  accent: ANSI.brightYellow,
  error: ANSI.brightRed,
  warning: ANSI.brightYellow,
  success: ANSI.brightGreen,
  info: ANSI.brightCyan,

  text: ANSI.brightWhite,
  textDim: ANSI.brightBlack,
  textBright: ANSI.brightWhite,
  textInverse: ANSI.black,
  link: ANSI.brightCyan,

  background: ANSI.black,
  surface: ANSI.grey15,
  border: ANSI.grey31,
  selection: ANSI.brightBlue,

  promptFg: ANSI.brightCyan,
  promptBg: undefined,

  statusBar: {
    text: ANSI.brightWhite,
    dim: ANSI.brightBlack,
    background: ANSI.grey15,
    separator: ANSI.grey55,
    modeFg: ANSI.brightCyan,
    modelFg: ANSI.brightWhite,
    warningFg: ANSI.brightYellow,
    errorFg: ANSI.brightRed,
  },

  syntax: {
    keyword: ANSI.brightMagenta,
    string: ANSI.brightGreen,
    number: ANSI.brightYellow,
    comment: ANSI.brightBlack,
    type: ANSI.brightCyan,
    function: ANSI.brightYellow,
    variable: ANSI.brightWhite,
    constant: ANSI.brightYellow,
    operator: ANSI.brightCyan,
    punctuation: ANSI.grey135,
    tag: ANSI.brightRed,
    attribute: ANSI.brightYellow,
    regexp: ANSI.brightRed,
    builtin: ANSI.brightCyan,
    className: ANSI.brightYellow,
    property: ANSI.brightCyan,
    boolean: ANSI.brightYellow,
    nullish: ANSI.grey111,
    decorator: ANSI.brightCyan,
  },

  spinner: ANSI.brightCyan,
};

export const BUILTIN_THEMES: Record<string, ThemeDefinition> = {
  dark: DARK_THEME,
  light: LIGHT_THEME,
  "high-contrast": HIGH_CONTRAST_THEME,
};

// ── Theme Manager ──

export interface ThemeConfig {
  mode: "dark" | "light" | "auto";
  overrides?: Partial<ThemeDefinition>;
  /** Override automatic color detection. Used by ThemeProvider. */
  colorEnabled?: boolean;
}

/**
 * Resolve a theme from config.
 * - 'auto' follows system preference via `prefers-color-scheme`
 * - Named themes resolve from builtins
 * - Overrides are shallow-merged into the base theme
 */
export function resolveTheme(config?: ThemeConfig): ThemeDefinition {
  const mode = config?.mode ?? "dark";

  let themeName: string;
  if (mode === "auto") {
    // Best-effort system preference detection (no deps, no remote)
    themeName = detectSystemTheme();
  } else {
    themeName = mode;
  }

  const base = BUILTIN_THEMES[themeName] ?? DARK_THEME;

  if (!config?.overrides) return base;

  return deepMergeTheme(base, config.overrides);
}

/** Dependencies for system-theme detection, injectable for testing. */
export interface SystemThemeDeps {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** Runs a command and returns stdout; must throw on non-zero exit. */
  exec: (cmd: string) => string;
}

/**
 * Pure system-theme detector (no caching, no I/O of its own beyond the injected
 * `exec`). Detection order:
 *   1. COLORFGBG ("fg;bg" or "fg;x;bg") — last field 0–6 or 8 → dark, 7/15 → light.
 *   2. macOS: `defaults read -g AppleInterfaceStyle` prints "Dark" → dark;
 *      a non-zero exit (key absent) → light. Only attempted on darwin.
 *   3. Fallback: dark.
 */
export function detectSystemThemeFrom(deps: SystemThemeDeps): "dark" | "light" {
  // 1. COLORFGBG — set by many terminals to advertise fg/bg palette indices.
  const colorfgbg = deps.env.COLORFGBG;
  if (colorfgbg) {
    const parts = colorfgbg.split(";");
    const bg = parts[parts.length - 1]?.trim();
    const bgNum = Number(bg);
    if (bg !== "" && Number.isInteger(bgNum)) {
      if (bgNum === 7 || bgNum === 15) return "light";
      if ((bgNum >= 0 && bgNum <= 6) || bgNum === 8) return "dark";
      // Any other value: fall through to the next detection stage.
    }
  }

  // 2. macOS system appearance.
  if (deps.platform === "darwin") {
    try {
      const out = deps.exec("defaults read -g AppleInterfaceStyle");
      if (out.trim() === "Dark") return "dark";
      // Key present but not "Dark" — treat as light.
      return "light";
    } catch {
      // Non-zero exit means the key is absent, i.e. Light mode.
      return "light";
    }
  }

  // 3. Fallback.
  return "dark";
}

function detectSystemTheme(): "dark" | "light" {
  if (_systemThemeCache) return _systemThemeCache;

  const result = detectSystemThemeFrom({
    env: process.env,
    platform: process.platform,
    exec: (cmd) =>
      execSync(cmd, { timeout: 1000, stdio: ["ignore", "pipe", "ignore"] }).toString(),
  });

  _systemThemeCache = result;
  return result;
}

let _systemThemeCache: "dark" | "light" | null = null;

function deepMergeTheme(base: ThemeDefinition, overrides: Partial<ThemeDefinition>): ThemeDefinition {
  const result = { ...base };

  for (const key of Object.keys(overrides) as (keyof ThemeDefinition)[]) {
    const val = overrides[key];
    if (val === undefined) continue;

    if (key === "statusBar" && typeof val === "object") {
      result.statusBar = { ...result.statusBar, ...(val as any) };
    } else if (key === "syntax" && typeof val === "object") {
      result.syntax = { ...result.syntax, ...(val as any) };
    } else {
      (result as any)[key] = val;
    }
  }

  return result;
}

// ── React Context Types (used by Ink components) ──

/**
 * A resolved theme with helper methods for applying colors to text.
 * This is what components receive at runtime.
 */
export class ThemeContextValue {
  readonly theme: ThemeDefinition;
  readonly colorEnabled: boolean;

  constructor(theme: ThemeDefinition, colorEnabled?: boolean) {
    this.theme = theme;
    this.colorEnabled = colorEnabled ?? (!!process.stdout.isTTY && !process.env.NO_COLOR);
  }

  /** Format text with a foreground color from the theme. */
  fg(color: number, text: string): string {
    return this._wrap(color, undefined, false, text, false);
  }

  /** Format text with bold + foreground. */
  bold(color: number, text: string): string {
    return this._wrap(color, undefined, true, text, false);
  }

  /** Dim text. */
  dim(text: string): string {
    if (!this.colorEnabled) return text;
    return `\x1b[2m${text}\x1b[0m`;
  }

  /** Format text as dimmed foreground. */
  dimFg(color: number, text: string): string {
    return this._wrap(color, undefined, false, text, true);
  }

  /** Format text using a semantic color key from the theme. */
  semantic(key: keyof ThemeDefinition, text: string): string {
    const color = this.theme[key] as number | undefined;
    if (color === undefined) return text;
    return this.fg(color, text);
  }

  /** Format text using a syntax highlighting color. */
  syntax(key: keyof SyntaxColors, text: string): string {
    const color = this.theme.syntax[key];
    return this.fg(color, text);
  }

  private _wrap(
    fg: number | undefined,
    bg: number | undefined,
    bold: boolean,
    text: string,
    forceDim: boolean,
  ): string {
    if (!this.colorEnabled) return text;
    let codes = "";
    if (bold) codes += "\x1b[1m";
    if (forceDim) codes += "\x1b[2m";
    if (fg !== undefined) codes += ansiFg(fg);
    if (bg !== undefined) codes += ansiBg(bg);
    if (!codes) return text;
    return `${codes}${text}${ANSI_RESET}`;
  }
}

/** Default theme context value (dark). */
export function createDefaultTheme(): ThemeContextValue {
  return new ThemeContextValue(DARK_THEME);
}
