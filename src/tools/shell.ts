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

/** A word as the shell takes it whole: as it is, or in single quotes where the shell would split or expand it. */
export function quoteWord(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
}

/** Commands that run a project's tests, by the usual runners' names. */
export const TEST_COMMAND = /\b(pytest|unittest|tox|npm (run )?test|yarn test|pnpm test|node --test|jest|vitest|mocha|go test|cargo test|make (check|test)|rspec|phpunit|dotnet test|ctest)\b/;

/**
 * A command without its heredocs' lines, which are a file's content, not commands: `cat > solve.py << 'EOF'`
 * writes solve.py, whatever its lines say, up to the line with the delimiter.
 */
export function withoutHeredocs(command: string): string {
  const lines: string[] = [];
  let heredoc: string | undefined;
  for (const line of command.split("\n")) {
    if (heredoc !== undefined) {
      if (line.trim() === heredoc) heredoc = undefined;
      continue;
    }
    lines.push(line);
    heredoc = /(?<!<)<<(?!<)-?\s*["'\\]?(\w+)/.exec(line)?.[1];
  }
  return lines.join("\n");
}
