# Execution modes Implementation Plan

> **For agentic workers:** Execute task-by-task. Do not skip tests. Do not implement Cursor cloud, slash `/mode` (plan 11), artefacto de plan (plan 14), cola de turns (plan 29), ni sandbox de red (plan 26). Spec: [`plan.md`](./plan.md). Depende del contrato de tools en [`agent-tools`](../agent-tools/implementation.md): si `chat.tool.update` / `agent.tool.approve` / `canUseTool` aún no existen, esta fase los añade (no los reescribe si ya están).

**Goal:** El usuario elige cómo el agente usa tools destructivas. Los tres modos (`plan`, `auto`, `ask`) existen en CLI, TUI, Web y API, se persisten con el resto de preferencias (`user_preferences`), viajan con cada turn, y aplican igual a Claude (ejecutable hoy) y a Cursor (cuando el [plan 4](../cursor-provider/plan.md) lo haga ejecutable). Lecturas nunca piden confirmación. Write/edit/bash dependen del modo. Auto no relaja el sandbox de path.

**Architecture:** El filesystem real vive en el proceso daemon (`cli/src/ws/daemon.ts` o TUI con `clientKind: "daemon"`). La API **no** ejecuta tools: persiste el modo, lo estampa en el dispatch, hace fan-out de `awaiting_approval` / approve / deny. El gate corre en `canUseTool` **antes** de que el SDK toque el disco.

```
PUT /providers/preferences { activeExecutionMode }
        |
        v
  prefs.updated  --broadcast-->  Web, TUI, CLI watch
        |
Composer (Web | TUI | CLI ask)
        |
        v
  agent.turn.request
        |  API lee prefs → executionMode (nunca un default local del daemon)
        |  dispatch { prompt, executionMode }
        v
  publishAgentTurn
        |  chat.append user  metadata.executionMode
        |  query({ permissionMode: "default", canUseTool: gate(mode) + sandbox })
        |
        |  read/grep/glob          → allow (todos los modos)
        |  write/edit/bash + auto  → allow tras sandbox de path
        |  write/edit/bash + plan  → deny PLAN_MUTATION_DENIED (disco intacto)
        |  write/edit/bash + ask   → chat.tool.update awaiting_approval
        |                            waitForApproval (Web / TUI / CLI | timeout 300s)
        |                            approve → SDK ejecuta → done
        |                            deny/timeout → deny, modelo puede continuar
        v
  API persist + broadcast  →  Web ToolCard | TUI [y]/[n] | CLI watch + approve
```

Estado actual que este plan extiende (no reescribir):

- `api/src/db/schema.ts` `user_preferences` tiene `activeProvider` / `activeModel` / `activeEffort`. **No** hay `activeExecutionMode`.
- `api/src/routes/providers.ts` PUT `/providers/preferences` acepta cualquier string en effort; no valida modo.
- `api/src/ws/handlers.ts` despacha `agent.turn.request` **sin** `executionMode`. `chat.append` ya persiste `metadata`.
- `cli/src/llm/claude-runner.ts` usa `permissionMode: "bypassPermissions"` hoy; el plan 2 lo pasa a `default` + `canUseTool` sandbox. Esta fase **extiende** ese `canUseTool` (sandbox **y** modo). No volver a `bypassPermissions`.
- `cli/src/llm/publish-turn.ts` lee provider/model/effort de GET `/providers`. No lee ni estampa modo.
- TUI cicla provider (`p`), model (`[`/`]`), effort (`{`/`}`). No hay modo. `Message` no muestra metadata de modo.
- Web `ProvidersPanel.tsx` guarda model/effort. `ChatDetailPanel.tsx` ToolCard (plan 2) pinta `awaiting_approval` y botones; si los botones no existen, Task 7 los añade.
- CLI no tiene `chavez mode` ni `chat approve`/`deny`.
- Cursor `runnable: false`. El modo se persiste igual; no simular tools de Cursor.

**Tech Stack:** Bun, Hono + Drizzle `user_preferences`, WebSocket hub, Claude Agent SDK `query` (`canUseTool`, `PermissionResult`, `permissionMode: "default"`, `permissionPrompts: "host"`), Ink TUI, Astro/React web.

**Global Constraints:**

1. El filesystem se lee y escribe **solo** en el daemon (cwd del workspace). API y browser no ejecutan tools ni aprueban “en el servidor”: solo reenvían `agent.tool.approve` / `deny` al daemon, que es quien resuelve el waiter y deja correr el SDK.
2. Sin daemon bound, `agent.turn.request` falla con el string existente: `"No daemon bound for this workspace. Run: chavez headless workspace open"`. No queda un waiter huérfano.
3. Modos válidos **únicamente** `plan` | `auto` | `ask`. Default **`ask`** (el más seguro). Un valor `yolo` / vacío / typo → 400, el modo activo no cambia.
4. El modo del turn es el de **preferencias en el instante del request** (API) o el estado TUI ya persistido. El daemon **no** usa un default local distinto. El mensaje user queda etiquetado `metadata.executionMode`.
5. Lecturas (`Read`, `Grep`, `Glob`, `LS`) **nunca** piden confirmación, en ningún modo.
6. Write / Edit / NotebookEdit / Bash:
   - `ask` → `awaiting_approval` hasta approve/deny/timeout. El archivo **no** cambia hasta approve.
   - `auto` → ejecuta sin prompt. Sigue el sandbox de path (auto ≠ sin límites).
   - `plan` → deny con mensaje; no escribe, no corre shell. El árbol del workspace queda igual.
7. Aprobaciones **una a una**. Sin lote ni “siempre permitir”. Ignorar `suggestions` / `updatedPermissions` del SDK. El primero que resuelve gana; el segundo es no-op (`"No tool awaiting approval"` si el status ya no es `awaiting_approval`).
8. Timeout o desconexión **no** deja el turn busy para siempre: a los `ASK_APPROVAL_TIMEOUT_MS` se deniega con mensaje visible. Headless **no** auto-aprueba en silencio. Web / TUI / `chat watch` pueden aprobar.
9. 1 turn por daemon (lock del plan 2). Cambiar el modo **no** cancela el turn en curso; aplica al **siguiente**.
10. Claude es el provider ejecutable. Cursor vinculado **no** ejecuta turns en esta fase; el modo igual se persiste y se muestra.
11. Web, TUI y CLI `watch` ven el mismo pedido (path + resumen) y el mismo status.
12. No Cursor cloud. No red/sandbox de bash (plan 26: en auto la red se denegará después; aquí no se implementa). No slash `/mode` (plan 11). No artefacto editable de plan (plan 14). No “already resolved” pulido (plan 13) más allá del fail `"No tool awaiting approval"`.

**Constantes (congeladas, no inventar otras):**

| Nombre | Valor |
|---|---|
| `EXECUTION_MODES` | `"plan"` \| `"auto"` \| `"ask"` |
| `DEFAULT_EXECUTION_MODE` | `"ask"` |
| `ASK_APPROVAL_TIMEOUT_MS` | `300_000` |
| `INVALID_MODE_ERROR` | `"executionMode must be plan, auto, or ask"` |
| `NO_APPROVAL_ERROR` | `"No tool awaiting approval"` |
| `PLAN_MUTATION_DENIED` | `"Plan mode: write/edit/bash are disabled. Switch to ask or auto to apply changes."` |
| `ASK_DENIED` | `"User denied this tool"` |
| `ASK_TIMEOUT_DENIED` | `"Approval timed out after 300s — tool denied"` |
| `PLAN_MODE_PREAMBLE` | `"You are in plan mode. You may read, grep, and glob the workspace. Do not write, edit, or run shell that mutates the system. Propose a concrete plan the user can apply after switching to ask or auto."` |
| `MODE_CYCLE` | `["ask", "auto", "plan"]` (TUI tecla `o`) |

Clases de tool (igual que plan 2):

- **read:** `Read`, `Grep`, `Glob`, `LS` → siempre allow (tras sandbox de path).
- **write:** `Write`, `Edit`, `NotebookEdit`, `Bash` → gate de modo.
- **other:** (p.ej. `TodoWrite` si el modelo la emite) → misma regla que write.

No usar `permissionMode: "plan"` ni `"auto"` ni `"bypassPermissions"` del SDK: el `plan` del SDK puede bloquear lecturas; el `auto` del SDK es un clasificador distinto; `bypassPermissions` se salta el sandbox. Chavez posee la semántica en `canUseTool`.

---

## Task 1: Módulos puros — modos, gate, waiter

**Files:**

- Create: `cli/src/llm/execution-mode.ts`
- Create: `cli/src/llm/execution-gate.ts`
- Create: `cli/src/llm/tool-approval.ts`
- Test: `cli/src/llm/execution-mode.test.ts`
- Test: `cli/src/llm/execution-gate.test.ts`
- Test: `cli/src/llm/tool-approval.test.ts`
- Modify: `cli/package.json`

