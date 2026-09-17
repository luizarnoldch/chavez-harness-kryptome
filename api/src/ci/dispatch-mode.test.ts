import { describe, expect, test } from "bun:test";
import { resolveCiDispatchMode } from "./dispatch-mode";

describe("resolveCiDispatchMode", () => {
  test("CI usa auto cuando la preferencia falta o es inválida", () => {
    expect(resolveCiDispatchMode(true, null)).toBe("auto");
    expect(resolveCiDispatchMode(true, undefined)).toBe("auto");
    expect(resolveCiDispatchMode(true, "invalid")).toBe("auto");
  });

  test("CI conserva modos válidos, incluido ask para que actúe el gate", () => {
    expect(resolveCiDispatchMode(true, "auto")).toBe("auto");
    expect(resolveCiDispatchMode(true, "plan")).toBe("plan");
    expect(resolveCiDispatchMode(true, "ask")).toBe("ask");
  });

  test("fuera de CI conserva el default ask", () => {
    expect(resolveCiDispatchMode(false, null)).toBe("ask");
  });
});
