import { describe, expect, test } from "bun:test";
import {
  classifyNotificationEvent,
  isNeverNotifyType,
  shouldShowTuiBadge,
  shouldShowWebChatBanner,
  shouldShowWebToast,
} from "./classify";
import { NEVER_NOTIFY_TYPES, NO_RUNNER_LABEL } from "./constants";

const ctx = { surface: "web" as const, activeChatId: null };

test("delta never notifies", () => {
  expect(isNeverNotifyType("chat.stream.delta")).toBe(true);
  expect(
    classifyNotificationEvent(
      { type: "chat.stream.delta", data: { chatId: "c1", delta: "x" } },
      ctx,
    ).op,
  ).toBe("ignore");
});

test("thinking delta never notifies", () => {
  expect(
    classifyNotificationEvent(
      { type: "chat.thinking.delta", data: { chatId: "c1", delta: "…" } },
      ctx,
    ).op,
  ).toBe("ignore");
});

test("start end error classify", () => {
  expect(
    classifyNotificationEvent(
      { type: "chat.stream.start", data: { chatId: "c1", streamId: "s1" } },
      ctx,
    ).op,
  ).toBe("upsert");
  const end = classifyNotificationEvent(
    { type: "chat.stream.end", data: { chatId: "c1", streamId: "s1" } },
    ctx,
  );
  expect(end.op).toBe("upsert");
  if (end.op === "upsert") expect(end.notification.kind).toBe("turn_done");
  const err = classifyNotificationEvent(
    {
      type: "chat.stream.error",
      data: { chatId: "c1", streamId: "s1", error: "boom" },
    },
    ctx,
  );
  expect(err.op).toBe("upsert");
  if (err.op === "upsert") expect(err.notification.kind).toBe("turn_error");
});

test("awaiting_approval upserts sticky ask", () => {
  const r = classifyNotificationEvent(
    {
      type: "chat.tool.update",
      data: {
        chatId: "c1",
        toolCallId: "t1",
        metadata: { status: "awaiting_approval", toolName: "Write" },
      },
    },
    ctx,
  );
  expect(r.op).toBe("upsert");
  if (r.op === "upsert") {
    expect(r.notification.kind).toBe("approval");
    expect(r.notification.sticky).toBe(true);
  }
});

test("read tool never approval notice", () => {
  const r = classifyNotificationEvent(
    {
      type: "chat.tool.update",
      data: {
        chatId: "c1",
        toolCallId: "t1",
        metadata: { status: "awaiting_approval", sdkName: "Read" },
      },
    },
    ctx,
  );
  expect(r.op).toBe("ignore");
});

test("tool running is not a notice", () => {
  expect(
    classifyNotificationEvent(
      {
        type: "chat.tool.start",
        data: {
          chatId: "c1",
          toolCallId: "t1",
          metadata: { status: "running", toolName: "Write" },
        },
      },
      ctx,
    ).op,
  ).toBe("ignore");
});

test("resolved dismisses ask", () => {
  const r = classifyNotificationEvent(
    {
      type: "chat.tool.resolved",
      data: { chatId: "c1", toolCallId: "t1", outcome: "approve" },
    },
    ctx,
  );
  expect(r).toEqual({ op: "dismiss", id: "approval:c1:t1" });
});

test("daemon down is sin runner; up dismisses", () => {
  const down = classifyNotificationEvent(
    { type: "daemon.presence", data: { bound: false, workspaceId: "w1" } },
    ctx,
  );
  expect(down.op).toBe("upsert");
  if (down.op === "upsert") {
    expect(down.notification.title).toBe(NO_RUNNER_LABEL);
    expect(down.notification.sticky).toBe(true);
  }
  const up = classifyNotificationEvent(
    { type: "daemon.presence", data: { bound: true, workspaceId: "w1" } },
    ctx,
  );
  expect(up.op).toBe("dismissKind");
});

test("message.appended is not a notice", () => {
  expect(
    classifyNotificationEvent(
      { type: "message.appended", data: { chatId: "c1" } },
      ctx,
    ).op,
  ).toBe("ignore");
});

test("TUI badge only when not in that chat (except approval)", () => {
  const done = { kind: "turn_done" as const, chatId: "c1" };
  expect(shouldShowTuiBadge(done, "c1")).toBe(false);
  expect(shouldShowTuiBadge(done, "c2")).toBe(true);
  expect(shouldShowTuiBadge({ kind: "approval", chatId: "c1" }, "c1")).toBe(true);
});

test("Web toast skipped on the open chat; banner shown instead", () => {
  const done = { kind: "turn_done" as const, chatId: "c1", sticky: false };
  expect(shouldShowWebToast(done, "c1")).toBe(false);
  expect(shouldShowWebToast(done, null)).toBe(true);
  expect(shouldShowWebChatBanner(done, "c1")).toBe(true);
});

test("NEVER_NOTIFY_TYPES covers spam sources", () => {
  expect(NEVER_NOTIFY_TYPES).toContain("chat.stream.delta");
});
