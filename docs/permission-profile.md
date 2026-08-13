# Permission Profile — Parallel ACL Design

**Status:** forward-looking design (draft for owner review) · 2026-08-13 ·
nothing in this doc is built; no code follows this contract until it is
approved and the status line changes.

This is the design doc that feature-plans.md §9 requires as step 1 of the
PermissionProfile workstream (decision **K**: full parallel ACL model, Codex
style, beside the existing rule engine). It settles the two open decisions —
**L** (evaluation order) and **M** (subsumption) — as recommendations the
owner approves or redirects.

---

## 1. Problem & context

Heirloom's permission architecture today is the Claude-Code family:
pattern rules + approval posture + guarded tiers (permission-spec.md,
security-spec.md). Its protections are *behavioral* — they match what the
model asked to do (`run_bash` command text, edit-tool paths via
`isEditToolInWorkspace`) and decide allow/ask/deny.

What the rule engine does **not** provide is a *capability boundary*: a
declarative statement of what the agent may touch at all, independent of
which tool or phrasing it uses. Two real gaps follow:

- **Reachability.** Every path check is per-tool and per-rule. A path that
  no rule mentions is policy-free — `isEditToolInWorkspace` only knows
  "inside/outside the workspace," nothing finer, and it is consulted by the
  approval overlay, not as a hard boundary.
- **Network.** `web_fetch`/`web_search` have their own SSRF guards, and
  bash egress sits in the guarded tier — but there is no single place that
  says "this agent may talk to these hosts and no others."

The Codex CLI model (researched 2026-08-13) splits this cleanly:
`sandbox_mode` levels (read-only / workspace-write / danger-full-access)
set the *default capability* of the whole agent, PermissionProfile rules
(path globs, network domains) carve exceptions inside the level, and the OS
sandbox (macOS Seatbelt, Linux Landlock/seccomp) enforces it mechanically.
Approval prompts are a separate axis — how often the user is asked — layered
on top.

## 2. Two layers, two axes (the core insight)

| | Rule engine (exists) | PermissionProfile (proposed) |
|---|---|---|
| Question answered | *May this operation run?* | *Is this resource reachable at all?* |
| Matches on | tool name + command/path pattern | path globs, network domains |
| Outcomes | allow / ask / deny | allow / deny (per level default) |
| Nature | behavioral policy, fine-grained, posture-upgradable | capability boundary, coarse, absolute |
| Escalation path | ask → user prompt | none (deny is terminal, silent) |

They are **orthogonal axes**, not competitors: a profile says *what the
agent can see and touch*; the rule engine says *which of those touches are
polite enough to do silently vs. need a human nod*. Neither subsumes the
other — a profile cannot express "guarded `rm -rf` always prompts," and a
rule cannot express "no reads outside the workspace, regardless of tool."

## 3. Profile schema

Config key `permissionProfile` (settings.json, project > global merge like
permissions):

```yaml
permissionProfile:
  level: workspace-write        # strict-sandbox | workspace-write | unrestricted
  fs:
    - path: "**/*.env"          # gitignore-style globs, relative to workspace roots
      action: deny              # deny | read | write   (write implies read)
    - path: ".git/**"
      action: deny
    - path: "~/notes/**"        # home-relative allowed
      action: read
  network:
    allow: ["api.deepseek.com", "registry.npmjs.org"]
    deny: ["*"]                 # allowlist mode; omit deny for default-allow
```

**Level presets** set the implicit default the explicit rules carve into:

| Level | Default fs | Default network | Equivalent today |
|---|---|---|---|
| `strict-sandbox` | read-only (any path) | denied | plan posture, but absolute |
| `workspace-write` | read anywhere; write only inside workspace roots | default-deny + allowlist | current behavior + a network allowlist |
| `unrestricted` | read + write anywhere | default-allow | exactly today's behavior |

Explicit `fs`/`network` rules **narrow only** — they can deny within a
level's allowance or grant read within `strict-sandbox`; they can never
grant more than the level's default permits (a `write` rule under
`strict-sandbox` is a config error, caught by validation). `.git/` and the
profile file itself are always denied, as in Codex.

## 4. Evaluation order — decision L: profile-gate → rules → posture

**Recommendation: profile first.** One composed entry point — call it
`authorize(call)` — that runs:

```
1. profile.decide(call)      → deny ⇒ DONE (silent, audit row "deny-by-profile")
                               allow ⇒ continue
2. rules.resolve(call)       → deny ⇒ DONE   (deny-by-rule / guarded)
                               ask  ⇒ continue to posture overlay
                               allow ⇒ DONE (allow-by-rule)
3. posture overlay           → upgrades rule-ask to allow-by-posture or
                               stays ask → user prompt (ask-approved /
                               ask-denied / unresolved-ask)
4. headless                  → any surviving ask ⇒ deny (existing rule)
```

**Deny-absolute invariant (proved per layer):**
- Layer 1 emits only `deny` or pass-through — a profile has no `ask`, so
  nothing a profile allows bypasses layer 2.
- Layer 2 `deny` (rule or guarded tier) is untouched by posture — existing
  invariant, unchanged.
- Layer 3 upgrades only `ask` → `allow`; it can never see a profile deny.
- Therefore every deny produced anywhere is final. ∎

