# Notify hook

**Status:** current · verified 2026-08-13 · covers `src/notify.ts`, `src/cli.tsx`, `src/exec-runner.ts`

## 1. Overview

Runs a user-configured script when a turn/task completes or fails, so the
user can be pinged (Slack, desktop notification, terminal bell, …) without
watching the session. Activated by the `notify` key in `settings.json`.

Implemented by `src/notify.ts`: a pure `buildNotifyEnv(...)` (the env
contract, unit-testable) plus a `fireNotify(...)` fire-and-forget spawn
wrapper. It is called from the two completion boundaries where a turn's
outcome is definitively known — never from the UI/render layer.

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
| `STATUS` | always | `"completed"` on a normal turn end, `"failed"` when the turn threw |
| `DURATION` | always | Turn duration in whole seconds (integer, as a string) |
| `BODY` | always | Text of the last assistant reply, secret-redacted (empty on fail) |
| `TITLE` | always | Session title / first-prompt prefix (truncated to 120 chars) |
| `FAIL_REASON` | failure only | Concise error message (omitted when empty or on success) |

The user's `env` block (e.g. `SLACK_WEBHOOK_URL`) is passed through so
scripts can reach their targets. Contract variables always win over `env`
block keys of the same name.

## 4. Entry points

Both call sites time the run and call `fireNotify` once the outcome is
known:

- **Interactive** — `runAgentTurnBridge` in `src/cli.tsx`, after `runAgent`
  returns (or throws). `TITLE` is the session's first user prompt.
- **Headless (`-p`)** — the completion boundary in `src/exec-runner.ts`, on
  both the success path and the provider-failure catch. `TITLE` is the exec
  prompt.

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
