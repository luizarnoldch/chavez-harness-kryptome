# Turn Queue Implementation Plan

> **For agentic workers:** Execute task-by-task. Do not skip tests. Do not implement Cursor cloud, voz, extensión IDE, upload desde el navegador, worktrees paralelos (plan 28), notificaciones OS/email, lote de cancel, ni “siempre permitir”. Spec: [`plan.md`](./plan.md). Depende del dispatch existente (`agent.turn.request` → `agent.turn.dispatch` → `publishAgentTurn`) y, si ya aterrizaron, de `turnBusy` / `agent.turn.ended` ([`agent-tools`](../agent-tools/implementation.md) / [`invariants`](../invariants/implementation.md)), del waiter de ask ([`approvals`](../approvals/implementation.md) / [`execution-modes`](../execution-modes/implementation.md)) y del classifier in-app ([`notifications`](../notifications/implementation.md)). Si un sibling ya creó un archivo citado, **extiéndelo**; no lo reescribas. Esta fase **sustituye** el fail `TURN_BUSY_ERROR` de `agent.turn.request` (Web/TUI/CLI interactivo) por una cola FIFO de **1 running por daemon**.

**Goal:** El usuario no pierde prompts. Si el daemon ya tiene un turn running, el siguiente desde Web o TUI **no se rechaza en silencio**: queda `queued` con **posición**, y al terminar el actual arranca el siguiente. Se puede **quitar un queued** (no corre). En modo `ask`, el queued **no** pide aprobación hasta que es running. Web y TUI reflejan el paso queued → running → done (plan 24). En CI/no-interactivo, busy **espera un timeout o falla**; **no** encola para siempre.

**Architecture:** El filesystem y el loop del agente viven en el daemon (`cli/src/ws/daemon.ts` o TUI `clientKind: "daemon"`). La API **no** ejecuta el LLM: es dueña de la cola **por workspace** (un daemon = un running). El segundo `agent.turn.request` encola; `agent.turn.ended` / `chat.stream.end|error` drena FIFO y despacha el siguiente con `skipUserAppend: true`. El daemon sigue con `turnBusy` como cinturón (nunca dos `publishAgentTurn`). Approvals solo existen cuando el SDK está running.

```
Composer (Web | TUI | CLI ask)
        |
        v
  agent.turn.request  --WS-->  API
        |  no daemon          → fail NO_DAEMON_ERROR
        |  enqueue:false + busy → fail TURN_BUSY_ERROR / QUEUE_CI_BUSY
        |  queue.length>=20   → fail QUEUE_FULL_ERROR
        |  !busy              → persist user? no (daemon append)
        |                     → dispatch + setTurnBusy
        |                     → ok { accepted, queued:false }
        |  busy               → persist user metadata.kind=queued_turn
        |                     → FIFO.push + broadcast agent.queue.updated
        |                     → ok { accepted, queued:true, position, queueId }
        v
  daemon / TUI
        agent.turn.dispatch  → publishAgentTurn (1 a la vez)
        finally → agent.turn.ended
        v
  API onTurnFinished → setTurnBusy false → promote head → dispatch
        v
  broadcast agent.queue.updated  →  Web QueueCard | TUI badge | CLI watch JSON
```

Estado actual que este plan extiende (no reescribir):

- `api/src/ws/handlers.ts` `agent.turn.request`: si hay daemon, **siempre** `sendTo` `agent.turn.dispatch` y `ok { accepted: true }`. **No** hay `turnBusy`. **No** hay cola. Un segundo request se “acepta” y el daemon lo tira.
- `api/src/ws/hub.ts` `HubConnection` **no** tiene `turnBusy` / `turnChatId`. `findDaemon` = primer `clientKind === "daemon"`.
- `cli/src/ws/daemon.ts`: `turnBusy` local. Segundo dispatch → `log("turn already running — ignoring dispatch")` y **return** (silencio hacia el requester).
- `tui/src/App.tsx`: `sendWithLlm` si `turnBusyRef` → `setLog("Ya hay un turn en curso")` y return. Compose `if (busy) return`. Dispatch remoto: `setLog("Turn remoto ignorado — ya hay uno en curso")`.
- `web/src/components/ChatDetailPanel.tsx`: el composer **sí** deja enviar mientras `streaming` (solo `agent.isPending` deshabilita). Tras ok muestra “Turn aceptado” aunque el daemon ignore el segundo.
- `cli/src/commands/headless.ts` `chat ask`: un `agent.turn.request` (timeout 30s del RPC), imprime `accepted` y **sale 0**. No espera el turn. No hay `--no-queue` ni `--wait-timeout`.
- `cli/src/llm/publish-turn.ts` ya tiene `skipUserAppend?: boolean`. Tras el turn **no** emite `agent.turn.ended`.
- `cli/src/llm/history.ts` mete todo user/assistant/system. Un user `queued` en DB se **colaría** en el historial del turn running si no se filtra.
- `api/src/db/schema.ts` `chat_messages.metadata` jsonb **ya existe**. **Sin** tabla nueva. **Sin** migración.
- Planes 2/5 añaden `TURN_BUSY_ERROR` en request. **Esta fase lo reemplaza** por enqueue salvo `enqueue: false` (CI).
- Plan 13: `awaiting_approval` solo desde `canUseTool` del turn running. Un queued **no** corre el SDK → no hay ask. No reimplementar el waiter.
- Plan 24: classifier **no** existe aún en el repo. Esta fase pinta cola desde `agent.queue.updated`. Si `cli/src/notifications/classify.ts` ya existe, **extenderlo**; si no, crear `cli/src/queue/notify.ts` y Web duplicado.
- Plan 16 follow-up de steer: si auto-despacha en el daemon tras `ended`, **no** lo haga: el drain de esta cola es el único siguiente turn. Si `peekFollowUp` existe, encolar con `agent.turn.request` **antes** de emitir `ended`.
- Plan 28 worktree: el drain usa el cwd actual del daemon. **Cero** turns paralelos en dos worktrees.
- Cursor `runnable: false`. La cola no simula un turn Cursor; cuando el plan 4 exista, el mismo FIFO despacha al mismo runner.

**Tech Stack:** Bun, Hono WebSocket hub **in-memory FIFO por workspace** + persistencia del prompt en `chat_messages.metadata` jsonb (sin migración), Claude Agent SDK vía `publishAgentTurn` existente, Ink TUI, Astro/React islands + TanStack Query. Tests: `bun test`. Web y API **no** importan CLI: duplicar model/constants (comentario keep-in-sync). TUI importa `cli/src/queue/…`.

**Global Constraints:**

1. El filesystem y el agente viven **solo** en el daemon (cwd del workspace). API encola y despacha; no corre tools ni hidrata `@`.
2. Sin daemon bound, `agent.turn.request` sigue fallando con exactamente `"No daemon bound for this workspace. Run: chavez headless workspace open"`. **No** se encola un turn huérfano.
3. **1 turn por daemon** (decisión 17). Cola sí; worktrees **no** paralelos. El siguiente turn usa el cwd que tenga el daemon al promoverlo.
4. Web, CLI `watch` y TUI ven el mismo snapshot (`agent.queue.updated`) y el mismo stream cuando el queued pasa a running.
5. Provider / modelo / esfuerzo / **modo** se estampan al **encolar** (`metadata.executionMode` si el plan 3 ya viaja en prefs). Al promover, el dispatch lleva esos valores; no se re-leen prefs si cambiaron a mitad de cola.
6. Claude es el ejecutable hoy. Cursor vinculado no corre turns aquí.
7. Tools por defecto solo corren cuando el turn es **running**. Lecturas nunca piden confirmación. Write/edit/bash en `ask` esperan hasta running (Gherkin: el queued no pide aprobación).
8. Aprobaciones **una a una** (plan 13). Cancelar cola es **un** `queueId` por request. Sin “cancelar todos”, sin “siempre permitir”.
9. Un usuario = su vault. La cola es por `(userId, workspaceId)`, no hay cola de org.
10. Cancelar un queued **no** toca git ni disco. Cancelar el running sigue siendo `agent.turn.cancel` (plan 16); al terminar (cancel/end/error) se drena el siguiente queued.
11. CI/no-TTY: default **no encola**. `--wait-timeout <ms>` encola, espera, y al vencer **cancela** el item y sale `!= 0`. Nunca deja un queued eterno.
12. Fuera de alcance: Cursor cloud, voz, extensión IDE, upload desde el navegador, Notification API / email, worktrees paralelos, tabla `turn_queue`.

**Constantes (congeladas, no inventar otras):**

