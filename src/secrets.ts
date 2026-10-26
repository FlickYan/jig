// What jig refuses to write into its own memory, AGENTS.md or a skill, and blanks out of the sessions it
// exports: things that look like credentials. A memory outlives the session and goes into every later
// prompt, so a pasted key would leak from then on; an export is made to leave the machine.

// Keys and tokens as providers hand them out, known by their prefix and length, so that code naming
// something with the same start (hf_hub_download, npm_config_cache) isn't taken for one.
const KEYS: [string, RegExp][] = [
  ["an API key", /\b(sk|pk|rk)-[A-Za-z0-9_-]{20,}/],
  ["an API key", /\bxai-[A-Za-z0-9_]{40,}/], // xAI
  ["an API key", /\bgsk_[A-Za-z0-9]{40,}/], // Groq
  ["a Google API key", /\bAIza[0-9A-Za-z_-]{35}/],
  ["a Stripe key", /\b(?:(?:sk|rk)_(?:live|test|prod)|whsec)_[A-Za-z0-9]{20,}/],
  ["an AWS access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["a GitHub token", /\bgh[pousr]_[A-Za-z0-9]{36,}/],
  ["a GitHub token", /\bgithub_pat_[A-Za-z0-9_]{60,}/],
  ["a GitLab token", /\bgl(?:pat|dt|rt|ptt)-[A-Za-z0-9_-]{20,}/],
  ["a Hugging Face token", /\bhf_[A-Za-z0-9]{34}\b/],
  ["an npm token", /\bnpm_[A-Za-z0-9]{36}\b/],
  ["a PyPI token", /\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,}/],
  ["a Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["a Slack token", /\bxapp-\d-[A-Z0-9]+-\d+-[a-z0-9]+/], // its whole shape, as names start with xapp- too (xapp-sn-watcher)
  ["a SendGrid key", /\bSG\.[\w-]{22}\.[\w-]{43}/],
];

// A password in a URL, unless the host is this machine or an example: postgres://postgres:postgres@localhost
// is a local convention AGENTS.md should be able to hold. A placeholder ($PASSWORD, <password>, ***) and a
// key already blanked out aren't passwords. It starts at the :// rather than the scheme, which is much
// faster to search for; the first group is everything up to the password.
const LOCAL_HOST = String.raw`(?:(?:[\w-]+\.)*(?:localhost|example(?:\.(?:com|net|org))?|test|invalid)|127(?:\.\d+){3}|0\.0\.0\.0|\[::1\])(?![\w.-])`;
const URL_PASSWORD = String.raw`(://[^\s/?#:@]*:)(?![$<{[*])[^\s/?#@"'<>]{3,}(?=@(?!${LOCAL_HOST}))`;

// A password or token assigned to a name (password=, api_key: or, as in JSON, "secret": "), up to its value.
// The name may end a longer one (DB_PASSWORD, AWS_SECRET_ACCESS_KEY, PGPASSWORD, clientSecret), but nothing
// may follow it in the word (passwordField, token_count, MAX_TOKENS). The \b keeps a long word to one read:
// without it, \w* would read the rest of the word again from every letter. A quote may be escaped, as in
// JSON in a string, and escaped again, as a tool call's arguments hold a command with JSON in it.
const ASSIGNMENT = String.raw`\b\w*(?:password|passwd|secret(?:[_-]?(?:access[_-]?)?key)?|token|api[_-]?key)(?:\\*["'])?\s*[:=]\s*(?:\\*["'])?`;

const PATTERNS: [string, RegExp][] = [
  ...KEYS,
  ["a private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["a password in a URL", new RegExp(URL_PASSWORD, "i")],
  // Placeholders aren't passwords here either: ${DB_PASSWORD} is how a compose file says where one is kept.
  // Nor is code that reads one from there, a value that starts with a name and then . ( or [, as in
  // os.environ["DB_PASSWORD"], process.env.TOKEN or z.string(). The name has no digit, so p4ss.w0rd still is.
  ["a password or token", new RegExp(String.raw`${ASSIGNMENT}(?![$<{[*]|[A-Za-z_$]+[.([])[^\s"']{8,}`, "i")],
];

/** What kind of secret the text seems to hold, or undefined. */
export function findSecret(text: string): string | undefined {
  return PATTERNS.find(([, pattern]) => pattern.test(text))?.[0];
}

/** How each kind is blanked out: keys and JWTs whole, a private key to its end line, and only the value of a password. */
const REDACTIONS: [RegExp, string][] = [
  ...KEYS.map(([, pattern]): [RegExp, string] => [new RegExp(pattern.source, "g"), "[REDACTED]"]),
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[REDACTED]"],
  // A JWT doesn't stop a memory or a skill, which may hold one from a test, but a session that has one has
  // more likely logged in with it. Its header and payload are JSON, so both start with eyJ.
  [/\beyJ[\w-]{5,}\.eyJ[\w-]{5,}\.[\w-]{10,}/g, "[REDACTED]"],
  [new RegExp(URL_PASSWORD, "gi"), "$1[REDACTED]"],
  // The value must look like a secret, with a digit in it, and not like code: `token = tokens[i]` and
  // `token = token.strip()` stay as they are. The digit must be in its first 100 characters: looked for to
  // the end, a long run like token=token=... was read again from every name in it.
  [new RegExp(String.raw`(${ASSIGNMENT})(?=[\w+/=~!@#$%^&*-]{0,99}\d)[\w+/=~!@#$%^&*-]{8,}(?![\w.([])`, "gi"), "$1[REDACTED]"],
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
