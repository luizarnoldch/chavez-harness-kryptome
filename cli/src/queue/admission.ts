import {
  NO_DAEMON_ERROR,
  QUEUE_CI_BUSY,
  QUEUE_CI_DEFAULT_WAIT_MS,
  QUEUE_CI_MAX_WAIT_MS,
  QUEUE_FULL_ERROR,
  QUEUE_MAX_LENGTH,
  TURN_BUSY_ERROR,
} from "./constants";

export type AdmissionInput = {
  hasDaemon: boolean;
  busy: boolean;
  queueLength: number;
  enqueue: boolean; // default true en el caller interactivo
};

export type Admission =
  | { action: "dispatch" }
  | { action: "enqueue" }
  | { action: "reject"; error: string };

export function admitTurn(input: AdmissionInput): Admission {
  if (!input.hasDaemon) {
    return { action: "reject", error: NO_DAEMON_ERROR };
  }
  if (!input.busy) return { action: "dispatch" };
  if (!input.enqueue) {
    return { action: "reject", error: QUEUE_CI_BUSY };
  }
  if (input.queueLength >= QUEUE_MAX_LENGTH) {
    return { action: "reject", error: QUEUE_FULL_ERROR };
  }
  return { action: "enqueue" };
}

export function isNonInteractive(
  env: NodeJS.ProcessEnv = process.env,
  stdout: { isTTY?: boolean } = process.stdout,
): boolean {
  const ci = env.CI;
  if (ci === "1" || ci === "true" || env.CHAVEZ_CI === "1") return true;
  return stdout.isTTY === false;
}

export function resolveAskPolicy(input: {
  nonInteractive: boolean;
  noQueue: boolean;
  waitTimeoutMs?: number;
}): { enqueue: boolean; waitTimeoutMs: number; busyError: string } {
  const raw = input.waitTimeoutMs;
  const waitTimeoutMs = Math.max(
    0,
    Math.min(
      raw == null || Number.isNaN(raw) ? QUEUE_CI_DEFAULT_WAIT_MS : raw,
      QUEUE_CI_MAX_WAIT_MS,
    ),
  );
  if (input.noQueue) {
    return { enqueue: false, waitTimeoutMs: 0, busyError: QUEUE_CI_BUSY };
  }
  if (waitTimeoutMs > 0) {
    return { enqueue: true, waitTimeoutMs, busyError: QUEUE_CI_BUSY };
  }
  if (input.nonInteractive) {
    return { enqueue: false, waitTimeoutMs: 0, busyError: QUEUE_CI_BUSY };
  }
  return { enqueue: true, waitTimeoutMs: 0, busyError: TURN_BUSY_ERROR };
}

export function capWaitTimeout(ms: number): number {
  if (!Number.isFinite(ms) || ms < 0) return 0;
  return Math.min(ms, QUEUE_CI_MAX_WAIT_MS);
}