| Nombre | Valor |
|---|---|
| `NO_DAEMON_ERROR` | `"No daemon bound for this workspace. Run: chavez headless workspace open"` |
| `TURN_BUSY_ERROR` | `"Turn already running on this daemon"` |
| `QUEUE_FULL_ERROR` | `"Turn queue is full (max 20)"` |
| `QUEUE_NOT_FOUND` | `"Queued turn not found"` |
| `QUEUE_CANCELLED` | `"Queued turn cancelled"` |
| `QUEUE_CI_BUSY` | `"Daemon busy — not queued (CI / --no-queue). Retry or pass --wait-timeout"` |
| `QUEUE_CI_TIMEOUT` | `"Timed out waiting for the daemon (CI). Queued turn cancelled"` |
| `QUEUE_MAX_LENGTH` | `20` |
| `QUEUE_CI_DEFAULT_WAIT_MS` | `0` |
| `QUEUE_CI_MAX_WAIT_MS` | `600_000` |
| `QUEUE_KIND` | `"queued_turn"` |
| `QUEUE_STATUS_QUEUED` | `"queued"` |
| `QUEUE_STATUS_DISPATCHED` | `"dispatched"` |
| `QUEUE_STATUS_CANCELLED` | `"cancelled"` |
| `QUEUE_PREVIEW_CHARS` | `80` |
| `QUEUE_ENQUEUED_LABEL` | `"Turn encolado"` |
| `QUEUE_PROMOTED_LABEL` | `"Turn en cola iniciado"` |
| `QUEUE_DONE_LABEL` | `"Turn en cola terminado"` |
| `QUEUE_POSITION_PREFIX` | `"queued · #"` |
| `WEB_QUEUED_HINT` | `"Encolado · posición"` |
| `TUI_QUEUED_HINT` | `"queued #"` |
| `TUI_COMPOSE_WHILE_BUSY` | `"Busy: Enter encola (posición) · x quita el último queued"` |

Reusar `NO_DAEMON_ERROR` / `TURN_BUSY_ERROR` si ya existen en `api/src/ws/errors.ts` o `cli/src/llm/tool-names.ts`; **no** cambiar esos strings. `TURN_BUSY_ERROR` queda para `enqueue: false` y para compact/undo (otros planes), **no** para el segundo prompt interactivo.

Nombres de events WS:

| Tipo | Dirección | Semántica |
|---|---|---|
| `agent.turn.request` | cliente → API | `{ chatId, prompt, enqueue? }`. Default `enqueue: true`. |
| `agent.turn.dispatch` | API → daemon | `{ chatId, prompt, queueId, skipUserAppend, executionMode?, path, workspaceId, sessionId }` |
| `agent.turn.started` | daemon → API | `{ chatId, queueId?, streamId? }` — `setTurnBusy(true)` idempotente |
| `agent.turn.ended` | daemon → API | `{ chatId, streamId, status }` — `onTurnFinished` + drain |
| `agent.queue.updated` | API → broadcast | snapshot (ver tipo abajo) |
| `agent.queue.cancel` | cliente → API | `{ queueId }` — un item. Idempotente. |
| `agent.queue.list` | cliente → API | `{ workspaceId? , chatId? }` → snapshot |

`chat.stream.end` / `chat.stream.error` también llaman `onTurnFinished` (idempotente si `ended` ya drenó).

HTTP: ninguno nuevo. Reload: `chat.get` reconstruye badges desde `metadata.kind === "queued_turn"`. `agent.queue.list` reconstruye posiciones live.

Contrato del FIFO (puro):

```ts
export type QueueStatus = "queued" | "dispatched" | "cancelled";

export type QueueItem = {
  queueId: string; // === message.id
  chatId: string;
  workspaceId: string;
  prompt: string;
  createdAt: string; // ISO-8601
  executionMode?: "plan" | "auto" | "ask";
  skipUserAppend: true;
};

export type QueueSnapshot = {
  workspaceId: string;
  running: { chatId: string; queueId?: string; streamId?: string } | null;
  items: Array<{
    queueId: string;
    chatId: string;
    position: number; // 1-based, solo queued
    promptPreview: string;
    createdAt: string;
    executionMode?: string;
  }>;
  reason:
    | "enqueued"
    | "promoted"
    | "cancelled"
    | "drained"
    | "hydrated"
    | "started";
  changedQueueId?: string;
};

export type QueueAdmission =
  | { action: "dispatch" }
  | { action: "enqueue" }
  | { action: "reject"; error: string };
```

User message persistido al encolar:

```ts
{
  kind: "queued_turn",
  queueId: string,
  queueStatus: "queued" | "dispatched" | "cancelled",
  position: number,          // snapshot al encolar; la UI live usa el snapshot WS
  executionMode?: string,
}
```

`historyFromChatMessages` **salta** filas con `kind === "queued_turn"` y `queueStatus` `queued` o `cancelled`. Tras `dispatched` el prompt es historial normal.

---

## Task 1: Módulo puro — FIFO, posiciones, admisión CI, historial

**Files:**

- Create: `cli/src/queue/constants.ts`
- Create: `cli/src/queue/model.ts`
- Create: `cli/src/queue/admission.ts`
- Create: `cli/src/queue/parse-ask-args.ts`
- Test: `cli/src/queue/model.test.ts`
- Test: `cli/src/queue/admission.test.ts`
- Test: `cli/src/queue/parse-ask-args.test.ts`
- Modify: `cli/src/llm/history.ts`
- Test: `cli/src/llm/history.test.ts` (crear o extender)
- Modify: `cli/package.json`

Sin I/O de red. TUI importa desde aquí. API y Web duplican constants+model en Tasks 2 y 6 (keep-in-sync).

- [ ] Añadir `"test": "bun test"` en `cli/package.json` `scripts` si aún no existe (dejar `start`/`dev`/`bin` intactos):

```json
"scripts": {
  "start": "bun run src/index.ts",
  "dev": "bun run src/index.ts",
  "test": "bun test"
}
```

- [ ] Crear `cli/src/queue/constants.ts`:

```ts
export const NO_DAEMON_ERROR =
  "No daemon bound for this workspace. Run: chavez headless workspace open";
export const TURN_BUSY_ERROR = "Turn already running on this daemon";
export const QUEUE_FULL_ERROR = "Turn queue is full (max 20)";
export const QUEUE_NOT_FOUND = "Queued turn not found";
export const QUEUE_CANCELLED = "Queued turn cancelled";
export const QUEUE_CI_BUSY =
  "Daemon busy — not queued (CI / --no-queue). Retry or pass --wait-timeout";
export const QUEUE_CI_TIMEOUT =
  "Timed out waiting for the daemon (CI). Queued turn cancelled";
export const QUEUE_MAX_LENGTH = 20;
export const QUEUE_CI_DEFAULT_WAIT_MS = 0;
export const QUEUE_CI_MAX_WAIT_MS = 600_000;
export const QUEUE_KIND = "queued_turn";
export const QUEUE_STATUS_QUEUED = "queued";
export const QUEUE_STATUS_DISPATCHED = "dispatched";
export const QUEUE_STATUS_CANCELLED = "cancelled";
export const QUEUE_PREVIEW_CHARS = 80;
export const QUEUE_ENQUEUED_LABEL = "Turn encolado";
export const QUEUE_PROMOTED_LABEL = "Turn en cola iniciado";
export const QUEUE_DONE_LABEL = "Turn en cola terminado";
export const QUEUE_POSITION_PREFIX = "queued · #";
export const WEB_QUEUED_HINT = "Encolado · posición";
export const TUI_QUEUED_HINT = "queued #";
export const TUI_COMPOSE_WHILE_BUSY =
  "Busy: Enter encola (posición) · x quita el último queued";

export type QueueStatus = "queued" | "dispatched" | "cancelled";
export type QueueReason =
  | "enqueued"
  | "promoted"
  | "cancelled"
  | "drained"
  | "hydrated"
  | "started";
```

Si `NO_DAEMON_ERROR` / `TURN_BUSY_ERROR` ya existen, reexportarlos y **no** duplicar el literal.

- [ ] Crear `cli/src/queue/model.ts` — FIFO en memoria, posiciones 1-based, cancel, promote, preview:

```ts
import {
  QUEUE_FULL_ERROR,
  QUEUE_KIND,
  QUEUE_MAX_LENGTH,
  QUEUE_PREVIEW_CHARS,
  QUEUE_STATUS_CANCELLED,
  QUEUE_STATUS_QUEUED,
  type QueueReason,
} from "./constants";

export type QueueItem = {
  queueId: string;
  chatId: string;
  workspaceId: string;
  prompt: string;
  createdAt: string;
  executionMode?: "plan" | "auto" | "ask";
  skipUserAppend: true;
};

export type QueueRunning = {
  chatId: string;
  queueId?: string;
  streamId?: string;
} | null;

export type QueueSnapshot = {
  workspaceId: string;
  running: QueueRunning;
  items: Array<{
    queueId: string;
    chatId: string;
    position: number;
    promptPreview: string;
    createdAt: string;
    executionMode?: string;
  }>;
  reason: QueueReason;
  changedQueueId?: string;
};

export function promptPreview(prompt: string, max = QUEUE_PREVIEW_CHARS): string {
  const t = prompt.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

export function isQueuedHistoryRow(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object") return false;
  const m = metadata as Record<string, unknown>;
  const status = m.queueStatus;
  return (
    m.kind === QUEUE_KIND &&
    (status === QUEUE_STATUS_QUEUED || status === QUEUE_STATUS_CANCELLED)
  );
}

export class TurnQueue {
  readonly workspaceId: string;
  running: QueueRunning = null;
  private items: QueueItem[] = [];

  constructor(workspaceId: string) {
    this.workspaceId = workspaceId;
  }

  get length(): number {
    return this.items.length;
  }

  snapshot(reason: QueueReason, changedQueueId?: string): QueueSnapshot {
    return {
      workspaceId: this.workspaceId,
      running: this.running ? { ...this.running } : null,
      items: this.items.map((it, i) => ({
        queueId: it.queueId,
        chatId: it.chatId,
        position: i + 1,
        promptPreview: promptPreview(it.prompt),
        createdAt: it.createdAt,
        executionMode: it.executionMode,
      })),
      reason,
      changedQueueId,
    };
  }

  canEnqueue(): { ok: true } | { ok: false; error: string } {
    if (this.items.length >= QUEUE_MAX_LENGTH) {
      return { ok: false, error: QUEUE_FULL_ERROR };
    }
    return { ok: true };
  }

  enqueue(item: QueueItem): { position: number } {
    this.items.push(item);
    return { position: this.items.length };
  }

  cancel(queueId: string): QueueItem | null {
    const idx = this.items.findIndex((it) => it.queueId === queueId);
    if (idx < 0) return null;
    const [removed] = this.items.splice(idx, 1);
    return removed ?? null;
  }

  promote(): QueueItem | null {
    return this.items.shift() ?? null;
  }

  peek(): QueueItem | null {
    return this.items[0] ?? null;
  }

  hydrate(items: QueueItem[], running: QueueRunning): void {
    this.items = [...items];
    this.running = running;
  }

  find(queueId: string): QueueItem | undefined {
    return this.items.find((it) => it.queueId === queueId);
  }
}

export function positionOf(
  items: Array<{ queueId: string }>,
  queueId: string,
): number | null {
  const idx = items.findIndex((it) => it.queueId === queueId);
  return idx < 0 ? null : idx + 1;
}
```

