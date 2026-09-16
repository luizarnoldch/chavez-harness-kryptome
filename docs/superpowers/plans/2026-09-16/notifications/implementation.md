# Notifications Implementation Plan

> **For agentic workers:** Execute task-by-task. Do not skip tests. Do not implement Cursor cloud, voz, extensión IDE, upload desde el navegador, notificaciones OS/email, cola de turns (plan 29), worktrees paralelos (plan 28), slash picker, ni Cursor ejecutable (plan 4). Spec: [`plan.md`](./plan.md). Depende del fan-out WS existente (`chat.stream.*`, `chat.tool.*`) y, si ya aterrizaron, de `awaiting_approval` ([`approvals`](../approvals/implementation.md) / [`execution-modes`](../execution-modes/implementation.md)) y de `daemon.presence` / `NO_RUNNER_LABEL` ([`daemon-reconnect`](../daemon-reconnect/implementation.md)). Si un sibling ya creó un archivo citado, **extiéndelo**; no lo reescribas. Esta fase **no** inventa un event `ui.notification`, **no** persiste una tabla de avisos y **no** toca `cli/src/commands/headless.ts` `watch` salvo para un test que prueba que sigue siendo el log.

**Goal:** Web y TUI no pierden un turn ni un ask. Un turn que termina pinta un aviso en el chat/workspace (Web) y un badge en TUI **solo** si el usuario no está en ese chat. Un `awaiting_approval` se destaca hasta resolver o timeout. Sin runner, ambas superficies muestran exactamente **`sin runner`** y el aviso desaparece al reconnect (plan 17). Cientos de `chat.stream.delta` no generan avisos: solo `start` / `end` / `error` / `approval` / `daemon`. CLI `watch` sigue siendo el log JSON (o `formatWatchLine` si el plan 2 lo añadió). Cero Notification API del OS, cero `notify-send`, cero email.

**Architecture:** El filesystem y el runner viven en el daemon (`cli/src/ws/daemon.ts` o TUI `clientKind: "daemon"`). La API **ya** hace fan-out de stream/tools/presencia; esta fase **no** añade un bus de notificaciones ni una fila Postgres. Web y TUI clasifican los pushes existentes con el mismo codec puro y los reducen a un store in-memory. CLI `watch` **no** importa ese store. Un reload hidrata `approval` desde `chat_messages.metadata.status === "awaiting_approval"` y `daemon` desde `daemon.presence` / connections; los toasts de turn done **no** sobreviven reload (son efímeros in-app).

```
daemon / TUI
  chat.stream.start | end | error
  chat.tool.update  status=awaiting_approval
  chat.tool.resolved | result (resolution)
  daemon.presence   bound true|false
        |
        v
API hub.broadcastToUser   (sin event nuevo, sin email)
        |
        +-- Web  classify → store → toast/banner/badge
        +-- TUI  classify → store → badge si chat !== activo
        +-- CLI watch  JSON / formatWatchLine   ← NO store, NO OS
```

Estado actual que este plan extiende (no reescribir):

- `api/src/ws/protocol.ts` `RESERVED_STREAM_TYPES` = start/delta/end/error. `api/src/ws/handlers.ts` broadcast de esos tipos + `chat.tool.start` / `result` + `message.appended`. **No** hay `ui.notification`. **No** hay tabla `notifications`.
- `cli/src/llm/publish-turn.ts` emite `chat.stream.start`, un `delta` por chunk, `end`/`error`, `chat.tool.start`/`result`. Un turn típico = 1 start + N deltas + 1 end.
- Web `web/src/lib/ws-context.tsx` invalida queries en `chat.stream.*` / `chat.tool.*`. `ChatDetailPanel.tsx` acumula `streamText` por delta y limpia en end/error. **No** hay toast, **no** hay badge en listas. Cada isla React (`ChatDetailPanel`, `WorkspaceDetailPanel`, `SessionDetailPanel`, `HubPanel`, `WorkspacesPanel`, `NavAuth`) monta su propio `AppProviders` → propio `WsProvider`.
- `WorkspaceDetailPanel.tsx` lista chats con `messageCount`; `SessionDetailPanel.tsx` lista `<a href={/chats/id}>` sin badge. `WorkspacesPanel.tsx` muestra `openConnections`, no “sin runner” (eso lo añade plan 17 `DaemonPresence`).
- TUI `tui/src/App.tsx`: header `status === "bound" ? " · daemon/runner" : ""`. Lista de chats sin badge. `onPush` recarga `chat.get` **solo** si `data.chatId === activeChatId`. Un turn que termina en otro chat no deja marca. `log` es una línea, no un inbox.
- CLI `cli/src/commands/headless.ts` `watch`: `console.log(JSON.stringify({ type, eventId, data }))` por cada push del `chatId`. No hay Notification, no hay `notify-send`.
- `api/src/auth.ts` usa `Resend` para magic link. Esta fase **no** llama a Resend ni añade template de email.
- Cursor `runnable: false`. Los avisos se disparan por el contrato WS, no por el provider: un turn Cursor (cuando plan 4 exista) reutiliza start/end/error. No simular un turn Cursor.
- Plan 13 emite `chat.tool.update` `awaiting_approval` + `chat.tool.resolved`. Si aún no está mergeado, el classifier reconoce esos tipos **y** `chat.tool.start` con `status === "awaiting_approval"`; sin ese event, no hay aviso de ask (no inventar polling HTTP).
- Plan 17 emite `daemon.presence` y pinta `DaemonPresence` con `NO_RUNNER_LABEL = "sin runner"`. Si ya está, **reusa** el copy y el componente; el store solo refleja `kind: "daemon"`. Si no está, esta fase pinta el mismo string.

**Tech Stack:** Bun, Hono WebSocket hub in-memory (fan-out existente, **sin** event nuevo), Drizzle `chat_messages.metadata` jsonb **solo lectura** para hidratar ask (sin migración, sin tabla), Ink TUI, Astro/React islands + TanStack Query. Tests: `bun test`. Web **no** importa CLI: duplicar constants/classify/store en `web/src/lib/notifications.ts` (comentario keep-in-sync). TUI importa `cli/src/notifications/…`.

**Global Constraints:**

1. El filesystem real vive en el daemon. Esta fase **cero** `readdir` / `readFile` / tools. Un aviso no ejecuta el agente ni toca disco.
2. Un turn solo corre si hay daemon bound. El aviso **sin runner** no sustituye `NO_DAEMON_ERROR` en `agent.turn.request`: el request sigue fallando con exactamente `"No daemon bound for this workspace. Run: chavez headless workspace open"`. El badge es el copy corto Gherkin `sin runner`.
3. Web, CLI `watch` y TUI ven el **mismo** chat en vivo. Watch imprime el event; **no** es una notificación in-app ni OS. Web y TUI derivan badges del mismo push.
4. Preferencias de provider/modelo/esfuerzo/modo **no** se tocan.
5. Claude es el provider ejecutable. Los avisos no dependen del nombre del provider: clasifican tipos WS. No simular Cursor.
6. Tools por defecto siguen en el daemon. `chat.tool.start` `running` y `chat.tool.result` `done` **no** generan aviso. Solo `awaiting_approval` (y su resolución, que **quita** el aviso).
7. Lecturas no piden confirmación y no pintan ask. Un `Read`/`Grep`/`Glob`/`LS` nunca entra al store como `approval`.
8. Aprobaciones una a una (plan 13). El badge de ask es **por `toolCallId`**, no un lote. Resolver uno no limpia otro ask del mismo chat.
9. Un usuario = su vault. El store es por isla/proceso del user autenticado. No hay inbox de org ni roles.
10. 1 turn por daemon. Un `turn_start` se sustituye por `turn_done`/`turn_error` del mismo `streamId` (no se apilan start+end como dos badges eternos en TUI).
11. Fuera de alcance: Cursor cloud, voz, extensión IDE, upload desde el navegador, Notification API / Service Worker / `notify-send` / email / Resend, persistir toasts, “siempre permitir”, cola de turns.
12. Astro MPA: cada isla tiene su `AppProviders`. `NavAuth` **no** monta `NotificationHost` (prop `notifications={false}`) para no duplicar toasts ni un segundo WS listener de avisos en la nav.

**Constantes (congeladas, no inventar otras):**

| Nombre | Valor |
|---|---|
| `NO_RUNNER_LABEL` | `"sin runner"` |
| `NO_DAEMON_ERROR` | `"No daemon bound for this workspace. Run: chavez headless workspace open"` |
| `TURN_START_LABEL` | `"Turn iniciado"` |
| `TURN_DONE_LABEL` | `"Turn terminado"` |
| `TURN_ERROR_LABEL` | `"Turn error"` |
| `APPROVAL_LABEL` | `"Ask pendiente"` |
| `TOAST_TTL_MS` | `8000` |
| `MAX_VISIBLE_TOASTS` | `5` |
| `NOTIFICATION_KINDS` | `"turn_start"` \| `"turn_done"` \| `"turn_error"` \| `"approval"` \| `"daemon"` |
| `NOTIFICATION_SOURCE_TYPES` | ver tabla WS abajo |
| `DELTA_TYPES` (nunca avisos) | `"chat.stream.delta"` \| `"chat.thinking.delta"` |

Reusar `NO_DAEMON_ERROR` / `NO_RUNNER_LABEL` si ya existen en `api/src/ws/errors.ts`, `cli/src/ws/presence-constants.ts` o `web/src/components/DaemonPresence.tsx`. **No** cambiar esos strings. `NO_RUNNER_LABEL` en este plan vive en `cli/src/notifications/constants.ts` y se reexporta; si plan 17 ya lo exportó, importar de ahí y no duplicar el literal.

Nombres de events WS (solo **fuentes**; esta fase no añade tipos):

| Tipo | ¿Aviso? | Semántica |
|---|---|---|
| `chat.stream.start` | sí (`turn_start`) | Un aviso por `streamId`. No por delta posterior. |
| `chat.stream.delta` | **no** | Nunca. Ni toast, ni badge, ni store.append. |
| `chat.thinking.delta` | **no** | Igual (plan 16). |
| `chat.stream.end` | sí (`turn_done`) | Cierra el `turn_start` del mismo `streamId`. |
| `chat.stream.error` | sí (`turn_error`) | Incluye `TURN_INTERRUPTED` del plan 17. |
| `chat.tool.update` / `start` con `status=awaiting_approval` | sí (`approval`) | Sticky hasta resolved/timeout. |
| `chat.tool.resolved` / `result` con `resolution` o status ≠ awaiting | **quita** `approval` | No genera un aviso nuevo. |
| `daemon.presence` `bound: false` | sí (`daemon`) | Copy `sin runner`. Sticky. |
| `daemon.presence` `bound: true` | **quita** `daemon` | El aviso desaparece. |
| `agent.turn.ended` | no (dedup) | `end`/`error` ya avisaron. |
| `message.appended` | **no** | Sync de timeline, no aviso. |
| `chat.tool.start` `running` | **no** | Visualización de tool, no aviso. |
| `chat.tool.result` `done` | **no** | Idem. |

