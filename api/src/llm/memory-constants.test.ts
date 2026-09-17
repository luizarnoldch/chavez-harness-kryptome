import { describe, expect, test } from "bun:test";
import {
  MEMORY_FACT_ERROR,
  MEMORY_SCOPE_ERROR,
  MEMORY_WORKSPACE_REQUIRED,
  parseSaveMemoryInput,
  titleFromFact,
} from "./memory-constants";

describe("parseSaveMemoryInput", () => {
  test("rejects empty fact", () => {
    expect(() => parseSaveMemoryInput({ fact: "  ", scope: "user" })).toThrow(
      MEMORY_FACT_ERROR,
    );
  });

  test("rejects bad scope", () => {
    expect(() =>
      parseSaveMemoryInput({ fact: "x", scope: "org" }),
    ).toThrow(MEMORY_SCOPE_ERROR);
  });

  test("user scope nulls workspaceId", () => {
    const ok = parseSaveMemoryInput({
      fact: "responde en español",
      scope: "user",
      workspaceId: "ws1",
    });
    expect(ok.scope).toBe("user");
    expect(ok.workspaceId).toBeNull();
  });

  test("workspace without id fails", () => {
    expect(() =>
      parseSaveMemoryInput({ fact: "use bun", scope: "workspace" }),
    ).toThrow(MEMORY_WORKSPACE_REQUIRED);
  });

  test("title default is first line trimmed to 120", () => {
    const long = "a".repeat(200);
    expect(titleFromFact(long).length).toBe(120);
    const ok = parseSaveMemoryInput({
      fact: "el paquete de tests es bun\nsegunda linea",
      workspaceId: "ws1",
    });
    expect(ok.title).toBe("el paquete de tests es bun");
  });
});
