import { describe, expect, test } from "bun:test";
import {
  AUTOTITLE_MAX_CHARS,
  autotitleFromPrompt,
  chatMatchesQuery,
  compareChatsForList,
  DEFAULT_CHAT_TITLE,
  displayChatTitle,
  escapeIlike,
  firstSearchableUserPrompt,
  hasMoreNonArchivedChats,
  ilikePattern,
  isPlaceholderTitle,
  isSearchableMessage,
  messageMatchesQuery,
  normalizeSearchQuery,
  normalizeTitleInput,
  shouldAutotitle,
  TITLE_MAX_CHARS,
  validateChatPatchInput,
  visibleChats,
  windowSlice,
} from "./org";

describe("autotitleFromPrompt", () => {
  test("first non-empty line, collapsed whitespace", () => {
    expect(autotitleFromPrompt("  Fix   auth   bug\nmore")).toBe("Fix auth bug");
  });
  test("empty → default", () => {
    expect(autotitleFromPrompt("  \n  ")).toBe(DEFAULT_CHAT_TITLE);
  });
  test("truncates at word boundary under AUTOTITLE_MAX_CHARS", () => {
    const words = Array.from({ length: 20 }, (_, i) => `word${i}`).join(" ");
    const title = autotitleFromPrompt(words);
    expect(title.endsWith("…")).toBe(true);
    expect(title.length).toBeLessThanOrEqual(AUTOTITLE_MAX_CHARS + 1);
    expect(title.includes("word0")).toBe(true);
  });
});

describe("shouldAutotitle", () => {
  const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  test("default placeholder yes", () => {
    expect(shouldAutotitle({ id, title: "Chat", titleSource: "default" })).toBe(true);
  });
  test("title equals id yes if default", () => {
    expect(shouldAutotitle({ id, title: id, titleSource: "default" })).toBe(true);
  });
  test("user title never", () => {
    expect(shouldAutotitle({ id, title: "Chat", titleSource: "user" })).toBe(false);
  });
  test("already auto never", () => {
    expect(shouldAutotitle({ id, title: "Fix auth", titleSource: "auto" })).toBe(false);
  });
});

describe("isSearchableMessage", () => {
  test("user and assistant yes", () => {
    expect(isSearchableMessage("user", null)).toBe(true);
    expect(isSearchableMessage("assistant", {})).toBe(true);
  });
  test("tool never — includes secret tool outputs (plan 8)", () => {
    expect(isSearchableMessage("tool", { toolName: "Bash", output: "sk-ant-secret" })).toBe(false);
    expect(isSearchableMessage("tool", { secret: true, output: "***" })).toBe(false);
  });
  test("slash_result and secret flags skipped", () => {
    expect(isSearchableMessage("assistant", { kind: "slash_result" })).toBe(false);
    expect(isSearchableMessage("user", { secret: true })).toBe(false);
    expect(isSearchableMessage("assistant", { vault: true })).toBe(false);
  });
});

describe("firstSearchableUserPrompt", () => {
  test("ignores searchable assistant messages", () => {
    expect(
      firstSearchableUserPrompt([
        {
          role: "assistant",
          content: "Do not use this as a title",
          metadata: null,
        },
        {
          role: "user",
          content: "Use this user prompt",
          metadata: null,
        },
      ]),
    ).toBe("Use this user prompt");
  });

  test("skips secret user messages and selects the first searchable prompt", () => {
    expect(
      firstSearchableUserPrompt([
        {
          role: "user",
          content: "vault password",
          metadata: { secret: true },
        },
        {
          role: "user",
          content: "Rename the billing workflow",
          metadata: null,
        },
      ]),
    ).toBe("Rename the billing workflow");
  });

  test("returns null when no user prompt is searchable", () => {
    expect(
      firstSearchableUserPrompt([
        {
          role: "user",
          content: "vault password",
          metadata: { vault: true },
        },
        {
          role: "user",
          content: "slash output",
          metadata: { kind: "slash_result" },
        },
      ]),
    ).toBeNull();
  });
});

describe("messageMatchesQuery", () => {
  test("does not match tool output even if query hits content", () => {
    expect(
      messageMatchesQuery("tool", "API key sk-ant-abc", "sk-ant", {
        output: "sk-ant-abc",
      }),
    ).toBe(false);
  });
  test("matches assistant body", () => {
    expect(messageMatchesQuery("assistant", "Fixed the login form", "login", null)).toBe(true);
  });
});

