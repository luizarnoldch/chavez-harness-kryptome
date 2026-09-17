import { describe, expect, test } from "bun:test";
import { isSlashInput } from "../llm/slash";
import { parseAskArgs } from "../llm/slash-flags";

test("flags do not require a TTY", () => {
  const p = parseAskArgs([
    "--mode",
    "auto",
    "--provider",
    "cursor",
    "--model",
    "composer-2.5",
    "chat-1",
    "/compact",
  ]);
  expect(p.mode).toBe("auto");
  expect(p.provider).toBe("cursor");
  expect(p.model).toBe("composer-2.5");
  expect(p.chatId).toBe("chat-1");
  expect(isSlashInput(p.prompt)).toBe(true);
});

test("plain ask is not slash", () => {
  const p = parseAskArgs(["chat-1", "refactor", "auth"]);
  expect(p.prompt).toBe("refactor auth");
  expect(isSlashInput(p.prompt)).toBe(false);
});