HTTP: ninguno nuevo. Hidratar ask con `chat.get` / GET `/chats/:id` (metadata ya viene). Hidratar daemon con `GET /connections` / `daemon.presence`.

Contrato del store (puro, sin React/Ink):

```ts
export type NotificationKind =
  | "turn_start"
  | "turn_done"
  | "turn_error"
  | "approval"
  | "daemon";

export type InAppNotification = {
  id: string; // estable: ver dedupKey
  kind: NotificationKind;
  chatId?: string;
  workspaceId?: string;
  streamId?: string;
  toolCallId?: string;
  title: string;
  body: string;
  sticky: boolean;
  createdAt: number;
  read: boolean;
};

export type NotificationState = {
  items: InAppNotification[];
};

export type ClassifyContext = {
  surface: "web" | "tui";
  activeChatId: string | null;
  now?: number;
};

export type ClassifyInput = {
  type: string;
  data?: unknown;
};
```

`sticky`: `approval` y `daemon` = true; `turn_*` = false. Un sticky **no** caduca por `TOAST_TTL_MS`.

Visibilidad (Gherkin):

| kind | Web, viendo ese chat | Web, otra página | TUI, chat activo | TUI, otro chat |
|---|---|---|---|---|
| `turn_done` / `turn_error` | banner in-chat | toast + badge en la fila | no badge | badge |
| `turn_start` | el stream ya se ve | badge “live” (sin toast) | no badge | badge |
| `approval` | highlight hasta resolver | badge “ask” sticky + toast sticky | banner plan 13 + highlight | badge sticky |
| `daemon` | `sin runner` (DaemonPresence o banner) | `sin runner` | header `sin runner` | header `sin runner` |

---

## Task 1: Módulo puro — kinds, classify, store, anti-spam

**Files:**

- Create: `cli/src/notifications/constants.ts`
- Create: `cli/src/notifications/classify.ts`
- Create: `cli/src/notifications/store.ts`
- Test: `cli/src/notifications/classify.test.ts`
- Test: `cli/src/notifications/store.test.ts`
- Modify: `cli/package.json`

Sin I/O de red, sin React, sin Ink. TUI importa desde aquí. Web duplica en Task 4.

- [ ] Añadir `"test": "bun test"` en `cli/package.json` `scripts` si aún no existe (dejar `start`/`dev`/`bin` intactos):

```json
"scripts": {
  "start": "bun run src/index.ts",
  "dev": "bun run src/index.ts",
  "test": "bun test"
}
```

- [ ] Crear `cli/src/notifications/constants.ts`. Si `cli/src/ws/presence-constants.ts` (plan 17) **ya** exporta `NO_RUNNER_LABEL` / `NO_DAEMON_ERROR` con **el mismo valor**, reexportarlos y no duplicar el literal:

```ts
export const NO_RUNNER_LABEL = "sin runner";
export const NO_DAEMON_ERROR =
  "No daemon bound for this workspace. Run: chavez headless workspace open";
export const TURN_START_LABEL = "Turn iniciado";
export const TURN_DONE_LABEL = "Turn terminado";
export const TURN_ERROR_LABEL = "Turn error";
export const APPROVAL_LABEL = "Ask pendiente";
export const TOAST_TTL_MS = 8000;
export const MAX_VISIBLE_TOASTS = 5;

export const NOTIFICATION_SOURCE_TYPES = [
  "chat.stream.start",
  "chat.stream.end",
  "chat.stream.error",
  "chat.tool.update",
  "chat.tool.start",
  "chat.tool.resolved",
  "chat.tool.result",
  "daemon.presence",
] as const;

export const NEVER_NOTIFY_TYPES = [
  "chat.stream.delta",
  "chat.thinking.delta",
  "message.appended",
  "agent.turn.ended",
  "agent.turn.dispatch",
] as const;

export const READ_SDK = new Set(["Read", "Grep", "Glob", "LS"]);

export type NotificationKind =
  | "turn_start"
  | "turn_done"
  | "turn_error"
  | "approval"
  | "daemon";
```

- [ ] Crear `cli/src/notifications/classify.ts`:

```ts
import {
  APPROVAL_LABEL,
  NEVER_NOTIFY_TYPES,
  NO_RUNNER_LABEL,
  READ_SDK,
  TURN_DONE_LABEL,
  TURN_ERROR_LABEL,
  TURN_START_LABEL,
  type NotificationKind,
} from "./constants";

/** Draft upserted into the store. `createdAt` / `read` se asignan en reduce. */
export type NotificationDraft = {
  id: string;
  kind: NotificationKind;
  chatId?: string;
  workspaceId?: string;
  streamId?: string;
  toolCallId?: string;
  title: string;
  body: string;
  sticky: boolean;
};

export type ClassifyContext = {
  surface: "web" | "tui";
  activeChatId: string | null;
  now?: number;
};

export type ClassifyInput = {
  type: string;
  data?: unknown;
};

export type ClassifyResult =
  | { op: "ignore" }
  | { op: "upsert"; notification: NotificationDraft }
  | { op: "dismiss"; id: string }
  | { op: "dismissKind"; kind: NotificationKind; chatId?: string; workspaceId?: string };

function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

function metaOf(data: Record<string, unknown>): Record<string, unknown> {
  const message = rec(data.message);
  return rec(message?.metadata) || rec(data.metadata) || {};
}

export function dedupKey(kind: NotificationKind, parts: {
  chatId?: string;
  streamId?: string;
  toolCallId?: string;
  workspaceId?: string;
}): string {
  if (kind === "daemon") return `daemon:${parts.workspaceId || "*"}`;
  if (kind === "approval") {
    return `approval:${parts.chatId || ""}:${parts.toolCallId || ""}`;
  }
  return `${kind}:${parts.chatId || ""}:${parts.streamId || ""}`;
}

export function isNeverNotifyType(type: string): boolean {
  return (NEVER_NOTIFY_TYPES as readonly string[]).includes(type);
}

function sdkName(meta: Record<string, unknown>, data: Record<string, unknown>): string {
  return String(meta.sdkName || meta.toolName || data.toolName || "");
}

function isReadTool(meta: Record<string, unknown>, data: Record<string, unknown>): boolean {
  return READ_SDK.has(sdkName(meta, data));
}

export function classifyNotificationEvent(
  input: ClassifyInput,
  _ctx: ClassifyContext,
): ClassifyResult {
  const type = input.type;
  if (isNeverNotifyType(type)) return { op: "ignore" };

  const data = rec(input.data) || {};
  const meta = metaOf(data);
  const chatId = typeof data.chatId === "string" ? data.chatId : undefined;
  const streamId = typeof data.streamId === "string" ? data.streamId : undefined;
  const workspaceId =
    typeof data.workspaceId === "string" ? data.workspaceId : undefined;
  const toolCallId =
    typeof data.toolCallId === "string"
      ? data.toolCallId
      : typeof meta.toolCallId === "string"
        ? meta.toolCallId
        : undefined;
  const status = String(meta.status || data.status || "");

  if (type === "chat.stream.start") {
    const id = dedupKey("turn_start", { chatId, streamId });
    return {
      op: "upsert",
      notification: {
        id,
        kind: "turn_start",
        chatId,
        streamId,
        title: TURN_START_LABEL,
        body: chatId ? chatId.slice(0, 8) : "",
        sticky: false,
      },
    };
  }

  if (type === "chat.stream.end") {
    return {
      op: "upsert",
      notification: {
        id: dedupKey("turn_done", { chatId, streamId }),
        kind: "turn_done",
        chatId,
        streamId,
        title: TURN_DONE_LABEL,
        body: chatId ? chatId.slice(0, 8) : "",
        sticky: false,
      },
    };
  }

  if (type === "chat.stream.error") {
    const err = String(data.error || data.content || TURN_ERROR_LABEL);
    return {
      op: "upsert",
      notification: {
        id: dedupKey("turn_error", { chatId, streamId }),
        kind: "turn_error",
        chatId,
        streamId,
        title: TURN_ERROR_LABEL,
        body: err,
        sticky: false,
      },
    };
  }

  if (type === "chat.tool.update" || type === "chat.tool.start") {
    if (status !== "awaiting_approval") return { op: "ignore" };
    if (isReadTool(meta, data)) return { op: "ignore" };
    if (!toolCallId) return { op: "ignore" };
    return {
      op: "upsert",
      notification: {
        id: dedupKey("approval", { chatId, toolCallId }),
        kind: "approval",
        chatId,
        toolCallId,
        title: APPROVAL_LABEL,
        body: String(meta.summary || meta.toolName || data.toolName || "tool"),
        sticky: true,
      },
    };
  }

  if (type === "chat.tool.resolved") {
    if (!toolCallId) return { op: "ignore" };
    return { op: "dismiss", id: dedupKey("approval", { chatId, toolCallId }) };
  }

  if (type === "chat.tool.result") {
    if (!toolCallId) return { op: "ignore" };
    if (status === "awaiting_approval") return { op: "ignore" };
    return { op: "dismiss", id: dedupKey("approval", { chatId, toolCallId }) };
  }

  if (type === "daemon.presence") {
    const bound = data.bound === true;
    if (bound) {
      return { op: "dismissKind", kind: "daemon", workspaceId };
    }
    return {
      op: "upsert",
      notification: {
        id: dedupKey("daemon", { workspaceId }),
        kind: "daemon",
        workspaceId,
        title: NO_RUNNER_LABEL,
        body: NO_RUNNER_LABEL,
        sticky: true,
      },
    };
  }

  return { op: "ignore" };
}

export function shouldShowTuiBadge(
  n: Pick<NotificationDraft, "kind" | "chatId">,
  activeChatId: string | null,
): boolean {
  if (n.kind === "daemon") return false; // header, no fila
  if (!n.chatId) return false;
  if (n.kind === "approval") return true; // incluso en el chat activo: la fila se destaca
  return n.chatId !== activeChatId;
}

export function shouldShowWebToast(
  n: Pick<NotificationDraft, "kind" | "chatId" | "sticky">,
  viewingChatId: string | null,
): boolean {
  if (n.kind === "daemon") return false; // DaemonPresence / banner, no toast
  if (n.kind === "turn_start") return false;
  if (n.kind === "approval") return viewingChatId !== n.chatId;
  if (viewingChatId && n.chatId === viewingChatId) return false;
  return true;
}

export function shouldShowWebChatBanner(
  n: Pick<NotificationDraft, "kind" | "chatId">,
  viewingChatId: string | null,
): boolean {
  if (!viewingChatId || n.chatId !== viewingChatId) return false;
  return n.kind === "turn_done" || n.kind === "turn_error" || n.kind === "approval";
}
```

`classifyNotificationEvent` **ignora** `ctx.activeChatId`: la visibilidad es función aparte para que el store sea determinista (mismos pushes → mismo state en Web y TUI). El TUI decide el badge con `shouldShowTuiBadge`.

