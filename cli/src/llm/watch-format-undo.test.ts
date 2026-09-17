import { describe, expect, test } from "bun:test";
import { formatWatchLine } from "./watch-format";
import { SHELL_SIDE_EFFECT_WARNING, UNDO_NOOP } from "./undo-constants";

describe("watch undo lines", () => {
  test("noop", () => {
    const line = formatWatchLine({
      type: "chat.checkpoint.undone",
      data: { noop: true, message: UNDO_NOOP },
    });
    expect(line || "").toContain("noop");
    expect(line || "").toContain("no applied changes");
  });
  test("bash warning", () => {
    const line = formatWatchLine({
      type: "chat.checkpoint.undone",
      data: {
        noop: false,
        restored: ["a.ts"],
        commitAction: "none",
        warning: SHELL_SIDE_EFFECT_WARNING,
      },
    });
    expect(line || "").toContain("restored 1");
    expect(line || "").toContain("Unversioned shell");
  });
});