Módulos sin I/O de red. TUI importa desde `cli/src/llm/…`. Web y API **no** importan CLI: Tasks 2 y 7 duplican el enum.

- [ ] Añadir `"test": "bun test"` en `cli/package.json` `scripts` si aún no existe (dejar `start`/`dev`/`bin` intactos):

```json
"scripts": {
  "start": "bun run src/index.ts",
  "dev": "bun run src/index.ts",
  "test": "bun test"
}
```

- [ ] Crear `cli/src/llm/execution-mode.ts`:

```ts
export const EXECUTION_MODES = ["plan", "auto", "ask"] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

export const DEFAULT_EXECUTION_MODE: ExecutionMode = "ask";
export const MODE_CYCLE: ExecutionMode[] = ["ask", "auto", "plan"];

export const INVALID_MODE_ERROR =
  "executionMode must be plan, auto, or ask";

export const PLAN_MUTATION_DENIED =
  "Plan mode: write/edit/bash are disabled. Switch to ask or auto to apply changes.";

export const ASK_DENIED = "User denied this tool";
export const ASK_TIMEOUT_DENIED =
  "Approval timed out after 300s — tool denied";
export const ASK_APPROVAL_TIMEOUT_MS = 300_000;

export const PLAN_MODE_PREAMBLE =
  "You are in plan mode. You may read, grep, and glob the workspace. Do not write, edit, or run shell that mutates the system. Propose a concrete plan the user can apply after switching to ask or auto.";

export function isExecutionMode(v: unknown): v is ExecutionMode {
  return v === "plan" || v === "auto" || v === "ask";
}

/** Null/undefined/"" → default ask. Anything else invalid → throw. */
export function parseExecutionMode(
  v: unknown,
  opts: { defaultOnEmpty?: boolean } = { defaultOnEmpty: true },
): ExecutionMode {
  if (v == null || v === "") {
    if (opts.defaultOnEmpty === false) {
      throw new Error(INVALID_MODE_ERROR);
    }
    return DEFAULT_EXECUTION_MODE;
  }
  if (isExecutionMode(v)) return v;
  throw new Error(INVALID_MODE_ERROR);
}

export function cycleExecutionMode(
  current: ExecutionMode,
  dir: 1 | -1 = 1,
): ExecutionMode {
  const idx = MODE_CYCLE.indexOf(current);
  const i = idx < 0 ? 0 : idx;
  return MODE_CYCLE[(i + dir + MODE_CYCLE.length) % MODE_CYCLE.length];
}

export function sdkPermissionModeFor(
  _mode: ExecutionMode,
): "default" {
  return "default";
}
```

- [ ] Crear `cli/src/llm/execution-gate.ts`:

```ts
import {
  PLAN_MUTATION_DENIED,
  type ExecutionMode,
} from "./execution-mode";

const READ_SDK = new Set(["Read", "Grep", "Glob", "LS"]);
const WRITE_SDK = new Set(["Write", "Edit", "NotebookEdit", "Bash"]);

export type GateClass = "read" | "write" | "other";
export type GateDecision = "allow" | "deny" | "ask";

export function gateClass(sdkName: string): GateClass {
  if (READ_SDK.has(sdkName)) return "read";
  if (WRITE_SDK.has(sdkName)) return "write";
  return "other";
}

/**
 * Path sandbox is applied *before* this (denyIfEscapes). Auto still sandboxes.
 * Reads never ask. `other` follows write (safe default).
 */
export function gateMutation(
  mode: ExecutionMode,
  sdkName: string,
): { decision: GateDecision; message?: string } {
  const cls = gateClass(sdkName);
  if (cls === "read") return { decision: "allow" };
  if (mode === "auto") return { decision: "allow" };
  if (mode === "plan") {
    return { decision: "deny", message: PLAN_MUTATION_DENIED };
  }
  return { decision: "ask" };
}
```

- [ ] Crear `cli/src/llm/tool-approval.ts`:

```ts
import { ASK_APPROVAL_TIMEOUT_MS } from "./execution-mode";

export type ApprovalOutcome = "approve" | "deny" | "timeout" | "cancelled";

type Pending = {
  toolCallId: string;
  chatId: string;
  resolve: (outcome: ApprovalOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
  abortHandler?: () => void;
  signal?: AbortSignal;
};

const pending = new Map<string, Pending>();

export function pendingApproval(toolCallId: string): boolean {
  return pending.has(toolCallId);
}

export function pendingApprovalsForChat(chatId: string): string[] {
  return [...pending.values()]
    .filter((p) => p.chatId === chatId)
    .map((p) => p.toolCallId);
}

/** First resolver wins. Returns false if nothing is waiting. */
export function resolveApproval(
  toolCallId: string,
  outcome: ApprovalOutcome,
): boolean {
  const p = pending.get(toolCallId);
  if (!p) return false;
  pending.delete(toolCallId);
  clearTimeout(p.timer);
  if (p.signal && p.abortHandler) {
    p.signal.removeEventListener("abort", p.abortHandler);
  }
  p.resolve(outcome);
  return true;
}

export function cancelApprovalsForChat(
  chatId: string,
  outcome: ApprovalOutcome = "cancelled",
): number {
  let n = 0;
  for (const id of pendingApprovalsForChat(chatId)) {
    if (resolveApproval(id, outcome)) n += 1;
  }
  return n;
}

export function waitForApproval(
  toolCallId: string,
  chatId: string,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ApprovalOutcome> {
  const timeoutMs = opts.timeoutMs ?? ASK_APPROVAL_TIMEOUT_MS;
  if (pending.has(toolCallId)) {
    resolveApproval(toolCallId, "cancelled");
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolveApproval(toolCallId, "timeout");
    }, timeoutMs);
    const rec: Pending = {
      toolCallId,
      chatId,
      resolve,
      timer,
      signal: opts.signal,
    };
    if (opts.signal) {
      if (opts.signal.aborted) {
        clearTimeout(timer);
        resolve("cancelled");
        return;
      }
      rec.abortHandler = () => resolveApproval(toolCallId, "cancelled");
      opts.signal.addEventListener("abort", rec.abortHandler, { once: true });
    }
    pending.set(toolCallId, rec);
  });
}
```

- [ ] Crear `cli/src/llm/execution-mode.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_EXECUTION_MODE,
  INVALID_MODE_ERROR,
  cycleExecutionMode,
  isExecutionMode,
  parseExecutionMode,
  sdkPermissionModeFor,
} from "./execution-mode";

describe("parseExecutionMode", () => {
  test("accepts the three modes", () => {
    expect(parseExecutionMode("plan")).toBe("plan");
    expect(parseExecutionMode("auto")).toBe("auto");
    expect(parseExecutionMode("ask")).toBe("ask");
  });

  test("null/empty defaults to ask", () => {
    expect(parseExecutionMode(null)).toBe(DEFAULT_EXECUTION_MODE);
    expect(parseExecutionMode(undefined)).toBe("ask");
    expect(parseExecutionMode("")).toBe("ask");
  });

  test("rejects yolo and does not coerce", () => {
    expect(() => parseExecutionMode("yolo")).toThrow(INVALID_MODE_ERROR);
    expect(() => parseExecutionMode("bypass")).toThrow(INVALID_MODE_ERROR);
    expect(() => parseExecutionMode("ASK")).toThrow(INVALID_MODE_ERROR);
    expect(isExecutionMode("yolo")).toBe(false);
  });
});

describe("cycleExecutionMode", () => {
  test("ask → auto → plan → ask", () => {
    expect(cycleExecutionMode("ask")).toBe("auto");
    expect(cycleExecutionMode("auto")).toBe("plan");
    expect(cycleExecutionMode("plan")).toBe("ask");
    expect(cycleExecutionMode("ask", -1)).toBe("plan");
  });
});

describe("sdkPermissionModeFor", () => {
  test("always default so canUseTool + sandbox run", () => {
    expect(sdkPermissionModeFor("plan")).toBe("default");
    expect(sdkPermissionModeFor("auto")).toBe("default");
    expect(sdkPermissionModeFor("ask")).toBe("default");
  });
});
```

