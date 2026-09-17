import { describe, expect, test } from "bun:test";
import { ASK_CI_INVALID } from "./constants";

describe("ci constants", () => {
  test('ASK_CI_INVALID === "ask no válido en no-interactivo"', () => {
    expect(ASK_CI_INVALID).toBe("ask no válido en no-interactivo");
  });
});