- [ ] Crear `cli/src/notifications/store.ts`:

```ts
import { MAX_VISIBLE_TOASTS, TOAST_TTL_MS } from "./constants";
import {
  classifyNotificationEvent,
  type ClassifyContext,
  type ClassifyInput,
  type NotificationDraft,
} from "./classify";

export type InAppNotification = NotificationDraft & {
  createdAt: number;
  read: boolean;
};

export type NotificationState = {
  items: InAppNotification[];
};

export const emptyNotificationState = (): NotificationState => ({ items: [] });

function upsertItem(
  items: InAppNotification[],
  next: InAppNotification,
): InAppNotification[] {
  const without = items.filter((i) => i.id !== next.id);
  if (next.kind === "turn_done" || next.kind === "turn_error") {
    const rest = without.filter(
      (i) =>
        !(
          i.kind === "turn_start" &&
          i.chatId === next.chatId &&
          i.streamId === next.streamId
        ),
    );
    return [...rest, next];
  }
  return [...without, next];
}

export function reduceNotification(
  state: NotificationState,
  input: ClassifyInput,
  ctx: ClassifyContext,
): { state: NotificationState; added: InAppNotification | null } {
  const now = ctx.now ?? Date.now();
  const result = classifyNotificationEvent(input, ctx);
  if (result.op === "ignore") return { state, added: null };

  if (result.op === "dismiss") {
    return {
      state: { items: state.items.filter((i) => i.id !== result.id) },
      added: null,
    };
  }

  if (result.op === "dismissKind") {
    return {
      state: {
        items: state.items.filter((i) => {
          if (i.kind !== result.kind) return true;
          if (result.workspaceId && i.workspaceId && i.workspaceId !== result.workspaceId) {
            return true;
          }
          return false;
        }),
      },
      added: null,
    };
  }

  const added: InAppNotification = {
    ...result.notification,
    createdAt: now,
    read: false,
  };
  return { state: { items: upsertItem(state.items, added) }, added };
}

export function markChatRead(
  state: NotificationState,
  chatId: string,
): NotificationState {
  return {
    items: state.items
      .map((i) => {
        if (i.chatId !== chatId) return i;
        if (i.kind === "approval" || i.kind === "daemon") return i;
        return { ...i, read: true };
      })
      .filter((i) => i.kind === "approval" || i.kind === "daemon" || !i.read),
  };
}

export function pruneExpired(
  state: NotificationState,
  now = Date.now(),
): NotificationState {
  return {
    items: state.items.filter(
      (i) => i.sticky || i.read || now - i.createdAt <= TOAST_TTL_MS,
    ),
  };
}

export function visibleToasts(
  state: NotificationState,
  pred: (n: InAppNotification) => boolean,
): InAppNotification[] {
  return state.items.filter((i) => !i.read && pred(i)).slice(-MAX_VISIBLE_TOASTS);
}

export function unreadCountForChat(
  state: NotificationState,
  chatId: string,
): number {
  return state.items.filter(
    (i) => i.chatId === chatId && !i.read && i.kind !== "daemon",
  ).length;
}

export function hasApproval(
  state: NotificationState,
  chatId?: string,
): boolean {
  return state.items.some(
    (i) => i.kind === "approval" && (!chatId || i.chatId === chatId),
  );
}

export function hasDaemonDown(state: NotificationState): boolean {
  return state.items.some((i) => i.kind === "daemon");
}

export function seedApproval(input: {
  chatId: string;
  toolCallId: string;
  summary?: string;
  now?: number;
}): ClassifyInput {
  return {
    type: "chat.tool.update",
    data: {
      chatId: input.chatId,
      toolCallId: input.toolCallId,
      status: "awaiting_approval",
      metadata: {
        status: "awaiting_approval",
        toolCallId: input.toolCallId,
        toolName: "write",
        summary: input.summary || "tool",
      },
    },
  };
}

export function seedDaemonDown(workspaceId?: string): ClassifyInput {
  return {
    type: "daemon.presence",
    data: { bound: false, workspaceId },
  };
}

export function seedDaemonUp(workspaceId?: string): ClassifyInput {
  return {
    type: "daemon.presence",
    data: { bound: true, workspaceId },
  };
}
```

- [ ] Tests en `cli/src/notifications/classify.test.ts` (casos **obligatorios**, nombres exactos):

```ts
import { describe, expect, test } from "bun:test";
import {
  classifyNotificationEvent,
  isNeverNotifyType,
  shouldShowTuiBadge,
  shouldShowWebChatBanner,
  shouldShowWebToast,
} from "./classify";
import { NEVER_NOTIFY_TYPES, NO_RUNNER_LABEL } from "./constants";

const ctx = { surface: "web" as const, activeChatId: null };

test("delta never notifies", () => {
  expect(isNeverNotifyType("chat.stream.delta")).toBe(true);
  expect(
    classifyNotificationEvent(
      { type: "chat.stream.delta", data: { chatId: "c1", delta: "x" } },
      ctx,
    ).op,
  ).toBe("ignore");
});

test("thinking delta never notifies", () => {
  expect(
    classifyNotificationEvent(
      { type: "chat.thinking.delta", data: { chatId: "c1", delta: "…" } },
      ctx,
    ).op,
  ).toBe("ignore");
});

test("start end error classify", () => {
  expect(
    classifyNotificationEvent(
      { type: "chat.stream.start", data: { chatId: "c1", streamId: "s1" } },
      ctx,
    ).op,
  ).toBe("upsert");
  const end = classifyNotificationEvent(
    { type: "chat.stream.end", data: { chatId: "c1", streamId: "s1" } },
    ctx,
  );
  expect(end.op).toBe("upsert");
  if (end.op === "upsert") expect(end.notification.kind).toBe("turn_done");
  const err = classifyNotificationEvent(
    {
      type: "chat.stream.error",
      data: { chatId: "c1", streamId: "s1", error: "boom" },
    },
    ctx,
  );
  expect(err.op).toBe("upsert");
  if (err.op === "upsert") expect(err.notification.kind).toBe("turn_error");
});

test("awaiting_approval upserts sticky ask", () => {
  const r = classifyNotificationEvent(
    {
      type: "chat.tool.update",
      data: {
        chatId: "c1",
        toolCallId: "t1",
        metadata: { status: "awaiting_approval", toolName: "Write" },
      },
    },
    ctx,
  );
  expect(r.op).toBe("upsert");
  if (r.op === "upsert") {
    expect(r.notification.kind).toBe("approval");
    expect(r.notification.sticky).toBe(true);
  }
});

test("read tool never approval notice", () => {
  const r = classifyNotificationEvent(
    {
      type: "chat.tool.update",
      data: {
        chatId: "c1",
        toolCallId: "t1",
        metadata: { status: "awaiting_approval", sdkName: "Read" },
      },
    },
    ctx,
  );
  expect(r.op).toBe("ignore");
});

test("tool running is not a notice", () => {
  expect(
    classifyNotificationEvent(
      {
        type: "chat.tool.start",
        data: {
          chatId: "c1",
          toolCallId: "t1",
          metadata: { status: "running", toolName: "Write" },
        },
      },
      ctx,
    ).op,
  ).toBe("ignore");
});

test("resolved dismisses ask", () => {
  const r = classifyNotificationEvent(
    {
      type: "chat.tool.resolved",
      data: { chatId: "c1", toolCallId: "t1", outcome: "approve" },
    },
    ctx,
  );
  expect(r).toEqual({ op: "dismiss", id: "approval:c1:t1" });
});

test("daemon down is sin runner; up dismisses", () => {
  const down = classifyNotificationEvent(
    { type: "daemon.presence", data: { bound: false, workspaceId: "w1" } },
    ctx,
  );
  expect(down.op).toBe("upsert");
  if (down.op === "upsert") {
    expect(down.notification.title).toBe(NO_RUNNER_LABEL);
    expect(down.notification.sticky).toBe(true);
  }
  const up = classifyNotificationEvent(
    { type: "daemon.presence", data: { bound: true, workspaceId: "w1" } },
    ctx,
  );
  expect(up.op).toBe("dismissKind");
});

test("message.appended is not a notice", () => {
  expect(
    classifyNotificationEvent(
      { type: "message.appended", data: { chatId: "c1" } },
      ctx,
    ).op,
  ).toBe("ignore");
});

test("TUI badge only when not in that chat (except approval)", () => {
  const done = { kind: "turn_done" as const, chatId: "c1" };
  expect(shouldShowTuiBadge(done, "c1")).toBe(false);
  expect(shouldShowTuiBadge(done, "c2")).toBe(true);
  expect(shouldShowTuiBadge({ kind: "approval", chatId: "c1" }, "c1")).toBe(true);
});

test("Web toast skipped on the open chat; banner shown instead", () => {
  const done = { kind: "turn_done" as const, chatId: "c1", sticky: false };
  expect(shouldShowWebToast(done, "c1")).toBe(false);
  expect(shouldShowWebToast(done, null)).toBe(true);
  expect(shouldShowWebChatBanner(done, "c1")).toBe(true);
});

test("NEVER_NOTIFY_TYPES covers spam sources", () => {
  expect(NEVER_NOTIFY_TYPES).toContain("chat.stream.delta");
});
```