- [ ] Crear `cli/src/llm/execution-gate.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { PLAN_MUTATION_DENIED } from "./execution-mode";
import { gateClass, gateMutation } from "./execution-gate";

describe("gateClass", () => {
  test("reads vs writes", () => {
    expect(gateClass("Read")).toBe("read");
    expect(gateClass("Grep")).toBe("read");
    expect(gateClass("Glob")).toBe("read");
    expect(gateClass("LS")).toBe("read");
    expect(gateClass("Write")).toBe("write");
    expect(gateClass("Edit")).toBe("write");
    expect(gateClass("NotebookEdit")).toBe("write");
    expect(gateClass("Bash")).toBe("write");
    expect(gateClass("TodoWrite")).toBe("other");
  });
});

describe("gateMutation", () => {
  test("reads never ask, in any mode", () => {
    for (const mode of ["ask", "auto", "plan"] as const) {
      for (const name of ["Read", "Grep", "Glob", "LS"]) {
        expect(gateMutation(mode, name).decision).toBe("allow");
      }
    }
  });

  test("ask confirms write/edit/bash", () => {
    expect(gateMutation("ask", "Write").decision).toBe("ask");
    expect(gateMutation("ask", "Edit").decision).toBe("ask");
    expect(gateMutation("ask", "Bash").decision).toBe("ask");
  });

  test("auto allows write/edit/bash (sandbox is a different layer)", () => {
    expect(gateMutation("auto", "Write").decision).toBe("allow");
    expect(gateMutation("auto", "Edit").decision).toBe("allow");
    expect(gateMutation("auto", "Bash").decision).toBe("allow");
  });

  test("plan denies mutations with a stable message", () => {
    const d = gateMutation("plan", "Write");
    expect(d.decision).toBe("deny");
    expect(d.message).toBe(PLAN_MUTATION_DENIED);
    expect(gateMutation("plan", "Bash").decision).toBe("deny");
    expect(gateMutation("plan", "Edit").decision).toBe("deny");
  });
});
```

- [ ] Crear `cli/src/llm/tool-approval.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  cancelApprovalsForChat,
  pendingApproval,
  resolveApproval,
  waitForApproval,
} from "./tool-approval";

describe("waitForApproval", () => {
  test("approve resolves and second resolve is false", async () => {
    const p = waitForApproval("t1", "c1", { timeoutMs: 5_000 });
    expect(pendingApproval("t1")).toBe(true);
    expect(resolveApproval("t1", "approve")).toBe(true);
    expect(await p).toBe("approve");
    expect(resolveApproval("t1", "deny")).toBe(false);
    expect(pendingApproval("t1")).toBe(false);
  });

  test("timeout denies without auto-approve", async () => {
    const p = waitForApproval("t2", "c1", { timeoutMs: 20 });
    expect(await p).toBe("timeout");
    expect(pendingApproval("t2")).toBe(false);
  });

  test("cancelApprovalsForChat unblocks the turn", async () => {
    const p = waitForApproval("t3", "chat-x", { timeoutMs: 5_000 });
    expect(cancelApprovalsForChat("chat-x")).toBe(1);
    expect(await p).toBe("cancelled");
  });

  test("abort signal cancels", async () => {
    const ac = new AbortController();
    const p = waitForApproval("t4", "c1", { timeoutMs: 5_000, signal: ac.signal });
    ac.abort();
    expect(await p).toBe("cancelled");
  });
});
```

- [ ] Correr:

```bash
cd cli && bun test src/llm/execution-mode.test.ts src/llm/execution-gate.test.ts src/llm/tool-approval.test.ts
```

Esperado: todos pasan.

- [ ] Commit:

```bash
git add cli/src/llm/execution-mode.ts cli/src/llm/execution-mode.test.ts \
  cli/src/llm/execution-gate.ts cli/src/llm/execution-gate.test.ts \
  cli/src/llm/tool-approval.ts cli/src/llm/tool-approval.test.ts \
  cli/package.json
git commit -m "feat(modes): plan/auto/ask gate and one-at-a-time approval waiter"
```

---

## Task 2: API — preferencia persistida, validación, dispatch estampado

**Files:**

- Create: `api/src/llm/execution-mode.ts`
- Test: `api/src/llm/execution-mode.test.ts`
- Create: `api/drizzle/0001_active_execution_mode.sql`
- Modify: `api/src/db/schema.ts`
- Modify: `api/src/routes/providers.ts`
- Modify: `api/src/ws/handlers.ts`
- Modify: `api/src/ws/protocol.ts`
- Modify: `api/openapi/openapi.yaml`
- Modify: `api/package.json`

La API es la fuente de verdad del modo. GET coalescing: `null` → `"ask"`. PUT inválido no toca la fila.

- [ ] Añadir `"test": "bun test"` en `api/package.json` `scripts` si falta.

- [ ] Crear `api/src/llm/execution-mode.ts` — **misma semántica** que `cli/src/llm/execution-mode.ts` para `EXECUTION_MODES`, `DEFAULT_EXECUTION_MODE`, `INVALID_MODE_ERROR`, `isExecutionMode`, `parseExecutionMode`. Copiar esas exportaciones (no importar `cli/`). No hace falta `cycleExecutionMode` ni el waiter.

- [ ] Crear `api/src/llm/execution-mode.test.ts` con los mismos casos de parse/reject `yolo` que Task 1.

- [ ] En `api/src/db/schema.ts`, ampliar `userPreferences`:

```ts
export const userPreferences = pgTable("user_preferences", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  activeProvider: text("active_provider"),
  activeModel: text("active_model"),
  activeEffort: text("active_effort"),
  activeExecutionMode: text("active_execution_mode"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
```

- [ ] Crear `api/drizzle/0001_active_execution_mode.sql`:

```sql
ALTER TABLE "user_preferences"
  ADD COLUMN IF NOT EXISTS "active_execution_mode" text;
```

- [ ] Aplicar el schema (dev usa push):

```bash
cd api && bun run db:push
```

Si `DATABASE_URL` no está, no inventar otra vía: fallar con el error de drizzle. No editar `docker-compose.yml`.

- [ ] En `api/src/routes/providers.ts`:

  1. Importar `hub` desde `../ws/hub`.
  2. Importar `DEFAULT_EXECUTION_MODE`, `INVALID_MODE_ERROR`, `isExecutionMode`, `parseExecutionMode` desde `../llm/execution-mode`.
  3. Ampliar el patch de `upsertPrefs` con `activeExecutionMode?: string | null`. En el `insert`, `activeExecutionMode: patch.activeExecutionMode ?? DEFAULT_EXECUTION_MODE`. En el `update`, el mismo patrón `!== undefined` que effort.
  4. Helper:

```ts
function publicPrefs(row: {
  activeProvider: string | null;
  activeModel: string | null;
  activeEffort: string | null;
  activeExecutionMode?: string | null;
} | undefined) {
  return {
    activeProvider: row?.activeProvider ?? null,
    activeModel: row?.activeModel ?? null,
    activeEffort: row?.activeEffort ?? null,
    activeExecutionMode: isExecutionMode(row?.activeExecutionMode)
      ? row!.activeExecutionMode
      : DEFAULT_EXECUTION_MODE,
  };
}
```

  5. GET `/` (lista providers): incluir `activeExecutionMode` vía `publicPrefs(prefs[0])` (hoy devuelve los tres campos sueltos; añadir el cuarto **sin** quitar catalogs/providers).
  6. PUT `/preferences`:

```ts
const body = await c.req.json<{
  activeProvider?: string | null;
  activeModel?: string | null;
  activeEffort?: string | null;
  activeExecutionMode?: string | null;
}>();

if (
  body.activeProvider !== undefined &&
  body.activeProvider !== null &&
  !isProvider(body.activeProvider)
) {
  return c.json({ error: "provider must be claude or cursor" }, 400);
}

if (body.activeExecutionMode !== undefined) {
  if (!isExecutionMode(body.activeExecutionMode)) {
    return c.json({ error: INVALID_MODE_ERROR }, 400);
  }
}

await upsertPrefs(session.user.id, body);
const prefs = await db
  .select()
  .from(userPreferences)
  .where(eq(userPreferences.userId, session.user.id))
  .limit(1);
const payload = publicPrefs(prefs[0]);
hub.broadcastToUser(
  session.user.id,
  hub.pushEvent("prefs.updated", payload),
);
return c.json(payload);
```

  **Orden:** validar → (si inválido, return 400 **antes** de `upsertPrefs`) → upsert → broadcast → 200. Un `yolo` no cambia la fila.

- [ ] En `api/src/ws/handlers.ts`, `agent.turn.request`, **después** de resolver `workspace` y **antes** de `sendTo`, leer prefs y estampar el modo:

```ts
import { userPreferences } from "../db/schema";
import {
  DEFAULT_EXECUTION_MODE,
  isExecutionMode,
} from "../llm/execution-mode";

const prefRows = await db
  .select()
  .from(userPreferences)
  .where(eq(userPreferences.userId, userId))
  .limit(1);
const executionMode = isExecutionMode(prefRows[0]?.activeExecutionMode)
  ? prefRows[0]!.activeExecutionMode
  : DEFAULT_EXECUTION_MODE;

const sent = hub.sendTo(
  daemon.connectionId,
  hub.pushEvent("agent.turn.dispatch", {
    chatId: msg.chatId,
    prompt: msg.prompt.trim(),
    requestId: id,
    workspaceId: ctx.workspaceId,
    path: workspace?.path || daemon.path,
    sessionId: ctx.session.id,
    requesterConnectionId: connectionId,
    executionMode,
  }),
);
```

