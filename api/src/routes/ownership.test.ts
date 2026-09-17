import { describe, expect, test } from "bun:test";
import { missingJson } from "./ownership";
import {
  FORBIDDEN_STATUS,
  NOT_FOUND_CHAT,
  NOT_FOUND_SESSION,
  NOT_FOUND_WORKSPACE,
  OWNERSHIP_STATUS_FOREIGN,
  UNAUTHORIZED,
} from "../lib/no-team";

describe("ownership errors", () => {
  test("foreign resource is 404 with a single error key", () => {
    expect(OWNERSHIP_STATUS_FOREIGN).not.toBe(FORBIDDEN_STATUS);
    for (const entity of ["workspace", "session", "chat"] as const) {
      const body = missingJson(entity);
      expect(Object.keys(body)).toEqual(["error"]);
      expect(JSON.stringify(body)).not.toMatch(/@/);
      expect(JSON.stringify(body)).not.toMatch(/userId/);
    }
    expect(missingJson("workspace").error).toBe(NOT_FOUND_WORKSPACE);
    expect(missingJson("session").error).toBe(NOT_FOUND_SESSION);
    expect(missingJson("chat").error).toBe(NOT_FOUND_CHAT);
  });

  test("unauthenticated string is Unauthorized not Forbidden", () => {
    expect(UNAUTHORIZED).toBe("Unauthorized");
    expect(UNAUTHORIZED).not.toBe("Forbidden");
  });
});