- [ ] Crear `cli/src/queue/admission.ts`:

```ts
import {
  QUEUE_CI_BUSY,
  QUEUE_CI_DEFAULT_WAIT_MS,
  QUEUE_CI_MAX_WAIT_MS,
  QUEUE_FULL_ERROR,
  QUEUE_MAX_LENGTH,
  TURN_BUSY_ERROR,
} from "./constants";

export type AdmissionInput = {
  hasDaemon: boolean;
  busy: boolean;
  queueLength: number;
  enqueue: boolean; // default true en el caller interactivo
};

export type Admission =
  | { action: "dispatch" }
  | { action: "enqueue" }
  | { action: "reject"; error: string };

export function admitTurn(input: AdmissionInput): Admission {
  if (!input.hasDaemon) {
    return {
      action: "reject",
      error:
        "No daemon bound for this workspace. Run: chavez headless workspace open",
    };
  }
  if (!input.busy) return { action: "dispatch" };
  if (!input.enqueue) {
    return { action: "reject", error: QUEUE_CI_BUSY };
  }
  if (input.queueLength >= QUEUE_MAX_LENGTH) {
    return { action: "reject", error: QUEUE_FULL_ERROR };
  }
  return { action: "enqueue" };
}

export function isNonInteractive(
  env: NodeJS.ProcessEnv = process.env,
  stdout: { isTTY?: boolean } = process.stdout,
): boolean {
  const ci = env.CI;
  if (ci === "1" || ci === "true" || env.CHAVEZ_CI === "1") return true;
  return stdout.isTTY === false;
}

export function resolveAskPolicy(input: {
  nonInteractive: boolean;
  noQueue: boolean;
  waitTimeoutMs?: number;
}): { enqueue: boolean; waitTimeoutMs: number; busyError: string } {
  const raw = input.waitTimeoutMs;
  const waitTimeoutMs = Math.max(
    0,
    Math.min(
      raw == null || Number.isNaN(raw) ? QUEUE_CI_DEFAULT_WAIT_MS : raw,
      QUEUE_CI_MAX_WAIT_MS,
    ),
  );
  if (input.noQueue) {
    return { enqueue: false, waitTimeoutMs: 0, busyError: QUEUE_CI_BUSY };
  }
  if (waitTimeoutMs > 0) {
    return { enqueue: true, waitTimeoutMs, busyError: QUEUE_CI_BUSY };
  }
  if (input.nonInteractive) {
    return { enqueue: false, waitTimeoutMs: 0, busyError: QUEUE_CI_BUSY };
  }
  return { enqueue: true, waitTimeoutMs: 0, busyError: TURN_BUSY_ERROR };
}

export function capWaitTimeout(ms: number): number {
  if (!Number.isFinite(ms) || ms < 0) return 0;
  return Math.min(ms, QUEUE_CI_MAX_WAIT_MS);
}
```

`admitTurn` **no** usa `NO_DAEMON_ERROR` importado si el reexport aún no existe: el string debe ser **idéntico**. Preferir importar la constante.

- [ ] Crear `cli/src/queue/parse-ask-args.ts`:

```ts
import { capWaitTimeout } from "./admission";

export type ParsedAskArgs = {
  chatId: string;
  prompt: string;
  noQueue: boolean;
  waitTimeoutMs: number | undefined;
};

export function parseAskArgs(rest: string[]): ParsedAskArgs {
  let noQueue = false;
  let waitTimeoutMs: number | undefined;
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--no-queue") {
      noQueue = true;
      continue;
    }
    if (a === "--wait-timeout") {
      waitTimeoutMs = capWaitTimeout(Number(rest[++i]));
      continue;
    }
    if (a.startsWith("--wait-timeout=")) {
      waitTimeoutMs = capWaitTimeout(
        Number(a.slice("--wait-timeout=".length)),
      );
      continue;
    }
    positional.push(a);
  }
  const chatId = positional[0] || "";
  const prompt = positional.slice(1).join(" ");
  return { chatId, prompt, noQueue, waitTimeoutMs };
}
```

- [ ] Tests `cli/src/queue/model.test.ts`:

  1. `enqueue` dos items → posiciones `1` y `2`; `snapshot("enqueued").items[1].position === 2`.
  2. `cancel` del primero → el que era `#2` pasa a `#1`; `cancel` de id desconocido → `null`.
  3. `promote` FIFO: A luego B; `promote()` es A, peek es B; segundo promote es B; tercero `null`.
  4. `canEnqueue` con 20 items → `QUEUE_FULL_ERROR`; con 19 → ok.
  5. `isQueuedHistoryRow`: `queued` y `cancelled` true; `dispatched` false; sin metadata false.
  6. `promptPreview` recorta a 80 y colapsa whitespace.

- [ ] Tests `cli/src/queue/admission.test.ts`:

  1. Sin daemon → reject con el string `NO_DAEMON_ERROR`.
  2. Daemon idle → `dispatch` aunque `enqueue: false`.
  3. Busy + `enqueue: true` + length 0 → `enqueue`.
  4. Busy + `enqueue: false` → reject `QUEUE_CI_BUSY`.
  5. Busy + length 20 → `QUEUE_FULL_ERROR`.
  6. `isNonInteractive`: `CI=true` / `CHAVEZ_CI=1` / `isTTY false` → true; TTY y sin CI → false.
  7. `resolveAskPolicy` interactivo default → `{ enqueue: true, waitTimeoutMs: 0 }`.
  8. No-interactivo default → `{ enqueue: false }`.
  9. `--wait-timeout 5000` en CI → `{ enqueue: true, waitTimeoutMs: 5000 }`.
  10. `--wait-timeout 999999999` → cap `600_000`.
  11. `--no-queue` gana sobre `--wait-timeout`.

- [ ] Tests `cli/src/queue/parse-ask-args.test.ts`:

  1. `["chat1", "hello", "world"]` → prompt `"hello world"`, `noQueue false`.
  2. `["--no-queue", "chat1", "p"]` y `["chat1", "--no-queue", "p"]` → `noQueue true`, prompt `"p"`.
  3. `["--wait-timeout", "1500", "chat1", "p"]` y `["--wait-timeout=1500", "chat1", "p"]`.

- [ ] Extender `cli/src/llm/history.ts`. Ampliar `DbMessage`:

```ts
type DbMessage = {
  role?: string | null;
  content?: string | null;
  metadata?: unknown;
};
```

Importar `isQueuedHistoryRow` desde `../queue/model`. En el loop, **antes** de pushear:

```ts
if (isQueuedHistoryRow(m.metadata)) continue;
```

- [ ] Tests `cli/src/llm/history.test.ts`: historial con user running + user `queued_turn/queued` + user `cancelled` + assistant. El modelo **no** ve los queued/cancelled. Un `dispatched` **sí** entra. El `currentPrompt` trailing se sigue recortando.

- [ ] Correr:

```bash
cd cli && bun test src/queue/model.test.ts src/queue/admission.test.ts \
  src/queue/parse-ask-args.test.ts src/llm/history.test.ts
```

Esperado: todos pasan.

- [ ] Commit:

```bash
git add cli/src/queue cli/src/llm/history.ts cli/src/llm/history.test.ts cli/package.json
git commit -m "feat(queue): FIFO, CI admission, skip queued history"
```

---

## Task 2: API — hub busy, persistir queued, drain, cancel, list

**Files:**

- Create: `api/src/ws/queue-constants.ts`
- Create: `api/src/ws/queue-model.ts`
- Create: `api/src/ws/turn-queue.ts`
- Test: `api/src/ws/queue-model.test.ts`
- Test: `api/src/ws/turn-queue.test.ts`
- Modify: `api/src/ws/hub.ts`
- Modify: `api/src/ws/protocol.ts`
- Modify: `api/src/ws/handlers.ts`
- Modify: `api/package.json`

API **no** importa `cli/`. Copiar constants + `TurnQueue` / `admitTurn` / `isQueuedHistoryRow` / `promptPreview` (comentario `// keep-in-sync with cli/src/queue/*`).

- [ ] Añadir `"test": "bun test"` en `api/package.json` `scripts` si no existe (dejar `dev`/`start`/`db:*`/`test:e2e` intactos).

