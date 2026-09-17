/** keep-in-sync: api/src/pty/constants.ts web/src/lib/pty-constants.ts */

export { NO_DAEMON_ERROR } from "../ws/presence-constants";

export const PTY_DENIED_AUTO =
  "PTY denied in auto mode: no human for the pager. Switch to ask.";
export const PTY_DENIED_PLAN =
  "Plan mode: PTY is disabled. Switch to ask to run interactive commands.";
export const PTY_DENIED_CI =
  "PTY is not available in CI / non-interactive mode.";
export const PTY_DENIED_ASK = "User denied this PTY";
export const PTY_UNSUPPORTED = "PTY is not supported on this platform.";
export const PTY_BUSY = "Too many PTY sessions on this daemon";
export const PTY_NOT_FOUND = "PTY session not found";
export const PTY_OWNER_GONE = "PTY closed: owner disconnected";
export const PTY_IDLE_CLOSED = "PTY closed: idle timeout";

export const PTY_MAX_SESSIONS = 4;
export const PTY_IDLE_MS = 1_800_000;
export const PTY_IDLE_SWEEP_MS = 30_000;
export const PTY_KILL_GRACE_MS = 1_500;
export const PTY_CHUNK_MAX_BYTES = 32_768;
export const PTY_TRANSCRIPT_MAX_CHARS = 8000;
export const PTY_AGENT_TIMEOUT_MS = 600_000;
export const PTY_OPEN_TIMEOUT_MS = 10_000;
export const PTY_DEFAULT_COLS = 80;
export const PTY_DEFAULT_ROWS = 24;

export const PTY_MCP_SERVER = "chavez-pty";
export const PTY_MCP_TOOL = "pty";
export const PTY_CANONICAL = "pty";
export const PTY_MCP_FULL = `mcp__${PTY_MCP_SERVER}__${PTY_MCP_TOOL}`;

export const PTY_PREAMBLE =
  "Prefer the Bash tool for one-shot commands (no TTY). Use Pty only when a command requires an interactive TTY (pagers, REPLs, editors). Pty is denied in auto and in CI.";

export const PTY_TUI_CLOSE_HINT =
  "ctrl+x cierra el PTY (no q: q va al shell)";

export const PTY_STRIP_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CURSOR_API_KEY",
  "CHAVEZ_ACCESS_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
] as const;
