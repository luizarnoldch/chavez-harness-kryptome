import { describe, expect, test } from "bun:test";
import { queryKeys } from "./query-keys";

describe("queryKeys.chatSearch", () => {
  test("includes workspaceId, sessionId and includeArchived", () => {
    expect(queryKeys.chatSearch("foo")).toEqual([
      "chatSearch",
      "foo",
      "",
      "",
      false,
    ]);
    expect(queryKeys.chatSearch("foo", "ws-1", "sess-1", true)).toEqual([
      "chatSearch",
      "foo",
      "ws-1",
      "sess-1",
      true,
    ]);
    expect(queryKeys.chatSearch("foo", "ws-1", "sess-1", false)).not.toEqual(
      queryKeys.chatSearch("foo", "ws-1", "sess-1", true),
    );
  });
});
