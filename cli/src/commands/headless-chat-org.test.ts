import { describe, expect, test } from "bun:test";
import { chatOrgAction, takeFlags } from "./chat-org-args";

describe("takeFlags", () => {
  test("list flags", () => {
    expect(takeFlags(["sid", "--archived"]).flags.archivedOnly).toBe(true);
    expect(takeFlags(["sid", "--include-archived"]).flags.includeArchived).toBe(true);
    expect(takeFlags(["sid"]).flags.archivedOnly).toBeUndefined();
  });

  test("passes through positional args", () => {
    expect(takeFlags(["sid", "--archived"]).rest).toEqual(["sid"]);
    expect(takeFlags(["a", "b", "--include-archived"]).rest).toEqual(["a", "b"]);
  });

  test("json and help flags", () => {
    expect(takeFlags(["x", "--json"]).flags.json).toBe(true);
    expect(takeFlags(["x", "--help"]).flags.help).toBe(true);
  });
});

describe("chatOrgAction", () => {
  test("list with sessionId only", () => {
    expect(chatOrgAction("list", ["sid-1"])).toEqual({
      type: "chat.list",
      sessionId: "sid-1",
    });
  });

  test("list with archivedOnly", () => {
    expect(chatOrgAction("list", ["sid-1", "--archived"])).toEqual({
      type: "chat.list",
      sessionId: "sid-1",
      archivedOnly: true,
    });
  });

  test("list with includeArchived", () => {
    expect(chatOrgAction("list", ["sid-1", "--include-archived"])).toEqual({
      type: "chat.list",
      sessionId: "sid-1",
      includeArchived: true,
    });
  });

  test("search with query", () => {
    expect(chatOrgAction("search", ["fix", "auth", "bug"])).toEqual({
      type: "chat.search",
      query: "fix auth bug",
    });
  });

  test("pin and unpin", () => {
    expect(chatOrgAction("pin", ["chat-1"])).toEqual({
      type: "chat.update",
      chatId: "chat-1",
      pinned: true,
    });
    expect(chatOrgAction("unpin", ["chat-1"])).toEqual({
      type: "chat.update",
      chatId: "chat-1",
      pinned: false,
    });
  });

  test("archive and unarchive", () => {
    expect(chatOrgAction("archive", ["chat-1"])).toEqual({
      type: "chat.update",
      chatId: "chat-1",
      archived: true,
    });
    expect(chatOrgAction("unarchive", ["chat-1"])).toEqual({
      type: "chat.update",
      chatId: "chat-1",
      archived: false,
    });
  });

  test("rename", () => {
    expect(chatOrgAction("rename", ["chat-1", "New", "title"])).toEqual({
      type: "chat.update",
      chatId: "chat-1",
      title: "New title",
    });
  });

  test("move", () => {
    expect(chatOrgAction("move", ["chat-1", "session-2"])).toEqual({
      type: "chat.update",
      chatId: "chat-1",
      sessionId: "session-2",
    });
  });

  test("missing args throw", () => {
    expect(() => chatOrgAction("list", [])).toThrow("sessionId");
    expect(() => chatOrgAction("search", [])).toThrow("query");
    expect(() => chatOrgAction("pin", [])).toThrow("chatId");
    expect(() => chatOrgAction("rename", ["chat-1"])).toThrow("title");
    expect(() => chatOrgAction("move", ["chat-1"])).toThrow("sessionId");
  });
});