- [ ] Copiar `api/src/ws/queue-constants.ts` y `api/src/ws/queue-model.ts` desde Task 1 (mismos exports públicos). `admitTurn` vive en `queue-model.ts` o `turn-queue.ts`; un solo sitio.

- [ ] Extender `api/src/ws/protocol.ts` `ClientMessage`:

```ts
  enqueue?: boolean;
  queueId?: string;
```

No quitar campos existentes.

- [ ] Extender `api/src/ws/hub.ts` `HubConnection`:

```ts
  turnBusy: boolean;
  turnChatId: string | null;
```

Defaults en `add()`: `turnBusy: false`, `turnChatId: null`. Métodos:

```ts
setTurnBusy(connectionId: string, busy: boolean, chatId: string | null = null) {
  const c = connections.get(connectionId);
  if (!c) return;
  c.turnBusy = busy;
  c.turnChatId = busy ? chatId : null;
},
isDaemonBusy(userId: string, workspaceId: string): boolean {
  return Boolean(this.findDaemon(userId, workspaceId)?.turnBusy);
},
```

Si el plan 2 ya los añadió, **no** duplicar. `listForUser` **no** necesita exponer la cola (el snapshot va por WS).

- [ ] Crear `api/src/ws/turn-queue.ts` — registro por `${userId}:${workspaceId}`:

```ts
import { TurnQueue, type QueueItem, type QueueSnapshot } from "./queue-model";

const queues = new Map<string, TurnQueue>();

export function queueKey(userId: string, workspaceId: string): string {
  return `${userId}:${workspaceId}`;
}

export function getQueue(userId: string, workspaceId: string): TurnQueue {
  const k = queueKey(userId, workspaceId);
  let q = queues.get(k);
  if (!q) {
    q = new TurnQueue(workspaceId);
    queues.set(k, q);
  }
  return q;
}

export function resetQueuesForTests(): void {
  queues.clear();
}
```

Exportar también `hydrateFromMessages` (puro, testeable): de una lista de `{ id, chatId, content, metadata, createdAt }` filtra `kind===queued_turn && queueStatus===queued`, ordena por `createdAt` asc, construye `QueueItem[]` con `queueId: id`, `skipUserAppend: true`.

- [ ] Tests `api/src/ws/queue-model.test.ts`: mismos casos FIFO/admit que CLI (mínimo enqueue/cancel/promote/full/CI). Si el archivo CLI ya cubre el algoritmo, aquí al menos **admitTurn** + **hydrateFromMessages** (2 queued, 1 cancelled ignorado, orden cronológico).

- [ ] Tests `api/src/ws/turn-queue.test.ts` (sin Postgres): `getQueue` misma key reusa instancia; keys distintas no se mezclan; `resetQueuesForTests` aísla.

- [ ] En `api/src/ws/handlers.ts`:

  1. Importar `admitTurn`, constantes, `getQueue`, `hydrateFromMessages`, `QUEUE_KIND`, statuses, `promptPreview`.

  2. Helper `async function persistQueuedUser(...)` inserta en `chatMessages` igual que `chat.append` (mismo shape: `id`, `chatId`, `role: "user"`, `content`, `metadata`, `createdAt`) y broadcast `message.appended`. `id` = `queueId` = `crypto.randomUUID()`.

  3. Helper `async function patchQueueStatus(messageId, status)`: update `metadata.queueStatus` (merge con metadata previa). Broadcast `message.appended` `{ updated: true }`.

  4. Helper `function broadcastQueue(userId, snap: QueueSnapshot)` → `broadcast(userId, "agent.queue.updated", snap)`.

  5. Helper `async function dispatchToDaemon(...)`:
     - `hub.sendTo(daemon.connectionId, hub.pushEvent("agent.turn.dispatch", { chatId, prompt, queueId, skipUserAppend, executionMode, requestId, workspaceId, path, sessionId, requesterConnectionId }))`.
     - Si `!sent` → fail `"Daemon connection unavailable"` y **no** marcar busy.
     - `hub.setTurnBusy(daemon.connectionId, true, chatId)`.
     - `getQueue(...).running = { chatId, queueId }`.
     - `broadcastQueue(..., snapshot("started" | "promoted", queueId))`.

  6. Helper `async function maybeDrain(userId, workspaceId)`:
     - `daemon = hub.findDaemon(...)`. Si `null`, no promover (la cola se queda).
     - Si `daemon.turnBusy`, return.
     - `next = queue.promote()`. Si `null`, `running = null`, `broadcastQueue(drained)`, return.
     - `patchQueueStatus(next.queueId, "dispatched")`.
     - `dispatchToDaemon` con `skipUserAppend: true`, `prompt: next.prompt`, `queueId: next.queueId`, `executionMode: next.executionMode`.
     - `broadcastQueue(promoted, next.queueId)`.

  7. Helper `async function onTurnFinished(userId, workspaceId, chatId)`:
     - Si `queue.running && queue.running.chatId !== chatId` → return (stale).
     - `daemon = hub.findDaemon`. Si existe, `hub.setTurnBusy(daemon.connectionId, false, null)`.
     - `queue.running = null`.
     - `await maybeDrain(userId, workspaceId)`.

  8. Sustituir el case `agent.turn.request` (si el plan 2 ya hace `fail(TURN_BUSY_ERROR)`, **reemplazar** ese fail):

```ts
case "agent.turn.request": {
  if (!msg.chatId || !msg.prompt?.trim()) {
    return fail(type, id, "chatId and prompt are required");
  }
  const ctx = await workspaceIdForChat(msg.chatId, userId);
  if (!ctx) return fail(type, id, "Chat not found");
  const daemon = hub.findDaemon(userId, ctx.workspaceId);
  const queue = getQueue(userId, ctx.workspaceId);
  const enqueueFlag = msg.enqueue !== false;
  const decision = admitTurn({
    hasDaemon: Boolean(daemon),
    busy: Boolean(daemon && (daemon.turnBusy || queue.running)),
    queueLength: queue.length,
    enqueue: enqueueFlag,
  });
  if (decision.action === "reject") {
    return fail(type, id, decision.error);
  }
  const prompt = msg.prompt.trim();
  const executionMode =
    typeof msg.metadata?.executionMode === "string"
      ? msg.metadata.executionMode
      : undefined; // si plan 3 estampa prefs aquí, leer prefs; no inventar default local
  if (decision.action === "dispatch") {
    const wsRows = await db.select().from(workspaces)
      .where(eq(workspaces.id, ctx.workspaceId)).limit(1);
    const sentOk = await dispatchToDaemon({
      daemon: daemon!,
      userId,
      connectionId,
      id,
      chatId: msg.chatId,
      prompt,
      workspaceId: ctx.workspaceId,
      path: wsRows[0]?.path || daemon!.path,
      sessionId: ctx.session.id,
      queueId: undefined,
      skipUserAppend: false,
      executionMode,
    });
    if (!sentOk) return fail(type, id, "Daemon connection unavailable");
    return ok(type, id, {
      accepted: true,
      queued: false,
      daemonConnectionId: daemon!.connectionId,
    });
  }
  // enqueue
  const queueId = crypto.randomUUID();
  const { position } = queue.enqueue({
    queueId,
    chatId: msg.chatId,
    workspaceId: ctx.workspaceId,
    prompt,
    createdAt: new Date().toISOString(),
    executionMode: executionMode as QueueItem["executionMode"],
    skipUserAppend: true,
  });
  await persistQueuedUser({
    id: queueId,
    chatId: msg.chatId,
    content: prompt,
    metadata: {
      kind: QUEUE_KIND,
      queueId,
      queueStatus: QUEUE_STATUS_QUEUED,
      position,
      executionMode,
    },
  });
  broadcastQueue(userId, queue.snapshot("enqueued", queueId));
  return ok(type, id, {
    accepted: true,
    queued: true,
    position,
    queueId,
    daemonConnectionId: daemon!.connectionId,
  });
}
```

  Si el plan 3 ya lee `user_preferences.activeExecutionMode` en request, **seguir haciéndolo** y estamparlo en el item encolado y en el dispatch inmediato. No hardcodear `"ask"` en el API si las prefs no están; omitir el campo.

  9. Nuevos cases:

```ts
case "agent.queue.cancel": {
  if (!msg.queueId) return fail(type, id, "queueId is required");
  // buscar en todas las colas del user (pocos workspaces) o resolver via message row
  const rows = await db.select().from(chatMessages)
    .where(eq(chatMessages.id, msg.queueId)).limit(1);
  const row = rows[0];
  if (!row) return ok(type, id, { cancelled: false, error: QUEUE_NOT_FOUND });
  const ctx = await workspaceIdForChat(row.chatId, userId);
  if (!ctx) return fail(type, id, "Chat not found");
  const queue = getQueue(userId, ctx.workspaceId);
  const removed = queue.cancel(msg.queueId);
  await patchQueueStatus(msg.queueId, QUEUE_STATUS_CANCELLED);
  broadcastQueue(userId, queue.snapshot("cancelled", msg.queueId));
  return ok(type, id, {
    cancelled: true,
    wasQueued: Boolean(removed),
    message: QUEUE_CANCELLED,
  });
}

case "agent.queue.list": {
  const workspaceId = msg.metadata?.workspaceId
    ? String(msg.metadata.workspaceId)
    : (msg.chatId
        ? (await workspaceIdForChat(msg.chatId, userId))?.workspaceId
        : null);
  if (!workspaceId) return fail(type, id, "workspaceId or chatId is required");
  const queue = getQueue(userId, workspaceId);
  return ok(type, id, queue.snapshot("hydrated"));
}

case "agent.turn.started": {
  if (!msg.chatId) return fail(type, id, "chatId is required");
  const ctx = await workspaceIdForChat(msg.chatId, userId);
  if (!ctx) return fail(type, id, "Chat not found");
  hub.setTurnBusy(connectionId, true, msg.chatId);
  const queue = getQueue(userId, ctx.workspaceId);
  queue.running = {
    chatId: msg.chatId,
    queueId: msg.queueId,
    streamId: msg.streamId,
  };
  broadcastQueue(userId, queue.snapshot("started", msg.queueId));
  return ok(type, id, { busy: true });
}

case "agent.turn.ended": {
  if (!msg.chatId) return fail(type, id, "chatId is required");
  const ctx = await workspaceIdForChat(msg.chatId, userId);
  if (!ctx) return fail(type, id, "Chat not found");
  await onTurnFinished(userId, ctx.workspaceId, msg.chatId);
  return ok(type, id, { ended: true });
}
```