**Why not rules-first (the alternative for L):** rules-first would let a
coarse rule (`allow edit *`) outrank a profile deny unless we special-case
"profile denies are absolute," which is just profile-gate again with extra
steps — the composition becomes stateful and harder to audit. Gate-first
also makes the audit trail one-directional: every record names exactly one
winning layer.

## 5. Subsumption — decision M: keep both, one surface

**Recommendation: permanent parallelism, composed behind `authorize()`.**

The axes argument in §2 is the reason migration would lose information:
guarded tiers and command-pattern rules are not expressible as reachability
rules. But two concrete consolidations happen as the profile lands:

1. **`isEditToolInWorkspace` (security-spec D1) becomes profile-derived.**
   The workspace-write default *is* that check, generalized: profile fs
   rules subsume the realpath-escape logic, and the overlay's "edits
   inside cwd" condition reads the profile's effective write-set instead
   of re-implementing containment.
2. **Edit-tool path rules in the rule engine get flagged for dedup.** If a
   session rule matches only on edit paths, it may be expressible as an fs
   rule; measure after phase (c), don't pre-migrate.

Everything else in the rule engine (command patterns, guarded patterns,
secret-adjacent reads, session rules, audit) stays.

## 6. Interactions with existing surfaces

- **Approval posture × profile.** Posture stays a *prompt-frequency* knob
  (manual / autoApprove / plan) layered above both. `autoApprove` never
  touches a profile deny (layers 1–2 precede it). `plan` aligns naturally
  with `strict-sandbox` but does not set it — switching levels is explicit
  config, not a posture side effect.
- **Guarded tiers.** Survive untouched and apply *after* the profile:
  `curl` egress remains always-prompt even under `unrestricted`, because
  bash's network reach is not profile-expressible (see §7).
- **Session rules** (`a` answers) stay in layer 2; they cannot reference
  the profile.
- **Headless.** Fail-closed unchanged: profile deny → deny; rule ask → deny.
- **MCP tools.** Profile does not gate MCP (their commands are already
  `strictMcpConfig`-allowlisted and their internal behavior is the server's
  contract); revisit if a server proves abusive.
- **Sub-agents.** Inherit the parent's profile and rule engine together
  (same object threading as today's permission inheritance).

## 7. Per-tool enforcement map

| Surface | Enforced by | Notes |
|---|---|---|
| edit-group tools (write targets) | profile fs rules (write) | replaces D1 containment as the boundary; D1 logic becomes the `workspace-write` default |
| read tools (`read_file`, `glob`, `search`, skills) | profile fs rules (read) | new: reads outside the workspace become profile-deniable |
| `web_fetch`, `web_search` | profile network rules | in front of the existing SSRF guard; both must pass |
| bash network egress (`curl`, `wget`, …) | rule-engine guarded tier (unchanged) | honest limitation: a shell has no tool-scoped network argument to gate; the profile cannot silently allow what the shell does. Documented, not fudged |
| `run_bash` fs side effects | rule engine only | same reason; Seatbelt phase closes this (below) |

## 8. Seatbelt phase (macOS)

The rules-first phase above is the *policy*; the OS sandbox is the
*mechanism*. Phase (e): `sandbox: { enabled: true }` launches the agent's
bash child processes under a Seatbelt profile per level — strict-sandbox:
read-only fs + no network; workspace-write: write only workspace roots +
network to profile allowlist. Non-macOS platforms run policy-only with a
startup notice. This mirrors Codex's backend choice and finally closes the
"bash can touch anything" gap from §7.

## 9. Migration & back-compat

- `permissionProfile` absent ⇒ level `unrestricted` + empty rules ⇒
  **byte-for-byte today's behavior** (layers 2–3 only). The feature is
  additive; nothing existing changes until the owner sets a level.
- Setting a level below `unrestricted` is a deliberate, visible change:
  the status line shows the level next to posture, and the first session
  at a new level prints a one-line notice (like posture's).

## 10. Phasing & verification

- **(a) this doc** — owner review of L, M, and the §7 bash-limitation
  honesty. **Verify:** review comments resolved.
- **(b) schema + config validation** — loader parses `permissionProfile`;
  invalid level/rule = fail fast naming file+field; narrowing-only
  violations rejected. **Verify:** loader tests.
- **(c) evaluation layer** — `authorize()` composition + audit rows
  (`deny-by-profile` decision value added to the session record union).
  **Verify:** engine tests incl. the deny-absolute matrix
  (profile-deny × posture, profile-deny × rule-allow, guarded ×
  unrestricted).
- **(d) posture/prompt/UI integration** — status-line level segment,
  headless wiring, `isEditToolInWorkspace` consolidation (M.1).
  **Verify:** App/headless tests + manual posture-matrix pass.
- **(e) Seatbelt** — flag-gated; profile fixtures per level.
  **Verify:** sandbox-escape fixture tests (write outside workspace,
  network to non-allowlisted host) fail closed.

## 11. Owner review checklist

1. **L** — approve profile-gate → rules → posture? (§4)
2. **M** — approve keep-both-one-surface with the two consolidations? (§5)
3. §7 honesty — acceptable that bash egress/fs side effects stay
   rule-engine-governed until the Seatbelt phase? (The alternative —
   pretending a network allowlist governs the shell — was rejected as a
   false security promise.)
4. Level names & defaults — Codex-compatible (`workspace-write` default)
   or heirloom-native?