describe("chatMatchesQuery", () => {
  test("title hit", () => {
    expect(chatMatchesQuery({ title: "Auth rewrite" }, [], "auth")).toBe(true);
  });
  test("tool-only hit does not count", () => {
    expect(
      chatMatchesQuery({ title: "Chat" }, [
        { role: "tool", content: "sk-ant-abc", metadata: { output: "sk-ant-abc" } },
      ], "sk-ant"),
    ).toBe(false);
  });
});

describe("visibleChats", () => {
  const chats = [
    { id: "1", title: "old", updatedAt: "2026-01-01T00:00:00Z", pinnedAt: null, archivedAt: null },
    { id: "2", title: "pinned", updatedAt: "2026-01-02T00:00:00Z", pinnedAt: "2026-01-03T00:00:00Z", archivedAt: null },
    { id: "3", title: "archived", updatedAt: "2026-01-04T00:00:00Z", pinnedAt: null, archivedAt: "2026-01-05T00:00:00Z" },
  ];
  test("pin rises; archived hidden", () => {
    expect(visibleChats(chats).map((c) => c.id)).toEqual(["2", "1"]);
  });
  test("archivedOnly", () => {
    expect(visibleChats(chats, { archivedOnly: true }).map((c) => c.id)).toEqual(["3"]);
  });
  test("includeArchived keeps pin first", () => {
    expect(visibleChats(chats, { includeArchived: true }).map((c) => c.id)).toEqual(["2", "3", "1"]);
  });
});

describe("windowSlice", () => {
  test("100 items window 20", () => {
    const items = Array.from({ length: 100 }, (_, i) => i);
    const page = windowSlice(items, 0, 20);
    expect(page.items).toHaveLength(20);
    expect(page.hasMore).toBe(true);
    expect(page.total).toBe(100);
    expect(windowSlice(items, 80, 20).hasMore).toBe(false);
  });
});

describe("hasMoreNonArchivedChats", () => {
  test("compares the active chats in an archived-inclusive window with active total", () => {
    const window = [
      { archivedAt: new Date("2026-01-01T00:00:00Z") },
      { archivedAt: null },
    ];

    expect(hasMoreNonArchivedChats(window, 2)).toBe(true);
    expect(hasMoreNonArchivedChats(window, 1)).toBe(false);
  });
});

describe("validateChatPatchInput", () => {
  test("accepts fields with their OpenAPI types", () => {
    expect(
      validateChatPatchInput({
        title: "Renamed",
        sessionId: "session-id",
        pinned: true,
        archived: false,
      }),
    ).toEqual({
      ok: true,
      patch: {
        title: "Renamed",
        sessionId: "session-id",
        pinned: true,
        archived: false,
      },
    });
  });

  test.each([
    [{ title: 42 }, "title must be a string"],
    [{ sessionId: false }, "sessionId must be a string"],
    [{ pinned: "true" }, "pinned must be a boolean"],
    [{ archived: 1 }, "archived must be a boolean"],
    [null, "request body must be an object"],
  ])("rejects invalid patch %#", (body, error) => {
    expect(validateChatPatchInput(body)).toEqual({ ok: false, error });
  });
});

describe("normalize", () => {
  test("title and query bounds", () => {
    expect(normalizeTitleInput("  ").ok).toBe(false);
    expect(normalizeTitleInput("x".repeat(TITLE_MAX_CHARS + 1)).ok).toBe(false);
    expect(normalizeSearchQuery("a").ok).toBe(false);
    expect(normalizeSearchQuery("ab").ok).toBe(true);
  });
  test("ilike escape", () => {
    expect(escapeIlike("100%_id")).toBe("100\\%\\_id");
    expect(ilikePattern("ab")).toBe("%ab%");
  });
});

describe("displayChatTitle", () => {
  test("falls back to short id, never empty", () => {
    expect(displayChatTitle({ id: "abcdef12-xxxx", title: "" })).toBe("abcdef12");
    expect(displayChatTitle({ id: "abcdef12-xxxx", title: "Fix auth" })).toBe("Fix auth");
  });
});
