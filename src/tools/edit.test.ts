import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolContext } from "./types.js";
import {
  editHandler,
  applyDiffHandler,
  applyPatchHandler,
  searchReplaceHandler,
  editFileHandler,
  writeToFileHandler,
} from "./edit.js";

const TEST_DIR = join(process.cwd(), ".test-tmp");

const mockCtx: ToolContext = {
  workingDir: TEST_DIR,
  sessionId: "test-session",
  askUser: async () => true,
  signal: new AbortController().signal,
};

function testPath(name: string): string {
  return join(TEST_DIR, name);
}

describe("edit", () => {
  beforeEach(() => {
    if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
  });
  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("replaces exact match", async () => {
    const path = testPath("test.txt");
    writeFileSync(path, "Hello World", "utf-8");
    const result = await editHandler(
      { path, oldString: "Hello", newString: "Goodbye" },
      mockCtx,
    );
    expect(result.error).toBeUndefined();
    expect(result.content).toContain("1 occurrence");
    expect(readFileSync(path, "utf-8")).toBe("Goodbye World");
  });

  it("returns error when string not found", async () => {
    const path = testPath("test.txt");
    writeFileSync(path, "Hello World", "utf-8");
    const result = await editHandler(
      { path, oldString: "xyz", newString: "abc" },
      mockCtx,
    );
    expect(result.error).toContain("String not found");
  });

  it("returns error when multiple occurrences", async () => {
    const path = testPath("test.txt");
    writeFileSync(path, "foo foo foo", "utf-8");
    const result = await editHandler(
      { path, oldString: "foo", newString: "bar" },
      mockCtx,
    );
    expect(result.error).toContain("Found 3 occurrences");
  });

  it("returns error when oldString is empty", async () => {
    const result = await editHandler(
      { path: testPath("test.txt"), oldString: "", newString: "bar" },
      mockCtx,
    );
    expect(result.error).toContain("must not be empty");
  });
});

describe("apply_diff", () => {
  beforeEach(() => {
    if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
  });
  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("applies a matching diff", async () => {
    const path = testPath("test.txt");
    writeFileSync(path, "line1\nline2\nline3\n", "utf-8");
    const diff = "@@ -1,3 +1,3 @@\n line1\n-line2\n+replaced\n line3\n";
    const result = await applyDiffHandler({ path, diff }, mockCtx);
    expect(result.error).toBeUndefined();
    expect(result.content).toContain("applied");
    expect(readFileSync(path, "utf-8")).toBe("line1\nreplaced\nline3\n");
  });

  it("returns error on non-matching diff", async () => {
    const path = testPath("test.txt");
    writeFileSync(path, "line1\nline2\nline3\n", "utf-8");
    const diff = "@@ -1,3 +1,3 @@\n line1\n-nonexistent\n+replaced\n line3\n";
    const result = await applyDiffHandler({ path, diff }, mockCtx);
    expect(result.error).toContain("Diff does not match");
  });

  it("returns success for empty diff", async () => {
    const path = testPath("test.txt");
    writeFileSync(path, "content", "utf-8");
    const result = await applyDiffHandler({ path, diff: "" }, mockCtx);
    expect(result.error).toBeUndefined();
    expect(result.content).toContain("Empty diff");
  });
});

describe("apply_patch", () => {
  beforeEach(() => {
    if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
  });
  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("applies a multi-file patch", async () => {
    const path1 = testPath("a.txt");
    const path2 = testPath("b.txt");
    writeFileSync(path1, "hello\n", "utf-8");
    writeFileSync(path2, "world\n", "utf-8");
    const patch = `diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/${path1}
@@ -1 +1 @@
-hello
+hi
diff --git a/b.txt b/b.txt
--- a/b.txt
+++ b/${path2}
@@ -1 +1 @@
-world
+earth`;
    const result = await applyPatchHandler({ patch }, mockCtx);
    expect(result.error).toBeUndefined();
    expect(result.content).toContain("ok");
    expect(readFileSync(path1, "utf-8")).toBe("hi\n");
    expect(readFileSync(path2, "utf-8")).toBe("earth\n");
  });

  it("returns early for empty patch", async () => {
    const result = await applyPatchHandler({ patch: "" }, mockCtx);
    expect(result.content).toContain("Empty patch");
  });
});

