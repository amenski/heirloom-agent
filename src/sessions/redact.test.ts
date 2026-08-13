import { describe, it, expect } from "vitest";
import { redactSecrets } from "./redact.js";

describe("redactSecrets", () => {
  it("redacts OpenAI API keys", () => {
    const input = 'export OPENAI_API_KEY=sk-proj1234567890abcdefghij';
    const result = redactSecrets(input);
    expect(result).not.toContain("sk-proj");
    expect(result).toContain("[redacted-api-key]");
  });

  it("redacts GitHub personal access tokens", () => {
    const input = "ghp_1234567890abcdefghij1234567890abcdef";
    const result = redactSecrets(input);
    expect(result).toContain("[redacted-github-token]");
    expect(result).not.toContain("ghp_");
  });

  it("redacts GitHub OAuth tokens", () => {
    const input = "gho_1234567890abcdefghij1234567890abcdef";
    const result = redactSecrets(input);
    expect(result).toContain("[redacted-github-token]");
    expect(result).not.toContain("gho_");
  });

  it("redacts GitHub installation tokens", () => {
    const input = "ghs_1234567890abcdefghij1234567890abcdef";
    const result = redactSecrets(input);
    expect(result).toContain("[redacted-github-token]");
    expect(result).not.toContain("ghs_");
  });

  it("redacts AWS access keys", () => {
    const input = "AKIA1234567890ABCDEF";
    const result = redactSecrets(input);
    expect(result).toContain("[redacted-aws-key]");
    expect(result).not.toContain("AKIA");
  });

  it("redacts private key blocks", () => {
    const input = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----";
    const result = redactSecrets(input);
    expect(result).toContain("[redacted-private-key]");
    expect(result).not.toContain("-----BEGIN");
  });

  it("redacts apiKey=... patterns", () => {
    const input = 'The config says apiKey = "abc123def456ghi789jkl012"';
    const result = redactSecrets(input);
    expect(result).toContain("[redacted-api-key]");
  });

  it("redacts token:... patterns", () => {
    const input = "Authorization: token: 'my-secret-token-that-is-long-enough'";
    const result = redactSecrets(input);
    expect(result).toContain("[redacted-token]");
  });

  it("leaves benign text unchanged", () => {
    const input = "This is a normal message with no secrets.";
    const result = redactSecrets(input);
    expect(result).toBe(input);
  });

  it("redacts multiple secrets in one string", () => {
    const input =
      "Keys: sk-proj1234567890abcdefghij and ghp_1234567890abcdefghij1234567890abcdef";
    const result = redactSecrets(input);
    expect(result).toContain("[redacted-api-key]");
    expect(result).toContain("[redacted-github-token]");
  });

  it("redacts key-name-aware secrets in JSON form (fix 4)", () => {
    const input = '{"api_key": "d41d8cd98f00b204e9800998ecf8427e", "password": "hunter2"}';
    const result = redactSecrets(input);
    expect(result).not.toContain("d41d8cd98f00b204e9800998ecf8427e");
    expect(result).not.toContain("hunter2");
    expect(result).toContain("[redacted-api-key]");
    expect(result).toContain("[redacted-password]");
  });

  it("redacts key=value and JSON-escaped forms case-insensitively (fix 4)", () => {
    const input = 'API_KEY=d41d8cd98f00b204e9800998ecf8427e and "Secret":"s3cr3tvalue1234567890"';
    const result = redactSecrets(input);
    expect(result).not.toContain("d41d8cd98f00b204e9800998ecf8427e");
    expect(result).not.toContain("s3cr3tvalue1234567890");
    expect(result).toContain("[redacted-api-key]");
    expect(result).toContain("[redacted-secret]");
  });

  it("redacts X-API-Key and Authorization: Bearer header forms (fix 4)", () => {
    const input =
      "X-API-Key: d41d8cd98f00b204e9800998ecf8427e\nAuthorization: Bearer e2c42c9f9d8b7a6f5e4d3c2b1a098765";
    const result = redactSecrets(input);
    expect(result).not.toContain("d41d8cd98f00b204e9800998ecf8427e");
    expect(result).not.toContain("e2c42c9f9d8b7a6f5e4d3c2b1a098765");
    expect(result).toContain("[redacted-api-key]");
    expect(result).toContain("[redacted-authorization]");
  });

  it("leaves benign prose containing key names unchanged (fix 4)", () => {
    const input = "The password for the vault is stored elsewhere; token: something_short";
    expect(redactSecrets(input)).toBe(input);
  });
});
