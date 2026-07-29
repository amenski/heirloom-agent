import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  outDir: "dist",
  clean: true,
  splitting: false,
  sourcemap: false,
  target: "node20",
  shims: false,
  dts: false,
  banner: {
    js: "#!/usr/bin/env node",
  },
});
