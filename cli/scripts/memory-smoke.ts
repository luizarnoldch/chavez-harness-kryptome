import assert from "node:assert/strict";
import {
  formatMemoryPrompt,
  memoryMetadata,
} from "../src/llm/memory-format";
import { memoryUsedLabel } from "../src/llm/memory-constants";
import { historyFromChatMessages } from "../src/llm/history";
import { runMemorySave, mergeMemoryMcpServer } from "../src/llm/memory-mcp";
import type { MemoryRecord } from "../src/llm/memory-format";
import type { MemoryApi } from "../src/llm/memory-api";

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

function fakeApi(store: MemoryRecord[]): MemoryApi {
  return {
    list: async (workspaceId) =>
      store.filter(
        (m) => m.scope === "user" || m.workspaceId === workspaceId,
      ),
    save: async (input) => {
      const row = rec(
        crypto.randomUUID(),
        input.scope,
        input.fact,
        input.scope === "user" ? null : input.workspaceId ?? "ws-A",
      );
      store.push(row);
      return row;
    },
    forget: async (id) => {
      const i = store.findIndex((m) => m.id === id);
      if (i >= 0) store.splice(i, 1);
    },
  };
}

// 1. Guardar recuerdo + chat nuevo lo ve
{
  const store: MemoryRecord[] = [];
  const api = fakeApi(store);
  await runMemorySave(
    { api, workspaceId: "ws-A" },
    { fact: bunFact, scope: "workspace" },
  );
  assert.equal(store.length, 1);
  const emptyHistory = historyFromChatMessages([], "hola chat nuevo");
  assert.equal(emptyHistory.length, 0);
  const injected = formatMemoryPrompt(await api.list("ws-A"));
  assert.ok(injected && injected.includes(bunFact));
}

// 2. No es una regla de archivo
{
  const store: MemoryRecord[] = [];
  await runMemorySave(
    { api: fakeApi(store), workspaceId: "ws-A" },
    { fact: bunFact },
  );
  assert.equal(store[0]?.fact, bunFact);
  const prompt = formatMemoryPrompt(store)!;
  assert.ok(
    prompt.includes("not project rules") ||
      prompt.includes("not instructions") ||
      prompt.includes("Do not write"),
  );
  assert.ok(!prompt.includes("disallowTools"));
}

// 3. Alcance
{
  const user = rec("u1", "user", "responde en español", null);
  const wsA = rec("wA", "workspace", bunFact, "ws-A");
  const forB = [user];
  const b = formatMemoryPrompt(forB)!;
  assert.ok(b.includes("responde en español"));
  assert.ok(!b.includes(bunFact));
  const a = formatMemoryPrompt([user, wsA])!;
  assert.ok(a.includes(bunFact));
}

// 4. Visible — listar/borrar + usé N
{
  const store = [
    rec("wA", "workspace", bunFact, "ws-A"),
    rec("u1", "user", "responde en español", null),
  ];
  const api = fakeApi(store);
  const listed = await api.list("ws-A");
  assert.equal(listed.length, 2);
  await api.forget("wA");
  assert.equal((await api.list("ws-A")).length, 1);
  const remaining = store.filter((m) => m.id === "u1");
  const meta = memoryMetadata(remaining);
  assert.equal(memoryUsedLabel(meta.used), "usé 1 recuerdo");
}

// 5. Compact no borra memoria global
{
  const mem = [rec("wA", "workspace", bunFact, "ws-A")];
  historyFromChatMessages(
    [
      { role: "user", content: "largo" },
      { role: "system", content: "contexto compactado" },
    ],
    "siguiente",
  );
  assert.ok(formatMemoryPrompt(mem)!.includes(bunFact));
}

assert.ok(
  mergeMemoryMcpServer({ "chavez-git": { n: 1 } }, { n: 2 })["chavez-git"],
);

console.log("memory-smoke ok");
