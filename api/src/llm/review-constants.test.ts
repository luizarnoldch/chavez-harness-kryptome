import { describe, expect, test } from "bun:test";
import { REVIEW_KIND } from "./review-constants";

describe("review-constants", () => {
  test("REVIEW_KIND", () => {
    expect(REVIEW_KIND).toBe("code_review");
  });
});
