// What jig refuses to write into its own memory, AGENTS.md or a skill: things that look like credentials.
// A memory outlives the session and goes into every later prompt, so a pasted key would leak from then on.

const PATTERNS: [string, RegExp][] = [
  ["an API key", /\b(sk|pk|rk)-[A-Za-z0-9_-]{20,}/],
  ["an AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["a GitHub token", /\bgh[pousr]_[A-Za-z0-9]{36,}/],
  ["a Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["a private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["a password or token", /\b(password|passwd|secret|token|api[_-]?key)\b\s*[:=]\s*["']?[^\s"']{8,}/i],
];

/** What kind of secret the text seems to hold, or undefined. */
export function findSecret(text: string): string | undefined {
  return PATTERNS.find(([, pattern]) => pattern.test(text))?.[0];
}
