export { NO_DAEMON_ERROR } from "../ws/presence-constants";

export const NO_RUNNER_LABEL = "sin runner";
export const TURN_START_LABEL = "Turn iniciado";
export const TURN_DONE_LABEL = "Turn terminado";
export const TURN_ERROR_LABEL = "Turn error";
export const APPROVAL_LABEL = "Ask pendiente";
export const TOAST_TTL_MS = 8000;
export const MAX_VISIBLE_TOASTS = 5;

export const NOTIFICATION_SOURCE_TYPES = [
  "chat.stream.start",
  "chat.stream.end",
  "chat.stream.error",
  "chat.tool.update",
  "chat.tool.start",
  "chat.tool.resolved",
  "chat.tool.result",
  "daemon.presence",
] as const;

export const NEVER_NOTIFY_TYPES = [
  "chat.stream.delta",
  "chat.thinking.delta",
  "message.appended",
  "agent.turn.ended",
  "agent.turn.dispatch",
] as const;

export const READ_SDK = new Set(["Read", "Grep", "Glob", "LS"]);

export type NotificationKind =
  | "turn_start"
  | "turn_done"
  | "turn_error"
  | "approval"
  | "daemon";
