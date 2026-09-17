import { describe, expect, test } from "bun:test";
import { createPtyOpenPending } from "./pty-open-pending";
import { fail, ok } from "./protocol";

const expected = {
  daemonConnectionId: "daemon-1",
  ownerConnectionId: "owner-1",
  workspaceId: "workspace-1",
};

describe("createPtyOpenPending", () => {
  test("only the expected daemon can complete a request", async () => {
    const pending = createPtyOpenPending(200);
    const result = pending.wait("request-1", "pty.open", expected);
    const reply = ok("pty.open", "request-1", { ptyId: "pty-1" });

    expect(
      pending.completeFromDaemon("request-1", "wrong-daemon", reply),
    ).toBe(false);
    expect(pending.expected("request-1")).toEqual(expected);
    expect(
      pending.completeFromDaemon("request-1", "daemon-1", reply),
    ).toBe(true);
    expect(await result).toEqual(reply);
  });

  test("removes expected daemon metadata when the request expires", async () => {
    const pending = createPtyOpenPending(5);

    await pending.wait("request-2", "pty.open", expected);

    expect(pending.expected("request-2")).toBeNull();
  });

  test("cancels opens by owner and recognizes a late daemon result", async () => {
    const pending = createPtyOpenPending(200);
    const result = pending.wait("request-3", "pty.open", expected);

    expect(
      pending.cancelByOwner("owner-1", (id) =>
        fail("pty.open", id, "PTY open cancelled: owner disconnected"),
      ),
    ).toEqual(["request-3"]);
    expect((await result).ok).toBe(false);
    expect(pending.expected("request-3")).toBeNull();
    expect(
      pending.consumeCanceledFromDaemon("request-3", "wrong-daemon"),
    ).toBeNull();
    expect(
      pending.consumeCanceledFromDaemon("request-3", "daemon-1"),
    ).toEqual(expected);
    expect(
      pending.consumeCanceledFromDaemon("request-3", "daemon-1"),
    ).toBeNull();
  });
});
