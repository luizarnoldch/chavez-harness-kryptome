import { fail, type ServerMessage } from "./protocol";

export type PendingReply = {
  resolve: (msg: ServerMessage) => void;
  timer: ReturnType<typeof setTimeout>;
};

type DataPendingReply = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export function createPendingMap(timeoutMs: number) {
  const map = new Map<string, PendingReply>();
  const dataMap = new Map<string, DataPendingReply>();
  return {
    wait(id: string, type?: string): Promise<ServerMessage | unknown> {
      if (type !== undefined) {
        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            map.delete(id);
            resolve(
              fail(
                type,
                id,
                "No daemon bound for this workspace. Run: chavez headless workspace open",
              ),
            );
          }, timeoutMs);
          map.set(id, { resolve, timer });
        });
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          dataMap.delete(id);
          reject(new Error("timeout"));
        }, timeoutMs);
        dataMap.set(id, { resolve, reject, timer });
      });
    },
    complete(id: string, msg: ServerMessage): boolean {
      const p = map.get(id);
      if (!p) return false;
      clearTimeout(p.timer);
      map.delete(id);
      p.resolve(msg);
      return true;
    },
    settle(id: string, data?: unknown, error?: string): boolean {
      const p = dataMap.get(id);
      if (!p) return false;
      clearTimeout(p.timer);
      dataMap.delete(id);
      const payload =
        error != null
          ? {
              ...(typeof data === "object" && data !== null
                ? (data as Record<string, unknown>)
                : {}),
              error,
            }
          : data;
      p.resolve(payload);
      return true;
    },
    has(id: string) {
      return map.has(id) || dataMap.has(id);
    },
  };
}

const pendingSteer = new Map<string, PendingReply>();

export function waitSteerResult(
  requestId: string,
  timeoutMs = 10_000,
): Promise<ServerMessage> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingSteer.delete(requestId);
      resolve(fail("agent.turn.steer", requestId, "Steer timed out"));
    }, timeoutMs);
    pendingSteer.set(requestId, { resolve, timer });
  });
}

export function completeSteerResult(
  requestId: string,
  msg: ServerMessage,
): boolean {
  const pending = pendingSteer.get(requestId);
  if (!pending) return false;
  clearTimeout(pending.timer);
  pendingSteer.delete(requestId);
  pending.resolve(msg);
  return true;
}
