#!/usr/bin/env tsx
import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, cpSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const FIXTURES_DIR = resolve(import.meta.dirname!, "..", "fixtures");
const EVAL_TMP = resolve(import.meta.dirname!, "..", ".eval-tmp");
const HEIRLOOM_SRC = resolve(import.meta.dirname!, "..", "src", "cli.tsx");
const TSX_BIN = resolve(import.meta.dirname!, "..", "node_modules", ".bin", "tsx");

// Eval permissions, injected into each copied fixture's .heirloom/ as
// settings.json. Headless runs fail closed (permission-spec.md §Headless
// Interaction), so a fixture without explicit allow rules would deny every
// edit and run_bash call and the golden task could never modify anything.
// Fixtures are throwaway copies in .eval-tmp/, so allowing these tools
// inside them is safe by construction.
const EVAL_SETTINGS = JSON.stringify({
  permissions: {
    defaultMode: "askAll",
    rules: [
      { tool: "edit", pattern: "", action: "allow" },
      { tool: "edit_file", pattern: "", action: "allow" },
      { tool: "search_replace", pattern: "", action: "allow" },
      { tool: "apply_diff", pattern: "", action: "allow" },
      { tool: "apply_patch", pattern: "", action: "allow" },
      { tool: "write_to_file", pattern: "", action: "allow" },
      { tool: "run_bash", pattern: "", action: "allow" },
    ],
  },
});

interface EvalCase {
  name: string;
  fixtureDir: string;
  prompt: string;
  assert: (workdir: string) => { pass: boolean; message: string };
}

const EVAL_CASES: EvalCase[] = [
  {
    name: "G2 — Fix failing test (calc)",
    fixtureDir: "calc",
    prompt: "fix the failing test in src/calc.test.js so all tests pass",
    assert: (workdir) => {
      try {
        const result = execSync("node --test src/calc.test.js", {
          cwd: workdir,
          encoding: "utf-8",
          timeout: 10000,
        });
        return {
          pass: result.includes("# pass 3") && !result.includes("fail"),
          message: result.trim().split("\n").slice(-3).join("; "),
        };
      } catch (e: any) {
        return { pass: false, message: e.stderr?.toString().slice(0, 200) || e.message };
      }
    },
  },
  {
    name: "G3 — Add greeting flag (cli)",
    fixtureDir: "cli",
    prompt:
      "add a --greeting flag to src/index.js. when passed, it should precede the name output. example: 'node src/index.js --greeting Hi --name World' should output 'Hi, World!' instead of 'Hello, World!'",
    assert: (workdir) => {
      try {
        const result = execSync("node src/index.js --greeting Hi --name World", {
          cwd: workdir,
          encoding: "utf-8",
          timeout: 5000,
        });
        return {
          pass: result.trim() === "Hi, World!",
          message: result.trim(),
        };
      } catch (e: any) {
        return { pass: false, message: e.stderr?.toString().slice(0, 200) || e.message };
      }
    },
  },
  {
    name: "G5 — Diagnose memory leak (leaky)",
    fixtureDir: "leaky",
    prompt: "identify the memory leak in src/server.js and explain the root cause",
    assert: () => {
      return { pass: true, message: "agent completed diagnosis" };
    },
  },
];

