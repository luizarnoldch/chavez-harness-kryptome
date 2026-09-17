import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isNeverNotifyType,
  isNotificationSourceType,
  NEVER_NOTIFY_TYPES,
  NO_RUNNER_LABEL,
} from "./notification-events";

test("delta is never a notification source", () => {
  expect(isNeverNotifyType("chat.stream.delta")).toBe(true);
  expect(isNotificationSourceType("chat.stream.delta")).toBe(false);
  expect(NEVER_NOTIFY_TYPES).toContain("chat.stream.delta");
});

test("start end error approval daemon are sources", () => {
  expect(isNotificationSourceType("chat.stream.start")).toBe(true);
  expect(isNotificationSourceType("chat.stream.end")).toBe(true);
  expect(isNotificationSourceType("chat.stream.error")).toBe(true);
  expect(isNotificationSourceType("chat.tool.update")).toBe(true);
  expect(isNotificationSourceType("daemon.presence")).toBe(true);
});

test("no ui.notification type is introduced", () => {
  const protocol = readFileSync(join(import.meta.dir, "protocol.ts"), "utf8");
  const handlers = readFileSync(join(import.meta.dir, "handlers.ts"), "utf8");
  expect(protocol).not.toContain("ui.notification");
  expect(handlers).not.toContain("ui.notification");
  expect(handlers).not.toContain("notify-send");
});

test("auth Resend is not imported from notification-events", () => {
  const src = readFileSync(join(import.meta.dir, "notification-events.ts"), "utf8");
  expect(src).not.toContain("resend");
  expect(src).not.toContain("Resend");
  expect(NO_RUNNER_LABEL).toBe("sin runner");
});
