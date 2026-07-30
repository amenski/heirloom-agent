# Blocking destructive commands — matching-strategy research

Status: **research complete; core mechanism now largely implemented, one gap
remains.** Companion to [security-spec.md](./security-spec.md); this is the
deep-dive behind its **D3** defect and threat **T2** ("`rm -rf` evadable via
flag reordering").

> **Update:** since this doc was started, `src/permissions/rules.ts` gained
> `normalizeShortFlagCluster` + `normalizeCommandToken` + `matchesDestructivePrefix`
> — i.e. Heirloom **now does flag-cluster normalization** (the approach the
> research below endorses). The flag-reordering / absolute-path / case evasions
> in T2/D3 are closed. **One concrete gap remains:** no long-form→short-flag
> mapping, so `rm --recursive --force /` still doesn't match the `rm -rf /`
> builtin. See [Recommendation](#recommendation).

---

## The problem

Heirloom has no sandbox — **the permission prompt is the only control** (see
security-spec Non-Goals). So the matcher that classifies a shell command as
destructive/guarded is load-bearing, and it must not be evadable by trivially
rewriting a command into a semantically-identical form.

The canonical case: a rule for `rm -rf /` must also catch every equivalent:

| Variant | Why it evades ordered-prefix matching |
|---|---|
| `rm -fr /` | flags reordered within the cluster |
| `rm -r -f /` | flag cluster split into separate tokens |
| `rm --recursive --force /` | long-form flags, different tokens entirely |
| `rm /tmp -rf` | target before flags — order differs |
| `/usr/bin/rm -rf /` | absolute path → first token isn't `rm` |
| `RM -RF /` | case |
| `FOO=bar rm -rf /` | leading env-assignment |
| `\rm -rf /`, `command rm -rf /` | escape / builtin indirection |
| `echo / \| xargs rm -rf` | indirection — `rm` never appears as first token |

## What Heirloom does today

Three cooperating pieces (all in `src/permissions/`):

1. **`bash-normalize.ts` — pre-processing.** Before matching, a command is:
   unwrapped one level from `bash -c`/`sh -c`/`eval` (`detectWrapper`), split
   into segments on top-level `&&`/`||`/`;`/`|`/newline/`&` (`splitCompound`,
   quote-aware), and `sudo`-stripped (`stripSudo`). Segments containing
   constructs it *can't* safely resolve — `$(…)`, backticks, `<(…)`/`>(…)`,
   leading `VAR=`, or a command-carrying wrapper (`env`/`nice`/`nohup`/
   `timeout`/`command`/`xargs`/`find -exec`/bare `sh`/`bash`) — are flagged
   `wasUnresolved` (`isUnresolved`) and force an **ask** rather than falling
   through to whatever rule matches the visible first token.

2. **`destructive.ts` — the deny seed.** A short built-in list of
   `origin: "builtin-destructive"` rules: `rm -rf /`, `rm -rf ~`,
   `git push --force`, `git push -f`, `git reset --hard`, `git clean -fdx`,
   `mkfs`, `dd if=`, and the fork-bomb literal. Prefix rules except the fork
   bomb (exact).

3. **`rules.ts` — the matcher.** Ordinary user rules use `matchesPrefix`
   (ordered tokens at the start, final token at a **word boundary** via
   `matchesTokenBoundary`, so `mkfs` catches `mkfs.ext4`). The
   **builtin-destructive** rules instead use `matchesDestructivePrefix`, which
   first **normalizes**: `normalizeCommandToken` resolves the command to its
   lowercase **basename** (`/usr/bin/RM` → `rm`), and `normalizeShortFlagCluster`
   merges the leading short-flag run and **sorts its letters lowercased**
   (`-fr`/`-rf`/`-r -f`/`-FR` → one canonical `-fr`) before comparing.

### The gap (now narrowed)

Steps 1–2 handle chaining/wrappers/fail-closed well, and step 3's
`matchesDestructivePrefix` now closes the flag-reordering, absolute-path, and
case evasions that were security-spec **D3/T2**. **What remains:**
`normalizeShortFlagCluster` deliberately leaves **long-form flags untouched**
(see its doc comment at `rules.ts:67`), so `rm --recursive --force /` does **not**
normalize to `rm -rf /` and slips the builtin rule. That single row of the table
above is the outstanding gap; the rest are covered.

---

## The two approaches named for this deep-dive

### A. Token-set membership

Decompose the command into an **unordered set (or multiset) of tokens** and test
membership / subset, ignoring order.

- **Catches:** reordering and target-position variants — `rm -fr /`,
  `rm /tmp -rf` become the same set as `rm -rf /`.
- **The catch (crux):** a bundled cluster is *one token*. `{"rm","-rf","/"}` ≠
  `{"rm","-r","-f","/"}` unless the flags are first **de-clustered**. So plain
  token-set membership does **not** by itself catch `rm -r -f /` vs `rm -rf /`,
  nor long-form (`--recursive`). It needs flag normalization to be correct —
  which is approach B.

### B. Flag-cluster normalization

Actually parse the argv and **canonicalize the flags** before matching:
de-bundle short clusters (`-rf` → `-r -f`), map long-form to canonical
(`--recursive` → `-r`, `--force` → `-f`), resolve the binary to its basename,
then match on a **structured predicate** like
`{ binary: "rm", flags ⊇ {r, f}, target ∈ dangerousPaths }`.

- **Catches:** all of `-rf` / `-fr` / `-r -f` / `--recursive --force`, absolute
  path, and (with basename resolution + case-folding) `/usr/bin/RM`.
- **Cost:** needs a getopt-style/argv model per guarded binary; each binary's
  flag grammar differs (`rm`, `dd`, `git`, `mkfs` are all different shapes).

**Verdict (confirmed by research): flag-cluster normalization strictly dominates
token-set membership, and the difference is exactly the flags.** Token-set
handles reordering of *separate* tokens for free, but breaks on bundling:
`{rm,-rf,/}` ≠ `{rm,-r,-f,/}` as sets, and neither handles `--recursive` without
a long→short map. **Token-set cannot solve the flag problem unless you decluster
first — and once you decluster, you have built flag-cluster normalization.**

`thefuck` proves this empirically: its `rm_root` rule checks only
`{'rm','/'}.issubset(script_parts)` — binary + target — and pointedly puts **no
flag** in the set, falling back to the shell's *error output*
(`--no-preserve-root in command.output`) as the danger signal. That dodge isn't
available to a **pre-execution** gate (you can't observe the deletion's output
before deciding), so a blocker *must* reason about flags, which means it *must*
decluster.

**Heirloom already does B.** `normalizeShortFlagCluster` + `normalizeCommandToken`
in `rules.ts` are exactly flag-cluster normalization (decluster+sort short flags,
basename+lowercase the command). The only missing piece is the **long-form→short
map** — see [Recommendation](#recommendation).

---

## Other candidate approaches (to evaluate in research)

- **Full shell-AST parsing** (tree-sitter-bash, `shlex`, `mvdan.cc/sh`) — get
  real structure instead of hand-rolling `splitCompound`/`detectWrapper`.
- **Deny-by-default allowlist inversion** — only permit a known-safe command
  set; everything else asks. Shifts the burden from enumerating danger to
  enumerating safety.
- **Sandboxing** (containers, seccomp, landlock, macOS `sandbox-exec`,
  read-only mounts) — the actual control; matching becomes a UX nicety. Heirloom
  lists this as a v1 non-goal, but it bounds how much the matcher must carry.
- **LLM/semantic intent classification** — flexible, but not a security boundary
  on its own (prompt-injectable, non-deterministic).

<a id="prior-art"></a>
## Prior art — how others do it

**Consensus across primary sources (Anthropic, OpenAI, academia): string/regex/
prefix matching is fragile and is NOT a security boundary.** The industry has
converged on two tiers: (1) argv-level parse-then-normalize for the
permission/UX layer, and (2) **OS-level sandboxing as the actual enforcement
boundary**.

| Approach | Catches `-rf`/`-r -f`? | `--recursive`? | `/usr/bin/rm`, `RM`? | Resolves `bash -c`/`xargs`/`$()`? | Real boundary? |
|---|---|---|---|---|---|
| 1. Ordered string-prefix (naive) | ❌ | ❌ | ❌ | ❌ | No |
| 2. Token-set membership | ⚠️ only if declustered | ⚠️ needs map | ⚠️ | ❌ | Weak |
| 3. **Flag-cluster normalization (argv)** ← *Heirloom* | ✅ | ✅ *with map* | ✅ | ❌ (can't see inside wrappers) | Weak/UX |
| 4. Full shell parse / AST | ✅ | ✅ | ✅ | ✅ | Better UX, still not enforcement |
| 5. Deny-by-default / allowlist | ✅ (unknown⇒ask) | ✅ | ✅ | ✅ | Stronger posture |
| 6. **OS sandbox / capability isolation** | contains, not matches | — | — | — | **Yes — the real boundary** |
| 7. LLM/semantic classification | usually ✅ | usually ✅ | usually ✅ | often ✅ | **No** (injectable, nondeterministic) |

Approaches 1–4 and 7 only answer *"should we prompt?"*; only 5 (posture) and 6
(enforcement) change *what can actually happen*. Real systems layer them.

**Who does what:**

- **Claude Code (Anthropic)** — hybrid: argv-aware prefix matching + compound
  split (`&& || ; | |& & \n`) + wrapper strip (`timeout/nice/nohup/command/
  xargs/…`), a read-only allowlist, **circuit-breaker denies** for `rm`/`rmdir`
  on `/`/`~` *even through* `$()`/backticks/`<()`, fail-closed on unparseable or
  >10k-char commands, plus an OS **sandbox** (Seatbelt/bubblewrap). Docs call
  arg-constraining patterns *"fragile"*, and state permissions are *"enforced by
  Claude Code, not by the model."* `rm -rf /` prompts even under
  `--dangerously-skip-permissions`.
- **OpenAI Codex CLI** — **sandbox-first**: `sandbox_mode` (read-only /
  workspace-write / full) × `approval_policy`; macOS Seatbelt, Linux
  bubblewrap+seccomp+Landlock; **fails closed** — refuses to run if the platform
  can't enforce the sandbox rather than run unsandboxed. Command-string
  inspection only auto-approves known-safe reads, never as containment.
- **aider** — human-in-the-loop only, **no sandbox, no dangerous-command
  detection**; shows the command and requires explicit yes (`--yes-always` does
  *not* auto-approve shell).
- **Warp** — **regex** allow/denylist (`rm(\s.*)?`, `curl…`, `eval…`) + an LLM
  `is_risky` flag. Cautionary failure: agent ran `dconf reset -f /` tagged
  `is_risky:false` (outside the regex list) — regex + LLM-flag gating **leaks**.
- **thefuck** — token/parts matching via `shlex` (`{'rm','/'}.issubset(...)`) —
  the canonical token-set example, and its flag-avoidance dodge (see verdict).
- **OPA/Rego, Gatekeeper, Conftest** — **parse-then-policy**: Rego has no shell
  tokenizer, so you parse to argv arrays first, then policy over structure.
- **ShellCheck** — proof that AST-level shell analysis is production-viable
  (SC2115 flags `rm -rf "$VAR/"` when `$VAR` may be empty — the real Steam bug);
  such dataflow is impossible with regex.
- **Academic:** *CARE* (arXiv 2607.21642) — canonicalize/unwrap deterministically,
  escalate only ambiguous cases to an LLM (~2ms, 85% F1); argues generic
  guardrails "do not capture shell structure." *Command-line Risk Classification*
  (arXiv 2412.01655, Huawei) — the hard problem is class imbalance (~0.3%
  blocked) ⇒ optimize **recall on the dangerous class**, not accuracy.

<a id="recommendation"></a>
## Recommendation

For a **no-sandbox single-user agent, be honest that there is no hard boundary** —
an adversarial or prompt-injected model can always reach execution via a
construct you didn't parse. The goal is to catch **model *error* and obvious
catastrophe** with a fail-closed, low-false-negative gate, and to point users at
real isolation. The research endorses exactly the shape Heirloom already has:

1. **Deny-by-default posture** — auto-allow only a small read-only set; else ask.
   (Heirloom's commit `86d17ea` "default to askAll, allow only in-cwd reads" is
   this.) ✅ already done.
2. **Argv parse-then-normalize for the deny list** — compound-split, wrapper
   strip, decluster+sort flags, basename+lowercase. ✅ already done
   (`bash-normalize.ts` + `matchesDestructivePrefix`).
3. **Fail closed on anything unresolved** — `$()`, backticks, process
   substitution, leading `VAR=`, escaped `\rm`, command-carrying wrappers ⇒ ask,
   never silent allow. ✅ `isUnresolved` does this.
4. **Hard circuit-breakers** for the catastrophic set that fire even through
   substitution and even under any future auto-approve mode. ✅ `destructive.ts`
   (deny is absolute).
5. **Do NOT rely on an LLM classifier as the boundary** (Warp's `is_risky:false`
   cautionary tale). Fine as an *extra* ask-trigger, never the sole gate.
6. **Document the limitation + offer the real fix** — say plainly (as Anthropic/
   OpenAI do) that matching is model-error mitigation, not adversary containment,
   and recommend running in a container/VM; a future lightweight OS sandbox
   (Seatbelt/bubblewrap) is the step that actually changes the security model.

### The one concrete code change to make now

Add a **long-form→short-flag map** for the guarded binaries so
`matchesDestructivePrefix` folds `--recursive`→`-r`, `--force`→`-f` (and the
`git`/`dd`/`mkfs` equivalents) before clustering. This closes the last row of the
[problem table](#the-problem) — currently `rm --recursive --force /` slips the
`rm -rf /` rule. Small, per-binary table; pairs with the existing declustering.

### Bigger, roadmap

Everything above is still tier-1 (guardrail against model error). The step that
would change Heirloom's *security model* is **tier-2: an actual OS sandbox**
(macOS `sandbox-exec`/Seatbelt, Linux bubblewrap+seccomp+Landlock), following
Codex/Claude Code. Currently a stated v1 non-goal — but it's the only thing that
"holds regardless of what the model chose to run." Worth a separate design doc if
Heirloom ever targets untrusted repos.

## Verification (for whatever is chosen)

A table-driven evasion test: every row in [The problem](#the-problem) must
resolve to **deny/ask**, never silent allow — plus the negative cases that must
**not** trip (`rm -rf ./build` in-cwd where policy allows it, `git reset --soft`,
`ddrescue`, a file literally named `mkfs-notes.txt`). This test is the
acceptance criterion and should live beside `destructive.test.ts`.
