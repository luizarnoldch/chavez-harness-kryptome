import { describe, expect, test } from "bun:test";
import {
  cancelApprovalsForChat,
  pendingApproval,
  resolveApproval,
  waitForApproval,
} from "./tool-approval";

describe("waitForApproval", () => {
  test("approve resolves and second resolve is false", async () => {
    const p = waitForApproval("t1", "c1", { timeoutMs: 5_000 });
    expect(pendingApproval("t1")).toBe(true);
    expect(resolveApproval("t1", "approve")).toBe(true);
    expect(await p).toBe("approve");
    expect(resolveApproval("t1", "deny")).toBe(false);
    expect(pendingApproval("t1")).toBe(false);
  });

  test("timeout denies without auto-approve", async () => {
    const p = waitForApproval("t2", "c1", { timeoutMs: 20 });
    expect(await p).toBe("timeout");
    expect(pendingApproval("t2")).toBe(false);
  });

  test("cancelApprovalsForChat unblocks the turn", async () => {
    const p = waitForApproval("t3", "chat-x", { timeoutMs: 5_000 });
    expect(cancelApprovalsForChat("chat-x")).toBe(1);
    expect(await p).toBe("cancelled");
  });

  test("abort signal cancels", async () => {
    const ac = new AbortController();
    const p = waitForApproval("t4", "c1", { timeoutMs: 5_000, signal: ac.signal });
    ac.abort();
    expect(await p).toBe("cancelled");
  });
});
