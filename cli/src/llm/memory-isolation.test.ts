import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { MEMORY_MCP_SERVER, MEMORY_PREAMBLE } from "./memory-constants";
import { formatMemoryPrompt, type MemoryRecord } from "./memory-format";
import { historyFromChatMessages } from "./history";
import { runMemorySave, type MemoryMcpContext } from "./memory-mcp";

const bunFact = "el paquete de tests es bun";

function rec(
  id: string,
  scope: "user" | "workspace",
  fact: string,
  ws: string | null,
): MemoryRecord {
  return {
    id,
    scope,
    title: fact.slice(0, 40),
    fact,
    workspaceId: ws,
    createdAt: "2026-09-16T00:00:00.000Z",
    updatedAt: "2026-09-16T00:00:00.000Z",
  };
}

describe("alcance", () => {
  test("workspace memory does not fly to another workspace; user memory does", () => {
    const user = rec("u1", "user", "responde en español", null);
    const wsA = rec("wA", "workspace", bunFact, "ws-A");
    const forA = [user, wsA];
    const forB = [user];
    const a = formatMemoryPrompt(forA)!;
    const b = formatMemoryPrompt(forB)!;
    expect(a).toContain(bunFact);
    expect(a).toContain("responde en español");
    expect(b).toContain("responde en español");
    expect(b).not.toContain(bunFact);
  });
});

describe("no es una regla de archivo", () => {
  test("memory_save talks to MemoryApi only — source never writes AGENTS.md", async () => {
    const saved: MemoryRecord[] = [];
    const ctx: MemoryMcpContext = {
      workspaceId: "ws-A",
      api: {
        list: async () => saved,
        save: async (input) => {
          const row = rec(
            "m1",
            input.scope,
            input.fact,
            input.workspaceId ?? "ws-A",
          );
          saved.push(row);
          return row;
        },
        forget: async () => {},
      },
    };
    await runMemorySave(ctx, { fact: bunFact });
    expect(saved).toHaveLength(1);
    expect(saved[0]!.fact).toBe(bunFact);
    expect(saved[0]!.scope).toBe("workspace");

    const mcpSrc = readFileSync(new URL("./memory-mcp.ts", import.meta.url), "utf8");
    expect(mcpSrc).not.toMatch(/from ["']node:fs["']/);
    expect(mcpSrc).not.toMatch(/writeFileSync|AGENTS\.md|MEMORY\.md|CLAUDE\.md/);

    const prompt = formatMemoryPrompt(saved)!;
    expect(prompt).toContain(MEMORY_PREAMBLE);
    expect(prompt).not.toContain("disallowTools");
  });
});

describe("compact no borra memoria global", () => {
  test("compact_marker in chat history does not remove formatMemoryPrompt facts", () => {
    const mem = [rec("wA", "workspace", bunFact, "ws-A")];
    const history = historyFromChatMessages(
      [
        { role: "user", content: "hola" },
        { role: "assistant", content: "ok" },
        { role: "system", content: "contexto compactado" },
      ],
      "siguiente",
    );
    expect(formatMemoryPrompt(mem)).toContain(bunFact);
    expect(history.some((m) => m.content.includes(bunFact))).toBe(false);
  });

  test("compact source does not import or delete memories", () => {
    if (existsSync(new URL("./compact.ts", import.meta.url))) {
      const src = readFileSync(new URL("./compact.ts", import.meta.url), "utf8");
      expect(src).not.toMatch(/from ["'].*memory/);
      expect(src).not.toMatch(/DELETE\s+FROM\s+memories/i);
      expect(src).not.toContain("memory_forget");
    }
    if (existsSync(new URL("./compact-run.ts", import.meta.url))) {
      const src = readFileSync(
        new URL("./compact-run.ts", import.meta.url),
        "utf8",
      );
      expect(src).not.toContain(MEMORY_MCP_SERVER);
      expect(src).toMatch(/tools:\s*\[\s*\]/);
    }
  });
});

describe("chat nuevo lo ve", () => {
  test("empty chat history still injects memory prompt", () => {
    const history = historyFromChatMessages([], "empieza");
    expect(history).toEqual([]);
    const prompt = formatMemoryPrompt([
      rec("wA", "workspace", bunFact, "ws-A"),
    ]);
    expect(prompt).toContain(bunFact);
  });
});
