import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("watch does not import OS or in-app notification backends", () => {
  const src = readFileSync(join(import.meta.dir, "headless.ts"), "utf8");
  expect(src).not.toContain("node-notifier");
  expect(src).not.toContain("notify-send");
  expect(src).not.toContain("osascript");
  expect(src).not.toContain("new Notification");
  expect(src).not.toContain("from \"resend\"");
  expect(src).not.toContain("from \"../notifications/store\"");
  expect(src).not.toContain("from \"../notifications/classify\"");
  expect(src).toContain("watching chat=");
  expect(src).toContain("JSON.stringify");
});
