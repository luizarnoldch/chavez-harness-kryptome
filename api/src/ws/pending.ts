import { fail, type ServerMessage } from "./protocol";

export type PendingReply = {
  resolve: (msg: ServerMessage) => void;
  timer: ReturnType<typeof setTimeout>;
};

export function createPendingMap(timeoutMs: number) {
  const map = new Map<string, PendingReply>();
  return {
    wait(id: string, type: string): Promise<ServerMessage> {
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
    },
    complete(id: string, msg: ServerMessage): boolean {
      const p = map.get(id);
      if (!p) return false;
      clearTimeout(p.timer);
      map.delete(id);
      p.resolve(msg);
      return true;
    },
    has(id: string) {
      return map.has(id);
    },
  };
}
