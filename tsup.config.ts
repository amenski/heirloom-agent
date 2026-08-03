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
    // Bundled CJS deps (e.g. typescript's getNodeSystem) assume the CJS
    // globals require/__filename/__dirname at load time. In an ESM output
    // these are undefined, so esbuild's shim throws "Dynamic require of ..."
    // and __filename/__dirname are ReferenceErrors. Recreate all three from
    // import.meta.url (already present in the ESM bundle; see src/cli.tsx).
    js: [
      "#!/usr/bin/env node",
      "import { createRequire as __createRequire } from 'module';",
      "import { fileURLToPath as __fileURLToPath } from 'url';",
      "import { dirname as __pathDirname } from 'path';",
      "const require = __createRequire(import.meta.url);",
      "const __filename = __fileURLToPath(import.meta.url);",
      "const __dirname = __pathDirname(__filename);",
    ].join("\n"),
  },
  // tsup bundles JS/TS only; the builtin mode YAMLs are assets the ModeLoader
  // resolves relative to the compiled module (dist/cli.js -> dist/builtin/).
  // Copy them into dist so the packaged binary can list and load modes.
  async onSuccess() {
    await import("./scripts/copy-modes.mjs");
  },
});
