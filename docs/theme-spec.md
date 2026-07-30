# Theme Spec

Status: **partly implemented, partly planned.** Gutter/prompt contrast fix and
real system-theme detection shipped 2026-08-01 (`ansi256()` bridge, tuned slots,
injectable detector + tests; note: detection must use static ESM imports — a
`require()` there silently breaks in the tsup bundle). `/theme` command, extra
presets, and `ThemeableStatic` still planned. The token model + resolver exist
and are wired in; the runtime `/theme` switcher, a working system-detect, and the
gutter/prompt contrast fix below are planned.

Heirloom's theme system lives in `src/ui/theme.ts`: a fully offline, config-driven
color engine with ~20 semantic slots, a 19-color `SyntaxColors` set, and a
`statusBar` sub-palette — richer than most terminal-CLI theme systems. Colors are
8-bit ANSI codes (0–255) for broad terminal compatibility, exposed to Ink
components through a `ThemeContextValue` + `useTheme` context.

Config: the `theme` key (`theme.mode: dark | light | auto`, `theme.name`,
`theme.overrides`) is parsed by the loader; `resolveTheme(config)` returns the
resolved `ThemeDefinition`, shallow-merging any overrides.

---

## Gutter & prompt contrast — problem and fix

### Problem

Several user-facing accents are **hardcoded truecolor hex** that bypass the
theme, so they don't adapt to the terminal's background:

- **The message gutter bar `▌`** (`src/ui/OutputArea.tsx:83`) is `#229ac3`, a
  fixed mid-cyan. On a **light** terminal it's a low-contrast mid-tone against
  white; on dark it's on the dim side. It ignores the theme entirely.
- **Permission prompt** (`src/ui/PermissionPrompt.tsx`) mixes named colors
  (`yellow`) with hardcoded hex (`#229ac3`, and status hexes `#ef4444`,
  `#f59e0b`, `#22c55e`).
- Hardcoded hex counts across the UI: `#229ac3`×15, `#ef4444`×8, `#f59e0b`×4,
  `#22c55e`×2 — all theme-blind.

Why a fixed hex can't win: Ink renders hex as **24-bit truecolor** — a literal
RGB the terminal shows verbatim, so it can't lean on the terminal's own light/dark
palette. **A single fixed color cannot be legible on both a white and a black
background** — that's a contrast impossibility, not a tuning problem.

Minor bug found alongside: `src/ui/views/AskUserQuestionPrompt.tsx:152` —
`focused === "other" ? "cyan" : "cyan"` is a no-op (both branches identical); the
focused state was meant to change the border color but doesn't.

### Decision — route accents through theme slots

**Chosen approach:** feed the gutter and ask/permission accents from the theme's
semantic slots (primarily `promptFg`, with `accent` for secondary emphasis)
instead of hardcoded hex — and give the **light** and **dark** themes distinct,
high-contrast values for those slots:

- **dark theme:** a bright blue `▌` on black,
- **light theme:** a deep blue / indigo `▌` on white (not the current mid-cyan,
  which washes out).

This makes the accent adapt per theme, and it composes with the planned `/theme`
switch + system auto-detect below (once `auto` reliably detects a light terminal,
the light values kick in automatically).

Rationale for theme-slots over "named ANSI + bold": named ANSI (`cyan`/`blue`)
would also be terminal-adaptive and is simpler, but routing through the theme
keeps a single source of truth for accent color, lets a user retheme it, and is
the on-architecture choice given Heirloom already has the slots. (Named-ANSI
values remain a fine *default* for those slots — see note.)

### Scope of the change

1. **`theme.ts`** — ensure `promptFg`/`accent` have deliberately contrasting
   values in `DARK_THEME` vs `LIGHT_THEME` (tune the light values off the current
   washed-out mid-cyan toward a deep blue/indigo). Consider ANSI-named defaults
   so the slot is legible even before any theme tuning.
2. **`OutputArea.tsx`** — gutter `▌` uses `theme.promptFg` (via `useTheme`),
   dropping `#229ac3`.
3. **`PermissionPrompt.tsx` / `AskUserQuestionPrompt.tsx`** — replace hardcoded
   accent hex with theme slots; keep the true-semantic status colors (error/warn/
   success) but source them from `theme.error/warning/success`. Fix the no-op
   `borderColor` ternary so focus actually changes it.

### Verify

- On a **light** terminal profile and a **dark** one, the gutter `▌` and the
  ask/permission border are clearly legible in both — the acceptance bar is
  "visible without squinting on white *and* black."
- Switching `theme.mode` between `light`/`dark` visibly changes the accent.
- `NO_COLOR` / non-TTY still degrades to no color (existing `colorEnabled` gate).

---

## Roadmap — runtime theming (from PR #132 review)

Heirloom has the theme *infrastructure* but no runtime control. These items
(analyzed in [improvement-roadmap.md → PR #132](./improvement-roadmap.md#pr-132--theme-system))
belong here:

1. **`/theme` command** — a picker (mirroring the `/model` dropdown + `/mcp` view
   patterns) with **live preview** and **Esc-to-revert**, persisting the chosen
   theme to settings on confirm. Heirloom currently has **no** `/theme` command —
   theme is config-file-only. This is the headline gap.
2. **Fix `detectSystemTheme`** — the current implementation in `theme.ts` is a
   stub (the `matchMedia` branch never fires in a terminal; it checks whether
   `~/.config/dconf/user` exists, else returns `"dark"`), so `mode:"auto"` is
   effectively "always dark." Replace with real detection (`COLORFGBG`, macOS
   `AppleInterfaceStyle`). **This is a real bug**, and the gutter fix above
   depends on it to auto-pick light values on a light terminal.
3. **Extra presets** (dracula, monokai, github-light/dark, ansi ×2) — re-expressed
   in Heirloom's richer `ThemeDefinition` shape (not PR #132's thinner token
   model, which would be a downgrade).
4. **`ThemeableStatic`** — needed only if live-preview `/theme` is added, so a
   preview repaints already-committed scrollback. (Note: interacts with the
   separate output-render work in [input-stall-diagnosis.md](./input-stall-diagnosis.md),
   which proposes moving committed output into Ink `<Static>` — coordinate the
   two.)

Explicitly **rejected** from PR #132: its `ThemeTokens` model and `resolver.ts` —
Heirloom's model is strictly richer and already integrated.
