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
  const canceledByRequest = new Map<
    string,
    {
      expected: ExpectedPtyOpen;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

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
    cancelByOwner(
      ownerConnectionId: string,
      reply: (id: string) => ServerMessage,
    ): string[] {
      const canceled: string[] = [];
      for (const [id, expected] of expectedByRequest) {
        if (expected.ownerConnectionId !== ownerConnectionId) continue;
        const timer = setTimeout(() => {
          canceledByRequest.delete(id);
        }, timeoutMs);
        canceledByRequest.set(id, { expected, timer });
        if (pending.complete(id, reply(id))) canceled.push(id);
      }
      return canceled;
    },
    consumeCanceledFromDaemon(
      id: string,
      daemonConnectionId: string,
    ): ExpectedPtyOpen | null {
      const canceled = canceledByRequest.get(id);
      if (
        !canceled ||
        canceled.expected.daemonConnectionId !== daemonConnectionId
      ) {
        return null;
      }
      clearTimeout(canceled.timer);
      canceledByRequest.delete(id);
      return canceled.expected;
    },
  };
}
