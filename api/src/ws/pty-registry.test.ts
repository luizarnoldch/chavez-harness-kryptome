import { beforeEach, describe, expect, test } from "bun:test";
import { ptyRegistry, type PtyHubSession } from "./pty-registry";

const session: PtyHubSession = {
  ptyId: "pty-1",
  ownerConnectionId: "owner-1",
  daemonConnectionId: "daemon-1",
  workspaceId: "workspace-1",
  kind: "user",
  chatId: null,
};

describe("ptyRegistry", () => {
  beforeEach(() => ptyRegistry.clear());

  test("adds and gets a session", () => {
    ptyRegistry.add(session);
    expect(ptyRegistry.get(session.ptyId)).toEqual(session);
  });

  test("lists only sessions owned by a connection", () => {
    ptyRegistry.add(session);
    ptyRegistry.add({
      ...session,
      ptyId: "pty-2",
      ownerConnectionId: "owner-2",
    });
    expect(ptyRegistry.listByOwner("owner-1")).toEqual([session]);
  });

  test("lists only sessions hosted by a daemon", () => {
    ptyRegistry.add(session);
    ptyRegistry.add({
      ...session,
      ptyId: "pty-2",
      daemonConnectionId: "daemon-2",
    });
    expect(ptyRegistry.listByDaemon("daemon-1")).toEqual([session]);
  });

  test("removes a session", () => {
    ptyRegistry.add(session);
    ptyRegistry.remove(session.ptyId);
    expect(ptyRegistry.get(session.ptyId)).toBeNull();
  });
});