- [ ] Tests en `cli/src/notifications/store.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { TOAST_TTL_MS } from "./constants";
import {
  emptyNotificationState,
  hasApproval,
  hasDaemonDown,
  markChatRead,
  pruneExpired,
  reduceNotification,
  unreadCountForChat,
} from "./store";

const ctx = { surface: "tui" as const, activeChatId: "active", now: 1_000 };

function push(state: ReturnType<typeof emptyNotificationState>, type: string, data: unknown) {
  return reduceNotification(state, { type, data }, ctx).state;
}

test("100 deltas do not grow the store", () => {
  let s = emptyNotificationState();
  s = push(s, "chat.stream.start", { chatId: "c1", streamId: "s1" });
  for (let i = 0; i < 100; i++) {
    s = push(s, "chat.stream.delta", { chatId: "c1", streamId: "s1", delta: "x" });
  }
  s = push(s, "chat.stream.end", { chatId: "c1", streamId: "s1" });
  expect(s.items).toHaveLength(1);
  expect(s.items[0].kind).toBe("turn_done");
});

test("start then end collapses to one turn_done", () => {
  let s = emptyNotificationState();
  s = push(s, "chat.stream.start", { chatId: "c1", streamId: "s1" });
  s = push(s, "chat.stream.end", { chatId: "c1", streamId: "s1" });
  expect(s.items.map((i) => i.kind)).toEqual(["turn_done"]);
});

test("approval stays until resolved or result", () => {
  let s = emptyNotificationState();
  s = push(s, "chat.tool.update", {
    chatId: "c1",
    toolCallId: "t1",
    metadata: { status: "awaiting_approval", toolName: "Bash" },
  });
  expect(hasApproval(s, "c1")).toBe(true);
  s = markChatRead(s, "c1");
  expect(hasApproval(s, "c1")).toBe(true);
  s = push(s, "chat.tool.resolved", {
    chatId: "c1",
    toolCallId: "t1",
    outcome: "timeout",
  });
  expect(hasApproval(s, "c1")).toBe(false);
});

test("two asks are independent", () => {
  let s = emptyNotificationState();
  s = push(s, "chat.tool.update", {
    chatId: "c1",
    toolCallId: "t1",
    metadata: { status: "awaiting_approval", toolName: "Write" },
  });
  s = push(s, "chat.tool.update", {
    chatId: "c1",
    toolCallId: "t2",
    metadata: { status: "awaiting_approval", toolName: "Bash" },
  });
  expect(unreadCountForChat(s, "c1")).toBe(2);
  s = push(s, "chat.tool.resolved", { chatId: "c1", toolCallId: "t1" });
  expect(hasApproval(s, "c1")).toBe(true);
  expect(s.items).toHaveLength(1);
});

test("daemon down then reconnect clears", () => {
  let s = emptyNotificationState();
  s = push(s, "daemon.presence", { bound: false, workspaceId: "w1" });
  expect(hasDaemonDown(s)).toBe(true);
  s = push(s, "daemon.presence", { bound: true, workspaceId: "w1" });
  expect(hasDaemonDown(s)).toBe(false);
});

test("opening a chat marks turn notices read, keeps ask", () => {
  let s = emptyNotificationState();
  s = push(s, "chat.stream.end", { chatId: "c1", streamId: "s1" });
  s = push(s, "chat.tool.update", {
    chatId: "c1",
    toolCallId: "t1",
    metadata: { status: "awaiting_approval", toolName: "Write" },
  });
  s = markChatRead(s, "c1");
  expect(s.items.some((i) => i.kind === "turn_done")).toBe(false);
  expect(hasApproval(s, "c1")).toBe(true);
});

test("non-sticky prune after TTL; sticky survives", () => {
  let s = emptyNotificationState();
  s = reduceNotification(
    s,
    { type: "chat.stream.end", data: { chatId: "c1", streamId: "s1" } },
    { ...ctx, now: 0 },
  ).state;
  s = reduceNotification(
    s,
    {
      type: "chat.tool.update",
      data: {
        chatId: "c1",
        toolCallId: "t1",
        metadata: { status: "awaiting_approval", toolName: "Write" },
      },
    },
    { ...ctx, now: 0 },
  ).state;
  const pruned = pruneExpired(s, TOAST_TTL_MS + 1);
  expect(pruned.items.map((i) => i.kind)).toEqual(["approval"]);
});
```

- [ ] Correr:

```bash
cd cli && bun test src/notifications/classify.test.ts src/notifications/store.test.ts
```

Esperado: todos PASS. Si un import de `NO_RUNNER_LABEL` choca con plan 17, reexportar y no cambiar el string.

- [ ] Commit:

```bash
git add cli/src/notifications/constants.ts cli/src/notifications/classify.ts \
  cli/src/notifications/store.ts cli/src/notifications/classify.test.ts \
  cli/src/notifications/store.test.ts cli/package.json
git commit -m "feat(notifications): classify start/end/error/approval/daemon, ignore deltas"
```

---

## Task 2: API — allowlist, cero event nuevo, cero email

**Files:**

- Create: `api/src/ws/notification-events.ts`
- Test: `api/src/ws/notification-events.test.ts`
- Modify: `api/src/ws/protocol.ts`
- Modify: `api/package.json`

La API **no** emite `ui.notification`. El allowlist documenta qué pushes pueden convertirse en aviso en el cliente y garantiza que `chat.stream.delta` no está. `Resend` no se toca.

- [ ] Añadir `"test": "bun test"` en `api/package.json` `scripts` si no existe (dejar `dev`/`start`/`db:*`/`test:e2e` intactos).

- [ ] Crear `api/src/ws/notification-events.ts`. Comentario keep-in-sync con `cli/src/notifications/constants.ts`:

```ts
/** keep-in-sync with cli/src/notifications/constants.ts */
export const NOTIFICATION_SOURCE_TYPES = [
  "chat.stream.start",
  "chat.stream.end",
  "chat.stream.error",
  "chat.tool.update",
  "chat.tool.start",
  "chat.tool.resolved",
  "chat.tool.result",
  "daemon.presence",
] as const;

export const NEVER_NOTIFY_TYPES = [
  "chat.stream.delta",
  "chat.thinking.delta",
  "message.appended",
  "agent.turn.ended",
  "agent.turn.dispatch",
] as const;

export const NO_RUNNER_LABEL = "sin runner";

export function isNotificationSourceType(type: string): boolean {
  return (NOTIFICATION_SOURCE_TYPES as readonly string[]).includes(type);
}

export function isNeverNotifyType(type: string): boolean {
  return (NEVER_NOTIFY_TYPES as readonly string[]).includes(type);
}
```

Si `api/src/ws/errors.ts` ya exporta `NO_RUNNER_LABEL`, reexportar desde ahí.

- [ ] En `api/src/ws/protocol.ts`, **no** añadir `"ui.notification"` a `RESERVED_STREAM_TYPES`. Añadir un comentario encima del array:

```ts
// Plan 24: in-app notices are classified on Web/TUI from existing pushes.
// Deltas stay in RESERVED_STREAM_TYPES for fan-out, never as OS/email/ui.notification.
```

Dejar el array como está (start/delta/end/error). Delta **sigue** en el fan-out (Web/TUI/watch lo necesitan para el live stream). Solo se prohibe un **segundo** event de aviso por delta.

- [ ] Test `api/src/ws/notification-events.test.ts`:

```ts
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isNeverNotifyType,
  isNotificationSourceType,
  NEVER_NOTIFY_TYPES,
  NO_RUNNER_LABEL,
} from "./notification-events";

test("delta is never a notification source", () => {
  expect(isNeverNotifyType("chat.stream.delta")).toBe(true);
  expect(isNotificationSourceType("chat.stream.delta")).toBe(false);
  expect(NEVER_NOTIFY_TYPES).toContain("chat.stream.delta");
});

test("start end error approval daemon are sources", () => {
  expect(isNotificationSourceType("chat.stream.start")).toBe(true);
  expect(isNotificationSourceType("chat.stream.end")).toBe(true);
  expect(isNotificationSourceType("chat.stream.error")).toBe(true);
  expect(isNotificationSourceType("chat.tool.update")).toBe(true);
  expect(isNotificationSourceType("daemon.presence")).toBe(true);
});

test("no ui.notification type is introduced", () => {
  const protocol = readFileSync(join(import.meta.dir, "protocol.ts"), "utf8");
  const handlers = readFileSync(join(import.meta.dir, "handlers.ts"), "utf8");
  expect(protocol).not.toContain("ui.notification");
  expect(handlers).not.toContain("ui.notification");
  expect(handlers).not.toContain("notify-send");
});

test("auth Resend is not imported from notification-events", () => {
  const src = readFileSync(join(import.meta.dir, "notification-events.ts"), "utf8");
  expect(src).not.toContain("resend");
  expect(src).not.toContain("Resend");
  expect(NO_RUNNER_LABEL).toBe("sin runner");
});
```

- [ ] Correr:

```bash
cd api && bun test src/ws/notification-events.test.ts
```

- [ ] Commit:

```bash
git add api/src/ws/notification-events.ts api/src/ws/notification-events.test.ts \
  api/src/ws/protocol.ts api/package.json
git commit -m "feat(notifications): document WS notice sources; no ui.notification event"
```

---

## Task 3: TUI — badge si no estoy en ese chat, ask destacado, sin runner

**Files:**

- Modify: `tui/src/App.tsx`
- Modify: `tui/package.json`
- Test: `cli/src/notifications/tui-visibility.test.ts`

TUI importa el store del CLI. No duplicar classify. Ink no necesita un componente nuevo: badge en la fila y una línea de header.

- [ ] Añadir `"test": "bun test"` en `tui/package.json` si falta (los tests de visibilidad viven en CLI; TUI no tiene que copiar el codec).

- [ ] En `tui/src/App.tsx`:

  1. Imports (junto a los existentes):

```tsx
import {
  classifyNotificationEvent,
} from "../../cli/src/notifications/classify";
import {
  emptyNotificationState,
  hasApproval,
  hasDaemonDown,
  markChatRead,
  reduceNotification,
  type NotificationState,
} from "../../cli/src/notifications/store";
import { NO_RUNNER_LABEL } from "../../cli/src/notifications/constants";
import { shouldShowTuiBadge } from "../../cli/src/notifications/classify";
```

Si plan 17 ya exporta `NO_RUNNER_LABEL` desde presence-constants, importar **una** vez (constants de notifications reexporta).

  2. Estado:

```tsx
const [notices, setNotices] = useState<NotificationState>(emptyNotificationState);
const noticesRef = useRef(notices);
noticesRef.current = notices;
```

  3. En el `onPush` existente (el `useEffect` que ya maneja `agent.turn.dispatch` / stream / `chat.created`), **antes** del early-return de dispatch, aplicar el reducer a **todo** push:

```tsx
setNotices((prev) =>
  reduceNotification(
    prev,
    { type: msg.type, data: msg.data },
    { surface: "tui", activeChatId: activeChatIdRef.current },
  ).state,
);
```

No filtrar por `activeChatId` aquí: un turn que termina en otro chat **debe** entrar al store. El `loadChat` existente sigue filtrando por chat activo (no cambiar esa recarga).

  4. En `selectChat`, después de `setActiveChatId(chat.id)`:

```tsx
setNotices((prev) => markChatRead(prev, chat.id));
```

`markChatRead` **no** borra `approval`. Al abrir el chat con ask, el banner de plan 13 (si existe) + el highlight de la fila cubren Gherkin “lo destacan hasta resolver”.

  5. Header, sustituir la línea de WS. Hoy:

```tsx
{status === "bound" ? " · daemon/runner" : ""}
```

Queda:

```tsx
<Text>
  WS: {status}
  {workspaceId ? ` · workspace ${workspaceId.slice(0, 8)}…` : ""}
  {status === "bound" && !hasDaemonDown(notices)
    ? " · daemon/runner"
    : status === "connecting"
      ? ""
      : ` · ${NO_RUNNER_LABEL}`}
</Text>
{hasDaemonDown(notices) || (status !== "bound" && status !== "connecting") ? (
  <Text color="red" bold>
    {NO_RUNNER_LABEL}
  </Text>
) : null}
```

Regla: el primer paint `connecting` **no** grita `sin runner` (no es un daemon caído). Tras bind, si `status` pasa a `error` / `closed` / `reconnecting` (plan 17) **o** llega `daemon.presence` `bound: false`, se muestra `sin runner`. Al volver `bound` y `hasDaemonDown === false`, la línea desaparece.

