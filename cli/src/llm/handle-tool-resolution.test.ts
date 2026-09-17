import { describe, expect, test } from "bun:test";
import { handleToolResolutionPush } from "./handle-tool-resolution";
import { waitForApproval, pendingApproval } from "./tool-approval";

describe("handleToolResolutionPush", () => {
  test("does not treat dispatch as an approval", () => {
    expect(
      handleToolResolutionPush({
        type: "agent.turn.dispatch",
        push: true,
        eventId: "e",
        data: { chatId: "c" },
      }),
    ).toBe(false);
  });

  test("approve resolves waiter; missing pending is no-op not auto-approve", async () => {
    const p = waitForApproval("t-h", "c", { timeoutMs: 5_000 });
    expect(
      handleToolResolutionPush({
        type: "agent.tool.approve",
        push: true,
        eventId: "e",
        data: { toolCallId: "t-h" },
      }),
    ).toBe(true);
    expect(await p).toBe("approve");
    expect(
      handleToolResolutionPush({
        type: "agent.tool.approve",
        push: true,
        eventId: "e2",
        data: { toolCallId: "nope" },
      }),
    ).toBe(true);
    expect(pendingApproval("nope")).toBe(false);
  });
});
