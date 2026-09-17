export const NO_DAEMON_ERROR =
  "No daemon bound for this workspace. Run: chavez headless workspace open";
export const DAEMON_STANDBY_NOTE =
  "Another daemon is already primary for this workspace; this connection is standby";
export const TURN_INTERRUPTED = "Turn interrupted: daemon disconnected";
export const HEARTBEAT_INTERVAL_MS = 2000;
export const RECONNECT_BASE_MS = 500;
export const RECONNECT_MAX_MS = 8000;
export const RECONNECT_JITTER_MS = 250;