Si plan 17 aún no emite `daemon.presence`, el fallback `status !== "bound" && status !== "connecting"` cubre TUI-como-daemon cuando el WS se cae.

  6. Lista de chats — en el `chatWin.slice.map`, la fila gana badge:

```tsx
const badgeKinds = notices.items.filter(
  (n) => n.chatId === c.id && shouldShowTuiBadge(n, activeChatId),
);
const ask = badgeKinds.some((n) => n.kind === "approval");
const done = badgeKinds.some(
  (n) => n.kind === "turn_done" || n.kind === "turn_error",
);
const live = badgeKinds.some((n) => n.kind === "turn_start");
const mark = ask ? " !" : done ? " ●" : live ? " …" : "";
```

Render:

```tsx
<Text
  key={c.id}
  color={ask ? "red" : active ? "yellow" : undefined}
  bold={focused || ask}
>
  {focused ? ">" : " "} {c.title} ({c.id.slice(0, 8)})
  {mark ? (
    <Text color={ask ? "red" : done ? "green" : "cyan"}>{mark}</Text>
  ) : null}
</Text>
```

`data` no aplica en Ink; el test de visibilidad cubre la regla. El `!` rojo es el ask (Gherkin “lo destacan”). El `●` verde es turn done **solo** si `c.id !== activeChatId`.

  7. Banner de ask **si** plan 13 aún no puso el bloque `firstAwaiting`. Si `firstAwaiting` **ya** existe, no dupliques el countdown; sí asegúrate de que `hasApproval(notices, activeChatId)` pone `color="red"` en esa línea. Si no existe, mínimo:

```tsx
{hasApproval(notices, activeChatId) ? (
  <Text color="red" bold>
    {APPROVAL_LABEL} — [y]/[n] en el chat (plan 13)
  </Text>
) : null}
```

Importar `APPROVAL_LABEL` de constants. **No** implementes approve/deny aquí (plan 13). El highlight es el aviso.

- [ ] Test de visibilidad extra en `cli/src/notifications/tui-visibility.test.ts` (el codec ya está; esto clava el escenario Gherkin TUI):

```ts
import { expect, test } from "bun:test";
import { shouldShowTuiBadge } from "./classify";
import {
  emptyNotificationState,
  markChatRead,
  reduceNotification,
} from "./store";

test("TUI turn done badges only the other chat", () => {
  const ctx = { surface: "tui" as const, activeChatId: "mine", now: 1 };
  let s = emptyNotificationState();
  s = reduceNotification(
    s,
    { type: "chat.stream.end", data: { chatId: "other", streamId: "s1" } },
    ctx,
  ).state;
  s = reduceNotification(
    s,
    { type: "chat.stream.end", data: { chatId: "mine", streamId: "s2" } },
    ctx,
  ).state;
  const other = s.items.find((i) => i.chatId === "other")!;
  const mine = s.items.find((i) => i.chatId === "mine")!;
  expect(shouldShowTuiBadge(other, "mine")).toBe(true);
  expect(shouldShowTuiBadge(mine, "mine")).toBe(false);
});

test("opening the other chat clears the turn badge, not a live ask", () => {
  const ctx = { surface: "tui" as const, activeChatId: "mine", now: 1 };
  let s = emptyNotificationState();
  s = reduceNotification(
    s,
    { type: "chat.stream.end", data: { chatId: "other", streamId: "s1" } },
    ctx,
  ).state;
  s = reduceNotification(
    s,
    {
      type: "chat.tool.update",
      data: {
        chatId: "other",
        toolCallId: "t1",
        metadata: { status: "awaiting_approval", toolName: "Write" },
      },
    },
    ctx,
  ).state;
  s = markChatRead(s, "other");
  expect(s.items.some((i) => i.kind === "turn_done")).toBe(false);
  expect(s.items.some((i) => i.kind === "approval")).toBe(true);
  expect(shouldShowTuiBadge(s.items[0], "other")).toBe(true);
});
```

- [ ] Correr:

```bash
cd cli && bun test src/notifications/tui-visibility.test.ts src/notifications/store.test.ts
```

No hay test de render Ink (no añadir `ink-testing-library`). La regla de badge está en el codec.

- [ ] Commit:

```bash
git add tui/src/App.tsx tui/package.json cli/src/notifications/tui-visibility.test.ts
git commit -m "feat(notifications): TUI chat badges and sin runner header"
```

---

## Task 4: Web — provider, host, banner in-chat, badges en workspace/session

**Files:**

- Create: `web/src/lib/notifications.ts`
- Test: `web/src/lib/notifications.test.ts`
- Create: `web/src/lib/notification-context.tsx`
- Create: `web/src/components/NotificationHost.tsx`
- Create: `web/src/components/NotificationBadge.tsx`
- Modify: `web/src/components/AppProviders.tsx`
- Modify: `web/src/components/NavAuth.tsx`
- Modify: `web/src/components/ChatDetailPanel.tsx`
- Modify: `web/src/components/WorkspaceDetailPanel.tsx`
- Modify: `web/src/components/SessionDetailPanel.tsx`
- Modify: `web/src/components/WorkspacesPanel.tsx`
- Modify: `web/src/components/HubPanel.tsx`
- Modify: `web/src/styles/global.css`
- Modify: `web/package.json`

Web **no** importa `cli/`. Copiar constants + classify + store a un solo archivo `web/src/lib/notifications.ts` con cabecera:

```ts
/** keep-in-sync with cli/src/notifications/{constants,classify,store}.ts */
```

Pegar exports usados por la UI (`classifyNotificationEvent`, `reduceNotification`, `emptyNotificationState`, `markChatRead`, `pruneExpired`, `visibleToasts`, `unreadCountForChat`, `hasApproval`, `hasDaemonDown`, `shouldShowWebToast`, `shouldShowWebChatBanner`, `shouldShowTuiBadge` no es obligatorio en web, `NO_RUNNER_LABEL`, `TURN_DONE_LABEL`, `APPROVAL_LABEL`, `TOAST_TTL_MS`, `MAX_VISIBLE_TOASTS`, `seedApproval`, `seedDaemonDown`, `seedDaemonUp`). Misma semántica; no “simplificar” el reducer.

- [ ] Añadir `"test": "bun test"` en `web/package.json` `scripts` si falta (dejar `dev`/`build`/`preview`/`start`).

- [ ] `web/src/lib/notifications.test.ts`: copiar los tests de Task 1 que ejercitan `delta never notifies`, `100 deltas`, `approval stays`, `daemon reconnect`, `Web toast skipped on the open chat`. Adaptar imports a `./notifications`. Al menos estos 5 nombres:

  - `delta never notifies`
  - `100 deltas do not grow the store`
  - `approval stays until resolved or result`
  - `daemon down then reconnect clears`
  - `Web toast skipped on the open chat; banner shown instead`

- [ ] Crear `web/src/lib/notification-context.tsx`:

```tsx
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useWs } from "./ws-context";
import {
  emptyNotificationState,
  markChatRead,
  pruneExpired,
  reduceNotification,
  TOAST_TTL_MS,
  type NotificationState,
  type InAppNotification,
} from "./notifications";

type Ctx = {
  state: NotificationState;
  viewingChatId: string | null;
  setViewingChatId: (id: string | null) => void;
  markRead: (chatId: string) => void;
  apply: (type: string, data?: unknown) => void;
};

const NotificationContext = createContext<Ctx | null>(null);

export function NotificationProvider({
  children,
  enabled = true,
}: {
  children: ReactNode;
  enabled?: boolean;
}) {
  const ws = useWs();
  const [state, setState] = useState<NotificationState>(emptyNotificationState);
  const [viewingChatId, setViewingChatId] = useState<string | null>(null);

  const apply = useCallback((type: string, data?: unknown) => {
    setState((prev) =>
      reduceNotification(
        prev,
        { type, data },
        { surface: "web", activeChatId: viewingChatId },
      ).state,
    );
  }, [viewingChatId]);

  useEffect(() => {
    if (!enabled) return;
    return ws.onPush((msg) => apply(msg.type, msg.data));
  }, [ws, apply, enabled]);

  useEffect(() => {
    if (!enabled) return;
    const t = setInterval(() => {
      setState((prev) => pruneExpired(prev));
    }, TOAST_TTL_MS);
    return () => clearInterval(t);
  }, [enabled]);

  const markRead = useCallback((chatId: string) => {
    setState((prev) => markChatRead(prev, chatId));
  }, []);

  const value = useMemo<Ctx>(
    () => ({ state, viewingChatId, setViewingChatId, markRead, apply }),
    [state, viewingChatId, markRead, apply],
  );

  if (!enabled) return <>{children}</>;
  return (
    <NotificationContext.Provider value={value}>
      {children}
    </NotificationContext.Provider>
  );
}

export function useNotifications(): Ctx {
  const ctx = useContext(NotificationContext);
  if (!ctx) {
    throw new Error("useNotifications must be used within NotificationProvider");
  }
  return ctx;
}

export function useNotificationsOptional(): Ctx | null {
  return useContext(NotificationContext);
}
```

`enabled=false` para `NavAuth`: no subscribe, no host, no segundo inbox.

- [ ] Extender `web/src/components/AppProviders.tsx`:

```tsx
import { NotificationProvider } from "../lib/notification-context";
import { NotificationHost } from "./NotificationHost";

export function AppProviders({
  children,
  notifications = true,
}: {
  children: ReactNode;
  notifications?: boolean;
}) {
  const [client] = useState(makeClient);
  return (
    <QueryClientProvider client={client}>
      <WsProvider>
        <NotificationProvider enabled={notifications}>
          {notifications ? <NotificationHost /> : null}
          {children}
        </NotificationProvider>
      </WsProvider>
    </QueryClientProvider>
  );
}
```

`NotificationProvider` usa `useWs()` → **debe** ir **dentro** de `WsProvider`.

- [ ] `NavAuth`: `<AppProviders notifications={false}>` (hoy es `<AppProviders>`). No cambies el resto.

- [ ] Crear `web/src/components/NotificationHost.tsx`:

```tsx
import { useNotifications } from "../lib/notification-context";
import {
  shouldShowWebToast,
  visibleToasts,
} from "../lib/notifications";

export function NotificationHost() {
  const { state, viewingChatId } = useNotifications();
  const toasts = visibleToasts(state, (n) =>
    shouldShowWebToast(n, viewingChatId),
  );
  if (toasts.length === 0) return null;
  return (
    <div className="notice-host" data-testid="notice-host" role="status">
      {toasts.map((n) => (
        <a
          key={n.id}
          className={`notice-toast notice-${n.kind}${n.sticky ? " notice-sticky" : ""}`}
          data-testid={`notice-${n.kind}`}
          href={n.chatId ? `/chats/${n.chatId}` : "/workspaces"}
        >
          <strong>{n.title}</strong>
          {n.body ? <span> · {n.body}</span> : null}
        </a>
      ))}
    </div>
  );
}
```

Toasts **no** usan `new Notification(...)`, ni `serviceWorker`, ni `mailto:`. Click navega al chat (MPA).

