import { describe, expect, test } from "bun:test";
import { ASK_CI_INVALID } from "./constants";
import { ciAskGate } from "./ask-gate";

describe("ciAskGate", () => {
  test('ci + ask → reject ASK_CI_INVALID', () => {
    expect(ciAskGate({ ci: true, activeExecutionMode: "ask" })).toEqual({
      ok: false,
      error: ASK_CI_INVALID,
    });
    expect(ASK_CI_INVALID).toBe("ask no válido en no-interactivo");
  });

  test("ci + auto → ok", () => {
    expect(ciAskGate({ ci: true, activeExecutionMode: "auto" })).toEqual({
      ok: true,
    });
  });

  test("ci + plan → ok", () => {
    expect(ciAskGate({ ci: true, activeExecutionMode: "plan" })).toEqual({
      ok: true,
    });
  });

  test("ci + null mode → ok", () => {
    expect(ciAskGate({ ci: true, activeExecutionMode: null })).toEqual({
      ok: true,
    });
  });

  test("non-ci + ask → ok", () => {
    expect(ciAskGate({ ci: false, activeExecutionMode: "ask" })).toEqual({
      ok: true,
    });
  });
});
