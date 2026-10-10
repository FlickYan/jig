/**
 * Collects the lines jig prints that contain `marker` (its notices), until stop(). Everything else still
 * goes to stdout, where node --test reports the results: swallowing it would lose other tests' reports.
 */
export function collectNotices(marker: string): { notices: string[]; stop: () => void } {
  const notices: string[] = [];
  const write = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    if (!String(chunk).includes(marker)) return (write as (...args: unknown[]) => boolean).call(process.stdout, chunk, ...rest);
    notices.push(...String(chunk).split("\n").filter((line) => line.includes(marker)));
    return true;
  }) as typeof process.stdout.write;
  return {
    notices,
    stop() {
      process.stdout.write = write;
    },
  };
}
