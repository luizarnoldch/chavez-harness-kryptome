import { describe, expect, test } from "bun:test";
import { parseApproveArgs } from "./approval-args";

describe("parseApproveArgs", () => {
  test("approve requires both ids — one at a time", () => {
    expect(parseApproveArgs("approve", ["c1", "t1"])).toEqual({
      action: "approve",
      chatId: "c1",
      toolCallId: "t1",
    });
    expect(() => parseApproveArgs("approve", ["c1"])).toThrow("toolCallId");
  });
});
