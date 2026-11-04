// A reader for the YAML of the deploy files (test/server-runners.test.ts, test/server-observability.test.ts).

/**
 * The YAML the deploy files are written in, and no more: block maps and lists, plain, quoted and JSON
 * flow scalars, `|` blocks, whole-line comments, and `---` between documents. Anything else is refused.
 */
export function parseYaml(text: string): unknown[] {
  if (/\t/.test(text)) throw new Error("tabs");
  const documents: unknown[] = [];
  for (const part of text.split(/^---$/m)) {
    const lines = part.split("\n");
    let i = 0;
    const indent = (line: string) => line.length - line.trimStart().length;
    const skip = () => {
      while (i < lines.length && /^\s*(#.*)?$/.test(lines[i])) i++;
    };
    const item = (line: string) => /^\s*-( |$)/.test(line);
    const scalar = (value: string): unknown => {
      if (/^["[{]/.test(value)) return JSON.parse(value);
      // A plain scalar with ": " in it, which YAML reads as a map, is refused too.
      if (/ #|: |^[&*!|>'%@`]/.test(value)) throw new Error(`a scalar this reader doesn't take: ${value}`);
      if (value === "true" || value === "false") return value === "true";
      if (value === "null") return null;
      return /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value;
    };
    const node = (at: number): unknown => (item(lines[i]) ? list(at) : map(at));
    const list = (at: number): unknown[] => {
      const items: unknown[] = [];
      for (skip(); i < lines.length && indent(lines[i]) === at && item(lines[i]); skip()) {
        const rest = lines[i].trim().slice(1).trim();
        if (/^[\w./-]+:( |$)/.test(rest)) {
          // A map that starts on the dash's line: the same map as if it started on the next.
          lines[i] = `${" ".repeat(at + 2)}${rest}`;
          items.push(map(at + 2));
        } else if (rest) {
          i++;
          items.push(scalar(rest));
        } else {
          i++;
          skip();
          items.push(node(indent(lines[i])));
        }
      }
      return items;
    };
    const map = (at: number): Record<string, unknown> => {
      const result: Record<string, unknown> = {};
      for (skip(); i < lines.length && indent(lines[i]) === at && !item(lines[i]); skip()) {
        const [, key, value = ""] = /^([\w./-]+):(?: (.*))?$/.exec(lines[i].trim()) ?? [];
        if (!key) throw new Error(`line ${i + 1}: ${lines[i]}`);
        if (key in result) throw new Error(`line ${i + 1}: ${key} twice`);
        i++;
        if (value === "|") {
          const block: string[] = [];
          for (; i < lines.length && (!lines[i].trim() || indent(lines[i]) > at); i++) block.push(lines[i]);
          const margin = Math.min(...block.filter((line) => line.trim()).map(indent));
          result[key] = `${block.map((line) => line.slice(margin)).join("\n").trimEnd()}\n`;
        } else if (value) {
          result[key] = scalar(value);
        } else {
          skip();
          const next = lines[i] === undefined ? -1 : indent(lines[i]);
          result[key] = next > at || (next === at && item(lines[i])) ? node(next) : null;
        }
      }
      return result;
    };
    skip();
    if (i === lines.length) continue;
    documents.push(node(indent(lines[i])));
    skip();
    if (i < lines.length) throw new Error(`line ${i + 1} isn't read: ${lines[i]}`);
  }
  return documents;
}
