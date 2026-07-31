import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.tsx"],
  format: ["esm"],
  outDir: "dist",
  clean: true,
  splitting: false,
  sourcemap: false,
  target: "node20",
  shims: false,
  dts: false,
  treeshake: false,
  external: ["react-devtools-core", "ws"],
  esbuildOptions(opts) {
    opts.treeShaking = false;
  },
  banner: {
    js: "#!/usr/bin/env node",
  },
  // tsup bundles JS/TS only; the builtin mode YAMLs are assets the ModeLoader
  // resolves relative to the compiled module (dist/cli.js -> dist/builtin/).
  // Copy them into dist so the packaged binary can list and load modes.
  async onSuccess() {
    await import("./scripts/copy-modes.mjs");
  },
});
