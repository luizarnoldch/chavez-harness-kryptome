import { describe, expect, test } from "bun:test";
import { missingJson } from "./ownership";
import {
  NOT_FOUND_CHAT,
  NOT_FOUND_SESSION,
  NOT_FOUND_WORKSPACE,
  UNAUTHORIZED,
} from "../ws/errors";

describe("ownership errors", () => {
  test("404 bodies never include foreign identifiers", () => {
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

  test("unauthenticated string is Unauthorized", () => {
    expect(UNAUTHORIZED).toBe("Unauthorized");
  });
});
