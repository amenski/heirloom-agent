## 6. Failure Modes & Robustness

What happens when things break. Each policy lives here; the affected spec
(tool-spec, provider-spec) carries the matching contract.

### Provider Failures

Adapters throw; the **agent loop** owns retries (adapters never retry
silently — see provider-spec.md requirement 3):

| Class | Examples | Policy |
|-------|----------|--------|
| Retryable | 429, 5xx, network drop, stream cut mid-response | Backoff 1s → 2s → 4s, max 3 attempts, notice printed (`[provider error, retry 1/3]`) |
| Fatal | 401/403 (bad key), 404 (bad model), invalid request | Fail immediately with the provider's message + which config to fix |

A mid-stream failure discards the partial turn entirely — accumulated text
and half-built tool calls are dropped and the whole call retries. Safe
because sessions persist only completed turns (session-spec.md); the user
sees partial text followed by the retry notice.

After exhaustion: the turn fails, the session stays intact, the user decides
(retry / switch model / stop). Model fallback chains remain future work.

### Loop Detection

Two counters, per turn:
- **Identical-call**: same tool + same arguments 3× → inject a system
  message naming the repetition and the last error. If it happens again →
  end the turn and tell the user. (RooCode's consecutive-mistake counter.)
- **Failure streak**: 5 consecutive failed tool calls of any kind → same
  escalation. Catches thrashing that varies arguments but makes no progress.

### maxTurns Exhaustion

Hitting the cap (default 20) is a pause, not an error: print progress (the
todo list state if one exists), persist the session, and return to the
prompt. The user typing anything continues with a fresh turn budget —
nothing is lost, the loop just refuses to run unattended forever.

### Stale-File Detection

The session tracks mtime at every `read_file`. Edit-group tools compare
before writing: file changed since last read → `FILE_MODIFIED` error
(tool-spec.md), no write. Forces a re-read instead of clobbering the user's
concurrent editor changes — the highest-probability data-loss scenario for a
local agent.

### Config Validation

At startup: schema-validate every config/mode YAML. Invalid value (unknown
`api:`, bad `fileRegex`, non-numeric threshold) → **fail fast**, naming file
and field. Unknown *fields* → warn and continue (forward compatibility).
A config error at turn 15 is a much worse experience than one at startup.

### Assumptions (stated, not silently held)

- **One instance per repo.** Two concurrent heirlooms in one workingDir race
  on files and checkpoints; not detected in v1 (a lockfile is trivial later).
- **Platform: macOS/Linux.** `run_bash` assumes a POSIX shell; Windows is
  untested and out of scope until someone cares.
- Implementation note: the Phase 1 loop's malformed-tool-JSON fallback
  (`{_raw: ...}` in agent.ts) predates the layered-recovery spec — Layer 1
  requery (§3) replaces it in Phase 8; until then malformed args surface as
  `PARSE_ERROR` to the model, never as silently-wrong arguments.

---

---

_Part of the [subsystems deep dive](../subsystems.md)._
