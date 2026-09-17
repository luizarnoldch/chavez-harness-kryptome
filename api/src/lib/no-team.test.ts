import { describe, expect, test } from "bun:test";
import {
  FORBIDDEN_STATUS,
  FORBIDDEN_TABLE_NAMES,
  OWNERSHIP_STATUS_FOREIGN,
  OWNERSHIP_STATUS_UNAUTH,
  SHARE_NOT_MEMBERSHIP,
  SHARE_READONLY_BANNER,
  UNAUTHORIZED,
  assertNoForbiddenTables,
  hasForbiddenTeamToken,
  missingJson,
  pgTableNames,
} from "./no-team";

describe("no-team constants", () => {
  test("ownership is 401/404 never 403", () => {
    expect(OWNERSHIP_STATUS_UNAUTH).toBe(401);
    expect(OWNERSHIP_STATUS_FOREIGN).toBe(404);
    expect(FORBIDDEN_STATUS).toBe(403);
    expect(UNAUTHORIZED).toBe("Unauthorized");
    expect(missingJson("workspace")).toEqual({ error: "Workspace not found" });
    expect(missingJson("session")).toEqual({ error: "Session not found" });
    expect(missingJson("chat")).toEqual({ error: "Chat not found" });
    expect(missingJson("share")).toEqual({ error: "Share not found" });
    expect(JSON.stringify(missingJson("chat"))).not.toMatch(/userId|@/);
  });

  test("share banner denies membership", () => {
    expect(SHARE_READONLY_BANNER).toContain("solo lectura");
    expect(SHARE_READONLY_BANNER).toContain("No es un workspace compartido");
    expect(SHARE_NOT_MEMBERSHIP).toContain("not membership");
  });

  test("pgTable scanner flags team tables", () => {
    const dirty = `export const member = pgTable("member", { id: text("id") });`;
    expect(assertNoForbiddenTables(dirty)).toEqual(["member"]);
    expect(pgTableNames(`pgTable("workspaces", {})`)).toEqual(["workspaces"]);
    expect(FORBIDDEN_TABLE_NAMES).toContain("organization");
  });

  test("column freeze", () => {
    expect(hasForbiddenTeamToken("activeOrganizationId")).toBe(true);
    expect(hasForbiddenTeamToken("user_id")).toBe(false);
  });
});
