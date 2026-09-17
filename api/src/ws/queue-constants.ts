// keep-in-sync with cli/src/queue/constants.ts
export {
  NO_DAEMON_ERROR,
  TURN_BUSY_ERROR,
} from "./errors";

export const QUEUE_FULL_ERROR = "Turn queue is full (max 20)";
export const QUEUE_NOT_FOUND = "Queued turn not found";
export const QUEUE_CANCELLED = "Queued turn cancelled";
export const QUEUE_CI_BUSY =
  "Daemon busy — not queued (CI / --no-queue). Retry or pass --wait-timeout";
export const QUEUE_CI_TIMEOUT =
  "Timed out waiting for the daemon (CI). Queued turn cancelled";
export const QUEUE_MAX_LENGTH = 20;
export const QUEUE_CI_DEFAULT_WAIT_MS = 0;
export const QUEUE_CI_MAX_WAIT_MS = 600_000;
export const QUEUE_KIND = "queued_turn";
export const QUEUE_STATUS_QUEUED = "queued";
export const QUEUE_STATUS_DISPATCHED = "dispatched";
export const QUEUE_STATUS_CANCELLED = "cancelled";
export const QUEUE_PREVIEW_CHARS = 80;
export const QUEUE_ENQUEUED_LABEL = "Turn encolado";
export const QUEUE_PROMOTED_LABEL = "Turn en cola iniciado";
export const QUEUE_DONE_LABEL = "Turn en cola terminado";
export const QUEUE_POSITION_PREFIX = "queued · #";
export const WEB_QUEUED_HINT = "Encolado · posición";
export const TUI_QUEUED_HINT = "queued #";
export const TUI_COMPOSE_WHILE_BUSY =
  "Busy: Enter encola (posición) · x quita el último queued";

export type QueueStatus = "queued" | "dispatched" | "cancelled";
export type QueueReason =
  | "enqueued"
  | "promoted"
  | "cancelled"
  | "drained"
  | "hydrated"
  | "started";
