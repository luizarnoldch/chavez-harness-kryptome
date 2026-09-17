import { describe, expect, test } from "bun:test";
import {
  MEMORY_FACT_ERROR,
  MEMORY_PREAMBLE,
  MEMORY_SAVE_HINT,
  MEMORY_SCOPE_ERROR,
  MEMORY_WORKSPACE_REQUIRED,
  memoryUsedLabel,
  memoryWatchLine,
} from "./memory-constants";
import {
  formatMemoryPrompt,
  joinSystemPrompts,
  memoryMetadata,
  parseSaveMemoryInput,
  selectMemoriesForPrompt,
  type MemoryRecord,
} from "./memory-format";

function rec(
  partial: Partial<MemoryRecord> & Pick<MemoryRecord, "id" | "scope" | "fact">,
): MemoryRecord {
  return {
    title: partial.title ?? partial.fact.slice(0, 20),
    workspaceId: partial.scope === "workspace" ? partial.workspaceId ?? "ws1" : null,
    createdAt: partial.createdAt ?? "2026-09-16T00:00:00.000Z",
    updatedAt: partial.updatedAt ?? partial.createdAt ?? "2026-09-16T00:00:00.000Z",
    ...partial,
  };
}

describe("parseSaveMemoryInput", () => {
  test("default scope is workspace and requires workspaceId", () => {
    expect(() => parseSaveMemoryInput({ fact: "use bun" })).toThrow(
      MEMORY_WORKSPACE_REQUIRED,
    );
    const ok = parseSaveMemoryInput({
      fact: "el paquete de tests es bun",
      workspaceId: "ws1",
    });
    expect(ok.scope).toBe("workspace");
    expect(ok.workspaceId).toBe("ws1");
    expect(ok.title).toContain("bun");
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

  test("rejects empty fact and bad scope", () => {
    expect(() => parseSaveMemoryInput({ fact: "  ", scope: "user" })).toThrow(
      MEMORY_FACT_ERROR,
    );
    expect(() =>
      parseSaveMemoryInput({ fact: "x", scope: "org" }),
    ).toThrow(MEMORY_SCOPE_ERROR);
  });
});

describe("formatMemoryPrompt", () => {
  test("undefined when empty", () => {
    expect(formatMemoryPrompt([])).toBeUndefined();
    expect(formatMemoryPrompt(undefined)).toBeUndefined();
  });

  test("separates user and workspace and is facts not rules", () => {
    const text = formatMemoryPrompt([
      rec({
        id: "u1",
        scope: "user",
        fact: "responde en español",
        createdAt: "2026-09-16T01:00:00.000Z",
      }),
      rec({
        id: "w1",
        scope: "workspace",
        fact: "el paquete de tests es bun",
        createdAt: "2026-09-16T02:00:00.000Z",
      }),
    ]);
    expect(text).toContain(MEMORY_PREAMBLE);
    expect(text).toContain(MEMORY_SAVE_HINT);
    expect(text).toContain("el paquete de tests es bun");
    expect(text).toContain("responde en español");
    expect(text).not.toContain("disallowTools");
    expect(text).toContain("## User");
    expect(text).toContain("## Workspace");
  });
});

describe("selectMemoriesForPrompt", () => {
  test("keeps newest when over budget", () => {
    const rows = [
      rec({
        id: "old",
        scope: "user",
        fact: "OLD".repeat(100),
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
      rec({
        id: "new",
        scope: "user",
        fact: "NEW fact",
        createdAt: "2026-09-16T00:00:00.000Z",
      }),
    ];
    const kept = selectMemoriesForPrompt(rows, 400);
    expect(kept.some((r) => r.id === "new")).toBe(true);
  });
});

describe("memoryMetadata + labels", () => {
  test("used counts injected rows without bodies", () => {
    const meta = memoryMetadata([
      rec({ id: "w1", scope: "workspace", fact: "use bun", title: "bun" }),
    ]);
    expect(meta.used).toBe(1);
    expect(meta.applied[0]).not.toHaveProperty("fact");
    expect(memoryUsedLabel(1)).toBe("usé 1 recuerdo");
    expect(memoryUsedLabel(3)).toBe("usé 3 recuerdos");
    expect(memoryWatchLine(1)).toBe("memory: usé 1 recuerdo");
    expect(memoryUsedLabel(0)).toBe("0 recuerdos");
  });
});

describe("joinSystemPrompts", () => {
  test("skips empty and joins with separator", () => {
    expect(joinSystemPrompts(undefined, "  ")).toBeUndefined();
    expect(joinSystemPrompts("rules here", "memory here")).toContain("---");
    expect(joinSystemPrompts("rules here", "memory here")).toContain("memory here");
  });
});
