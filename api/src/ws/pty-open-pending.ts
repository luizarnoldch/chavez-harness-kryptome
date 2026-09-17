import { createPendingMap } from "./pending";
import type { ServerMessage } from "./protocol";

export type ExpectedPtyOpen = {
  daemonConnectionId: string;
  ownerConnectionId: string;
  workspaceId: string;
};

export function createPtyOpenPending(timeoutMs: number) {
  const pending = createPendingMap(timeoutMs);
  const expectedByRequest = new Map<string, ExpectedPtyOpen>();

  return {
    wait(
      id: string,
      type: string,
      expected: ExpectedPtyOpen,
    ): Promise<ServerMessage> {
      expectedByRequest.set(id, expected);
      return pending.wait(id, type).finally(() => {
        expectedByRequest.delete(id);
      });
    },
    expected(id: string): ExpectedPtyOpen | null {
      return expectedByRequest.get(id) ?? null;
    },
    completeFromDaemon(
      id: string,
      daemonConnectionId: string,
      msg: ServerMessage,
    ): boolean {
      const expected = expectedByRequest.get(id);
      if (!expected || expected.daemonConnectionId !== daemonConnectionId) {
        return false;
      }
      return pending.complete(id, msg);
    },
    cancel(id: string, msg: ServerMessage): boolean {
      return pending.complete(id, msg);
    },
  };
}
