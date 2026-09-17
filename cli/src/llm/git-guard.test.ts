import { describe, expect, test } from "bun:test";
import { COMMIT_ON_PROTECTED, FORCE_PUSH_PROTECTED } from "./git-constants";
import {
  denyCommitOnProtected,
  denyForcePushToProtected,
  sanitizeWorkBranch,
} from "./git-guard";

describe("denyForcePushToProtected", () => {
  test("force + main", () => {
    expect(
      denyForcePushToProtected({ force: true, branch: "main" }),
    ).toBe(FORCE_PUSH_PROTECTED);
  });

  test("non-force is allowed", () => {
    expect(denyForcePushToProtected({ force: false, branch: "main" })).toBeNull();
  });
});

describe("denyCommitOnProtected", () => {
  test("auto on main", () => {
    expect(
      denyCommitOnProtected({
        branch: "main",
        allowProtected: false,
        mode: "auto",
      }),
    ).toBe(COMMIT_ON_PROTECTED);
  });

  test("ask + allowProtected", () => {
    expect(
      denyCommitOnProtected({
        branch: "main",
        allowProtected: true,
        mode: "ask",
      }),
    ).toBeNull();
  });
});

describe("sanitizeWorkBranch", () => {
  test("hello world", () => {
    expect(sanitizeWorkBranch("Hello World")).toBe("chavez/hello-world");
  });
});