Cancel **idempotente**: si el id no está en el FIFO pero el mensaje existe, igual se marca `cancelled` y `wasQueued: false`. No despacha. Cancel del **running** por este RPC: si `queue.running?.queueId === msg.queueId`, **no** abortar el turn (eso es `agent.turn.cancel`); devolver `fail` con `"Turn is running — use agent.turn.cancel"` **o** `ok { cancelled: false, running: true }`. Elegir `ok { cancelled: false, running: true, error: TURN_BUSY_ERROR }` para no inventar un string más.

  10. En `chat.stream.end` y `chat.stream.error` **después** de persistir/broadcast existentes: si `msg.chatId`, `workspaceIdForChat` + `onTurnFinished`. Idempotente.

  11. En `workspace.bind` cuando `clientKind === "daemon"`: tras `setClientKind`, `hydrate` si `queue.length === 0` (SELECT messages join chats join sessions where workspace y metadata.kind queued_turn queued) y `maybeDrain`. Así un restart de API + daemon nuevo retoma la cola persistida.

- [ ] Si `executionMode` se lee de prefs (plan 3): hacerlo **una vez** al request (dispatch e enqueue). El queued no vuelve a leer prefs.

- [ ] Tests de handler: si el repo aún no monta WS en unit tests, extraer `admitTurn` + un `promoteAndDispatchPlan(queue, busy, hasDaemon)` testeado en `turn-queue.test.ts` que cubra: busy→enqueue, ended→promote, cancel→no promote de ese id, sin daemon→no promote. Un smoke en Task 7 cubre el WS real.

- [ ] Correr:

```bash
cd api && bun test src/ws/queue-model.test.ts src/ws/turn-queue.test.ts
```

Esperado: todos pasan.

- [ ] Commit:

```bash
git add api/src/ws/queue-constants.ts api/src/ws/queue-model.ts \
  api/src/ws/turn-queue.ts api/src/ws/queue-model.test.ts \
  api/src/ws/turn-queue.test.ts api/src/ws/hub.ts \
  api/src/ws/protocol.ts api/src/ws/handlers.ts api/package.json
git commit -m "feat(queue): API FIFO per workspace, cancel, drain on turn end"
```

---

## Task 3: Daemon + TUI runner — 1 running, started/ended, skipUserAppend

**Files:**

- Modify: `cli/src/ws/daemon.ts`
- Modify: `cli/src/llm/publish-turn.ts`
- Modify: `tui/src/App.tsx`
- Test: `cli/src/llm/publish-turn.queue.test.ts`

El daemon **nunca** corre dos `publishAgentTurn`. Si llega un dispatch stale con `turnBusy`, **no** lo ignora en silencio: emite `chat.stream.error` con `TURN_BUSY_ERROR` (el API no debería mandarlo; cinturón).

- [ ] En `cli/src/llm/publish-turn.ts`, al inicio (tras resolver prompt) y en el `finally` real — envolver el cuerpo:

El archivo hoy no tiene `finally` de ended. Añadir, **sin** cambiar el stream/tools:

```ts
await client.request({
  type: "agent.turn.started",
  chatId,
  streamId,
  queueId: input.queueId,
});
try {
  // ... append user unless skipUserAppend, run Claude, stream end
} finally {
  await client.request({
    type: "agent.turn.ended",
    chatId,
    streamId,
    status: "finished", // el caller puede pasar "error" si throw
  });
}
```

Extender el input:

```ts
  queueId?: string;
  skipUserAppend?: boolean; // ya existe
  executionMode?: string;   // si el runner del plan 3 lo lee; si no, ignorar
```

Si `started`/`ended` fallan porque el API aún no tiene el case, el `request` devuelve `ok: false`. **No** tirar el turn: log y seguir. Tras Task 2 el case existe.

El `finally` de `ended` debe correr también en el catch de stream.error (después de emitir error). Un solo `ended` por turn.

- [ ] Test `cli/src/llm/publish-turn.queue.test.ts`: mock de `client.request` + `runClaudeTurn`. Con `skipUserAppend: true` **no** hay `chat.append`. Siempre hay `agent.turn.started` antes del stream y `agent.turn.ended` en success y en throw. No llamar al LLM real.

Si `publish-turn.ts` es difícil de mockear por imports de `apiFetch`, extraer `export async function emitTurnBookends(client, { chatId, streamId, queueId, phase: "start" | "end", status? })` a `cli/src/queue/bookends.ts` y testear eso + que `publishAgentTurn` lo llama. Preferir extraer si el mock se complica.

- [ ] En `cli/src/ws/daemon.ts` el `onPush`:

```ts
if (msg.type !== "agent.turn.dispatch") return;
const data = (msg.data || {}) as {
  chatId?: string;
  prompt?: string;
  path?: string;
  queueId?: string;
  skipUserAppend?: boolean;
  executionMode?: string;
};
if (!data.chatId || !data.prompt) {
  log("dispatch missing chatId/prompt");
  return;
}
if (turnBusy) {
  log("turn already running — rejecting dispatch");
  await client.request({
    type: "chat.stream.error",
    chatId: data.chatId,
    streamId: crypto.randomUUID(),
    content: "Turn already running on this daemon",
  });
  return;
}
turnBusy = true;
try {
  await publishAgentTurn({
    client,
    chatId: data.chatId,
    prompt: data.prompt,
    cwd: data.path || path,
    token: config.accessToken!,
    skipUserAppend: Boolean(data.skipUserAppend),
    queueId: data.queueId,
    executionMode: data.executionMode,
  });
} catch (err) {
  log(`turn fail: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  turnBusy = false;
}
```

`publishAgentTurn` ya emite `ended`; el API drena. El `turnBusy` local evita solapes si el drain llega antes de salir del finally (el API no despacha hasta `ended`, que es await dentro de publish; el orden es: ended request → API drain → nuevo dispatch push. El push puede llegar **antes** de `turnBusy = false` del finally). Por eso el cinturón: si eso pasa, el error stream hace que el API vea un error del chat **nuevo** y podría drenar mal.

Mitigación concreta: en daemon, **no** poner `turnBusy = false` hasta el final, y el API **no** despacha el siguiente hasta haber procesado `ended` del actual. El nuevo dispatch llega como push en el mismo socket. Si el message handler de `ChavezWsClient` no await los onPush (`cli/src/ws/client.ts` llama `h(raw)` sin await), el segundo dispatch puede entrar mientras `turnBusy` aún true.

Fix obligatorio en daemon:

```ts
const pending: Array<() => void> = [];
// after finally turnBusy = false:
const next = pending.shift();
if (next) next();
```

Más simple y suficiente: **serializar** dispatches:

```ts
let chain = Promise.resolve();
client.onPush((msg) => {
  if (msg.type !== "agent.turn.dispatch") return;
  chain = chain.then(() => runDispatch(msg)).catch((err) => log(String(err)));
});
```

`runDispatch` contiene el `turnBusy` + `publishAgentTurn`. Así el segundo dispatch **espera** al primero. Si el API ya espera `ended`, esto es belt-and-suspenders. **Usar la chain** (no un drop silencioso).

- [ ] En `tui/src/App.tsx`:

  1. El handler `agent.turn.dispatch` usa la **misma** semántica: si `turnBusyRef`, **no** drop silencioso. Encadenar con un `dispatchChainRef: Promise<void>` igual que el daemon, **o** si busy, `setLog(TURN_BUSY_ERROR)` + `chat.stream.error` y return. Preferir chain para no perder el queued que el API acaba de promover.

  2. Pasar `skipUserAppend: Boolean(data.skipUserAppend)` y `queueId: data.queueId` a `publishAgentTurn`.

  3. `sendWithLlm` **deja de** llamar `publishAgentTurn` directo. Solo:

```ts
const sendWithLlm = useCallback(async (text: string) => {
  if (!client || !activeChatId) return;
  if (provider !== "claude") { /* stub Cursor existente: chat.append + log; return */ }
  if (!providersInfo?.providers.claude?.linked) {
    setLog("Claude no está vinculado — chavez provider link claude");
    return;
  }
  const res = await client.request({
    type: "agent.turn.request",
    chatId: activeChatId,
    prompt: text,
  });
  if (!res.ok) {
    setLog(res.error || "agent.turn.request failed");
    return;
  }
  const data = (res.data || {}) as { queued?: boolean; position?: number };
  if (data.queued) {
    setLog(`${TUI_QUEUED_HINT}${data.position}`);
    return;
  }
  setLog("Turn aceptado");
}, [/* deps sin turnBusyRef como guard del send */]);
```

  El `busy` / `turnBusyRef` lo pone el handler de dispatch (running). Encolar **no** pone `busy` extra (ya lo está el running).

  4. Quitar el early-return `if (turnBusyRef.current) { setLog("Ya hay un turn en curso"); return; }` de `sendWithLlm`.

- [ ] Correr:

```bash
cd cli && bun test src/llm/publish-turn.queue.test.ts src/queue/model.test.ts
```

Esperado: pasan. El TUI se verifica en Task 5 + smoke Task 7.

- [ ] Commit:

```bash
git add cli/src/ws/daemon.ts cli/src/llm/publish-turn.ts \
  cli/src/llm/publish-turn.queue.test.ts cli/src/queue/bookends.ts \
  tui/src/App.tsx
