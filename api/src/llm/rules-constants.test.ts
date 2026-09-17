import { describe, expect, test } from "bun:test";
import {
  INVALID_DISALLOW_ERROR,
  USER_RULES_CAP_ERROR,
  USER_RULES_MAX,
  USER_RULE_TITLE_ERROR,
  USER_RULE_TITLE_MAX,
  parseCanonicalToolList,
} from "./rules-constants";

describe("parseCanonicalToolList", () => {
  test("accepts bash", () => {
    expect(parseCanonicalToolList(["bash"])).toEqual(["bash"]);
    expect(parseCanonicalToolList("bash")).toEqual(["bash"]);
  });

  test("rejects laser", () => {
    expect(parseCanonicalToolList(["laser"])).toBeNull();
    expect(parseCanonicalToolList("laser")).toBeNull();
    expect(INVALID_DISALLOW_ERROR).toContain("bash");
  });
});

describe("user rule caps", () => {
  test("cap is 50", () => {
    expect(USER_RULES_MAX).toBe(50);
    expect(USER_RULES_CAP_ERROR).toBe("Maximum 50 user rules");
  });

  test("empty title is invalid", () => {
    const title = "".trim();
    expect(title.length < 1 || title.length > USER_RULE_TITLE_MAX).toBe(true);
    expect(USER_RULE_TITLE_ERROR).toBe("title must be 1–120 characters");
  });
});
