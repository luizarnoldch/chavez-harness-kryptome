/** keep-in-sync: cli/src/pty/constants.ts web/src/lib/pty-constants.ts */

export const NO_DAEMON_ERROR =
  "No daemon bound for this workspace. Run: chavez headless workspace open";

export const PTY_DENIED_CI =
  "PTY is not available in CI / non-interactive mode.";
export const PTY_NOT_FOUND = "PTY session not found";
export const PTY_BUSY = "Too many PTY sessions on this daemon";
export const PTY_OPEN_TIMEOUT_MS = 10_000;
export const PTY_CANONICAL = "pty";
