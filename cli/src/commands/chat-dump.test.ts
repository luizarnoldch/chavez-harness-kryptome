import { describe, expect, test } from "bun:test";
import { DUMP_USAGE } from "../llm/turn-replay";
import { readFileSync } from "node:fs";

test("dump usage string", () => {
  expect(DUMP_USAGE).toContain("chat dump");
});

test("headless dump does not dispatch a turn", () => {
  const src = readFileSync(new URL("./headless.ts", import.meta.url), "utf8");
  const dumpBlock = src.slice(
    src.indexOf('action === "dump"'),
    src.indexOf('action === "watch"'),
  );
  expect(dumpBlock).toContain("chat.replay");
  expect(dumpBlock).not.toContain("agent.turn.request");
  expect(dumpBlock).not.toContain("agent.turn.dispatch");
  expect(dumpBlock).not.toContain("Bun.spawn");
  expect(dumpBlock).not.toContain("publishAgentTurn");
});

test("daemon does not handle chat.replay", () => {
  const daemon = readFileSync(new URL("../ws/daemon.ts", import.meta.url), "utf8");
  expect(daemon).not.toContain("chat.replay");
});
