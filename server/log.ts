// What the task service, the gateway and the router say about themselves, on stderr: as the plain lines
// they always wrote ("jig service: ..."), or as one JSON object a line for a log pipeline to index, with
// the task, tenant and request each line is about as fields of their own. JIG_LOG_FORMAT=json picks JSON;
// JIG_LOG_LEVEL (debug, info, warn or error) the least a line must be to be written.

export type Level = "debug" | "info" | "warn" | "error";
export type Fields = Record<string, unknown>;

export interface Log {
  debug(message: string, fields?: Fields): void;
  info(message: string, fields?: Fields): void;
  warn(message: string, fields?: Fields): void;
  error(message: string, fields?: Fields): void;
  /** The same log, with these fields on every line. */
  with(fields: Fields): Log;
}

export interface LogOptions {
  format?: "text" | "json";
  /** Lines below it are dropped (default: JIG_LOG_LEVEL, or info). */
  level?: Level;
  /** Where the lines go (default: stderr). */
  write?: (line: string) => void;
  /** For the timestamps (tests). */
  now?: () => Date;
}

const ORDER: Level[] = ["debug", "info", "warn", "error"];

/** An error as a field: its message, and its stack in JSON, where it doesn't break the line. */
function plain(value: unknown, json: boolean): unknown {
  if (value instanceof Error) return json ? { message: value.message, ...(value.stack && { stack: value.stack }) } : value.message;
  return value;
}

/** The format the environment asks for. */
export function logFormat(env: NodeJS.ProcessEnv = process.env): "text" | "json" {
  return env.JIG_LOG_FORMAT === "json" ? "json" : "text";
}

/** The level the environment asks for. */
export function logLevel(env: NodeJS.ProcessEnv = process.env): Level {
  return ORDER.includes(env.JIG_LOG_LEVEL as Level) ? (env.JIG_LOG_LEVEL as Level) : "info";
}

/** A log for `component` ("service", "gateway", "router"). */
export function createLog(component: string, options: LogOptions = {}, bound: Fields = {}): Log {
  const format = options.format ?? logFormat();
  const level = options.level ?? logLevel();
  const least = ORDER.indexOf(level);
  const write = options.write ?? ((line: string) => process.stderr.write(`${line}\n`));
  const now = options.now ?? (() => new Date());
  const emit = (level: Level, message: string, fields: Fields = {}) => {
    if (ORDER.indexOf(level) < least) return;
    const all = { ...bound, ...fields };
    if (format === "json") {
      const entries = Object.entries(all).map(([key, value]) => [key, plain(value, true)]);
      write(JSON.stringify({ ts: now().toISOString(), level, component, msg: message, ...Object.fromEntries(entries) }));
      return;
    }
    const extra = Object.entries(all)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => {
        const text = plain(value, false);
        return `${key}=${typeof text === "string" && !/[\s"=]/.test(text) ? text : JSON.stringify(text)}`;
      });
    write(`jig ${component}: ${message}${extra.length ? ` (${extra.join(" ")})` : ""}`);
  };
  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
    with: (fields) => createLog(component, { ...options, format, level, write, now }, { ...bound, ...fields }),
  };
}