- [ ] Crear `web/src/components/NotificationBadge.tsx`:

```tsx
import { useNotificationsOptional } from "../lib/notification-context";
import { hasApproval, unreadCountForChat } from "../lib/notifications";

export function NotificationBadge({ chatId }: { chatId: string }) {
  const ctx = useNotificationsOptional();
  if (!ctx) return null;
  const ask = hasApproval(ctx.state, chatId);
  const n = unreadCountForChat(ctx.state, chatId);
  if (!ask && n === 0) return null;
  return (
    <span
      className={`badge ${ask ? "err" : "ok"}`}
      data-testid={`chat-notice-${chatId}`}
      data-kind={ask ? "approval" : "turn"}
    >
      {ask ? "ask" : n}
    </span>
  );
}
```

- [ ] `ChatDetailPanel.tsx`:

  1. Import `useNotifications`, `shouldShowWebChatBanner`, `TURN_DONE_LABEL`, `TURN_ERROR_LABEL`, `APPROVAL_LABEL`, `NO_RUNNER_LABEL`, `hasDaemonDown`, `hasApproval`.
  2. En `ChatDetailInner`:

```tsx
const notices = useNotifications();
useEffect(() => {
  notices.setViewingChatId(chatId);
  notices.markRead(chatId);
  return () => notices.setViewingChatId(null);
}, [chatId]);
```

No pongas `notices` entero en el array de deps (el objeto cambia cada push y re-marcaría read el ask). Deps: `[chatId]`. eslint: disable esa línea con comentario `chatId is the viewing key`.

  3. Banner in-chat, **encima** de `.messages` (Gherkin “aviso en el chat”):

```tsx
{notices.state.items
  .filter((n) => shouldShowWebChatBanner(n, chatId))
  .map((n) => (
    <p
      key={n.id}
      className={n.kind === "turn_error" || n.kind === "approval" ? "error" : "ok"}
      data-testid="chat-turn-notice"
      data-kind={n.kind}
    >
      {n.title}
      {n.kind === "approval" ? " — hasta resolver o timeout" : ""}
    </p>
  ))}
```

  4. Daemon: si `DaemonPresence` (plan 17) **ya** está montado en este panel, no añadas un segundo párrafo. Si **no** está, y `hasDaemonDown(notices.state)`:

```tsx
<p className="error" data-testid="runner-status">{NO_RUNNER_LABEL}</p>
```

  5. ToolCard: si `status === "awaiting_approval"`, añadir `className="tool-card tool-ask"` y `data-testid="tool-ask"`. No reimplementes Aprobar/Rechazar (plan 13). El highlight CSS es el aviso.

- [ ] `WorkspaceDetailPanel.tsx`: en cada `<li>` de chat, junto al título:

```tsx
<NotificationBadge chatId={ch.id} />
```

Si hay `DaemonPresence`, no dupliques. Si no, bajo el path:

```tsx
{hasDaemonDown(useNotifications().state) ? (
  <p className="error" data-testid="runner-status">{NO_RUNNER_LABEL}</p>
) : null}
```

Hidratar ask desde `recentMessages` (Task 6 llama `apply`; aquí solo pinta).

- [ ] `SessionDetailPanel.tsx`: cada `<li>` de chat:

```tsx
<li key={c.id}>
  <a href={`/chats/${c.id}`}>{c.title || c.id}</a>{" "}
  <NotificationBadge chatId={c.id} />
</li>
```

- [ ] `WorkspacesPanel.tsx`: si no hay `DaemonPresence`, por cada workspace sin daemon (plan 17 `w.daemonBound === false`, o `openConnections` y ningún connection `clientKind==="daemon"` cuando ese campo exista):

```tsx
<span className="badge err" data-testid="runner-status">{NO_RUNNER_LABEL}</span>
```

Si `DaemonPresence` ya pinta el copy, **no** añadas otro badge con el mismo string en la misma fila.

- [ ] `HubPanel.tsx`: si `hasDaemonDown` o `hasApproval` (cualquier chat), una línea bajo el header:

```tsx
{hasDaemonDown(notices.state) ? (
  <p className="error" data-testid="runner-status">{NO_RUNNER_LABEL}</p>
) : null}
```

- [ ] CSS en `web/src/styles/global.css` (añadir al final, no reescribir el archivo):

```css
.notice-host {
  position: sticky;
  top: 0.5rem;
  z-index: 40;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  margin-bottom: 0.75rem;
}
.notice-toast {
  display: block;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 0.5rem 0.75rem;
  color: var(--fg);
}
.notice-toast:hover { text-decoration: none; border-color: var(--accent); }
.notice-turn_done { border-color: var(--accent-dim); }
.notice-turn_error, .notice-approval, .notice-daemon { border-color: var(--danger); }
.notice-sticky { box-shadow: 0 0 0 1px var(--danger); }
.tool-ask { outline: 1px solid var(--danger); }
```

Esto es **in-app**. No `position: fixed` a viewport del OS; sticky dentro de `.shell` basta. En móvil (viewport estrecho) el host sigue en flujo, no un overlay a pantalla completa.

- [ ] Correr:

```bash
cd web && bun test src/lib/notifications.test.ts
```

- [ ] Commit:

```bash
git add web/src/lib/notifications.ts web/src/lib/notifications.test.ts \
  web/src/lib/notification-context.tsx web/src/components/NotificationHost.tsx \
  web/src/components/NotificationBadge.tsx web/src/components/AppProviders.tsx \
  web/src/components/NavAuth.tsx web/src/components/ChatDetailPanel.tsx \
  web/src/components/WorkspaceDetailPanel.tsx \
  web/src/components/SessionDetailPanel.tsx \
  web/src/components/WorkspacesPanel.tsx web/src/components/HubPanel.tsx \
  web/src/styles/global.css web/package.json
git commit -m "feat(notifications): Web in-app toasts, chat banner, list badges"
```

---

## Task 5: CLI watch es el log — cero OS, cero store

**Files:**

- Test: `cli/src/notifications/watch-is-log.test.ts`
- Test: `cli/src/commands/headless-watch-no-os.test.ts`

**No** modifiques el `onPush` de `watch` en `cli/src/commands/headless.ts` para llamar a `reduceNotification`. Si plan 2/13 añadió `formatWatchLine`, déjalo: es log, no badge. Esta task solo **prueba** la invariante.

- [ ] Crear `cli/src/commands/headless-watch-no-os.test.ts`:

```ts
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("watch does not import OS or in-app notification backends", () => {
  const src = readFileSync(join(import.meta.dir, "headless.ts"), "utf8");
  expect(src).not.toContain("node-notifier");
  expect(src).not.toContain("notify-send");
  expect(src).not.toContain("osascript");
  expect(src).not.toContain("new Notification");
  expect(src).not.toContain("from \"resend\"");
  expect(src).not.toContain("from \"../notifications/store\"");
  expect(src).not.toContain("from \"../notifications/classify\"");
  expect(src).toContain("watching chat=");
  expect(src).toContain("JSON.stringify");
});
```

- [ ] Crear `cli/src/notifications/watch-is-log.test.ts` — el classifier existe pero watch no lo usa; un delta **impreso** no es un aviso:

```ts
import { expect, test } from "bun:test";
import { classifyNotificationEvent } from "./classify";
import { emptyNotificationState, reduceNotification } from "./store";

test("watch may print deltas; the notice store still ignores them", () => {
  const ctx = { surface: "web" as const, activeChatId: null, now: 1 };
  let s = emptyNotificationState();
  const events = [
    { type: "chat.stream.start", data: { chatId: "c", streamId: "s" } },
    ...Array.from({ length: 50 }, () => ({
      type: "chat.stream.delta",
      data: { chatId: "c", streamId: "s", delta: "tok" },
    })),
    { type: "chat.stream.end", data: { chatId: "c", streamId: "s" } },
  ];
  const printed = events.map((e) => JSON.stringify({ type: e.type, data: e.data }));
  expect(printed).toHaveLength(52);
  for (const e of events) {
    expect(classifyNotificationEvent(e, ctx).op === "ignore").toBe(
      e.type === "chat.stream.delta",
    );
    s = reduceNotification(s, e, ctx).state;
  }
  expect(s.items).toHaveLength(1);
  expect(s.items[0].kind).toBe("turn_done");
});
```

Esto clava Gherkin “watch sigue siendo el log” + “no hay un aviso por delta” + “no hay notificaciones OS”.

- [ ] Correr:

```bash
cd cli && bun test src/commands/headless-watch-no-os.test.ts src/notifications/watch-is-log.test.ts
```

- [ ] Commit:

```bash
git add cli/src/commands/headless-watch-no-os.test.ts \
  cli/src/notifications/watch-is-log.test.ts
git commit -m "test(notifications): CLI watch stays a log with no OS notices"
```

---

## Task 6: Hidratar ask y daemon — sticky hasta resolver/timeout/reconnect

**Files:**

- Modify: `web/src/lib/notification-context.tsx`
- Modify: `web/src/components/ChatDetailPanel.tsx`
- Modify: `web/src/components/WorkspaceDetailPanel.tsx`
- Modify: `web/src/components/WorkspacesPanel.tsx`
- Modify: `tui/src/App.tsx`
- Create: `cli/src/notifications/hydrate.ts`
- Test: `cli/src/notifications/hydrate.test.ts`
- Create: `web/src/lib/notification-hydrate.ts`
- Test: `web/src/lib/notification-hydrate.test.ts`

Un reload no debe perder un ask ni un “sin runner”. Los turn_done **sí** se pierden (efímeros). Timeout: si plan 13 emite `chat.tool.resolved` `outcome=timeout`, el store ya lo quita (Task 1). Esta task hidrata y, si el deadline ISO ya pasó y aún no llegó resolved, descarta el ask localmente para no dejar un badge zombie.

- [ ] Crear `cli/src/notifications/hydrate.ts`:

