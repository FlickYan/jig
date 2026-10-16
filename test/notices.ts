/**
 * Collects the lines jig prints that contain one of `markers` (its notices), until stop(). Everything else
 * still goes to stdout, where node --test reports the results: swallowing it would lose other tests' reports.
 */
export function collectNotices(...markers: string[]): { notices: string[]; stop: () => void } {
  const notices: string[] = [];
  const write = process.stdout.write;
  const marked = (text: string) => markers.some((marker) => text.includes(marker));
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    if (!marked(String(chunk))) return (write as (...args: unknown[]) => boolean).call(process.stdout, chunk, ...rest);
    notices.push(...String(chunk).split("\n").filter(marked));
    return true;
  }) as typeof process.stdout.write;
  return {
    notices,
    stop() {
      process.stdout.write = write;
    },
  };
}