No aceptar `executionMode` del cliente en `agent.turn.request`: la preferencia persistida es la fuente. El CLI `--mode` hace PUT prefs **antes** de disparar (Task 5).

- [ ] Si **no** existen aún (plan 2 no mergeado), añadir en el mismo `switch` los cases `chat.tool.update`, `agent.tool.approve`, `agent.tool.deny` **exactamente** como en agent-tools Task 2. Extra, en approve/deny, **antes** de `sendTo`:

```ts
const existing = await db
  .select()
  .from(chatMessages)
  .where(eq(chatMessages.chatId, msg.chatId))
  .orderBy(desc(chatMessages.createdAt));
const toolRow = existing.find((m) => {
  const meta = (m.metadata || {}) as Record<string, unknown>;
  return m.role === "tool" && meta.toolCallId === msg.toolCallId;
});
if (!toolRow) return fail(type, id, "Tool call not found");
const st = String(
  ((toolRow.metadata || {}) as Record<string, unknown>).status || "",
);
if (st !== "awaiting_approval") {
  return fail(type, id, "No tool awaiting approval");
}
```

Si plan 2 ya tiene los cases, **solo** insertar esta guarda de status. No reescribir persistencia de tools.

- [ ] En `api/src/ws/protocol.ts`, `ClientMessage` ya tiene `toolCallId` / `status` / `metadata`. No hace falta un campo top-level `executionMode`: viaja en `metadata` del append y en el payload de push. Dejar el tipo.

- [ ] En `api/openapi/openapi.yaml`:

  - Schemas `ProvidersListResponse`, `ProviderPreferencesBody`, `ProviderPreferences`: añadir

```yaml
        activeExecutionMode:
          type: string
          nullable: true
          enum: [plan, auto, ask]
```

  - Description de `/ws`: añadir `prefs.updated` (push), y si faltan: `chat.tool.update`, `agent.tool.approve`, `agent.tool.deny`. Mencionar que `agent.turn.dispatch` incluye `executionMode`.
  - Response 400 de PUT `/providers/preferences`: el body `error` es `executionMode must be plan, auto, or ask` cuando el modo es inválido.

- [ ] Correr:

```bash
cd api && bun test src/llm/execution-mode.test.ts
```

Esperado: todos pasan.

- [ ] Commit:

```bash
git add api/src/llm/execution-mode.ts api/src/llm/execution-mode.test.ts \
  api/src/db/schema.ts api/drizzle/0001_active_execution_mode.sql \
  api/src/routes/providers.ts api/src/ws/handlers.ts \
  api/openapi/openapi.yaml api/package.json
git commit -m "feat(modes): persist plan/auto/ask and stamp it on turn dispatch"
```

---

## Task 3: Runner — el modo viaja con el turn y el gate corre en `canUseTool`

**Files:**

- Modify: `cli/src/llm/claude-runner.ts`
- Modify: `cli/src/llm/publish-turn.ts`
- Test: `cli/src/llm/claude-runner.mode.test.ts` (solo el wiring del gate; no llama al SDK)

El SDK **no** ejecuta write/edit/bash hasta que `canUseTool` resuelve `allow`. En `ask`, eso es después de approve. En `plan`, nunca. En `auto`, tras el sandbox.

- [ ] En `cli/src/llm/claude-runner.ts`:

  1. Importar `PLAN_MODE_PREAMBLE`, `PLAN_MUTATION_DENIED`, `ASK_DENIED`, `ASK_TIMEOUT_DENIED`, `sdkPermissionModeFor`, type `ExecutionMode` desde `./execution-mode`.
  2. Importar `gateMutation` desde `./execution-gate`.
  3. Importar `denyIfEscapes` desde `./tool-sandbox` si el archivo existe (plan 2). Si **no** existe, copiar `denyIfEscapes` + `extractToolPath` de agent-tools Task 1 a `cli/src/llm/tool-sandbox.ts` (no dejar el path sandbox fuera: auto no significa sin límites).
  4. Ampliar `RunClaudeTurnInput`:

```ts
import type { ExecutionMode } from "./execution-mode";

export type AskPermission = (req: {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  signal: AbortSignal;
}) => Promise<"approve" | "deny" | "timeout" | "cancelled">;

export type RunClaudeTurnInput = {
  prompt: string;
  history?: HistoryMessage[];
  model: string;
  effort: EffortLevel;
  auth: ClaudeAuth;
  cwd: string;
  executionMode: ExecutionMode;
  onAskPermission?: AskPermission;
  onEvent?: (event: AgentTurnEvent) => void | Promise<void>;
};
```

  5. Options de `query` (reemplazar `bypassPermissions` si aún está; no volver a él):

```ts
import { DEFAULT_CLAUDE_TOOLS } from "./tool-names";
// Si tool-names.ts no existe, inlinar:
// const DEFAULT_CLAUDE_TOOLS = ["Read","Write","Edit","Grep","Glob","Bash"] as const;

const options: Record<string, unknown> = {
  model: input.model,
  cwd: input.cwd,
  env: cleanEnv,
  settingSources: [],
  tools: [...DEFAULT_CLAUDE_TOOLS],
  allowedTools: [...DEFAULT_CLAUDE_TOOLS],
  permissionMode: sdkPermissionModeFor(input.executionMode),
  permissionPrompts: "host",
  canUseTool: async (
    toolName: string,
    toolInput: Record<string, unknown>,
    toolOpts: { signal: AbortSignal; toolUseID?: string },
  ) => {
    const denied = denyIfEscapes(input.cwd, toolName, toolInput);
    if (denied) return denied;

    const g = gateMutation(input.executionMode, toolName);
    if (g.decision === "allow") return { behavior: "allow" as const };
    if (g.decision === "deny") {
      return {
        behavior: "deny" as const,
        message: g.message || PLAN_MUTATION_DENIED,
      };
    }

    const toolCallId = String(toolOpts.toolUseID || crypto.randomUUID());
    if (!input.onAskPermission) {
      return { behavior: "deny" as const, message: ASK_DENIED };
    }
    const outcome = await input.onAskPermission({
      toolCallId,
      toolName,
      input: toolInput,
      signal: toolOpts.signal,
    });
    if (outcome === "approve") return { behavior: "allow" as const };
    const message =
      outcome === "timeout"
        ? ASK_TIMEOUT_DENIED
        : outcome === "cancelled"
          ? ASK_DENIED
          : ASK_DENIED;
    return { behavior: "deny" as const, message };
  },
};
```

  6. Si `input.executionMode === "plan"`, el prompt que se pasa a `query` es:

```ts
const userPrompt =
  input.executionMode === "plan"
    ? `${PLAN_MODE_PREAMBLE}\n\n${input.prompt}`
    : input.prompt;
const prompt = promptWithHistory(userPrompt, input.history ?? []);
```

  `historyFromChatMessages` **no** se toca: un plan previo sigue en el chat; al pasar a `auto` y decir “aplica el plan”, el historial assistant sigue ahí.

- [ ] En `cli/src/llm/publish-turn.ts`:

  1. Ampliar `ProvidersResponse` con `activeExecutionMode: string | null`.
  2. Ampliar el input:

```ts
export async function publishAgentTurn(input: {
  client: ChavezWsClient;
  chatId: string;
  prompt: string;
  cwd: string;
  token?: string;
  skipUserAppend?: boolean;
  executionMode?: ExecutionMode;
}): Promise<string> {
```

  3. Tras GET `/providers`, resolver el modo **una vez** y usarlo en append + runner:

```ts
import {
  parseExecutionMode,
  type ExecutionMode,
} from "./execution-mode";
import { waitForApproval, cancelApprovalsForChat } from "./tool-approval";
import { canonicalToolName } from "./tool-names";
import { sanitizeToolInput, summarizeToolInput } from "./tool-display";
```

Si `tool-names` / `tool-display` no existen, usar `toolName.toLowerCase()` y `JSON.stringify(input).slice(0, 200)` como summary temporal **solo** en ese fallback; no dejar `awaiting_approval` sin path/resumen.

```ts
const executionMode = parseExecutionMode(
  input.executionMode ?? providers.activeExecutionMode,
);
```

  4. `chat.append` del user (cuando `!skipUserAppend`) incluye metadata:

```ts
await client.request({
  type: "chat.append",
  chatId,
  role: "user",
  content: prompt,
  metadata: { executionMode },
});
```

  5. `runClaudeTurn({ …, executionMode, onAskPermission })`.

  6. `onAskPermission`:

