const SECRET_PATTERNS: [RegExp, string][] = [
  [/sk-[a-zA-Z0-9]{20,}/g, "[redacted-api-key]"],
  [/ghp_[a-zA-Z0-9]{36}/g, "[redacted-github-token]"],
  [/gho_[a-zA-Z0-9]{36}/g, "[redacted-github-token]"],
  [/ghs_[a-zA-Z0-9]{36}/g, "[redacted-github-token]"],
  [/AKIA[0-9A-Z]{16}/g, "[redacted-aws-key]"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted-private-key]"],
  [/api[Kk]ey\s*[=:]\s*['"]?[a-zA-Z0-9_\-.]{20,}['"]?/g, "[redacted-api-key]"],
  [/token\s*[=:]\s*['"]?[a-zA-Z0-9_\-.]{20,}['"]?/g, "[redacted-token]"],
];

export function redactSecrets(text: string): string {
  let result = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}