git commit -m "feat(queue): daemon serializes turns and emits started/ended"
```

(`bookends.ts` solo si se extrajo.)

---

## Task 4: CLI headless — no-queue, wait-timeout, watch, dequeue

**Files:**

- Modify: `cli/src/commands/headless.ts`
- Modify: `cli/src/index.ts`
- Create: `cli/src/commands/headless-ask-wait.ts`
- Test: `cli/src/commands/headless-ask-wait.test.ts`
- Test: `cli/src/queue/parse-ask-args.test.ts` (ya en Task 1)

- [ ] Crear `cli/src/commands/headless-ask-wait.ts` — espera pura (sin red):

```ts
import { QUEUE_CI_TIMEOUT } from "../queue/constants";

export type WaitOutcome =
  | { ok: true; reason: "dispatched" | "finished" }
  | { ok: false; error: string };

export function onAskPush(
  state: {
    queueId?: string;
    chatId: string;
    promoted: boolean;
    finished: boolean;
    error?: string;
  },
  msg: { type: string; data?: unknown },
): typeof state {
  const data = (msg.data || {}) as {
    chatId?: string;
    changedQueueId?: string;
    reason?: string;
    items?: unknown;
    error?: string;
    status?: string;
  };
  if (msg.type === "agent.queue.updated") {
    if (data.reason === "promoted" && data.changedQueueId === state.queueId) {
      return { ...state, promoted: true };
    }
    if (data.reason === "cancelled" && data.changedQueueId === state.queueId) {
      return { ...state, finished: true, error: "Queued turn cancelled" };
    }
  }
  if (
    (msg.type === "chat.stream.end" || msg.type === "agent.turn.ended") &&
    data.chatId === state.chatId &&
    (state.promoted || !state.queueId)
  ) {
    return { ...state, finished: true };
  }
  if (msg.type === "chat.stream.error" && data.chatId === state.chatId) {
    return {
      ...state,
      finished: true,
      error: String(data.error || "stream error"),
    };
  }
  return state;
}

export function timeoutError(): string {
  return QUEUE_CI_TIMEOUT;
}
```

- [ ] Test `cli/src/commands/headless-ask-wait.test.ts`: secuencia enqueue → `agent.queue.updated promoted` mismo queueId → `chat.stream.end` mismo chatId → `finished`. Un `stream.end` de **otro** chatId no cierra. Timeout no se simula con clock: `timeoutError()` es el string congelado.

- [ ] En `cli/src/commands/headless.ts` `action === "ask"`:

```ts
import { parseAskArgs } from "../queue/parse-ask-args";
import { isNonInteractive, resolveAskPolicy } from "../queue/admission";
import { onAskPush, timeoutError } from "./headless-ask-wait";
import { QUEUE_CI_BUSY, QUEUE_CI_TIMEOUT } from "../queue/constants";

const parsed = parseAskArgs(rest);
if (!parsed.chatId || !parsed.prompt) {
  throw new Error(
    "Uso: … chat ask [--no-queue] [--wait-timeout <ms>] <chatId> <prompt…>",
  );
}
const policy = resolveAskPolicy({
  nonInteractive: isNonInteractive(),
  noQueue: parsed.noQueue,
  waitTimeoutMs: parsed.waitTimeoutMs,
});
const res = await client.request(
  {
    type: "agent.turn.request",
    chatId: parsed.chatId,
    prompt: parsed.prompt,
    enqueue: policy.enqueue,
  },
  30_000,
);
if (!res.ok) throw new Error(res.error);
const data = (res.data || {}) as {
  queued?: boolean;
  position?: number;
  queueId?: string;
  accepted?: boolean;
};
console.log(JSON.stringify(res.data, null, 2));

if (!policy.enqueue && data.queued) {
  // el API no debería encolar si enqueue:false; cinturón
  await client.request({ type: "agent.queue.cancel", queueId: data.queueId });
  throw new Error(QUEUE_CI_BUSY);
}

if (data.queued && policy.waitTimeoutMs <= 0) {
  console.log(
    `Turn encolado posición ${data.position}. Usa chat watch o --wait-timeout.`,
  );
  return;
}

if (!data.queued && policy.waitTimeoutMs <= 0 && process.stdout.isTTY) {
  console.log(
    "Turn aceptado por el daemon. Usa `chat watch` o el hub web para ver el stream.",
  );
  return;
}

// wait path (CI --wait-timeout o interactivo con flag)
if (policy.waitTimeoutMs > 0) {
  let state = {
    queueId: data.queueId,
    chatId: parsed.chatId,
    promoted: !data.queued,
    finished: false as boolean,
    error: undefined as string | undefined,
  };
  const deadline = Date.now() + policy.waitTimeoutMs;
  const done = new Promise<void>((resolve, reject) => {
    const t = setTimeout(async () => {
      if (state.queueId && !state.promoted) {
        await client.request({
          type: "agent.queue.cancel",
          queueId: state.queueId,
        });
      }
      reject(new Error(timeoutError()));
    }, policy.waitTimeoutMs);
    client.onPush((msg) => {
      state = onAskPush(state, msg);
      if (state.finished) {
        clearTimeout(t);
        if (state.error) reject(new Error(state.error));
        else resolve();
      }
    });
  });
  try {
    await done;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    process.exitCode = 1;
    throw err;
  }
  console.log("Turn finished");
  return;
}
```

El RPC `request` debe aceptar `enqueue?: boolean`. Extender `cli/src/ws/client.ts` `WsRequest` con `enqueue?: boolean` y `queueId?: string`.

- [ ] Añadir acciones `queue` y `dequeue`:

```
chat queue [chatId]     → agent.queue.list, imprime JSON snapshot
chat dequeue <queueId>  → agent.queue.cancel
```

Uso en el throw de grupo chat y en `cli/src/index.ts` usage:

```
chavez headless chat create|list|append|get|ask|watch|queue|dequeue
chavez headless chat ask [--no-queue] [--wait-timeout <ms>] <chatId> <prompt…>
```

- [ ] `watch`: ya imprime JSON de cualquier push del `chatId`. Incluir `agent.queue.updated` cuando `data.items` tenga ese `chatId` **o** `data.running?.chatId === chatId` **o** `data.changedQueueId` pertenezca a ese chat. Hoy filtra `data.chatId`; el snapshot **no** tiene `chatId` top-level. Ajustar:

```ts
const data = msg.data as {
  chatId?: string;
  items?: Array<{ chatId?: string }>;
  running?: { chatId?: string };
} | undefined;
const matches =
  data?.chatId === chatId ||
  data?.running?.chatId === chatId ||
  data?.items?.some((it) => it.chatId === chatId);
if (data?.chatId && data.chatId !== chatId && !matches) return;
if (msg.type === "agent.queue.updated" && !matches) return;
```

Watch **no** es notificación OS (plan 24). Sigue siendo log.

- [ ] Correr:

```bash
cd cli && bun test src/commands/headless-ask-wait.test.ts \
  src/queue/parse-ask-args.test.ts src/queue/admission.test.ts
```

Esperado: todos pasan.

- [ ] Commit:

```bash
git add cli/src/commands/headless.ts cli/src/commands/headless-ask-wait.ts \
  cli/src/commands/headless-ask-wait.test.ts cli/src/index.ts \
  cli/src/ws/client.ts
git commit -m "feat(queue): CI ask --no-queue/--wait-timeout and dequeue"
```

---

## Task 5: TUI — compose en busy, posición, cancel, badges

**Files:**

- Modify: `tui/src/App.tsx`
- Create: `tui/src/queue-view.ts`
- Test: `tui/src/queue-view.test.ts`
- Modify: `tui/package.json`

TUI importa `cli/src/queue/constants.ts` y `promptPreview` / tipos de `cli/src/queue/model.ts`.

- [ ] Añadir `"test": "bun test"` en `tui/package.json` `scripts` si no existe.

- [ ] Crear `tui/src/queue-view.ts`:

```ts
import {
  QUEUE_POSITION_PREFIX,
  TUI_QUEUED_HINT,
} from "../../cli/src/queue/constants";
import type { QueueSnapshot } from "../../cli/src/queue/model";

export function formatQueueBadge(
  snap: QueueSnapshot | null,
  chatId: string | null,
): string | null {
  if (!snap || !chatId) return null;
  const item = snap.items.find((it) => it.chatId === chatId);
  if (item) return `${TUI_QUEUED_HINT}${item.position}`;
  const n = snap.items.length;
  if (n > 0) return `${QUEUE_POSITION_PREFIX}${n}`;
  return null;
}