```ts
import { READ_SDK } from "./constants";
import {
  reduceNotification,
  seedApproval,
  seedDaemonDown,
  seedDaemonUp,
  type NotificationState,
} from "./store";

export type HydrateMessage = {
  role?: string;
  chatId?: string;
  metadata?: Record<string, unknown> | null;
};

export type HydrateConnection = {
  clientKind?: string;
  role?: string;
  workspaceId?: string | null;
};

export function hydrateFromMessages(
  state: NotificationState,
  messages: HydrateMessage[],
  chatId: string,
  now = Date.now(),
): NotificationState {
  let s = state;
  for (const m of messages) {
    if (m.role !== "tool") continue;
    const meta = m.metadata || {};
    if (String(meta.status) !== "awaiting_approval") continue;
    const sdk = String(meta.sdkName || meta.toolName || "");
    if (READ_SDK.has(sdk)) continue;
    const toolCallId = String(meta.toolCallId || "");
    if (!toolCallId) continue;
    const deadline = meta.approvalDeadline;
    if (typeof deadline === "string") {
      const t = Date.parse(deadline);
      if (!Number.isNaN(t) && t <= now) continue;
    }
    s = reduceNotification(
      s,
      seedApproval({
        chatId: m.chatId || chatId,
        toolCallId,
        summary: String(meta.summary || meta.toolName || "tool"),
        now,
      }),
      { surface: "web", activeChatId: null, now },
    ).state;
  }
  return s;
}

export function hydrateDaemonFromConnections(
  state: NotificationState,
  connections: HydrateConnection[],
  workspaceId?: string,
  now = Date.now(),
): NotificationState {
  const daemons = connections.filter((c) => c.clientKind === "daemon");
  const forWs = workspaceId
    ? daemons.filter((c) => !c.workspaceId || c.workspaceId === workspaceId)
    : daemons;
  const bound = forWs.some((c) => c.role !== "standby") || (forWs.length > 0);
  const event = bound ? seedDaemonUp(workspaceId) : seedDaemonDown(workspaceId);
  return reduceNotification(
    state,
    event,
    { surface: "web", activeChatId: null, now },
  ).state;
}

export function hydrateDaemonFromPresence(
  state: NotificationState,
  presence: { bound?: boolean; workspaceId?: string },
  now = Date.now(),
): NotificationState {
  return reduceNotification(
    state,
    presence.bound
      ? seedDaemonUp(presence.workspaceId)
      : seedDaemonDown(presence.workspaceId),
    { surface: "web", activeChatId: null, now },
  ).state;
}
```

Si `GET /connections` aún **no** tiene `clientKind` (plan 17 no mergeado): `daemons.length === 0` ⇒ `bound: false` ⇒ `sin runner`. Eso es correcto: un socket web `clientKind: "client"` no es runner. No uses `openConnections > 0` como proxy de daemon.

- [ ] Test `cli/src/notifications/hydrate.test.ts`:

```ts
import { expect, test } from "bun:test";
import { emptyNotificationState, hasApproval, hasDaemonDown } from "./store";
import {
  hydrateDaemonFromConnections,
  hydrateDaemonFromPresence,
  hydrateFromMessages,
} from "./hydrate";

test("hydrate ask from awaiting_approval metadata", () => {
  const s = hydrateFromMessages(
    emptyNotificationState(),
    [
      {
        role: "tool",
        metadata: {
          status: "awaiting_approval",
          toolCallId: "t1",
          toolName: "Write",
        },
      },
    ],
    "c1",
  );
  expect(hasApproval(s, "c1")).toBe(true);
});

test("hydrate skips timed-out ask", () => {
  const s = hydrateFromMessages(
    emptyNotificationState(),
    [
      {
        role: "tool",
        metadata: {
          status: "awaiting_approval",
          toolCallId: "t1",
          toolName: "Write",
          approvalDeadline: new Date(0).toISOString(),
        },
      },
    ],
    "c1",
    Date.now(),
  );
  expect(hasApproval(s, "c1")).toBe(false);
});

test("hydrate skips Read even if marked awaiting", () => {
  const s = hydrateFromMessages(
    emptyNotificationState(),
    [
      {
        role: "tool",
        metadata: {
          status: "awaiting_approval",
          toolCallId: "t1",
          sdkName: "Read",
        },
      },
    ],
    "c1",
  );
  expect(hasApproval(s, "c1")).toBe(false);
});

test("no daemon connections → sin runner; presence bound clears", () => {
  let s = hydrateDaemonFromConnections(emptyNotificationState(), [], "w1");
  expect(hasDaemonDown(s)).toBe(true);
  s = hydrateDaemonFromConnections(
    s,
    [{ clientKind: "daemon", role: "primary", workspaceId: "w1" }],
    "w1",
  );
  expect(hasDaemonDown(s)).toBe(false);
  s = hydrateDaemonFromPresence(s, { bound: false, workspaceId: "w1" });
  expect(hasDaemonDown(s)).toBe(true);
  s = hydrateDaemonFromPresence(s, { bound: true, workspaceId: "w1" });
  expect(hasDaemonDown(s)).toBe(false);
});
```

- [ ] Copiar `hydrateFromMessages` / `hydrateDaemonFromConnections` / `hydrateDaemonFromPresence` a `web/src/lib/notification-hydrate.ts` (keep-in-sync) y el test a `web/src/lib/notification-hydrate.test.ts`.

- [ ] Web `ChatDetailInner`: cuando `chat.data?.messages` cambia, hidratar:

```tsx
useEffect(() => {
  if (!chat.data?.messages) return;
  const next = hydrateFromMessages(
    emptyNotificationState(),
    chat.data.messages.map((m) => ({
      role: m.role,
      chatId,
      metadata: (m.metadata || null) as Record<string, unknown> | null,
    })),
    chatId,
  );
  for (const n of next.items) {
    notices.apply("chat.tool.update", {
      chatId,
      toolCallId: n.toolCallId,
      metadata: { status: "awaiting_approval", toolName: "write", toolCallId: n.toolCallId },
    });
  }
}, [chat.data?.messages, chatId]);
```

Mejor: exportar `hydrateFromMessages` y aplicar el state **vía** `apply` por cada ask encontrado (idempotente por `dedupKey`). No resetear el store entero (borrarías un daemon down vivo).

- [ ] Web `WorkspaceDetailInner` / `WorkspacesPanelInner`: con `useConnections` (ya usado en WorkspacesPanel):

```tsx
const connections = useConnections(signedIn);
useEffect(() => {
  if (!connections.data) return;
  const rows = Array.isArray(connections.data)
    ? connections.data
    : (connections.data as { connections?: HydrateConnection[] }).connections || [];
  notices.apply(
    "daemon.presence",
    {
      bound: rows.some((c) => c.clientKind === "daemon" && (!workspaceId || c.workspaceId === workspaceId)),
      workspaceId,
    },
  );
}, [connections.data, workspaceId]);
```

En `WorkspacesPanel` el `workspaceId` es por fila: para cada `w`, `apply` con ese id. `dismissKind` sin match de otro workspace deja el aviso del workspace correcto (el id entra en `dedupKey`).

Si `useConnections` no existe en WorkspaceDetail, importarlo igual que WorkspacesPanel (`web/src/lib/hooks.ts`).

- [ ] `onPush` `daemon.presence` ya entra por Task 4. Hidratar connections cubre el **reload** sin esperar el siguiente heartbeat.

- [ ] TUI: tras `loadChat(id)` (la función que hace `chat.get`), hidratar mensajes:

```tsx
const rows = (got.data as { messages?: Array<{ role?: string; metadata?: Record<string, unknown>; chatId?: string }> })?.messages ?? [];
setNotices((prev) => hydrateFromMessages(prev, rows, id));
```

Tras bind inicial, si `status === "bound"` no seeds daemon down. En el `onPush`, `daemon.presence` ya reduce. Si el WS listener de close (plan 17 `reconnecting`) existe, `setNotices((p) => reduceNotification(p, seedDaemonDown(workspaceId), { surface: "tui", activeChatId: activeChatIdRef.current }).state)`. Si **no** existe on-close, el fallback del header Task 3 (`status !== "bound"`) ya muestra `sin runner`.

- [ ] Correr:

```bash
cd cli && bun test src/notifications/hydrate.test.ts
cd web && bun test src/lib/notification-hydrate.test.ts
```

- [ ] Commit:

```bash
git add cli/src/notifications/hydrate.ts cli/src/notifications/hydrate.test.ts \
  web/src/lib/notification-hydrate.ts web/src/lib/notification-hydrate.test.ts \
  web/src/lib/notification-context.tsx web/src/components/ChatDetailPanel.tsx \
  web/src/components/WorkspaceDetailPanel.tsx web/src/components/WorkspacesPanel.tsx \
  tui/src/App.tsx
git commit -m "feat(notifications): hydrate ask and sin runner across reload"
```

---

## Task 7: Smokes Gherkin — turn done, ask, daemon, anti-spam, watch

**Files:**

- Test: `cli/scripts/notifications-spam-smoke.ts`
- Test: `cli/scripts/notifications-ask-smoke.ts`
- Test: `cli/scripts/notifications-daemon-smoke.ts`
- Modify: `cli/package.json`

Sin LLM. Dos clientes WS del mismo user: A actúa como daemon publicando stream/tool/presence; B es el “viewer” y reduce el store. Cubre los 5 escenarios. Watch se cubre con el test de Task 5 más un assert en el smoke de spam: el viewer **imprime** deltas (simula watch) y el store queda en 1 item.

- [ ] En `cli/package.json` scripts, añadir si no están (no quitar `start`/`dev`/`test`):

```json
"smoke:notifications": "bun run scripts/notifications-spam-smoke.ts && bun run scripts/notifications-ask-smoke.ts && bun run scripts/notifications-daemon-smoke.ts"
```

- [ ] Crear `cli/scripts/notifications-spam-smoke.ts`:

```ts
/**
 * Gherkin: Sin spam + Turn done.
 * A publica start + 40 deltas + end. B reduce. Store = 1 turn_done.
 * Watch-like log length = 42. Cero OS.
 */
import { loadConfig } from "../src/config";
import { ChavezWsClient } from "../src/ws/client";
import {
  emptyNotificationState,
  reduceNotification,
} from "../src/notifications/store";
import { shouldShowTuiBadge } from "../src/notifications/classify";

const config = loadConfig();
const token = process.env.CHAVEZ_ACCESS_TOKEN || config.accessToken;
if (!token) {
  console.error("Need login / CHAVEZ_ACCESS_TOKEN");
  process.exit(1);
}

const a = new ChavezWsClient(token);
const b = new ChavezWsClient(token);
await a.connect();
await b.connect();

const session = await a.request({ type: "session.create", title: "notice-spam" });
if (!session.ok) throw new Error(session.error);
const sessionId = (session.data as { session: { id: string } }).session.id;
const chat = await a.request({ type: "chat.create", sessionId, title: "notice-spam-chat" });
if (!chat.ok) throw new Error(chat.error);
const chatId = (chat.data as { chat: { id: string } }).chat.id;
const streamId = crypto.randomUUID();

let s = emptyNotificationState();
const printed: string[] = [];
const done = new Promise<void>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("no stream.end within 8s")), 8000);
  b.onPush((msg) => {
    printed.push(JSON.stringify({ type: msg.type, data: msg.data }));
    s = reduceNotification(
      s,
      { type: msg.type, data: msg.data },
      { surface: "tui", activeChatId: "i-am-elsewhere", now: Date.now() },
    ).state;
    if (msg.type === "chat.stream.end") {
      clearTimeout(t);
      resolve();
    }
  });
});

await a.request({ type: "chat.stream.start", chatId, streamId });
for (let i = 0; i < 40; i++) {
  await a.request({ type: "chat.stream.delta", chatId, streamId, delta: "x" });
}
await a.request({ type: "chat.stream.end", chatId, streamId, content: "ok" });
await done;

if (s.items.length !== 1) throw new Error(`store size ${s.items.length} want 1`);
if (s.items[0].kind !== "turn_done") throw new Error(s.items[0].kind);
if (!shouldShowTuiBadge(s.items[0], "i-am-elsewhere")) {
  throw new Error("TUI must badge the other chat");
}
if (shouldShowTuiBadge(s.items[0], chatId)) {
  throw new Error("TUI must not badge the open chat");
}
const deltas = printed.filter((l) => l.includes("chat.stream.delta"));
if (deltas.length < 40) throw new Error(`watch-like log lost deltas: ${deltas.length}`);

a.close();
b.close();
console.log("SMOKE PASS notifications-spam (1 notice, 40 logged deltas)");
```