```ts
onAskPermission: async ({ toolCallId, toolName, input: toolInput, signal }) => {
  await client.request({
    type: "chat.tool.update",
    chatId,
    streamId,
    toolCallId,
    toolName: canonicalToolName(toolName),
    status: "awaiting_approval",
    metadata: {
      sdkName: toolName,
      input: sanitizeToolInput(toolInput),
      summary: summarizeToolInput(toolName, toolInput),
      executionMode,
    },
  });
  return waitForApproval(toolCallId, chatId, {
    timeoutMs: ASK_APPROVAL_TIMEOUT_MS,
    signal,
  });
},
```

Si `chat.tool.update` falla porque el start aún no persistió, reintentar una vez con `chat.tool.start` + `status: "awaiting_approval"` (mismos metadata). No auto-aprobar en ese fallback.

  7. En el `finally` de `publishAgentTurn` (junto a `agent.turn.ended` del plan 2):

```ts
cancelApprovalsForChat(chatId);
```

Así un stream error / disconnect no deja `canUseTool` colgado. Importar `ASK_APPROVAL_TIMEOUT_MS` desde `./execution-mode`.

  8. Si se emite `agent.turn.started` (plan 2), añadir `executionMode` al payload. Si ese tipo no existe aún, no inventarlo aquí.

- [ ] Crear `cli/src/llm/claude-runner.mode.test.ts` — **no** mockea `query`. Testea el helper extraído si hace falta. Extraer `buildCanUseTool` a `cli/src/llm/can-use-tool.ts` para poder testearlo sin SDK:

```ts
import type { ExecutionMode } from "./execution-mode";
import { denyIfEscapes } from "./tool-sandbox";
import { gateMutation } from "./execution-gate";
import {
  ASK_DENIED,
  ASK_TIMEOUT_DENIED,
  PLAN_MUTATION_DENIED,
} from "./execution-mode";

export type PermissionDecision =
  | { behavior: "allow" }
  | { behavior: "deny"; message: string };

export async function decideCanUseTool(input: {
  cwd: string;
  executionMode: ExecutionMode;
  toolName: string;
  toolInput: Record<string, unknown>;
  ask?: () => Promise<"approve" | "deny" | "timeout" | "cancelled">;
}): Promise<PermissionDecision> {
  const denied = denyIfEscapes(input.cwd, input.toolName, input.toolInput);
  if (denied) return denied;
  const g = gateMutation(input.executionMode, input.toolName);
  if (g.decision === "allow") return { behavior: "allow" };
  if (g.decision === "deny") {
    return { behavior: "deny", message: g.message || PLAN_MUTATION_DENIED };
  }
  const outcome = (await input.ask?.()) ?? "deny";
  if (outcome === "approve") return { behavior: "allow" };
  return {
    behavior: "deny",
    message: outcome === "timeout" ? ASK_TIMEOUT_DENIED : ASK_DENIED,
  };
}
```

El `canUseTool` de `claude-runner.ts` **delega** en `decideCanUseTool` (cwd + mode + ask callback). Tests:

```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { decideCanUseTool } from "./can-use-tool";
import { PLAN_MUTATION_DENIED } from "./execution-mode";

const cwd = mkdtempSync(join(tmpdir(), "chavez-mode-"));
writeFileSync(join(cwd, "in.txt"), "ok");

describe("decideCanUseTool", () => {
  test("ask + Read does not call ask()", async () => {
    let called = false;
    const r = await decideCanUseTool({
      cwd,
      executionMode: "ask",
      toolName: "Read",
      toolInput: { file_path: join(cwd, "in.txt") },
      ask: async () => {
        called = true;
        return "deny";
      },
    });
    expect(r.behavior).toBe("allow");
    expect(called).toBe(false);
  });

  test("ask + Write waits; deny does not imply allow", async () => {
    const r = await decideCanUseTool({
      cwd,
      executionMode: "ask",
      toolName: "Write",
      toolInput: { file_path: join(cwd, "out.txt"), content: "x" },
      ask: async () => "deny",
    });
    expect(r).toEqual({ behavior: "deny", message: "User denied this tool" });
  });

  test("auto + Write inside cwd allows", async () => {
    const r = await decideCanUseTool({
      cwd,
      executionMode: "auto",
      toolName: "Write",
      toolInput: { file_path: join(cwd, "out.txt"), content: "x" },
    });
    expect(r.behavior).toBe("allow");
  });

  test("auto + Write outside cwd still sandboxes", async () => {
    const r = await decideCanUseTool({
      cwd,
      executionMode: "auto",
      toolName: "Write",
      toolInput: { file_path: "/etc/passwd", content: "nope" },
    });
    expect(r.behavior).toBe("deny");
    if (r.behavior === "deny") {
      expect(r.message.startsWith("Path outside workspace:")).toBe(true);
    }
  });

  test("plan + Write denies without ask", async () => {
    let called = false;
    const r = await decideCanUseTool({
      cwd,
      executionMode: "plan",
      toolName: "Write",
      toolInput: { file_path: join(cwd, "out.txt"), content: "x" },
      ask: async () => {
        called = true;
        return "approve";
      },
    });
    expect(r).toEqual({ behavior: "deny", message: PLAN_MUTATION_DENIED });
    expect(called).toBe(false);
  });
});
```

Si `denyIfEscapes` no está exportado aún, Task 3 lo crea (ver arriba). El test de `/etc/passwd` es el escenario Gherkin “Path fuera del workspace se rechaza también en auto”.

- [ ] `claude-runner.ts` usa `decideCanUseTool` dentro de `canUseTool`. No duplicar la lógica.

- [ ] Correr:

```bash
cd cli && bun test src/llm/execution-gate.test.ts src/llm/can-use-tool.ts src/llm/claude-runner.mode.test.ts
```

Esperado: todos pasan. (El glob del test es `cli/src/llm/claude-runner.mode.test.ts`; si el archivo de `can-use-tool` tests vive ahí, un solo archivo basta.)

- [ ] Commit:

```bash
git add cli/src/llm/claude-runner.ts cli/src/llm/publish-turn.ts \
  cli/src/llm/can-use-tool.ts cli/src/llm/claude-runner.mode.test.ts \
  cli/src/llm/tool-sandbox.ts
git commit -m "feat(modes): honor plan/auto/ask in canUseTool before disk writes"
```

No incluir `tool-sandbox.ts` en el commit si ya venía de agent-tools sin cambios.

---

## Task 4: Daemon y TUI — resolver approve/deny, no auto-aprobar

**Files:**

- Modify: `cli/src/ws/daemon.ts`
- Modify: `tui/src/App.tsx`

El waiter vive en el proceso daemon. API solo reenvía. Headless sin TTY espera; no llama `resolveApproval(..., "approve")` solo.

- [ ] Extraer un helper compartido (daemon y TUI lo usan igual) en `cli/src/llm/handle-tool-resolution.ts`:

```ts
import type { WsPushMessage } from "../ws/client";
import { resolveApproval } from "./tool-approval";

export function handleToolResolutionPush(msg: WsPushMessage): boolean {
  if (msg.type !== "agent.tool.approve" && msg.type !== "agent.tool.deny") {
    return false;
  }
  const data = (msg.data || {}) as { toolCallId?: string };
  if (!data.toolCallId) return true;
  const outcome = msg.type === "agent.tool.approve" ? "approve" : "deny";
  resolveApproval(data.toolCallId, outcome);
  return true;
}
```

Si no hay pending, `resolveApproval` devuelve false: no-op, **no** se aprueba nada. Log en daemon: `"No tool awaiting approval"`.

- [ ] En `cli/src/ws/daemon.ts`, el `onPush` actual solo atiende `agent.turn.dispatch`. Cambiar a:

```ts
import { handleToolResolutionPush } from "../llm/handle-tool-resolution";
import { parseExecutionMode } from "../llm/execution-mode";

client.onPush(async (msg: WsPushMessage) => {
  if (handleToolResolutionPush(msg)) {
    const data = (msg.data || {}) as { toolCallId?: string };
    log(`${msg.type} toolCallId=${data.toolCallId ?? "?"}`);
    return;
  }
  if (msg.type !== "agent.turn.dispatch") return;
  const data = (msg.data || {}) as {
    chatId?: string;
    prompt?: string;
    path?: string;
    executionMode?: string;
  };
  // … busy guard existente …
  await publishAgentTurn({
    client,
    chatId: data.chatId,
    prompt: data.prompt,
    cwd: data.path || path,
    token: config.accessToken!,
    executionMode: parseExecutionMode(data.executionMode),
  });
});
```

Pasar `executionMode` del dispatch, **no** releer un default local. `parseExecutionMode(undefined)` → `ask` solo si el API no estampó (no debería pasar tras Task 2).

Quitar el log del plan 2 `"execution-modes plan not active"` si está.

- [ ] En `tui/src/App.tsx`, el efecto `onPush`:

  1. Importar `handleToolResolutionPush` y `parseExecutionMode`.
  2. **Antes** del branch `agent.turn.dispatch`:

