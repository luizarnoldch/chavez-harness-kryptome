import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("chat.replay handler never looks up a daemon", () => {
  const src = readFileSync(new URL("./handlers.ts", import.meta.url), "utf8");
  const start = src.indexOf('case "chat.replay"');
  expect(start).toBeGreaterThan(-1);
  const nextCase = src.indexOf("case \"", start + 1);
  const rest = src.slice(start, nextCase > start ? nextCase : start + 800);
  expect(rest).toContain("buildChatReplay");
  expect(rest).not.toContain("findDaemon");
  expect(rest).not.toContain("agent.turn.dispatch");
  expect(rest).not.toContain("NO_DAEMON_ERROR");
});