`chat.stream.end` con `content: "ok"` también emite `message.appended` (handler actual). El store **ignora** `message.appended`; el size sigue 1. Si el test ve size 2, el classifier está mal — no “aceptes” appended.

- [ ] Crear `cli/scripts/notifications-ask-smoke.ts`:

```ts
/**
 * Gherkin: Ask pendiente hasta resolver o timeout.
 * A emite chat.tool.start+update awaiting_approval; B hidrata sticky.
 * A emite chat.tool.resolved (o result done); el ask desaparece.
 */
import { loadConfig } from "../src/config";
import { ChavezWsClient } from "../src/ws/client";
import {
  emptyNotificationState,
  hasApproval,
  reduceNotification,
} from "../src/notifications/store";

const config = loadConfig();
const token = process.env.CHAVEZ_ACCESS_TOKEN || config.accessToken;
if (!token) {
  console.error("Need login / CHAVEZ_ACCESS_TOKEN");
  process.exit(1);
}

const a = new ChavezWsClient(token);
const b = new ChavezWsClient(token);
await a.connect();
await b.connect();

const session = await a.request({ type: "session.create", title: "notice-ask" });
if (!session.ok) throw new Error(session.error);
const sessionId = (session.data as { session: { id: string } }).session.id;
const chat = await a.request({ type: "chat.create", sessionId, title: "notice-ask-chat" });
if (!chat.ok) throw new Error(chat.error);
const chatId = (chat.data as { chat: { id: string } }).chat.id;
const toolCallId = crypto.randomUUID();

let s = emptyNotificationState();
const gotAsk = new Promise<void>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("no ask within 8s")), 8000);
  b.onPush((msg) => {
    s = reduceNotification(
      s,
      { type: msg.type, data: msg.data },
      { surface: "web", activeChatId: null, now: Date.now() },
    ).state;
    if (hasApproval(s, chatId)) {
      clearTimeout(t);
      resolve();
    }
  });
});

const start = await a.request({
  type: "chat.tool.start",
  chatId,
  toolCallId,
  toolName: "Write",
  content: "Write",
  metadata: { input: { path: "a.txt" }, status: "awaiting_approval" },
});
if (!start.ok) {
  // start hoy fuerza status running. Mandar update si el handler existe.
  const upd = await a.request({
    type: "chat.tool.update",
    chatId,
    toolCallId,
    status: "awaiting_approval",
    metadata: { status: "awaiting_approval", toolName: "Write", toolCallId },
  });
  if (!upd.ok) {
    // Fallback: inject locally after start so the smoke still proves the store,
    // and assert the handler error is NOT "ui.notification".
    if (String(upd.error).includes("ui.notification")) {
      throw new Error("API must not require ui.notification");
    }
    s = reduceNotification(
      s,
      {
        type: "chat.tool.update",
        data: {
          chatId,
          toolCallId,
          metadata: { status: "awaiting_approval", toolName: "Write", toolCallId },
        },
      },
      { surface: "web", activeChatId: null, now: Date.now() },
    ).state;
  }
} else {
  await gotAsk;
}

if (!hasApproval(s, chatId)) throw new Error("ask not sticky");

const resolved = await a.request({
  type: "chat.tool.result",
  chatId,
  toolCallId,
  toolName: "Write",
  content: "ok",
  status: "done",
});
if (resolved.ok) {
  await new Promise((r) => setTimeout(r, 300));
  s = reduceNotification(
    s,
    {
      type: "chat.tool.result",
      data: { chatId, toolCallId, status: "done" },
    },
    { surface: "web", activeChatId: null, now: Date.now() },
  ).state;
} else {
  s = reduceNotification(
    s,
    { type: "chat.tool.resolved", data: { chatId, toolCallId, outcome: "timeout" } },
    { surface: "web", activeChatId: null, now: Date.now() },
  ).state;
}

if (hasApproval(s, chatId)) throw new Error("ask survived resolve/timeout");

a.close();
b.close();
console.log("SMOKE PASS notifications-ask");
```

Si `chat.tool.update` aún no existe en handlers, el fallback local **sigue** validando el store (Task 1). El smoke no debe fallar el merge por un sibling ausente; sí debe fallar si alguien añadió `ui.notification`.

- [ ] Crear `cli/scripts/notifications-daemon-smoke.ts`:

```ts
/**
 * Gherkin: Daemon caído → sin runner; desaparece al reconnect (plan 17).
 * Sin heartbeat real: inyecta daemon.presence en el store (mismo classifier
 * que onPush) y, si el handler ya broadcast presence, también lo espera.
 */
import { loadConfig } from "../src/config";
import { ChavezWsClient } from "../src/ws/client";
import { NO_RUNNER_LABEL } from "../src/notifications/constants";
import {
  emptyNotificationState,
  hasDaemonDown,
  reduceNotification,
} from "../src/notifications/store";

const config = loadConfig();
const token = process.env.CHAVEZ_ACCESS_TOKEN || config.accessToken;
if (!token) {
  console.error("Need login / CHAVEZ_ACCESS_TOKEN");
  process.exit(1);
}

const path = process.cwd().replace(/\\/g, "/");
const daemon = new ChavezWsClient(token);
const viewer = new ChavezWsClient(token);
await daemon.connect();
await viewer.connect();

let s = emptyNotificationState();
viewer.onPush((msg) => {
  s = reduceNotification(
    s,
    { type: msg.type, data: msg.data },
    { surface: "web", activeChatId: null, now: Date.now() },
  ).state;
});

const bind = await daemon.bind(path, "daemon");
if (!bind.ok) throw new Error(bind.error || "bind failed");
const workspaceId = (bind.data as { workspace?: { id: string } })?.workspace?.id;

s = reduceNotification(
  s,
  { type: "daemon.presence", data: { bound: true, workspaceId } },
  { surface: "web", activeChatId: null, now: Date.now() },
).state;
if (hasDaemonDown(s)) throw new Error("bound must clear sin runner");

s = reduceNotification(
  s,
  { type: "daemon.presence", data: { bound: false, workspaceId } },
  { surface: "web", activeChatId: null, now: Date.now() },
).state;
if (!hasDaemonDown(s)) throw new Error("expected sin runner");
if (s.items.find((i) => i.kind === "daemon")?.title !== NO_RUNNER_LABEL) {
  throw new Error(`label must be ${NO_RUNNER_LABEL}`);
}

s = reduceNotification(
  s,
  { type: "daemon.presence", data: { bound: true, workspaceId } },
  { surface: "web", activeChatId: null, now: Date.now() },
).state;
if (hasDaemonDown(s)) throw new Error("reconnect must drop sin runner");

daemon.close();
viewer.close();
console.log("SMOKE PASS notifications-daemon (sin runner ↔ reconnect)");
```

- [ ] Correr unitarios + smokes (smokes requieren API + token; si no hay token, los unitarios bastan en CI de paquete y el smoke se documenta como manual):

```bash
cd cli && bun test src/notifications
cd web && bun test src/lib/notifications.test.ts src/lib/notification-hydrate.test.ts
cd api && bun test src/ws/notification-events.test.ts
cd cli && bun run smoke:notifications
```

- [ ] Commit:

```bash
git add cli/scripts/notifications-spam-smoke.ts \
  cli/scripts/notifications-ask-smoke.ts \
  cli/scripts/notifications-daemon-smoke.ts cli/package.json
git commit -m "test(notifications): gherkin smokes for turn, ask, daemon, anti-spam"
```

---

## Mapping Gherkin → tasks

| Escenario | Tasks | Señal de hecho |
|---|---|---|
| Turn done — Web aviso en chat/workspace | 1, 4, 7 | `data-testid="chat-turn-notice"` en el chat; `NotificationBadge` / toast en workspace; smoke store `turn_done` |
| Turn done — TUI badge si no estoy en ese chat | 1, 3, 7 | `shouldShowTuiBadge(n, active) === false` en el abierto, `true` en el otro; fila `●` |
| Ask pendiente hasta resolver o timeout | 1, 3, 4, 6, 7 | sticky `approval`; `markChatRead` no lo borra; `chat.tool.resolved` / deadline hidratado lo quita; CSS `tool-ask` / `!` |
| Daemon caído → `sin runner`; reconnect lo quita | 1, 3, 4, 6, 7 | copy exacto `sin runner`; `daemon.presence` bound true → `hasDaemonDown === false`; header TUI / `data-testid="runner-status"` |
| Sin spam de deltas | 1, 2, 5, 7 | 100 deltas → 1 item; `NEVER_NOTIFY_TYPES`; watch imprime deltas y no llama al store |
| CLI watch no es notificación / no OS | 5, 7 | `headless.ts` sin `Notification`/`notify-send`/`notifications/store`; JSON.stringify sigue |

## Fuera de alcance (no implementar en esta fase)

- `new Notification()`, Service Worker, badges del favicon/OS, `notify-send`, `osascript`, email, Resend.
- Event WS `ui.notification` o tabla `notifications`.
- Cola de turns, worktrees paralelos, Cursor cloud, voz, extensión IDE, upload desde el navegador.
- “Siempre permitir”, lote de asks, auto-approve headless.
- Cambiar `formatWatchLine` para que deje de loguear deltas (el live log **debe** seguir).

## Verificación manual (tras las tasks)

1. TUI en cwd A, Web en `/chats/<id>` de ese workspace. Disparar un turn. Al terminar: banner “Turn terminado” en el chat Web; TUI **sin** `●` si estás en ese chat.
2. En TUI, Tab a otro chat (o deja el cursor en uno distinto) y dispara el turn desde Web. TUI muestra `●` en el chat que no estás viendo. Enter en esa fila: el `●` desaparece.
3. Modo `ask` (plan 3/13): write. Web ToolCard `tool-ask` + banner “Ask pendiente”; TUI `!` rojo en la fila, incluso en el chat activo, hasta `[y]`/`[n]` o timeout 300s.
4. Matar el daemon. Web y TUI muestran **sin runner**. Relanzar `chavez headless workspace open` o esperar reconnect (plan 17): el copy desaparece.
5. Un turn largo: el stream live se mueve (deltas) y **no** llueve toasts. Un toast/banner al start (badge live en listas) y otro al end.
6. `chavez headless chat watch <id>`: JSON (o líneas `formatWatchLine`) por delta; ninguna burbuja de escritorio.
)
</tool_call>