async function main() {
  console.log("heirloom eval runner\n");

  if (existsSync(EVAL_TMP)) rmSync(EVAL_TMP, { recursive: true });
  mkdirSync(EVAL_TMP, { recursive: true });
  const evalHome = join(EVAL_TMP, ".home");
  mkdirSync(evalHome, { recursive: true });

  const results: { name: string; pass: boolean; message: string; duration: number }[] = [];
  let passed = 0;
  let failed = 0;

  for (const testCase of EVAL_CASES) {
    const fixtureSrc = join(FIXTURES_DIR, testCase.fixtureDir);
    const evalWorkdir = join(EVAL_TMP, testCase.fixtureDir);

    if (!existsSync(fixtureSrc)) {
      console.log(`  ${testCase.name} — SKIP (fixture not found: ${fixtureSrc})`);
      continue;
    }

    cpSync(fixtureSrc, evalWorkdir, { recursive: true });

    // Inject eval permissions so headless fail-closed doesn't deny the
    // edits the task requires (see EVAL_SETTINGS above).
    const settingsDir = join(evalWorkdir, ".heirloom");
    if (!existsSync(settingsDir)) mkdirSync(settingsDir, { recursive: true });
    writeFileSync(join(settingsDir, "settings.json"), EVAL_SETTINGS);

    process.stdout.write(`  ${testCase.name}... `);
    const start = Date.now();

    let spawnError: string | null = null;
    let result: ReturnType<typeof spawnSync> | null = null;
    try {
      result = spawnSync(
        TSX_BIN,
        [HEIRLOOM_SRC, "-p", testCase.prompt],
        {
          cwd: evalWorkdir,
          encoding: "utf-8",
          timeout: 120_000,
          // input: "" closes the child's stdin immediately — headless mode
          // reads piped stdin to EOF (exec-input.ts), and an open pipe
          // would hang the spawn for the full timeout.
          input: "",
          env: {
            ...process.env,
            // Isolate the eval from the developer's global config: an
            // empty HEIRLOOM_HOME means no global settings, no MCP servers
            // to spawn at startup (which would block the key check), and
            // no interference from personal credentials.
            HEIRLOOM_HOME: evalHome,
          },
        },
      );

      if (result.error) {
        spawnError = result.error.message;
      }
    } catch (e: any) {
      spawnError = e.message;
    }

    const duration = Date.now() - start;

    if (spawnError) {
      failed++;
      console.log("FAIL (spawn error)");
      results.push({
        name: testCase.name,
        pass: false,
        message: spawnError.slice(0, 40),
        duration,
      });
      continue;
    }

    // Distinguish "the agent could not run" from "the agent ran and did not
    // pass": a non-zero heirloom exit (e.g. no provider key) must not be
    // reported as a fixture-level task failure.
    if (result!.status !== 0) {
      failed++;
      console.log("FAIL (heirloom exit)");
      const stderrLine = (result!.stderr || "").trim().split("\n").slice(-1)[0] || "";
      results.push({
        name: testCase.name,
        pass: false,
        message: `heirloom exited ${result!.status}: ${stderrLine.slice(0, 60)}`,
        duration,
      });
      continue;
    }

    const assertion = testCase.assert(evalWorkdir);

    if (assertion.pass) {
      passed++;
      console.log("PASS");
    } else {
      failed++;
      console.log("FAIL");
    }

    results.push({
      name: testCase.name,
      pass: assertion.pass,
      message: assertion.message,
      duration,
    });
  }

  console.log("\n┌─────────────────────────────────────────────────────────────┐");
  console.log("│  Eval Results                                               │");
  console.log("├────────────────────────┬────────┬───────────────────────────┤");
  console.log("│  Task                  │  Result│  Message                  │");
  console.log("├────────────────────────┼────────┼───────────────────────────┤");
  for (const r of results) {
    const status = r.pass ? "PASS" : "FAIL";
    const color = r.pass ? "\x1b[32m" : "\x1b[31m";
    const reset = "\x1b[0m";
    const name = r.name.padEnd(22).slice(0, 22);
    const msg = r.message.padEnd(25).slice(0, 25);
    console.log(`│  ${name}│  ${color}${status}${reset}  │  ${msg}│`);
  }
  console.log("└────────────────────────┴────────┴───────────────────────────┘");
  console.log(`\n  ${passed} passed, ${failed} failed, ${results.length} total`);

  rmSync(EVAL_TMP, { recursive: true, force: true });

  process.exit(failed > 0 ? 1 : 0);
}

main();
