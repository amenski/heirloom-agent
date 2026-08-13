import { describe, it, expect, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  scanFileMentionItems,
  filterFileMentionItems,
  extractMentionedPaths,
  expandFileMentions,
} from "./file-mentions.js";

describe("scanFileMentionItems", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "heirloom-mentions-"));
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it("lists files and directories with directories first, skipping noise and dotfiles", () => {
    fs.mkdirSync(path.join(root, "src"));
    fs.mkdirSync(path.join(root, "node_modules"));
    fs.writeFileSync(path.join(root, ".env"), "SECRET=1");
    fs.writeFileSync(path.join(root, "src", "main.ts"), "export const x = 1;");
    fs.writeFileSync(path.join(root, "README.md"), "# hi");

    const items = scanFileMentionItems(root);
    expect(items).toContainEqual({ path: "src/", type: "directory" });
    expect(items).toContainEqual({ path: "src/main.ts", type: "file" });
    expect(items).toContainEqual({ path: "README.md", type: "file" });
    expect(items.some((i) => i.path.includes("node_modules"))).toBe(false);
    expect(items.some((i) => i.path.includes(".env"))).toBe(false);
    // Directories sort before files.
    expect(items[0].type).toBe("directory");
  });
});

describe("filterFileMentionItems", () => {
  const items = [
    { path: "src/ui/App.tsx", type: "file" as const },
    { path: "src/ui/", type: "directory" as const },
    { path: "README.md", type: "file" as const },
  ];

  it("empty query ranks directories ahead of files", () => {
    const [first, second] = filterFileMentionItems(items, "");
    expect(first.type).toBe("directory");
    expect(second.type).toBe("file");
  });

  it("prefix matches beat basename matches", () => {
    const byPrefix = filterFileMentionItems(items, "src");
    expect(byPrefix[0].path).toBe("src/ui/");
    const byBase = filterFileMentionItems(items, "readme");
    expect(byBase[0].path).toBe("README.md");
  });
});

describe("extractMentionedPaths", () => {
  it("finds @mentions at start of line or after whitespace", () => {
    expect(extractMentionedPaths("@README.md")).toEqual(["README.md"]);
    expect(extractMentionedPaths("look at @src/main.ts please")).toEqual(["src/main.ts"]);
  });

  it("ignores emails, word-internal @, and @ with a slash or parens", () => {
    expect(extractMentionedPaths("mail me at a@b.com")).toEqual([]);
    expect(extractMentionedPaths("foo@bar")).toEqual([]);
    expect(extractMentionedPaths("hi @(")).toEqual([]);
  });

  it("strips trailing punctuation from a mention", () => {
    expect(extractMentionedPaths("see @src/main.ts.")).toEqual(["src/main.ts"]);
    expect(extractMentionedPaths("see @src/main.ts, ok")).toEqual(["src/main.ts"]);
  });

  it("deduplicates repeated mentions, keeping first-occurrence order", () => {
    expect(extractMentionedPaths("@a.ts and @b.ts and @a.ts again")).toEqual(["a.ts", "b.ts"]);
  });
});

describe("expandFileMentions", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "heirloom-expand-"));
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it("reads resolvable files into <file> blocks and skips the rest", async () => {
    fs.writeFileSync(path.join(root, "a.ts"), "export const a = 1;");
    fs.writeFileSync(path.join(root, "b.ts"), Buffer.from([0, 1, 2])); // binary

    const blocks = await expandFileMentions("@a.ts and @missing.ts and @b.ts", root);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toBe('<file path="a.ts">\nexport const a = 1;\n</file>');
  });

  it("truncates oversized files with a marker", async () => {
    fs.writeFileSync(path.join(root, "big.txt"), "x".repeat(70_000));
    const [block] = await expandFileMentions("@big.txt", root);
    expect(block.length).toBeLessThan(70_000);
    expect(block.includes("… [truncated]")).toBe(true);
  });
});

describe("expandFileMentions permission gate", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "heirloom-gate-"));
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it("replaces a denied path with a not-injected note and injects allowed ones", async () => {
    fs.writeFileSync(path.join(root, "ok.ts"), "export const ok = 1;");
    fs.writeFileSync(path.join(root, "secret.env"), "TOKEN=abc");

    const blocks = await expandFileMentions(
      "@ok.ts and @secret.env",
      root,
      (raw) => (raw === "secret.env" ? "deny" : "allow"),
    );
    expect(blocks).toEqual([
      '<file path="ok.ts">\nexport const ok = 1;\n</file>',
      '<file path="secret.env">\n[not injected: denied by permissions]\n</file>',
    ]);
  });

  it("without a gate, behavior is unchanged", async () => {
    fs.writeFileSync(path.join(root, "plain.ts"), "export const p = 1;");
    const blocks = await expandFileMentions("@plain.ts", root);
    expect(blocks).toEqual(['<file path="plain.ts">\nexport const p = 1;\n</file>']);
  });
});
