import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCredential, readCredentialsFile } from "./credentials.js";

describe("credentials", () => {
  let dir: string;
  let credsPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "deepcode-creds-test-"));
    credsPath = join(dir, "credentials.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("getCredential", () => {
    it("returns the key for a present provider", () => {
      writeFileSync(
        credsPath,
        JSON.stringify({ deepseek: "sk-test-dummy", openrouter: "sk-or-test-dummy" }),
      );
      expect(getCredential("deepseek", credsPath)).toBe("sk-test-dummy");
      expect(getCredential("openrouter", credsPath)).toBe("sk-or-test-dummy");
    });

    it("returns undefined for an absent provider", () => {
      writeFileSync(credsPath, JSON.stringify({ deepseek: "sk-test-dummy" }));
      expect(getCredential("openai", credsPath)).toBeUndefined();
    });

    it("returns undefined when the file does not exist", () => {
      expect(getCredential("deepseek", join(dir, "nope.json"))).toBeUndefined();
    });

    it("returns undefined for a malformed (array) file", () => {
      writeFileSync(credsPath, JSON.stringify(["just", "a", "list"]));
      expect(getCredential("deepseek", credsPath)).toBeUndefined();
    });

    it("returns undefined for invalid JSON rather than throwing", () => {
      writeFileSync(credsPath, "{deepseek: [unterminated\n");
      expect(() => getCredential("deepseek", credsPath)).not.toThrow();
      expect(getCredential("deepseek", credsPath)).toBeUndefined();
    });

    it("returns undefined for an empty-string value", () => {
      writeFileSync(credsPath, JSON.stringify({ deepseek: "" }));
      expect(getCredential("deepseek", credsPath)).toBeUndefined();
    });
  });

  describe("readCredentialsFile", () => {
    it("returns an empty map for a missing file", () => {
      expect(readCredentialsFile(join(dir, "nope.json"))).toEqual({});
    });

    it("ignores non-string values", () => {
      writeFileSync(
        credsPath,
        JSON.stringify({ deepseek: "sk-test-dummy", nested: { foo: "bar" } }),
      );
      expect(readCredentialsFile(credsPath)).toEqual({
        deepseek: "sk-test-dummy",
      });
    });
  });
});
