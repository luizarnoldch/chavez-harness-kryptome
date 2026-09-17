export type PtyKind = "user" | "agent";

export type PtyHubSession = {
  ptyId: string;
  ownerConnectionId: string;
  daemonConnectionId: string;
  workspaceId: string;
  kind: PtyKind;
  chatId: string | null;
};

const byId = new Map<string, PtyHubSession>();

export const ptyRegistry = {
  add(session: PtyHubSession) {
    byId.set(session.ptyId, session);
  },
  get(ptyId: string): PtyHubSession | null {
    return byId.get(ptyId) ?? null;
  },
  remove(ptyId: string) {
    byId.delete(ptyId);
  },
  listByOwner(ownerConnectionId: string): PtyHubSession[] {
    return [...byId.values()].filter(
      (session) => session.ownerConnectionId === ownerConnectionId,
    );
  },
  listByDaemon(daemonConnectionId: string): PtyHubSession[] {
    return [...byId.values()].filter(
      (session) => session.daemonConnectionId === daemonConnectionId,
    );
  },
  clear() {
    byId.clear();
  },
};