```ts
if (handleToolResolutionPush(msg)) return;
```

  3. En `publishAgentTurn` del dispatch Web:

```ts
executionMode: parseExecutionMode(
  (data as { executionMode?: string }).executionMode,
),
```

  4. En `sendWithLlm` (turn local), pasar `executionMode` del state TUI (Task 6 lo añade). En esta task, si el state aún no existe, pasar `parseExecutionMode(providersInfo?.activeExecutionMode)`.

- [ ] Commit:

```bash
git add cli/src/llm/handle-tool-resolution.ts cli/src/ws/daemon.ts tui/src/App.tsx
git commit -m "feat(modes): daemon and TUI resolve ask approvals over the hub"
```

---

## Task 5: CLI — `mode`, flag en ask, approve/deny, watch visible

**Files:**

- Create: `cli/src/commands/mode.ts`
- Modify: `cli/src/index.ts`
- Modify: `cli/src/commands/headless.ts`
- Modify: `cli/src/commands/provider.ts`
- Modify: `cli/src/llm/watch-format.ts` (si existe; si no, crear el caso `awaiting_approval` en el `onPush` de watch)
- Test: `cli/src/llm/watch-format.test.ts` (añadir caso; crear archivo si plan 2 no lo hizo)

- [ ] Crear `cli/src/commands/mode.ts`:

```ts
import { apiFetch } from "../api-client";
import { loadConfig } from "../config";
import {
  INVALID_MODE_ERROR,
  parseExecutionMode,
  type ExecutionMode,
} from "../llm/execution-mode";

function requireAuth(): void {
  if (!loadConfig().accessToken) {
    throw new Error("No hay sesión. Ejecuta: chavez login");
  }
}

type Prefs = {
  activeExecutionMode?: string | null;
  activeProvider?: string | null;
};

export async function modeCommand(args: string[]): Promise<void> {
  requireAuth();
  const raw = args[0];
  if (!raw) {
    const data = await apiFetch<Prefs>("/providers");
    const mode = parseExecutionMode(data.activeExecutionMode);
    console.log(`Mode: ${mode}`);
    return;
  }
  if (raw === "-h" || raw === "--help") {
    console.log("Uso: chavez mode [plan|auto|ask]");
    return;
  }
  let mode: ExecutionMode;
  try {
    mode = parseExecutionMode(raw, { defaultOnEmpty: false });
  } catch {
    throw new Error(INVALID_MODE_ERROR);
  }
  const data = await apiFetch<Prefs>("/providers/preferences", {
    method: "PUT",
    body: JSON.stringify({ activeExecutionMode: mode }),
  });
  console.log(`Mode: ${parseExecutionMode(data.activeExecutionMode)}`);
}
```

- [ ] En `cli/src/index.ts`, registrar `case "mode": await modeCommand(rest);` e importar. Ampliar `usage()`:

```
  chavez mode [plan|auto|ask]
  chavez headless chat ask [--mode plan|auto|ask] <chatId> <prompt…>
  chavez headless chat approve <chatId> <toolCallId>
  chavez headless chat deny <chatId> <toolCallId>
```

- [ ] En `cli/src/commands/provider.ts`, el `list`/`status` imprime también el modo. Ampliar `ProvidersResponse` con `activeExecutionMode` y, tras `Active:`:

```ts
console.log(`Mode: ${data.activeExecutionMode ?? "ask"}`);
```

- [ ] En `cli/src/commands/headless.ts`:

  1. Parse de `chat ask`:

```ts
if (action === "ask") {
  let modeArg: string | undefined;
  const filtered: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--mode") {
      modeArg = rest[++i];
      continue;
    }
    filtered.push(rest[i]!);
  }
  const chatId = filtered[0];
  const prompt = filtered.slice(1).join(" ");
  if (!chatId || !prompt) {
    throw new Error(
      "Uso: … chat ask [--mode plan|auto|ask] <chatId> <prompt…>",
    );
  }
  if (modeArg) {
    const mode = parseExecutionMode(modeArg, { defaultOnEmpty: false });
    await apiFetch("/providers/preferences", {
      method: "PUT",
      body: JSON.stringify({ activeExecutionMode: mode }),
    });
  }
  const res = await client.request(
    { type: "agent.turn.request", chatId, prompt },
    30_000,
  );
  // resto igual: JSON del accepted + aviso de watch
}
```

  El PUT ocurre **antes** del request para que Web refleje el modo y el API estampe el mismo valor.

  2. Nuevas acciones `approve` / `deny`:

```ts
if (action === "approve" || action === "deny") {
  const chatId = rest[0];
  const toolCallId = rest[1];
  if (!chatId || !toolCallId) {
    throw new Error(`Uso: … chat ${action} <chatId> <toolCallId>`);
  }
  const res = await client.request({
    type: action === "approve" ? "agent.tool.approve" : "agent.tool.deny",
    chatId,
    toolCallId,
  });
  if (!res.ok) throw new Error(res.error);
  console.log(JSON.stringify(res.data, null, 2));
  return;
}
```

  Actualizar el `throw` de uso de `chat` para incluir `approve|deny`.

  3. `watch` **no** auto-aprueba. Si `formatWatchLine` existe (plan 2), añadir caso; si el watch aún vuelca JSON, además de eso, cuando `status === "awaiting_approval"` imprimir una línea extra:

```
approval needed — chavez headless chat approve <chatId> <toolCallId>
```

- [ ] En `cli/src/llm/watch-format.ts` (crear el archivo mínimo si no existe), `formatWatchLine` para `chat.tool.update` / `start` con `awaiting_approval`:

```ts
if (t.status === "awaiting_approval") {
  const chatId = String(data.chatId ?? rec(data.message)?.chatId ?? "");
  const id = String(
    (rec(data.message)?.metadata as Record<string, unknown> | undefined)
      ?.toolCallId ?? "",
  );
  const head = toolHeadline(t.name, "awaiting_approval", t.input);
  const hint =
    chatId && id
      ? `\napproval needed — chavez headless chat approve ${chatId} ${id}`
      : "\napproval needed — Web, TUI or: chavez headless chat approve <chatId> <toolCallId>";
  return `${head}${hint}`;
}
```

Test: el string contiene `awaiting_approval` y `approval needed`, y **no** contiene `auto-approved`.

- [ ] Correr:

```bash
cd cli && bun test src/llm/watch-format.test.ts src/llm/execution-mode.test.ts
```

- [ ] Commit:

```bash
git add cli/src/commands/mode.ts cli/src/index.ts \
  cli/src/commands/headless.ts cli/src/commands/provider.ts \
  cli/src/llm/watch-format.ts cli/src/llm/watch-format.test.ts
git commit -m "feat(modes): CLI mode command, ask flag, and headless approve/deny"
```

---

## Task 6: TUI — ciclar, mostrar, aprobar una a una, live prefs

**Files:**

- Modify: `tui/src/App.tsx`

Teclas nuevas: `o` cicla el modo (ask → auto → plan). Con un tool `awaiting_approval`, `y` aprueba y `n` rechaza **aunque** `busy` (el compose sigue bloqueado). No hay “siempre permitir”.

- [ ] State e imports:

```ts
import {
  cycleExecutionMode,
  parseExecutionMode,
  type ExecutionMode,
} from "../../cli/src/llm/execution-mode";
import { pendingApprovalsForChat } from "../../cli/src/llm/tool-approval";
```

```ts
const [executionMode, setExecutionMode] =
  useState<ExecutionMode>("ask");
```

Ampliar `ProvidersResponse` con `activeExecutionMode: string | null`.

En el `useEffect` que carga `/providers`, junto a effort:

```ts
setExecutionMode(parseExecutionMode(info.activeExecutionMode));
```

Ampliar `persistPrefs` para aceptar `activeExecutionMode?: string`.

- [ ] Header, junto a effort:

```tsx
{" · "}
mode: <Text color="cyan">{executionMode}</Text>
```

Ayuda: añadir `[o] mode` en la línea de atajos. Banner si hay awaiting:

```tsx
{messages.some((m) => {
  const st = String(
    (m.metadata as Record<string, unknown> | null)?.status || "",
  );
  return m.role === "tool" && st === "awaiting_approval";
}) ? (
  <Text color="yellow">
    awaiting approval — [y] sí  [n] no (uno a uno, sin “siempre”)
  </Text>
) : null}
```

- [ ] `useInput`: **antes** de `if (busy) return` en command mode (no dentro de compose):