describe("search_replace", () => {
  beforeEach(() => {
    if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
  });
  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("replaces single occurrence", async () => {
    const path = testPath("test.txt");
    writeFileSync(path, "hello world", "utf-8");
    const result = await searchReplaceHandler(
      { path, search: "hello", replace: "hi" },
      mockCtx,
    );
    expect(result.error).toBeUndefined();
    expect(result.content).toContain("1 occurrences");
    expect(readFileSync(path, "utf-8")).toBe("hi world");
  });

  it("replaces all occurrences", async () => {
    const path = testPath("test.txt");
    writeFileSync(path, "foo bar foo", "utf-8");
    const result = await searchReplaceHandler(
      { path, search: "foo", replace: "baz" },
      mockCtx,
    );
    expect(result.error).toBeUndefined();
    expect(result.content).toContain("2 occurrences");
    expect(readFileSync(path, "utf-8")).toBe("baz bar baz");
  });

  it("returns error when string not found", async () => {
    const path = testPath("test.txt");
    writeFileSync(path, "hello world", "utf-8");
    const result = await searchReplaceHandler(
      { path, search: "xyz", replace: "abc" },
      mockCtx,
    );
    expect(result.error).toContain("String not found");
  });
});

describe("edit_file", () => {
  beforeEach(() => {
    if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
  });
  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("replaces when count matches", async () => {
    const path = testPath("test.txt");
    writeFileSync(path, "foo foo foo", "utf-8");
    const result = await editFileHandler(
      { path, search: "foo", replace: "bar", expectedCount: 3 },
      mockCtx,
    );
    expect(result.error).toBeUndefined();
    expect(result.content).toContain("3 occurrences");
    expect(readFileSync(path, "utf-8")).toBe("bar bar bar");
  });

  it("aborts when count differs", async () => {
    const path = testPath("test.txt");
    writeFileSync(path, "foo foo foo", "utf-8");
    const result = await editFileHandler(
      { path, search: "foo", replace: "bar", expectedCount: 2 },
      mockCtx,
    );
    expect(result.error).toContain("Expected 2 occurrences, found 3");
    expect(readFileSync(path, "utf-8")).toBe("foo foo foo");
  });

  it("aborts when zero occurrences expected and found", async () => {
    const path = testPath("test.txt");
    writeFileSync(path, "foo foo foo", "utf-8");
    const result = await editFileHandler(
      { path, search: "foo", replace: "bar", expectedCount: 0 },
      mockCtx,
    );
    expect(result.error).toBeDefined();
    expect(readFileSync(path, "utf-8")).toBe("foo foo foo");
  });
});

describe("write_to_file", () => {
  beforeEach(() => {
    if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
  });
  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("writes a new file", async () => {
    const path = testPath("new.txt");
    const result = await writeToFileHandler(
      { path, content: "hello world" },
      mockCtx,
    );
    expect(result.error).toBeUndefined();
    expect(result.content).toContain("Wrote");
    expect(readFileSync(path, "utf-8")).toBe("hello world");
  });

  it("overwrites an existing file", async () => {
    const path = testPath("existing.txt");
    writeFileSync(path, "old content", "utf-8");
    const result = await writeToFileHandler(
      { path, content: "new content" },
      mockCtx,
    );
    expect(result.error).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe("new content");
  });

  it("creates parent directories", async () => {
    const path = testPath("sub/deep/new.txt");
    const result = await writeToFileHandler(
      { path, content: "nested" },
      mockCtx,
    );
    expect(result.error).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe("nested");
  });
});