export function lastQueuedIdForChat(
  snap: QueueSnapshot | null,
  chatId: string | null,
): string | null {
  if (!snap || !chatId) return null;
  const items = snap.items.filter((it) => it.chatId === chatId);
  return items[items.length - 1]?.queueId ?? null;
}

export function isQueuedMessage(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object") return false;
  const m = metadata as Record<string, unknown>;
  return m.kind === "queued_turn" && m.queueStatus === "queued";
}
```

- [ ] Test `tui/src/queue-view.test.ts`: item del chat activo → `queued #2`; otro chat con cola global → `queued · #1` (length); vacío → `null`. `lastQueuedIdForChat` toma el último del chat.

- [ ] En `tui/src/App.tsx`:

  1. `type Message = { id: string; role: string; content: string; metadata?: Record<string, unknown> | null }`.

  2. Estado `queueSnap` (`QueueSnapshot | null`). En `onPush`, si `msg.type === "agent.queue.updated"`, `setQueueSnap(msg.data)`. Tras bind, `client.request({ type: "agent.queue.list", chatId: active })` si hay chat.

  3. **Compose mientras busy:** en `mode === "compose"` **quitar** `if (busy) return`. Enter llama `sendWithLlm` (Task 3 ya encola). Vacío sigue cancelando compose.

  4. En command mode, **permitir** `m` (compose) aunque `busy`. El bloque `if (busy) return` debe ir **después** de `m`, o exceptuar `ch === "m"`.

  5. Tecla `x` (command mode): `queueId = lastQueuedIdForChat(queueSnap, activeChatId)`; si hay, `agent.queue.cancel`; si no, `setLog("No hay queued en este chat")`. No cancela el running.

  6. Header/log: si `busy`, seguir `… generando respuesta`. Si `formatQueueBadge`, línea cyan `queued #N`. Hint: `TUI_COMPOSE_WHILE_BUSY` cuando `busy || (queueSnap?.items.length ?? 0) > 0`.

  7. Lista de chats: si `snap.items.some(it => it.chatId === c.id)` pintar sufijo ` · queued #P` con la posición de ese chat (la primera si hay varias: `find`).

  8. Timeline: si `isQueuedMessage(m.metadata)` prefijo `[queued] ` en el content mostrado.

  9. Avisos in-app (Gherkin plan 24): si existe `cli/src/notifications/classify.ts`, llamarlo en `onPush` para `agent.queue.updated` con `reason === "promoted" | "drained"` y, si `activeChatId !== changed chat`, `setLog(QUEUE_PROMOTED_LABEL)` / `QUEUE_DONE_LABEL`. Si el classifier no existe, con `reason === "promoted"` y el chat no activo: `setLog(QUEUE_PROMOTED_LABEL)`; `chat.stream.end` de otro chat ya se ignora hoy — añadir: si `data.chatId !== active` y tipo end, `setLog(QUEUE_DONE_LABEL)`. **No** `notify-send`.

  10. Footer help: añadir `[x] dequeue`.

- [ ] Correr:

```bash
cd tui && bun test src/queue-view.test.ts
```

Esperado: pasa.

- [ ] Commit:

```bash
git add tui/src/App.tsx tui/src/queue-view.ts tui/src/queue-view.test.ts tui/package.json
git commit -m "feat(queue): TUI enqueue while busy, position, cancel"
```

---

## Task 6: Web — composer encola, card queued, cancel, badges, classify

**Files:**

- Create: `web/src/lib/queue.ts`
- Test: `web/src/lib/queue.test.ts`
- Modify: `web/src/lib/ws-client.ts`
- Modify: `web/src/lib/ws-hooks.ts`
- Modify: `web/src/lib/ws-context.tsx`
- Modify: `web/src/components/ChatDetailPanel.tsx`
- Modify: `web/src/components/WorkspaceDetailPanel.tsx`
- Modify: `web/src/components/SessionDetailPanel.tsx`
- Modify: `web/src/styles/global.css`
- Modify: `web/package.json`

Web **no** importa CLI. `web/src/lib/queue.ts` duplica constants usadas en UI + `promptPreview` + `isQueuedMessage` + `formatWebQueueHint(position)` = `` `${WEB_QUEUED_HINT} ${position}` ``. Comentario keep-in-sync.

- [ ] Añadir `"test": "bun test"` en `web/package.json` `scripts` si no existe.

- [ ] `web/src/lib/queue.ts` — tipos `QueueSnapshot` idénticos al CLI, helpers `isQueuedMessage`, `formatWebQueueHint`, `classifyQueueNotify(type, data, activeChatId)`:

```ts
export function classifyQueueNotify(
  type: string,
  data: { reason?: string; changedQueueId?: string; items?: Array<{ chatId: string }>; running?: { chatId?: string } },
  activeChatId: string | null,
): { kind: "queue_promoted" | "queue_done" | "queue_enqueued"; title: string; chatId?: string } | null {
  if (type !== "agent.queue.updated") return null;
  if (data.reason === "enqueued") {
    return { kind: "queue_enqueued", title: "Turn encolado" };
  }
  if (data.reason === "promoted") {
    return { kind: "queue_promoted", title: "Turn en cola iniciado", chatId: data.running?.chatId };
  }
  if (data.reason === "drained" || data.reason === "started") return null;
  return null;
}
```

`queue_enqueued` **no** genera toast si el usuario acaba de enviar (el form ya muestra el hint). `queue_promoted` / done: toast **solo** si `chatId !== activeChatId`. Deltas nunca.

Si `web/src/lib/notifications.ts` (plan 24) existe, **añadir** `agent.queue.updated` a `NOTIFICATION_SOURCE_TYPES` y estos kinds; no crear un bus paralelo. Si no existe, ChatDetailPanel usa `classifyQueueNotify` + un `<p className="ok">` efímero (8s), sin Notification API.

- [ ] Test `web/src/lib/queue.test.ts`: hint posición 2; `isQueuedMessage`; classify promoted de otro chat vs activo (activo → null para toast de promoted si `activeChatId === running.chatId`); `enqueued` devuelve kind (la UI decide no tostar).

- [ ] Extender `web/src/lib/ws-client.ts` `WsRequest` con `enqueue?: boolean; queueId?: string`.

- [ ] Extender `web/src/lib/ws-hooks.ts`:

```ts
export function useWsAgentTurn() {
  const ws = useWs();
  return useMutation({
    mutationFn: (input: { chatId: string; prompt: string; enqueue?: boolean }) =>
      ws.request({
        type: "agent.turn.request",
        chatId: input.chatId,
        prompt: input.prompt,
        enqueue: input.enqueue,
      }),
  });
}

export function useWsQueueCancel() {
  const ws = useWs();
  return useMutation({
    mutationFn: (queueId: string) =>
      ws.request({ type: "agent.queue.cancel", queueId }),
  });
}
```

Extender el tipo de `request` en `ws-context.tsx` para permitir `queueId` y `enqueue`.

- [ ] En `ws-context.tsx` `onPush`, invalidar también si `msg.type === "agent.queue.updated"` (`queryKeys.chat` para cada `items[].chatId` + `["workspaceSessions"]` + `["sessionChats"]`).

- [ ] `ChatDetailPanel.tsx`:

  1. Estado `queueSnap`. `onPush` `agent.queue.updated` → set. Al montar, `ws.request({ type: "agent.queue.list", chatId })`.

  2. `onAgent`: **no** deshabilitar el textarea/botón por `streaming`. Tras `mutateAsync`, leer `res.data.queued` / `position`:

```ts
const data = res.data as { queued?: boolean; position?: number } | undefined;
if (data?.queued) {
  setMsg({ kind: "ok", text: `${WEB_QUEUED_HINT} ${data.position}` });
} else {
  setMsg({ kind: "ok", text: "Turn aceptado — TUI o headless daemon ejecutará el agente." });
}
```

  El botón: `disabled={agent.isPending || ws.status !== "open"}` — **sin** `streaming`.

  3. Timeline: si `isQueuedMessage(m.metadata)`, card con badge `queued · #N` (`metadata.position` o live `queueSnap.items.find(queueId === m.id)?.position`) y botón `Quitar de la cola` → `useWsQueueCancel`. Disabled si WS no open.

  4. Strip sobre el composer: `Cola: N` + lista corta (máx 5) `posición · preview · [quitar]`.

  5. Banner in-app: `classifyQueueNotify` cuando el chat **no** es el activo no aplica dentro de esta isla (esta isla es el chat). Para promoted de **este** chat: el stream.start ya se ve; no toast. Para `queue_enqueued` el `setMsg` basta.

  6. **Ask:** un mensaje queued **no** pinta botones de approval (solo `role=tool` + `awaiting_approval` lo hace, plan 13). Verificar que `ToolCard` no se usa para `queued_turn`. No hay tool cards hasta running.

- [ ] `WorkspaceDetailPanel.tsx` y `SessionDetailPanel.tsx`: estado snap; onPush `agent.queue.updated`; en cada fila de chat, si hay item, `<span className="badge">queued · #P</span>`. `agent.queue.list` con `workspaceId` (workspace panel) o `chatId` del primer chat / session vía metadata.workspaceId si el list por session no existe — usar `chatId` de cada chat es N requests; **un** `agent.queue.list` con `metadata: { workspaceId }` desde el workspace. Session panel: list con el `workspaceId` ya cargado (`session.data.workspace.id`).

  Añadir `metadata?:` en el `request` del context si aún no está (ya está).

