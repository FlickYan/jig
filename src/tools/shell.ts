/**
 * Splits a shell command into the words of each simple command (separated by |, ;, && or ||), or
 * returns null when it uses syntax this small parser doesn't follow: substitutions, variables,
 * redirections, background jobs, escapes or several lines. Quotes are only stripped from the ends of
 * words, so callers that make decisions with it should treat anything unusual as "don't know".
 */
export function parseCommand(command: string): string[][] | null {
  if (/[`$<>\\\n]/.test(command) || /(^|[^&])&($|[^&])/.test(command)) return null;
  const commands = command.split(/&&|\|\||[|;]/).map((part) => part.trim().split(/\s+/).map(unquote));
  return commands.some((argv) => argv[0] === "") ? null : commands;
}

function unquote(word: string): string {
  return word.replace(/^["']+|["']+$/g, "");
}
