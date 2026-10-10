// What jig refuses to write into its own memory, AGENTS.md or a skill, and blanks out of the sessions it
// exports: things that look like credentials. A memory outlives the session and goes into every later
// prompt, so a pasted key would leak from then on; an export is made to leave the machine.

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

/** How each kind is blanked out: keys whole, a private key to its end line, and only the value of a password. */
const REDACTIONS: [RegExp, string][] = [
  ...PATTERNS.slice(0, 4).map(([, pattern]): [RegExp, string] => [new RegExp(pattern.source, "g"), "[REDACTED]"]),
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[REDACTED]"],
  // The value can be quoted, with the quote escaped (as in JSON in a string). It must look like a secret,
  // with a digit in it, and not like code: `token = tokens[i]` and `token = token.strip()` stay as they are.
  [/(\b(?:password|passwd|secret|token|api[_-]?key)\b\s*[:=]\s*(?:\\?["'])?)(?=[\w+/=~!@#$%^&*-]*\d)[\w+/=~!@#$%^&*-]{8,}(?![\w.([])/gi, "$1[REDACTED]"],
];

/** The text with everything that looks like a secret replaced by [REDACTED], and how many there were. */
export function redactSecrets(text: string): { text: string; count: number } {
  let count = 0;
  for (const [pattern, replacement] of REDACTIONS) {
    count += text.match(pattern)?.length ?? 0;
    text = text.replace(pattern, replacement);
  }
  return { text, count };
}