```ts
async function resolveFirstAwaiting(decision: "approve" | "deny") {
  if (!client || !activeChatId) return;
  const awaiting = messages.find((m) => {
    const meta = (m.metadata || {}) as Record<string, unknown>;
    return m.role === "tool" && meta.status === "awaiting_approval" && meta.toolCallId;
  });
  if (!awaiting) {
    setLog("No tool awaiting approval");
    return;
  }
  const toolCallId = String(
    (awaiting.metadata as Record<string, unknown>).toolCallId,
  );
  const res = await client.request({
    type: decision === "approve" ? "agent.tool.approve" : "agent.tool.deny",
    chatId: activeChatId,
    toolCallId,
  });
  setLog(
    res.ok
      ? `${decision} ${toolCallId.slice(0, 8)}…`
      : res.error || "No tool awaiting approval",
  );
}

if (ch === "y" || ch === "n") {
  await resolveFirstAwaiting(ch === "y" ? "approve" : "deny");
  return;
}
```

Esto corre también cuando `busy === true`. No aprobar en lote: `find` (el primero), no `filter`.

- [ ] Tecla `o` (solo si `!busy`, junto a `p` / model / effort):

```ts
if (ch === "o") {
  const next = cycleExecutionMode(executionMode, 1);
  setExecutionMode(next);
  await persistPrefs({ activeExecutionMode: next });
  setLog(`Mode → ${next}`);
  return;
}
```

El turn **en curso** no cambia de modo; el siguiente `sendWithLlm` usa `executionMode` del state.

- [ ] `sendWithLlm` pasa `executionMode` a `publishAgentTurn`. Dependencias del `useCallback`: incluir `executionMode`.

- [ ] Live sync: en el `onPush`, si `msg.type === "prefs.updated"`:

```ts
const d = (msg.data || {}) as {
  activeExecutionMode?: string;
  activeProvider?: string;
  activeModel?: string;
  activeEffort?: string;
};
if (d.activeExecutionMode) {
  setExecutionMode(parseExecutionMode(d.activeExecutionMode));
}
```

Así un `chavez mode auto` o el select de Web se refleja sin reiniciar la TUI.

- [ ] Mensajes user: si `metadata.executionMode` existe, el texto es `user [ask]: …` (slice 100 como ahora). Si `Message` aún no tiene `metadata`, ampliar el type como en agent-tools Task 6.

- [ ] Commit:

```bash
git add tui/src/App.tsx
git commit -m "feat(modes): TUI cycles plan/auto/ask and resolves ask one by one"
```

---

## Task 7: Web — picker de modo, tag en el turn, botones de ask

**Files:**

- Create: `web/src/lib/execution-mode.ts`
- Test: `web/src/lib/execution-mode.test.ts`
- Modify: `web/src/lib/hooks.ts`
- Modify: `web/src/lib/ws-hooks.ts`
- Modify: `web/src/lib/ws-context.tsx`
- Modify: `web/src/components/ProvidersPanel.tsx`
- Modify: `web/src/components/ChatDetailPanel.tsx`
- Modify: `web/package.json`

Web no ejecuta tools. Cambia la preferencia, dispara el turn (el API estampa el modo), pinta `awaiting_approval` y envía approve/deny al hub.

- [ ] Añadir `"test": "bun test"` en `web/package.json` scripts si falta.

- [ ] Crear `web/src/lib/execution-mode.ts` — copiar `EXECUTION_MODES`, `DEFAULT_EXECUTION_MODE`, `isExecutionMode`, `parseExecutionMode`, `INVALID_MODE_ERROR` (misma semántica que CLI). No importar `cli/`.

- [ ] Test de parse/reject `yolo` idéntico al de Task 1 (sin cycle).

- [ ] En `web/src/lib/hooks.ts`:

  - `ProvidersResponse` y el body de `useProviderPreferences` incluyen `activeExecutionMode?: string | null`.

- [ ] En `web/src/lib/ws-context.tsx`:

  - Ampliar el tipo de `request` con `toolCallId?: string` y `status?: string` si aún no están (plan 2).
  - En el `onPush` que invalida queries, tratar `prefs.updated`:

```ts
if (msg.type === "prefs.updated") {
  void qc.invalidateQueries({ queryKey: ["providers"] });
}
```

- [ ] En `web/src/lib/ws-hooks.ts`, si `useWsToolResolve` **no** existe (plan 2), añadirlo tal cual agent-tools Task 7 (`agent.tool.approve` / `deny`). No duplicar si ya está.

- [ ] `ProvidersPanel.tsx`:

  - Línea “Activo:” añade ` / {data.activeExecutionMode || "ask"}`.
  - En el form “Modelo y effort”, un `<select id="activeExecutionMode" name="activeExecutionMode">` con `plan`, `auto`, `ask` (`defaultValue={data.activeExecutionMode || "ask"}`, key `mode-${data.activeExecutionMode}`).
  - `onSavePrefs` envía `activeExecutionMode: String(fd.get("activeExecutionMode") || "ask")`.
  - Título del panel: “Modelo, effort y modo”.

- [ ] `ChatDetailPanel.tsx`:

  1. Importar `useProviders`, `useProviderPreferences`, `parseExecutionMode`.
  2. Encima del textarea “Enviar al agente”, un select controlado:

```tsx
const providers = useProviders(undefined, signedIn);
const prefs = useProviderPreferences();
const currentMode = parseExecutionMode(providers.data?.activeExecutionMode);

<select
  id="executionMode"
  aria-label="Modo de ejecución"
  value={currentMode}
  disabled={prefs.isPending}
  onChange={(e) => {
    const next = parseExecutionMode(e.target.value, { defaultOnEmpty: false });
    void prefs.mutateAsync({ activeExecutionMode: next });
  }}
>
  <option value="ask">ask — confirma write/edit/bash</option>
  <option value="auto">auto — ejecuta sin preguntar</option>
  <option value="plan">plan — solo lectura, propone</option>
</select>
```

  El siguiente `agent.turn.request` no manda el modo: el API lee prefs (Task 2). El mutate espera (invalidate providers) antes de que el usuario pulse enviar si cambia y envía en el mismo tick: `mutateAsync` ya es awaitable; no hace falta bloquear el submit más que `prefs.isPending`.

  3. Mensajes `role === "user"`: si `m.metadata?.executionMode`, badge `user · {mode}`.

  4. `ToolCard`: si aún no tiene botones para `awaiting_approval`, copiar el bloque de agent-tools Task 7 (Aprobar / Rechazar → `useWsToolResolve`). Mostrar `summary` o path, no solo el nombre. **Sin** botón “siempre permitir”. Un click = un `toolCallId`.

- [ ] Correr:

```bash
cd web && bun test src/lib/execution-mode.test.ts
```

- [ ] Commit:

```bash
git add web/src/lib/execution-mode.ts web/src/lib/execution-mode.test.ts \
  web/src/lib/hooks.ts web/src/lib/ws-hooks.ts web/src/lib/ws-context.tsx \
  web/src/components/ProvidersPanel.tsx web/src/components/ChatDetailPanel.tsx \
  web/package.json
git commit -m "feat(modes): Web persists and displays plan/auto/ask with ask buttons"
```

---

## Task 8: Smoke — Gherkin sin LLM vivo + contrato WS

**Files:**

- Create: `cli/scripts/execution-mode-smoke.ts`
- Modify: `scripts/llm-smoke.ts` (solo log del modo; no cambiar el runner)

No dispara un modelo real (cuota). Cubre persistencia, rechazo, stamp en dispatch, approve sin waiter, y que watch no auto-aprueba.

- [ ] Crear `cli/scripts/execution-mode-smoke.ts`:

