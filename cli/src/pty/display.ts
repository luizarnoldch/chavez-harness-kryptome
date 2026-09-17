export function formatPtyHeader(hostname: string, cwd: string): string {
  return `pty · ${hostname} · ${cwd}`;
}
