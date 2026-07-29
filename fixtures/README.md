# Golden Tasks

Fixture projects for agent-level end-to-end evals. Each subdirectory is a
self-contained Node.js project with a mission for the agent.

## G2 — Fix a planted failing test

```sh
cd fixtures/calc
heirloom -p "fix the failing test" --approve all
```

## G3 — Add a feature flag

```sh
cd fixtures/cli
heirloom -p "add a --greeting flag" --approve all
```

## G5 — Diagnose memory growth

```sh
cd fixtures/leaky
heirloom -p "why does this server grow memory" --approve all
```

Set `DEEPSEEK_API_KEY` before running.
