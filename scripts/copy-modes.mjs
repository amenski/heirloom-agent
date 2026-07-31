// Copies the builtin mode YAMLs into the dist bundle so the packaged binary
// can enumerate and load modes. tsup only bundles JS/TS; asset files like the
// builtin *.yaml are not copied, and the ModeLoader resolves them relative to
// its module URL (./builtin/). In dev that URL is src/modes/loader.ts, so it
// finds src/modes/builtin/; in the bundle the module URL is dist/cli.js, so it
// looks for dist/builtin/. This mirrors the source layout into dist/builtin/.
import { cp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src", "modes", "builtin");
const dest = join(root, "dist", "builtin");

await cp(src, dest, { recursive: true });