- [ ] CSS mínimo en `web/src/styles/global.css`:

```css
.badge.queued {
  background: color-mix(in srgb, #c9a227 35%, var(--panel));
  color: #f3e6b0;
}
```

Usar `className="badge queued"` en las cards. No rediseñar el layout.

- [ ] Si plan 24 `NotificationHost` existe, registrar `queue_promoted` / `queue_done` con títulos congelados. Si no, el strip + `setMsg` + badge de lista **cumplen** “Web/TUI lo reflejan”. Cero `new Notification`, cero email.

- [ ] Correr:

```bash
cd web && bun test src/lib/queue.test.ts
```

Esperado: pasa.

- [ ] Commit:

```bash
git add web/src/lib/queue.ts web/src/lib/queue.test.ts web/src/lib/ws-client.ts \
  web/src/lib/ws-hooks.ts web/src/lib/ws-context.tsx \
  web/src/components/ChatDetailPanel.tsx \
  web/src/components/WorkspaceDetailPanel.tsx \
  web/src/components/SessionDetailPanel.tsx \
  web/src/styles/global.css web/package.json
git commit -m "feat(queue): Web enqueue with position, cancel, in-app badges"
```

---

## Task 7: Notificaciones (plan 24), smoke Gherkin, CI

**Files:**

- Modify: `cli/src/notifications/classify.ts` (si existe)
- Modify: `cli/src/notifications/constants.ts` (si existe)
- Test: `cli/src/notifications/classify.test.ts` (extender o crear)
- Create: `cli/src/queue/notify.ts`
- Test: `cli/src/queue/notify.test.ts`
- Create: `cli/scripts/turn-queue-smoke.ts`
- Modify: `web/src/lib/notifications.ts` (si existe)

- [ ] Crear `cli/src/queue/notify.ts` (también usado si plan 24 no está):

```ts
import {
  QUEUE_DONE_LABEL,
  QUEUE_ENQUEUED_LABEL,
  QUEUE_PROMOTED_LABEL,
} from "./constants";

export function classifyQueueEvent(
  type: string,
  data: unknown,
  activeChatId: string | null,
): { title: string; sticky: false; chatId?: string } | null {
  if (type === "chat.stream.delta" || type === "chat.thinking.delta") return null;
  if (type === "agent.queue.updated") {
    const d = (data || {}) as {
      reason?: string;
      running?: { chatId?: string };
      items?: Array<{ chatId: string }>;
      changedQueueId?: string;
    };
    if (d.reason === "promoted") {
      const chatId = d.running?.chatId;
      if (chatId && chatId === activeChatId) return null; // el stream ya se ve
      return { title: QUEUE_PROMOTED_LABEL, sticky: false, chatId };
    }
    if (d.reason === "enqueued") {
      return { title: QUEUE_ENQUEUED_LABEL, sticky: false };
    }
    return null;
  }
  if (type === "chat.stream.end") {
    const chatId = (data as { chatId?: string } | undefined)?.chatId;
    if (chatId && chatId === activeChatId) return null;
    if (chatId) return { title: QUEUE_DONE_LABEL, sticky: false, chatId };
  }
  return null;
}
```

- [ ] Test `cli/src/queue/notify.test.ts`: delta → null; promoted otro chat → `QUEUE_PROMOTED_LABEL`; promoted chat activo → null; stream.end otro chat → `QUEUE_DONE_LABEL`; enqueued → label.

- [ ] Si `cli/src/notifications/classify.ts` existe: importar `classifyQueueEvent` al final del classify (antes de default null). Añadir `"agent.queue.updated"` a `NOTIFICATION_SOURCE_TYPES`. **No** añadir `ui.notification`. Web duplicado si `web/src/lib/notifications.ts` existe. Tests del plan 24 siguen verdes (deltas siguen sin aviso).

- [ ] Crear `cli/scripts/turn-queue-smoke.ts`. Daemon **falso** (no Claude): un WS `clientKind: "daemon"` cuyo `onPush` serializa `agent.turn.dispatch`:

```
1. bind daemon + client web
2. session.create + chat.create
3. daemon latch: primer dispatch espera 1500ms, luego stream.start/end + agent.turn.ended
   (sin publishAgentTurn / sin LLM)
4. web agent.turn.request "first" → accepted queued:false
5. web agent.turn.request "second" → queued:true position:1  (NO silencio, NO TURN_BUSY)
6. assert message.appended user second con metadata.kind queued_turn
7. assert agent.queue.updated items[0].position === 1
8. esperar promote: segundo dispatch llega al daemon con skipUserAppend true y prompt "second"
9. stream.end del segundo → cola vacía
10. request "a" (hold), request "b" y "c"; cancel queueId de "b";
    al terminar "a", el siguiente prompt es "c" (b no corre)
11. enqueue:false + busy → error incluye "not queued" o QUEUE_CI_BUSY
12. --wait-timeout simulado: enqueue + timeout 30ms → cancel + error QUEUE_CI_TIMEOUT
```

El daemon falso **no** llama tools: cubre “queued no pide aprobación” porque no hay `chat.tool.update`. Añadir assert: durante el item queued, **cero** eventos `chat.tool.update` / `awaiting_approval`.

Sin token/API: exit 2 con mensaje claro (como otros smokes). Con API: `SMOKE PASS` y líneas `ok enqueue-position`, `ok promote-fifo`, `ok cancel-skipped`, `ok ci-no-queue`, `ok ci-timeout-cancels`, `ok no-approval-while-queued`.

Latch del primer turn: `await Bun.sleep(1500)` **después** de `agent.turn.started` para que el segundo request vea `turnBusy`.

- [ ] Correr unitarios + smoke:

```bash
cd cli && bun test src/queue/model.test.ts src/queue/admission.test.ts \
  src/queue/parse-ask-args.test.ts src/queue/notify.test.ts \
  src/commands/headless-ask-wait.test.ts src/llm/history.test.ts \
  src/llm/publish-turn.queue.test.ts
cd api && bun test src/ws/queue-model.test.ts src/ws/turn-queue.test.ts
cd tui && bun test src/queue-view.test.ts
cd web && bun test src/lib/queue.test.ts
```

Esperado: todos pasan.

```bash
cd cli && bun run scripts/turn-queue-smoke.ts
```

Esperado: `SMOKE PASS`.

- [ ] Commit:

```bash
git add cli/src/queue/notify.ts cli/src/queue/notify.test.ts \
  cli/scripts/turn-queue-smoke.ts cli/src/notifications \
  web/src/lib/notifications.ts
git commit -m "test(queue): FIFO promote, cancel, CI timeout, in-app classify"
```

---

## Orden de ejecución

1. Task 1 (módulos puros + history) — no depende de API.
2. Task 2 (API cola) — no depende del runner.
3. Task 3 (daemon/TUI runner) — depende de Task 1–2 (`started`/`ended`/`skipUserAppend`).
4. Task 4 (CLI CI) — depende de Task 2.
5. Task 5 (TUI UI) — depende de Tasks 2–3.
6. Task 6 (Web UI) — depende de Task 2.
7. Task 7 (notify + smoke) — al final; Tasks 4–6 paralelizables tras 1–3.

## Verificación Gherkin → task

| Escenario | Dónde se cubre |
|---|---|
| Segundo prompt se encola; no se rechaza en silencio; posición; al terminar arranca el siguiente | Task 1 FIFO; Task 2 `admitTurn` enqueue + drain; Task 3 chain dispatch; Task 5/6 UI posición; Task 7 smoke `ok enqueue-position` / `ok promote-fifo` |
| Cancelar de la cola; no corre | Task 1 `cancel`; Task 2 `agent.queue.cancel` + status cancelled + history skip; Task 4 `dequeue`; Task 5 tecla `x`; Task 6 botón; Task 7 `ok cancel-skipped` |
| Modo ask en cola: no pide aprobación hasta running | Task 2 no despacha SDK al encolar; Task 3 skipUserAppend solo al promote; Task 6 no ToolCard en queued; Task 7 cero `chat.tool.update` mientras queued |
| Aviso in-app (plan 24) queued → running o done | Task 5 log/badge otro chat; Task 6 classify + badges listas; Task 7 `classifyQueueEvent` |
| CI: esperar timeout o fallar; no encola para siempre | Task 1 `resolveAskPolicy`; Task 4 `--no-queue` / `--wait-timeout` + cancel al vencer; Task 7 `ok ci-no-queue` / `ok ci-timeout-cancels` |

## Fuera de este plan (no implementar)

- Worktrees paralelos / cwd picker → [worktree-cwd](../worktree-cwd/plan.md). Esta cola despacha **1** turn al cwd actual del daemon.
- Cursor ejecutable → [cursor-provider](../cursor-provider/plan.md). El FIFO es agnóstico del runner.
- Approvals una a una / timeout ask → [approvals](../approvals/plan.md). El queued no abre waiter.
- Notificaciones OS / email / tabla de avisos → prohibido (decisión 13). Solo in-app.
- Compact/undo/steer como items de cola genérica → siguen sus RPCs y `TURN_BUSY_ERROR` si no deben encolarse.
- “Cancelar todos”, lote, “siempre permitir”.
- Cursor cloud, voz, extensión IDE, upload desde el navegador.
- Tabla SQL `turn_queue` / migración Drizzle.
