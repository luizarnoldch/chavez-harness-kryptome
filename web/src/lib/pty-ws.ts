/** keep-in-sync: cli/src/pty/display.ts */
export function formatPtyHeader(hostname: string, cwd: string): string {
  return `pty · ${hostname} · ${cwd}`;
}

export function encodePtyChunk(s: string): string {
  return btoa(unescape(encodeURIComponent(s)));
}

export function decodePtyChunk(b64: string): string {
  try {
    return decodeURIComponent(escape(atob(b64)));
  } catch {
    return atob(b64);
  }
}
