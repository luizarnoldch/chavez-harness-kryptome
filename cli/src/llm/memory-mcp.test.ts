import { describe, expect, test } from "bun:test";
import type { MemoryApi } from "./memory-api";
import type { MemoryRecord, SaveMemoryInput } from "./memory-format";
import { isMemoryToolName } from "./memory-constants";
import {
  allowedMemoryMcpTools,
  mergeMemoryMcpServer,
  runMemorySave,
  type MemoryMcpContext,
} from "./memory-mcp";

function fakeApi(): MemoryApi & {
  writes: SaveMemoryInput[];
  writeFile?: (path: string, data: string) => void;
  mkdir?: (path: string) => void;
} {
  const store = new Map<string, MemoryRecord>();
  const writes: SaveMemoryInput[] = [];
  return {
    writes,
    writeFile() {
      throw new Error("writeFile must not be called");
    },
    mkdir() {
      throw new Error("mkdir must not be called");
    },
    async list() {
      return [...store.values()];
    },
    async save(input) {
      writes.push(input);
      const now = new Date().toISOString();
      const row: MemoryRecord = {
        id: `mem-${store.size + 1}`,
        scope: input.scope,
        title: input.title ?? input.fact.slice(0, 40),
        fact: input.fact,
        workspaceId: input.workspaceId ?? null,
        createdAt: now,
        updatedAt: now,
      };
      store.set(row.id, row);
      return row;
    },
    async forget(id) {
      store.delete(id);
    },
  };
}

describe("runMemorySave", () => {
  test("defaults to workspace scope with workspaceId", async () => {
    const api = fakeApi();
    const ctx: MemoryMcpContext = { api, workspaceId: "ws-a" };
    const row = await runMemorySave(ctx, {
      fact: "el paquete de tests es bun",
    });
    expect(row.scope).toBe("workspace");
    expect(row.workspaceId).toBe("ws-a");
    expect(api.writes[0]?.workspaceId).toBe("ws-a");
    expect("writeFile" in api).toBe(true);
    expect(() => api.writeFile!("x", "y")).toThrow(/writeFile/);
  });

  test("scope user clears workspaceId", async () => {
    const api = fakeApi();
    const ctx: MemoryMcpContext = { api, workspaceId: "ws-a" };
    const row = await runMemorySave(ctx, {
      fact: "prefiero español",
      scope: "user",
    });
    expect(row.scope).toBe("user");
    expect(row.workspaceId).toBeNull();
    expect(api.writes[0]?.workspaceId).toBeNull();
  });

  test("never calls writeFile or mkdir", async () => {
    const api = fakeApi();
    let writeCalls = 0;
    let mkdirCalls = 0;
    api.writeFile = () => {
      writeCalls++;
      throw new Error("writeFile must not be called");
    };
    api.mkdir = () => {
      mkdirCalls++;
      throw new Error("mkdir must not be called");
    };
    await runMemorySave(
      { api, workspaceId: "ws-a" },
      { fact: "no files" },
    );
    expect(writeCalls).toBe(0);
    expect(mkdirCalls).toBe(0);
  });
});

describe("mergeMemoryMcpServer + tool names", () => {
  test("preserves chavez-git and adds chavez-memory", () => {
    const merged = mergeMemoryMcpServer({ "chavez-git": 1 }, { n: 2 });
    expect(merged["chavez-git"]).toBe(1);
    expect(merged["chavez-memory"]).toEqual({ n: 2 });
  });

  test("isMemoryToolName recognises mcp memory_save", () => {
    expect(isMemoryToolName("mcp__chavez-memory__memory_save")).toBe(true);
  });

  test("allowedMemoryMcpTools includes memory_save", () => {
    expect(allowedMemoryMcpTools()).toContain("memory_save");
  });
});
