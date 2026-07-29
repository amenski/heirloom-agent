# Permission Specification

Consolidates the permission system: the pattern ruleset (previously split
across architecture.md Layer 5 and config-spec.md) plus **approval modes** —
the session-level overlay that makes the agent usable without editing YAML
mid-session (Claude Code's permission-modes pattern).

Threat model and known permission-engine defects: [security-spec.md](./security-spec.md).
Guarded patterns (always-prompt, not upgradeable by approval modes) are
defined there and take precedence over the resolution table below.

---

## Two Orthogonal Axes

| Axis | Question it answers | Defined by |
|------|--------------------|-----------|
| **Mode** (persona) | Which tools *exist* this turn? | mode-spec.md groups |
| **Approval mode** | Do `ask` rules actually prompt? | This doc, session state |

`ask` mode (persona) has no edit tools at all — approval mode is irrelevant
there. The axes never interact except that both must pass: a tool must be in
the persona's groups AND clear the permission check.

## Rule Resolution (recap + one addition)

1. Rules are evaluated in insertion order; **last match wins** (opencode).
2. Sources, in evaluation order (later = higher precedence):
   built-in defaults → global config → project config → **session rules**
   (added by "allow for session" answers, in-memory only).
3. The winning rule's action resolves as:

| Winning action | `manual` | `edits` | `all` |
|---------------|----------|---------|-------|
| `allow` | allow | allow | allow |
| `ask` | prompt user | edit-group tool inside workingDir → allow; else prompt | allow |
| `deny` | deny | deny | **deny** |

**Invariant: approval modes only upgrade `ask` → `allow`. An explicit `deny`
always wins, in every approval mode.** `rm *: deny` blocks `rm` even in
`all`. This is what makes `all` tolerable: the user's red lines hold.

`edits` auto-allows only tools in the `edit` group targeting paths inside
`workingDir` — `run_bash` always prompts in `edits`, and an edit tool aimed
outside the working directory prompts too.

## Approval Mode Rules

- Session-scoped. **Never persisted** — a new session always starts `manual`.
  Making auto-approval permanent must be a deliberate config edit.
- Switched with `/approve <manual|edits|all>`; bare `/approve` prints the
  current setting.
- The prompt shows non-default state: `heirloom [code] >` becomes
  `heirloom [code ⚡edits] >` / `heirloom [code ⚡all] >`. Auto-approval must
  be visible at a glance.
- Entering `all` prints a one-line warning naming the workingDir it applies to.

## The Ask Prompt

When a tool call resolves to `ask` (and approval mode doesn't upgrade it):

```
  [run_bash] npm install left-pad
  Allow? (y)es once · (a)llow for session · (n)o  >
```

| Answer | Effect |
|--------|--------|
| `y` | Run this one call |
| `a` | Run it AND append a session rule: exact tool + generalized pattern (`npm install *` for bash commands, the file's directory for edit tools). Shown back to the user as it's added. |
| `n` | Tool returns `PERMISSION_DENIED: denied by user` — the model sees it and can adjust course |

`a` is the workhorse: the ruleset learns during the session, so the third
`npm install` never prompts, without touching config. Session rules are
listed by `/approve` and die with the session.

## Headless Interaction (cli-spec.md)

- Default: fail closed — `ask` resolves to deny (unchanged).
- `-p --approve all` (or `edits`): applies the overlay for scripted runs.
  This is how golden tasks execute fixtures without per-call prompts.
  `deny` rules still hold, per the invariant.

## Design Decisions

1. **Overlay, not rule rewriting.** Approval mode never mutates the ruleset;
   it changes only how `ask` resolves. Rules stay the single source of truth
   and `/approve manual` instantly restores them.
2. **Two tiers, not three.** Claude Code needs a plan mode; heirloom's
   read-only personas already gate harder (the tools don't exist). No
   redundant third tier.
3. **`deny` is absolute.** The alternative (bypass mode overrides deny, like
   Claude Code's `bypassPermissions`) makes `all` too sharp for a
   default-shipped feature. Users who truly want that can delete the deny rule.
