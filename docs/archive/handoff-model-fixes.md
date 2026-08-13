# Handoff — /model UX fixes + deepseek_reasoner provider wart

> **ARCHIVED - historical record (2026-08-13).** Describes a superseded design or
> a completed task brief. Nothing here describes current behavior. The live
> documentation set is indexed in [../README.md](../README.md).
> Why: Task brief, completed.

are retired — see `src/providers/models.json` for current IDs.

**For:** subagent (Sonnet). **Files:** `src/index.ts`, `src/providers/presets.ts`
(+ tests). Surgical — found by driving the CLI in a real terminal.

Observed output (real TTY):

```
▌ › /model
/model
Current: deepseek/deepseek-chat

Available:
› deepseek/deepseek-chat   (default)   ctx 128k
  deepseek_reasoner/deepseek-reasoner   (default)   ctx 64k
  openai/gpt-4o   (default)   ctx 128k
  ...
Usage: /model <provider/model>
```

## Fix 1 — Input echoes twice (HIGHEST PRIORITY, affects every turn)

After submitting, the command appears twice: once on the prompt line
(`▌ › /model`) and again as a bare `/model` line. The `/model` handler does
NOT print the command, so the duplicate comes from the input path in
`src/index.ts` — likely the raw-mode/keypress plumbing or an explicit echo
write on submit interacting with readline's own echo. Find the actual cause
(reproduce first — see Verify), then remove the duplicate. The prompt line
with the typed text should remain; the bare repeat must go.

## Fix 2 — Kill the fake `deepseek_reasoner` provider (root-cause fix)

`BUILTIN_PRESETS` has a top-level `deepseek_reasoner` key (presets.ts:24).
It is really a MODEL of the deepseek provider (same baseUrl, same key), not
a provider. Concrete breakage: a key stored in `credentials.yaml` under
`deepseek:` is not found by `getCredential("deepseek_reasoner")`, so the
reasoner works via env var but fails via the credentials file. It also
contradicts config-spec.md, which models deepseek as one provider with two
models.

Change `ProviderPreset` to carry a models map:

```ts
export interface ProviderPreset {
  api: string;
  baseUrl: string;
  keyEnv: string;
  defaultModel: string;
  models: Record<string, ModelCapabilities>;  // replaces single `capabilities`
}
```

- `deepseek` gets `models: { "deepseek-chat": {supportsTools: true, contextWindow: 128000}, "deepseek-reasoner": {supportsTools: false, contextWindow: 128000} }`.
  Note: use **128000** for the reasoner (config-spec.md is authoritative; the
  old 64000 was wrong — Fix 4).
- Every other preset gets a one-entry `models` map holding its current
  capabilities under its `defaultModel` key.
- DELETE the `deepseek_reasoner` preset entirely.
- Update all readers of `preset.capabilities` (grep for it — index.ts checks
  `supportsTools`, contextWindow lookups, etc.) to resolve per-model:
  `preset.models[modelId] ?? preset.models[preset.defaultModel]`.
- `getContextWindowForModel` should consult the preset models map too, not
  just config providers.
- If anything (config, session state) references provider name
  `deepseek_reasoner`, it should now error as unknown provider — that's
  acceptable; grep the repo to confirm nothing internal still uses the name.

## Fix 3 — /model listing polish (in the `case "/model"` handler)

- **Drop `(default)` entirely** — with one-model providers it appears on
  every line and carries no information.
- **Group by provider, align columns:**

```
Current: deepseek/deepseek-chat

deepseek
  › deepseek-chat        ctx 128k
    deepseek-reasoner    ctx 128k
openai
    gpt-4o               ctx 128k
openrouter
    anthropic/claude-sonnet-4   ctx 200k
...

Switch: /model <provider/model>
```

- Enumerate: for each `getKnownProviderNames()` provider, list preset
  `models` keys plus any `getProviderModels(name)` keys (dedupe).
- Active model: keep ONE indicator (the `›` marker, bright when
  `colorEnabled`) — the `Current:` line already names it, so no extra
  highlight styles.
- Rename the trailing line to `Switch: /model <provider/model>` (reads less
  like an error).
- Non-TTY/NO_COLOR: plain text, no ANSI (existing guard).
- Update the `/model` tab-completion source (completer) to the same
  enumeration so completions match the listing and no longer offer
  `deepseek_reasoner/...`; offer `deepseek/deepseek-reasoner` instead.

## Fix 4 — ctx inconsistency

deepseek-reasoner contextWindow = **128000** everywhere (covered in Fix 2).

## Constraints

- Match existing style. Don't touch provider adapter files, permission
  engine, or anything outside the named files + tests.
- Don't break `/model <provider/model>` switching, `/mode`, or startup
  provider detection (`detectProvider`/`hasAnyKey` in index.ts — they may
  iterate presets; verify they still work with the new shape).
- Do NOT commit. No Co-Authored-By anywhere.

## Verify (run, report output)

1. `npx tsc --noEmit` clean.
2. `npm test` — baseline 137 green; add/adjust tests for the preset models
   map (e.g. createProvider for deepseek with modelOverride "deepseek-reasoner",
   getContextWindowForModel from presets).
3. Piped: `printf '/model\n/exit\n' | DEEPSEEK_API_KEY=sk-dummy npx tsx src/index.ts 2>&1 | head -25`
   — grouped list, no `deepseek_reasoner` provider, no `(default)`, no ANSI.
4. Echo bug: reproduce BEFORE fixing (script/tty harness or explain the
   mechanism from code with certainty), confirm gone after. If it only
   reproduces on a real TTY, use `script -q /dev/null` to fake one:
   `printf '/model\n/exit\n' | script -q /dev/null npx tsx src/index.ts` and
   check for the duplicated bare command line.
5. `printf '/model deepseek/deepseek-reasoner\n/exit\n' | DEEPSEEK_API_KEY=sk-dummy npx tsx src/index.ts 2>&1 | head -8`
   — switch succeeds.

Report: diff (stat + hunks), gate results, the piped outputs, and the actual
root cause you found for the double echo.
