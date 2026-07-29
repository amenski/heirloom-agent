# cli — G3: Add a --greeting flag

A simple CLI that greets the user by name. Currently only supports `--name`.

**Mission:** Add a `--greeting` flag so the user can customize the greeting
(e.g. `node src/index.js --name Alice --greeting "Good morning"` should
output `Good morning, Alice!`).

When `--greeting` is not provided, default to `"Hello"`.

**Run:** `node src/index.js --name World`
