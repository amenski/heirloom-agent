import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCredential, readCredentialsFile } from "./credentials.js";

describe("credentials", () => {
  let dir: string;
  let credsPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "heirloom-creds-test-"));
    credsPath = join(dir, "credentials.yaml");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("getCredential", () => {
    it("returns the key for a present provider", () => {
      writeFileSync(credsPath, "deepseek: sk-test-dummy\nopenrouter: sk-or-test-dummy\n");
      expect(getCredential("deepseek", credsPath)).toBe("sk-test-dummy");
      expect(getCredential("openrouter", credsPath)).toBe("sk-or-test-dummy");
    });

    it("returns undefined for an absent provider", () => {
      writeFileSync(credsPath, "deepseek: sk-test-dummy\n");
      expect(getCredential("openai", credsPath)).toBeUndefined();
    });

    it("returns undefined when the file does not exist", () => {
      expect(getCredential("deepseek", join(dir, "nope.yaml"))).toBeUndefined();
    });

    it("returns undefined for a malformed (non-mapping) file", () => {
      writeFileSync(credsPath, "- just\n- a\n- list\n");
      expect(getCredential("deepseek", credsPath)).toBeUndefined();
    });

    it("returns undefined for invalid YAML rather than throwing", () => {
      writeFileSync(credsPath, "deepseek: [unterminated\n");
      expect(() => getCredential("deepseek", credsPath)).not.toThrow();
      expect(getCredential("deepseek", credsPath)).toBeUndefined();
    });

    it("returns undefined for an empty-string value", () => {
      writeFileSync(credsPath, "deepseek: \"\"\n");
      expect(getCredential("deepseek", credsPath)).toBeUndefined();
    });
  });

  describe("readCredentialsFile", () => {
    it("returns an empty map for a missing file", () => {
      expect(readCredentialsFile(join(dir, "nope.yaml"))).toEqual({});
    });

    it("ignores non-string values", () => {
      writeFileSync(credsPath, "deepseek: sk-test-dummy\nnested:\n  foo: bar\n");
      expect(readCredentialsFile(credsPath)).toEqual({ deepseek: "sk-test-dummy" });
    });
  });
});