```ts
/**
 * Smoke: prefs round-trip, invalid mode, dispatch stamp, approve without waiter.
 * Needs: chavez login, API up, daemon bound (headless workspace open or this process).
 */
import { loadConfig } from "../src/config";
import { apiFetch, ApiError } from "../src/api-client";
import { ChavezWsClient } from "../src/ws/client";
import { cwdPath } from "../src/workspace";
import { INVALID_MODE_ERROR } from "../src/llm/execution-mode";

const config = loadConfig();
const token = process.env.CHAVEZ_ACCESS_TOKEN || config.accessToken;
if (!token) {
  console.error("Need login");
  process.exit(1);
}

type Prefs = {
  activeExecutionMode?: string | null;
  activeProvider?: string | null;
};

const before = await apiFetch<Prefs>("/providers", {}, token);
console.log("before", before.activeExecutionMode);

try {
  await apiFetch(
    "/providers/preferences",
    {
      method: "PUT",
      body: JSON.stringify({ activeExecutionMode: "yolo" }),
    },
    token,
  );
  console.error("FAIL: yolo was accepted");
  process.exit(1);
} catch (err) {
  if (!(err instanceof ApiError) || err.status !== 400) {
    console.error("FAIL: expected 400 for yolo", err);
    process.exit(1);
  }
  const body = err.body as { error?: string } | undefined;
  const msg = body?.error || err.message;
  if (!String(msg).includes("plan, auto, or ask")) {
    console.error("FAIL: wrong error", msg, "expected", INVALID_MODE_ERROR);
    process.exit(1);
  }
}

const still = await apiFetch<Prefs>("/providers", {}, token);
if (
  parseFrozen(still.activeExecutionMode) !==
  parseFrozen(before.activeExecutionMode)
) {
  console.error("FAIL: invalid PUT mutated mode", still.activeExecutionMode);
  process.exit(1);
}

await apiFetch(
  "/providers/preferences",
  { method: "PUT", body: JSON.stringify({ activeExecutionMode: "auto" }) },
  token,
);
const afterAuto = await apiFetch<Prefs>("/providers", {}, token);
if (afterAuto.activeExecutionMode !== "auto") {
  console.error("FAIL: did not persist auto");
  process.exit(1);
}

await apiFetch(
  "/providers/preferences",
  { method: "PUT", body: JSON.stringify({ activeExecutionMode: "ask" }) },
  token,
);

function parseFrozen(v: unknown): string {
  return v === "plan" || v === "auto" || v === "ask" ? v : "ask";
}

const daemon = new ChavezWsClient(token);
const web = new ChavezWsClient(token);
await daemon.connect();
await web.connect();
const bindPath = cwdPath();
const db = await daemon.bind(bindPath, "daemon");
const wb = await web.bind(bindPath, "client");
if (!db.ok || !wb.ok) throw new Error(`bind fail ${db.error} ${wb.error}`);

const gotPrefs = new Promise<void>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("no prefs.updated")), 8000);
  daemon.onPush((msg) => {
    if (msg.type === "prefs.updated") {
      clearTimeout(t);
      const mode = (msg.data as { activeExecutionMode?: string })
        .activeExecutionMode;
      if (mode !== "plan") {
        reject(new Error(`prefs.updated mode=${mode}`));
        return;
      }
      resolve();
    }
  });
});
await apiFetch(
  "/providers/preferences",
  { method: "PUT", body: JSON.stringify({ activeExecutionMode: "plan" }) },
  token,
);
await gotPrefs;

const session = await web.request({ type: "session.create", title: "mode-smoke" });
if (!session.ok) throw new Error(session.error);
const sessionId = (session.data as { session: { id: string } }).session.id;
const chat = await web.request({
  type: "chat.create",
  sessionId,
  title: "mode-chat",
});
if (!chat.ok) throw new Error(chat.error);
const chatId = (chat.data as { chat: { id: string } }).chat.id;

const gotDispatch = new Promise<void>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("no dispatch")), 8000);
  daemon.onPush((msg) => {
    if (msg.type === "agent.turn.dispatch") {
      clearTimeout(t);
      const mode = (msg.data as { executionMode?: string }).executionMode;
      if (mode !== "plan") {
        reject(new Error(`dispatch executionMode=${mode}`));
        return;
      }
      resolve();
    }
  });
});

const turn = await web.request({
  type: "agent.turn.request",
  chatId,
  prompt: "mode-smoke ping",
});
if (!turn.ok) throw new Error(`turn failed: ${turn.error}`);
await gotDispatch;

const deny = await web.request({
  type: "agent.tool.deny",
  chatId,
  toolCallId: "does-not-exist",
});
if (deny.ok) {
  console.error("FAIL: deny without awaiting tool succeeded");
  process.exit(1);
}
if (!String(deny.error || "").includes("No tool awaiting") &&
    !String(deny.error || "").toLowerCase().includes("not found")) {
  console.error("FAIL: unexpected deny error", deny.error);
  process.exit(1);
}

daemon.close();
web.close();

await apiFetch(
  "/providers/preferences",
  {
    method: "PUT",
    body: JSON.stringify({
      activeExecutionMode: parseFrozen(before.activeExecutionMode),
    }),
  },
  token,
);

console.log("SMOKE PASS");
```

Ajustar el import de `ApiError` si el export real es distinto: en `cli/src/api-client.ts` la clase **sí** se exporta.

Si el daemon real (otro proceso) ya está bound, este script también se registra como daemon: `findDaemon` puede devolver el primero. El smoke **solo** exige que **algún** daemon reciba el dispatch con `executionMode: "plan"`. Si hay un daemon ocupado, el request puede fallar busy: en ese caso imprimir el error y `process.exit(0)` no. Reintentar una vez no. Documentar: correr con workspace sin turn en curso.

- [ ] En `scripts/llm-smoke.ts`, el type `ProvidersResponse` añade `activeExecutionMode` y un `console.log("activeExecutionMode", info.activeExecutionMode)`. No cambia el `query()`.

- [ ] Correr unitarios de las tres superficies:

```bash
cd cli && bun test src/llm/execution-mode.test.ts src/llm/execution-gate.test.ts src/llm/tool-approval.test.ts src/llm/claude-runner.mode.test.ts
cd api && bun test src/llm/execution-mode.test.ts
cd web && bun test src/lib/execution-mode.test.ts
```

Esperado: todos pasan.

- [ ] Smoke (API + login + WS):

```bash
cd cli && bun run scripts/execution-mode-smoke.ts
```

Esperado: `SMOKE PASS`.

- [ ] Commit:

```bash
git add cli/scripts/execution-mode-smoke.ts scripts/llm-smoke.ts
git commit -m "test(modes): prefs, invalid yolo, dispatch stamp, no silent approve"
```

---

## Orden de ejecución

1. Task 1 (módulos puros CLI) — no depende de API.
2. Task 2 (API prefs + dispatch) — no depende del runner.
3. Task 3 (runner gate) — depende de Task 1; sandbox de plan 2 o el fallback de esta fase.
4. Task 4 (daemon/TUI waiter) — depende de Tasks 1–3.
5. Task 5 (CLI) — depende de Task 2; watch se puede paralelizar con 4.
6. Task 6 (TUI UI) — depende de 4.
7. Task 7 (Web) — depende de Task 2.
8. Task 8 (smoke) — después de 2 como mínimo; idealmente al final.

Tasks 5 y 7 son paralelizables entre sí una vez 2 está mergeada.

## Verificación Gherkin → task

| Escenario | Dónde se cubre |
|---|---|
| Preferencia persistida Web → TUI / headless ask | Task 2 PUT+GET+broadcast `prefs.updated`; Task 6 escucha; Task 3 `publishAgentTurn` lee prefs / dispatch |
| Cambiar modo desde TUI (`o`) | Task 6 persistPrefs; siguiente turn usa state; plan no escribe (Task 3 gate) |
| Cambiar modo desde CLI | Task 5 `chavez mode` + `--mode` PUT antes del ask; Web GET/broadcast |
| Ask confirma write | Task 3 `onAskPermission` + `chat.tool.update`; disco intacto hasta `allow`; Task 6/7 UI |
| Ask rechaza bash | Task 3 deny → `ASK_DENIED`; SDK no ejecuta; `cancelApprovalsForChat` en finally |
| Confirmación Web, ejecución daemon | Task 2 forward approve; Task 4 `resolveApproval` en el proceso daemon; `cwd` intacto |
| Auto no pide confirmación | Task 1/3 `gateMutation("auto")` → allow; timeline sigue `running` → `done` (plan 2) |
| Plan no muta | Task 3 deny + preamble; test Write en plan no llama `ask` |
| Plan → auto “aplica el plan” | Task 3 no limpia historial; modo nuevo en el siguiente turn |
| Lecturas nunca piden | Task 1/3 `gateClass` read → allow; test `called === false` |
| Path fuera también en auto | Task 3 test `/etc/passwd` + `denyIfEscapes` |
| Modo inválido `yolo` | Task 2 400 + no upsert; Task 8 smoke |
| El modo viaja con el turn | Task 2 dispatch `executionMode`; Task 3 metadata user; daemon usa el stamp |
| Headless ask sin TTY | Task 4 no auto-approve; Task 5 watch hint + `chat approve`; Task 1 timeout |

## Fuera de este plan (no implementar)

- Cursor ejecutable con el mismo gate → [cursor-provider](../cursor-provider/plan.md). Esta fase **sí** persiste y muestra el modo para Cursor.
- Timeout UX, “ya resuelto”, diff al lado de la pregunta → [approvals](../approvals/plan.md). El waiter + 300s + `"No tool awaiting approval"` **sí** van aquí (Gherkin de este plan).
- Artefacto editable de plan / botón Aplicar → [plan-artifact](../plan-artifact/plan.md).
- Slash `/mode` `/plan` → [slash-commands](../slash-commands/plan.md). TUI usa `o`; CLI usa `chavez mode`.
- Red denegada en auto / ask puede pedir red → [sandbox-network](../sandbox-network/plan.md).
- Cola de turns → [turn-queue](../turn-queue/plan.md).
- “Siempre permitir”, lote, notificaciones OS → prohibido por decisiones 11 y 13.
