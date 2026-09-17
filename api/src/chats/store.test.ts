import { describe, expect, test } from "bun:test";
import { autotitleFromPrompt, shouldAutotitle } from "./org";
import { archivedClause, SEARCHABLE_ROLES } from "./store";

describe("archivedClause", () => {
  test("archivedOnly does not use the default isNull clause", () => {
    const archivedOnly = archivedClause({ archivedOnly: true });
    const activeOnly = archivedClause({});

    expect(archivedOnly).toBeDefined();
    expect(activeOnly).toBeDefined();
    expect(archivedOnly).not.toEqual(activeOnly);
  });
});

test("autotitle helpers remain usable from the shared store boundary", () => {
  const chat = {
    id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    title: "Chat",
    titleSource: "default",
  };

  expect(shouldAutotitle(chat)).toBe(true);
  expect(autotitleFromPrompt("  Fix   shared persistence  ")).toBe(
    "Fix shared persistence",
  );
});

test("search never includes tool role in SEARCHABLE_ROLES", () => {
  expect([...SEARCHABLE_ROLES]).not.toContain("tool");
});
