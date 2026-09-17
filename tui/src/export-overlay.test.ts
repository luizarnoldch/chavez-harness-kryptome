import { describe, expect, test } from "bun:test";
import {
  TUI_EXPORT_HINT,
  SHARE_READONLY_BANNER,
} from "../../cli/src/chats/export-share";

test("TUI export hint contains [E]", () => {
  expect(TUI_EXPORT_HINT).toContain("[E]");
});

test("share banner does not mention vault decrypt", () => {
  expect(SHARE_READONLY_BANNER.toLowerCase()).not.toContain("decrypt");
});
