# Notify hook

**Status:** current · verified 2026-08-13 · covers `src/notify.ts`, `src/cli.tsx`, `src/exec-runner.ts`

## 1. Overview

Runs a user-configured script when a turn/task completes or fails, or when a
background job finishes, so the user can be pinged (Slack, desktop
notification, terminal bell, …) without watching the session. Activated by
the `notify` key in `settings.json`.

Implemented by `src/notify.ts`: a pure `buildNotifyEnv(...)` (the env
contract, unit-testable) plus a `fireNotify(...)` fire-and-forget spawn
wrapper. It is called from the completion boundaries where an outcome is
definitively known — never from the UI/render layer.

## 2. Configuration

```json
{
  "notify": "/path/to/notify.sh",
  "env": { "SLACK_WEBHOOK_URL": "https://hooks.slack.com/services/…" }
}
```

`notify` is a path to an executable script. When unset, `fireNotify` is a
no-op.

## 3. Env contract

The script receives these environment variables (in addition to the parent
`process.env` and the user's `env` block from settings):

| Variable | When | Value |
| -------- | ---- | ----- |
| `STATUS` | always | `"completed"` on a normal turn end, `"failed"` when the turn threw, `"job_done"` when a background job finished |
| `DURATION` | always | Turn duration in whole seconds (integer, as a string); for `job_done`, the job's runtime |
| `BODY` | always | Text of the last assistant reply, secret-redacted (empty on fail); for `job_done`, the tail of the job's accumulated output |
| `TITLE` | always | Session title / first-prompt prefix (truncated to 120 chars); for `job_done`, the job's command |
| `FAIL_REASON` | failure only | Concise error message (omitted when empty or on success) |
| `JOB_ID` | `job_done` only | The background job's ID |
| `JOB_COMMAND` | `job_done` only | The job's command, secret-redacted (commands can carry inline secrets, e.g. `curl -H "Authorization: Bearer …"`) and truncated to 120 chars |
| `JOB_EXIT` | `job_done` only | The job's exit code; omitted when unknown (a job killed before it exited) |

The user's `env` block (e.g. `SLACK_WEBHOOK_URL`) is passed through so
scripts can reach their targets. Contract variables always win over `env`
block keys of the same name.

## 4. Entry points

The call sites time the run and call `fireNotify` once the outcome is known:

- **Interactive** — `runAgentTurnBridge` in `src/cli.tsx`, after `runAgent`
  returns (or throws). `TITLE` is the session's first user prompt.
- **Headless (`-p`)** — the completion boundary in `src/exec-runner.ts`, on
  both the success path and the provider-failure catch. `TITLE` is the exec
  prompt.
- **Background-job completion** — `src/cli.tsx`, from a `JobManager`
  completion event (`src/tools/jobs.ts`). `STATUS=job_done`; `TITLE` and
  `JOB_COMMAND` are the job's command, `BODY` is the tail of its accumulated
  output, `DURATION` is its runtime. Interactive sessions only — headless
  runs have no TUI job surface (the status segment for the same event is
  rendered by `src/ui/App.tsx`).

## 5. Non-blocking semantics

`fireNotify` never delays or crashes the app:

- The script is spawned `detached`, `stdio: "ignore"`, and `unref`'d — its
  lifetime is decoupled from the agent process.
- Spawn happens with `shell: false` and an explicit empty argv; contract
  data reaches the script only via environment variables (never
  interpolated into a shell line).
- A synchronous spawn throw or an asynchronous `'error'` event (e.g.
  `ENOENT` for a bad path) is swallowed, degrading to at most a single
  debug-level stderr line (only when `--debug` is set).

## 6. Security

`notify` is user-config and carries the **same trust level as the rest of
`settings.json`** — it can run arbitrary commands as the user. The path is
never derived from model output. `BODY` is redacted via
`src/sessions/redact.ts` before it leaves the process, but the script
itself runs with full user privileges; treat it as you would any other line
in your settings.

## 7. Example: Slack

`notify.sh`:

```bash
#!/usr/bin/env bash
# Requires SLACK_WEBHOOK_URL in settings.json `env`.
if [ "$STATUS" = "failed" ]; then
  text="❌ *${TITLE}* failed after ${DURATION}s — ${FAIL_REASON}"
else
  text="✅ *${TITLE}* completed in ${DURATION}s\n${BODY}"
fi
curl -sf -X POST -H 'Content-type: application/json' \
  --data "{\"text\": \"${text}\"}" \
  "$SLACK_WEBHOOK_URL" >/dev/null
```

Make it executable (`chmod +x notify.sh`) and point `notify` at it.
