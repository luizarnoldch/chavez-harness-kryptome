# Daemon reconnect Implementation Plan

> **For agentic workers:** Execute task-by-task. Do not skip tests. Do not implement Cursor cloud, voz, extensión IDE, upload desde el navegador, worktrees paralelos, cola de turns (plan 29), thinking/steer (plan 16), notificaciones OS/email (plan 24) ni Cursor ejecutable (plan 4). Spec: [`plan.md`](./plan.md). Si un sibling (`invariants` Task 2, `attach-files` Task 3) ya añadió `hostname` / `role` / `findDaemons` / `daemon.presence` / `NO_DAEMON_ERROR`, **extiende**; no reescribas ni cambies esos strings.

**Goal:** El runner no se pierde en un corte corto de red ni al dormir la laptop. El daemon **reconecta y re-bindea el mismo workspace** (mismo `daemonId`); Web deja de mostrar **sin runner**. Un turn a mitad de sleep termina `error/cancelled` de forma explícita — **no** queda busy eterno y **no** se reanuda solo. Web muestra **hostname, path y last-seen**; `chavez headless connections` lista el daemon. Dos daemons: **gana el primero**; el segundo se informa y **no duplica tools**. Si el daemon muere, Web lo nota **en segundos** y tanto `@` (`fs.complete`) como `agent.turn.request` fallan con **el mismo** `NO_DAEMON_ERROR`.

**Architecture:** El filesystem y el SDK viven en el proceso daemon (`cli/src/ws/daemon.ts` o TUI con `clientKind: "daemon"`). La API es un hub in-memory: bind, first-wins, fan-out WS. Hoy el daemon hace `ping` cada 20s y **`process.exit` si falla** — un corte corto mata el runner. Esta fase añade identidad estable (`daemonId`), heartbeat de 2s, barrido de stale a 5s, reconnect con backoff y presencia empujada a Web/CLI.

```
Daemon (headless | TUI)
  daemonId (UUID de proceso, persistido en ~/.chavez/workspaces/<hash>.json)
  heartbeat cada HEARTBEAT_INTERVAL_MS (2s)
  on WS close (no user): backoff → connect → workspace.bind { daemon, hostname, path, daemonId }
        │
        ▼
API hub
  touch(lastSeen) en cada mensaje
  evictStaleDaemons cada HEARTBEAT_SWEEP_MS
    lastSeen > HEARTBEAT_STALE_MS (5s)
      → close zombie, clear turnBusy, broadcast
         chat.stream.error TURN_INTERRUPTED
         agent.turn.ended { reason: "disconnected" }
         daemon.presence { bound: next? }
  bind + mismo daemonId → reclaim (evicta zombie, sigue primary)
  bind + otro daemonId  → standby (DAEMON_STANDBY_NOTE, no dispatch)
        │
        ▼
Web + CLI connections
  hostname · path · last-seen
  bound=false → badge "sin runner"
  fs.complete / agent.turn.request → NO_DAEMON_ERROR (mismo string)
```

Estado actual que este plan extiende (no reescribir):

- `api/src/ws/hub.ts`: `HubConnection` tiene `path`, `clientKind`, `connectedAt`. **No** hay `hostname`, `lastSeen`, `daemonId`, `role`, `turnBusy`. `findDaemon` devuelve el **primero insertado en el Map** (orden de inserción, no `connectedAt`).
- `api/src/ws/handlers.ts` `workspace.bind` guarda path + `clientKind`. Respuesta `{ workspace, clientKind }`. **No** emite `daemon.presence`. `ping` → `pong` y no toca liveness.
- `api/src/index.ts` `onClose` solo `hub.remove(connectionId)`. Nadie se entera. Un turn `turnBusy` en el daemon queda huérfano en el cliente; el hub **ni siquiera tiene** `turnBusy`.
- `cli/src/ws/daemon.ts`: bind una vez; `onPush` solo `agent.turn.dispatch`; `setInterval(ping, 20000)` y **`shutdown()` / `process.exit(0)` si el ping tira**. No reconnect. No `hostname`/`daemonId`.
- `cli/src/ws/client.ts`: `on close` rechaza pending, `ws = null`. **No** reconecta. `request()` llama `connect()` si el socket no está OPEN, pero no re-bindea.
- `tui/src/App.tsx`: un `useEffect` conecta + `bind(..., "daemon")`. Cleanup `c.close()`. Header `daemon/runner` si `status === "bound"`. Escape no es reconnect. Si el WS cae, `status` se queda en `bound` hasta error de request.
- `web/src/lib/ws-client.ts` / `ws-context.tsx`: cookie WS, **sin reconnect**. `useConnections` sin `refetchInterval`. `WorkspacesPanel` lista `path` y un badge de `openConnections`; **no** dice hostname ni last-seen ni **sin runner**.
- `GET /connections` (`api/src/routes/workspaces.ts`) = `hub.listForUser` → `connectionId, workspaceId, path, clientKind, connectedAt`. OpenAPI `ConnectionPublic` **omite** `clientKind`. CLI `chavez headless connections` vuelca el JSON crudo.
- `agent.turn.request` falla con el literal `"No daemon bound for this workspace. Run: chavez headless workspace open"` si `findDaemon` es null. `fs.complete` (plan attach-files) debe usar **ese mismo** string; si aún no existe, `agent.turn.request` es la fuente de verdad.
- Invariants Task 2 planea `role` / `findDaemons` / `daemon.presence` / hostname. Attach-files Task 3 planea `hostname` en bind. **Esta fase es la que hace liveness, reconnect y last-seen.** Si esos campos ya están, no los dupliques: añade `lastSeen`, `daemonId`, `firstBoundAt`, sweep y reclaim.

**Tech Stack:** Bun, Hono WebSocket hub in-memory, Claude Agent SDK `query({ abortController })` (si el runner aún no acepta abort, esta fase lo añade), Ink TUI, Astro/React web, `node:os.hostname()`.

**Global Constraints:**

1. El filesystem real vive en el daemon (cwd del workspace). API y browser no listan ni hidratan disco. Reconnect **no** mueve I/O al server.
2. Un turn solo corre si hay daemon **primary** bound y vivo (`lastSeen` fresco). Sin daemon, el error es exactamente `NO_DAEMON_ERROR` — el mismo string para `agent.turn.request`, `agent.turn.cancel` y `fs.complete`.
3. 1 turn por daemon. Sleep/disconnect **libera** `turnBusy`. El turn en vuelo termina con `TURN_INTERRUPTED` (visible en timeline). **No** auto-resume; el usuario dispara un turn nuevo.
4. First-wins: el daemon más antiguo (`firstBoundAt` ASC, tie-break `connectionId`) es primary y recibe `agent.turn.dispatch`. El segundo es standby: se le informa con `DAEMON_STANDBY_NOTE` y **no** ejecuta tools ni `publishAgentTurn` local.
5. Reclaim por `daemonId`: el **mismo proceso** que reconecta evicta su conexión zombie y sigue primary. Un **otro** `daemonId` (otra máquina o nuevo proceso) no desaloja al primary vivo.
6. Web, TUI y `chat watch` ven el mismo `daemon.presence` y el mismo `chat.stream.error` de interrupción.
7. Heartbeat es in-app (WS). Sin notificaciones OS/email.
8. Un usuario = su vault. Presencia y connections son **solo** del `userId` de la sesión. Un workspace ajeno sigue 404.
9. Claude es el provider ejecutable. Cursor vinculado no ejecuta turns aquí; cancel/busy/presencia aplican igual. No simular tools de Cursor.
10. Fuera de alcance: Cursor cloud, voz, extensión IDE, upload desde el navegador, worktrees paralelos, cola de turns, thinking/steer.

**Constantes (congeladas, no inventar otras):**

| Nombre | Valor |
|---|---|
| `NO_DAEMON_ERROR` | `"No daemon bound for this workspace. Run: chavez headless workspace open"` |
| `DAEMON_STANDBY_NOTE` | `"Another daemon is already primary for this workspace; this connection is standby"` |
| `TURN_BUSY_ERROR` | `"Turn already running on this daemon"` |
| `TURN_CANCELLED` | `"Turn cancelled"` |
| `TURN_INTERRUPTED` | `"Turn interrupted: daemon disconnected"` |
| `NO_RUNNER_LABEL` | `"sin runner"` |
| `HEARTBEAT_INTERVAL_MS` | `2000` |
| `HEARTBEAT_STALE_MS` | `5000` |
| `HEARTBEAT_SWEEP_MS` | `1000` |
| `RECONNECT_BASE_MS` | `500` |
| `RECONNECT_MAX_MS` | `8000` |
| `RECONNECT_JITTER_MS` | `250` |
| `WS_CONNECT_TIMEOUT_MS` | `10000` |

`NO_DAEMON_ERROR` / `DAEMON_STANDBY_NOTE` / `TURN_BUSY_ERROR` / `TURN_CANCELLED` deben ser **idénticos** a invariants / agent-tools. Un solo literal en runtime por paquete: API en `api/src/ws/errors.ts`; CLI en `cli/src/ws/presence-constants.ts` (CLI no importa `api/`). Si el archivo de errores ya existe, **añade** `TURN_INTERRUPTED` y reexporta el resto.

---

## Task 1: Hub — lastSeen, daemonId, first-wins, barrido stale

**Files:**

- Create: `api/src/ws/errors.ts` (o Modify si invariants ya lo creó)
- Create: `api/src/ws/heartbeat.ts`
- Test: `api/src/ws/heartbeat.test.ts`
- Modify: `api/src/ws/hub.ts`
- Test: `api/src/ws/hub.test.ts`
- Modify: `api/src/ws/protocol.ts`
- Modify: `api/package.json`

Cierra la base de los escenarios Heartbeat, Presencia y Dos daemons. Sin UI todavía: el Map conoce quién está vivo y quién es primary.

- [ ] Añadir `"test": "bun test"` en `api/package.json` `scripts` si no existe (dejar `dev`/`start`/`db:*`/`test:e2e` intactos).

- [ ] Crear o extender `api/src/ws/errors.ts`:

```ts
export const NO_DAEMON_ERROR =
  "No daemon bound for this workspace. Run: chavez headless workspace open";
export const DAEMON_STANDBY_NOTE =
  "Another daemon is already primary for this workspace; this connection is standby";
export const TURN_BUSY_ERROR = "Turn already running on this daemon";
export const TURN_CANCELLED = "Turn cancelled";
export const TURN_INTERRUPTED = "Turn interrupted: daemon disconnected";
```

Si `api/src/ws/tool-protocol.ts` ya exporta `NO_DAEMON_ERROR`, re-exportar desde `errors.ts` y borrar el duplicado. El texto de `agent.turn.request` en `handlers.ts` debe importar `NO_DAEMON_ERROR` (Task 2).

- [ ] En `api/src/ws/protocol.ts`, añadir a `ClientMessage` (dejar el resto):

```ts
  hostname?: string;
  daemonId?: string;
  role?: string;
```

- [ ] Reemplazar/extender tipos y métodos en `api/src/ws/hub.ts`. Si `hostname`/`role` ya existen, **añade** los campos nuevos (`lastSeen`, `daemonId`, `firstBoundAt`, `turnBusy`, `turnChatId`) y los métodos que falten. Estado objetivo:

```ts
import type { WSContext } from "hono/ws";

export type ClientKind = "client" | "daemon";
export type ConnectionRole = "primary" | "standby" | "client";

export type HubConnection = {
  connectionId: string;
  userId: string;
  workspaceId: string | null;
  path: string | null;
  clientKind: ClientKind;
  hostname: string | null;
  daemonId: string | null;
  role: ConnectionRole;
  connectedAt: string;
  firstBoundAt: string;
  lastSeen: string;
  turnBusy: boolean;
  turnChatId: string | null;
  ws: WSContext;
};

export type ConnectionPublic = {
  connectionId: string;
  workspaceId: string | null;
  path: string | null;
  clientKind: ClientKind;
  hostname: string | null;
  daemonId: string | null;
  role: ConnectionRole;
  connectedAt: string;
  firstBoundAt: string;
  lastSeen: string;
  turnBusy: boolean;
};

function toPublic(c: HubConnection): ConnectionPublic {
  return {
    connectionId: c.connectionId,
    workspaceId: c.workspaceId,
    path: c.path,
    clientKind: c.clientKind,
    hostname: c.hostname,
    daemonId: c.daemonId,
    role: c.role,
    connectedAt: c.connectedAt,
    firstBoundAt: c.firstBoundAt,
    lastSeen: c.lastSeen,
    turnBusy: c.turnBusy,
  };
}
```

En `hub.add`, defaults: `path: null`, `hostname: null`, `daemonId: null`, `clientKind: "client"`, `role: "client"`, `connectedAt`/`firstBoundAt`/`lastSeen` = `new Date().toISOString()`, `turnBusy: false`, `turnChatId: null`. Extender el `Omit`/`Partial` para los campos nuevos.

Métodos a garantizar (nombres exactos):

```ts
touch(connectionId: string, at = new Date().toISOString()) {
  const c = connections.get(connectionId);
  if (c) c.lastSeen = at;
},
setHostname(connectionId: string, hostname: string | null) { /* … */ },
setDaemonId(connectionId: string, daemonId: string | null) { /* … */ },
setRole(connectionId: string, role: ConnectionRole) { /* … */ },
setTurnBusy(connectionId: string, busy: boolean, chatId: string | null = null) {
  const c = connections.get(connectionId);
  if (!c) return;
  c.turnBusy = busy;
  c.turnChatId = busy ? chatId : null;
},
findDaemons(userId: string, workspaceId: string): HubConnection[] {
  return [...connections.values()]
    .filter(
      (c) =>
        c.userId === userId &&
        c.workspaceId === workspaceId &&
        c.clientKind === "daemon",
    )
    .sort(
      (a, b) =>
        a.firstBoundAt.localeCompare(b.firstBoundAt) ||
        a.connectionId.localeCompare(b.connectionId),
    );
},
findDaemon(userId: string, workspaceId: string): HubConnection | null {
  return this.findDaemons(userId, workspaceId)[0] ?? null;
},
findByDaemonId(userId: string, daemonId: string): HubConnection | null {
  for (const c of connections.values()) {
    if (c.userId === userId && c.daemonId === daemonId) return c;
  }
  return null;
},
listDaemons(): HubConnection[] {
  return [...connections.values()].filter((c) => c.clientKind === "daemon");
},
```

`listForUser` mapea con `toPublic` (incluye `lastSeen`, `hostname`, `role`, `daemonId`, `turnBusy`).

`remove` no cambia de semántica (borra del Map). Quien llame `remove` es responsable de broadcast (Task 2 / `evictStaleDaemons`).

- [ ] Crear `api/src/ws/heartbeat.ts`:

```ts
import { hub, type HubConnection } from "./hub";
import { TURN_INTERRUPTED } from "./errors";

export const HEARTBEAT_INTERVAL_MS = 2000;
export const HEARTBEAT_STALE_MS = 5000;
export const HEARTBEAT_SWEEP_MS = 1000;

export function isStale(
  lastSeenIso: string,
  now = Date.now(),
  staleMs = HEARTBEAT_STALE_MS,
): boolean {
  const t = Date.parse(lastSeenIso);
  if (!Number.isFinite(t)) return true;
  return now - t > staleMs;
}

export type DaemonPresencePayload = {
  workspaceId: string;
  bound: boolean;
  hostname: string | null;
  path: string | null;
  lastSeen: string | null;
  connectionId: string | null;
  daemonId: string | null;
  role: "primary" | "standby" | null;
  reason: "bind" | "unbind" | "disconnected" | "heartbeat-stale" | "reclaim";
};

export function presenceFromDaemon(
  workspaceId: string,
  daemon: HubConnection | null,
  reason: DaemonPresencePayload["reason"],
): DaemonPresencePayload {
  return {
    workspaceId,
    bound: Boolean(daemon),
    hostname: daemon?.hostname ?? null,
    path: daemon?.path ?? null,
    lastSeen: daemon?.lastSeen ?? null,
    connectionId: daemon?.connectionId ?? null,
    daemonId: daemon?.daemonId ?? null,
    role: daemon ? "primary" : null,
    reason,
  };
}

export function evictStaleDaemons(now = Date.now()): HubConnection[] {
  const evicted: HubConnection[] = [];
  for (const c of hub.listDaemons()) {
    if (!isStale(c.lastSeen, now)) continue;
    evicted.push(c);
    const chatId = c.turnBusy ? c.turnChatId : null;
    const { userId, workspaceId, connectionId } = c;
    try {
      c.ws.close();
    } catch {
      // ignore
    }
    hub.remove(connectionId);
    if (chatId) {
      hub.broadcastToUser(
        userId,
        hub.pushEvent("chat.stream.error", {
          chatId,
          error: TURN_INTERRUPTED,
        }),
      );
      hub.broadcastToUser(
        userId,
        hub.pushEvent("agent.turn.ended", {
          chatId,
          reason: "disconnected",
          error: TURN_INTERRUPTED,
        }),
      );
    }
    if (workspaceId) {
      const next = hub.findDaemon(userId, workspaceId);
      if (next) hub.setRole(next.connectionId, "primary");
      hub.broadcastToUser(
        userId,
        hub.pushEvent(
          "daemon.presence",
          presenceFromDaemon(workspaceId, next, "heartbeat-stale"),
        ),
      );
    }
  }
  return evicted;
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;

export function startHeartbeatSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    evictStaleDaemons(Date.now());
  }, HEARTBEAT_SWEEP_MS);
  if (typeof sweepTimer === "object" && sweepTimer && "unref" in sweepTimer) {
    (sweepTimer as NodeJS.Timeout).unref();
  }
}

export function stopHeartbeatSweep(): void {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
}
```

- [ ] Crear `api/src/ws/heartbeat.test.ts` con bun:test. Mock `WSContext`: `{ send: () => {}, close: () => {} } as unknown as WSContext`. Cubrir:

  1. `isStale` con `lastSeen` ahora → `false`; con `now - lastSeen = 5001` → `true`; ISO inválido → `true`.
  2. `evictStaleDaemons`: añadir un daemon con `lastSeen` viejo y `turnBusy: true` / `turnChatId: "c1"`. Tras evict: `findDaemon` es `null`; `remove` lo sacó; `ws.close` se llamó (espía). Un segundo daemon del mismo workspace con `lastSeen` fresco **no** se evicta y pasa a `role === "primary"`.
  3. Cliente (`clientKind: "client"`) con `lastSeen` viejo **no** se evicta (el sweep solo mira daemons).
  4. `presenceFromDaemon(null, "heartbeat-stale")` tiene `bound: false`, `hostname: null`, `reason: "heartbeat-stale"`.

Para (2), registra un spy en `hub.broadcastToUser` **o** un `ws.send` del viewer: añade un client connection del mismo `userId` cuyo `ws.send` acumule payloads. Tras `evictStaleDaemons`, el array contiene `chat.stream.error` con `error === TURN_INTERRUPTED` y `daemon.presence` con `bound: false` (si no queda daemon) o `bound: true` (si queda el fresco).

- [ ] Crear o extender `api/src/ws/hub.test.ts`:

  - `findDaemon` sin daemons → `null`.
  - Dos daemons mismo workspace: el de `firstBoundAt` más viejo gana **aunque se inserte segundo** (tras `add`, asignar `c.firstBoundAt` a mano).
  - `findByDaemonId` encuentra por id; otro `userId` no.
  - `touch` actualiza `lastSeen`.
  - `listForUser` incluye `hostname`, `role`, `lastSeen`, `daemonId`.
  - Tras `remove` del primary, `findDaemon` devuelve el standby restante.

No arrancar `startHeartbeatSweep` en tests unitarios (el timer ensucia). El sweep se prueba llamando `evictStaleDaemons` directo.

- [ ] Correr:

```bash
cd api && bun test src/ws/hub.test.ts src/ws/heartbeat.test.ts
```

Esperado: 0 fail. First-wins por `firstBoundAt`. Stale evicta, libera busy, no toca clients.

- [ ] Commit:

```bash
git add api/src/ws/errors.ts api/src/ws/heartbeat.ts api/src/ws/heartbeat.test.ts \
  api/src/ws/hub.ts api/src/ws/hub.test.ts api/src/ws/protocol.ts api/package.json
git commit -m "feat(daemon): hub lastSeen, daemonId and stale heartbeat sweep"
```

---

## Task 2: Bind reclaim, heartbeat RPC, disconnect interrumpe el turn

**Files:**

- Modify: `api/src/ws/handlers.ts`
- Modify: `api/src/index.ts`
- Modify: `api/src/routes/workspaces.ts`
- Modify: `api/openapi/openapi.yaml`
- Test: `api/src/ws/bind-reclaim.test.ts`

Cierra Reconnect (lado server: el mismo `daemonId` no queda standby detrás de un zombie) y el lado server de Turn-en-curso/sleep (busy se limpia al close/stale).

- [ ] En `api/src/index.ts`:

  1. Importar `startHeartbeatSweep` y `presenceFromDaemon` / `evict` no hace falta aquí más que el start.
  2. Llamar `startHeartbeatSweep()` **una vez** al cargar el módulo (junto al `console.log` del listen). `unref` ya está en heartbeat.ts para no impedir el exit de tests que importen el entry por error.
  3. Reemplazar `onClose` del upgrade WS:

```ts
onClose() {
  const conn = hub.get(connectionId);
  hub.remove(connectionId);
  if (!conn?.workspaceId) return;
  if (conn.turnBusy && conn.turnChatId) {
    hub.broadcastToUser(
      conn.userId,
      hub.pushEvent("chat.stream.error", {
        chatId: conn.turnChatId,
        error: TURN_INTERRUPTED,
      }),
    );
    hub.broadcastToUser(
      conn.userId,
      hub.pushEvent("agent.turn.ended", {
        chatId: conn.turnChatId,
        reason: "disconnected",
        error: TURN_INTERRUPTED,
      }),
    );
  }
  const next = hub.findDaemon(conn.userId, conn.workspaceId);
  if (next) hub.setRole(next.connectionId, "primary");
  hub.broadcastToUser(
    conn.userId,
    hub.pushEvent(
      "daemon.presence",
      presenceFromDaemon(conn.workspaceId, next, "disconnected"),
    ),
  );
},
```

Importar `TURN_INTERRUPTED` desde `./ws/errors` y `presenceFromDaemon` desde `./ws/heartbeat`.

- [ ] En `handleWsMessage` (`api/src/ws/handlers.ts`), **primera línea** dentro del `try` tras validar `type`/`id`:

```ts
hub.touch(connectionId);
```

Así `ping`, `daemon.heartbeat`, `chat.append`, etc. refrescan `lastSeen`.

- [ ] Case `ping`: dejar `ok("pong", id, { t: Date.now() })`. El touch ya cubre liveness.

- [ ] Nuevo case `daemon.heartbeat` (junto a `ping`):

```ts
case "daemon.heartbeat": {
  const conn = hub.get(connectionId);
  if (!conn) return fail(type, id, "Unknown connection");
  hub.touch(connectionId);
  if (typeof msg.daemonId === "string" && msg.daemonId.trim()) {
    hub.setDaemonId(connectionId, msg.daemonId.trim());
  }
  return ok(type, id, {
    t: Date.now(),
    lastSeen: hub.get(connectionId)?.lastSeen ?? null,
    role: conn.role,
  });
}
```

- [ ] Reescribir el final de `workspace.bind` (tras insert/update DB, `hub.setWorkspace`, `hub.setClientKind`) para hostname, daemonId, reclaim y presence. Pseudocódigo obligatorio:

```ts
const hostname =
  typeof msg.hostname === "string" && msg.hostname.trim()
    ? msg.hostname.trim()
    : null;
hub.setHostname(connectionId, hostname);

const daemonId =
  typeof msg.daemonId === "string" && msg.daemonId.trim()
    ? msg.daemonId.trim()
    : null;
hub.setDaemonId(connectionId, daemonId);

let role: "primary" | "standby" | "client" = "client";
let standbyReason: string | undefined;
let reclaimed = false;

if (clientKind === "daemon") {
  if (daemonId) {
    const zombie = hub.findByDaemonId(userId, daemonId);
    if (zombie && zombie.connectionId !== connectionId) {
      const keepFirst = zombie.firstBoundAt;
      const keepRole = zombie.role;
      try {
        zombie.ws.close();
      } catch {
        /* ignore */
      }
      hub.remove(zombie.connectionId);
      const self = hub.get(connectionId);
      if (self) self.firstBoundAt = keepFirst;
      reclaimed = true;
      role = keepRole === "standby" ? "standby" : "primary";
    }
  }
  const peers = hub
    .findDaemons(userId, workspace.id)
    .filter((c) => c.connectionId !== connectionId);
  if (!reclaimed) {
    if (peers[0]) {
      role = "standby";
      standbyReason = DAEMON_STANDBY_NOTE;
    } else {
      role = "primary";
    }
  } else if (role === "primary" && peers[0]) {
    // reclaim of the original primary: peers are other machines — they stay standby
    for (const p of peers) hub.setRole(p.connectionId, "standby");
  }
  hub.setRole(connectionId, role);
} else {
  hub.setRole(connectionId, "client");
}

const primary = hub.findDaemon(userId, workspace.id);
broadcast(
  userId,
  "daemon.presence",
  presenceFromDaemon(
    workspace.id,
    primary,
    reclaimed ? "reclaim" : "bind",
  ),
);

return ok(type, id, {
  workspace,
  clientKind,
  hostname: hub.get(connectionId)?.hostname ?? null,
  daemonId: hub.get(connectionId)?.daemonId ?? null,
  role,
  primaryConnectionId: primary?.connectionId ?? connectionId,
  standbyReason,
  reclaimed,
});
```

Importar `DAEMON_STANDBY_NOTE` desde `./errors` y `presenceFromDaemon` desde `./heartbeat`.

- [ ] En `workspace.unbind`: además de `setWorkspace(null)` / `setClientKind("client")`, `hub.setRole(connectionId, "client")`, `hub.setDaemonId(connectionId, null)`. Si este conn era daemon, broadcast `daemon.presence` con el `findDaemon` restante (`reason: "unbind"`).

- [ ] En `agent.turn.request`: sustituir el string inline por `NO_DAEMON_ERROR`. Tras `findDaemon`:

```ts
if (!daemon) return fail(type, id, NO_DAEMON_ERROR);
if (daemon.turnBusy) return fail(type, id, TURN_BUSY_ERROR);
hub.setTurnBusy(daemon.connectionId, true, msg.chatId);
```

Si `sendTo` falla: `hub.setTurnBusy(daemon.connectionId, false)` y `fail(..., "Daemon connection unavailable")`. El push `agent.turn.dispatch` incluye `daemonConnectionId`, `hostname`, `path`, `daemonId`.

Si invariants Task 5 ya añadió `turnBusy` / `agent.turn.ended` / `agent.turn.cancel`, **no** dupliques los cases; solo asegúrate de que `onClose` y `evictStaleDaemons` limpian busy. Si `agent.turn.ended` **no** existe, añadirlo (daemon lo enviará en Task 4):

```ts
case "agent.turn.ended": {
  if (!msg.chatId) return fail(type, id, "chatId is required");
  const ctx = await workspaceIdForChat(msg.chatId, userId);
  if (!ctx) return fail(type, id, "Chat not found");
  const daemon = hub.findDaemon(userId, ctx.workspaceId);
  if (daemon) hub.setTurnBusy(daemon.connectionId, false);
  const payload = {
    chatId: msg.chatId,
    streamId: msg.streamId,
    error: typeof msg.status === "string" ? msg.status : undefined,
  };
  broadcast(userId, "agent.turn.ended", payload);
  return ok(type, id, payload);
}
```

- [ ] En `api/src/routes/workspaces.ts` `GET /` y `GET /:workspaceId/sessions`, enriquecer cada workspace:

```ts
const daemon = hub.findDaemon(session.user.id, w.id);
return {
  ...w,
  openConnections: hub.countForWorkspace(session.user.id, w.id),
  daemonBound: Boolean(daemon),
  daemonHostname: daemon?.hostname ?? null,
  daemonPath: daemon?.path ?? w.path,
  daemonLastSeen: daemon?.lastSeen ?? null,
  daemonRole: daemon?.role ?? null,
};
```

`GET /connections` ya usa `hub.listForUser`; al extender `ConnectionPublic` los campos nuevos salen solos.

- [ ] OpenAPI `api/openapi/openapi.yaml`:

  - `ConnectionPublic`: añadir `clientKind` (`client` | `daemon`), `hostname` (nullable), `daemonId` (nullable), `role` (`primary` | `standby` | `client`), `firstBoundAt`, `lastSeen`, `turnBusy`.
  - Workspace list item: `daemonBound`, `daemonHostname`, `daemonPath`, `daemonLastSeen`.
  - Descripción de `/ws`: añadir tipos `daemon.heartbeat`, push `daemon.presence`, y que un daemon stale se evicta a los 5s.
  - `WsClientWorkspaceBind`: properties `clientKind`, `hostname`, `daemonId`.

- [ ] Crear `api/src/ws/bind-reclaim.test.ts`. Este test **no** levanta HTTP: instancia el hub a mano y llama a la lógica de reclaim extraída **o** simula dos `hub.add` + el bloque de reclaim copiado a una función exportada.

Para no duplicar el switch de handlers, extrae `assignDaemonRole` a `api/src/ws/bind-role.ts`:

```ts
import { hub } from "./hub";
import { DAEMON_STANDBY_NOTE } from "./errors";

export function assignDaemonRole(input: {
  connectionId: string;
  userId: string;
  workspaceId: string;
  daemonId: string | null;
}): { role: "primary" | "standby"; reclaimed: boolean; standbyReason?: string } {
  // exactamente el bloque reclaim + peers de arriba
}
```

`workspace.bind` llama `assignDaemonRole`. Tests:

  1. Primer daemon → `primary`, `reclaimed: false`.
  2. Segundo `daemonId` distinto, mismo workspace → `standby` + `standbyReason === DAEMON_STANDBY_NOTE`. `findDaemon` sigue siendo el primero.
  3. Reclaim: zombie con `daemonId: "d1"` + `firstBoundAt: "2026-01-01T00:00:00.000Z"`; nueva conn mismo `daemonId` → zombie `remove`d, nueva `role === "primary"`, `firstBoundAt` conservado, `reclaimed: true`. Un peer con otro id sigue standby.
  4. Reclaim mientras **otro** daemon distinto es primary vivo (firstBoundAt más viejo): el que reconecta queda **standby** (first-wins). No desaloja al otro.

- [ ] Correr:

```bash
cd api && bun test src/ws/hub.test.ts src/ws/heartbeat.test.ts src/ws/bind-reclaim.test.ts
```

- [ ] Commit:

```bash
git add api/src/ws/handlers.ts api/src/ws/bind-role.ts api/src/ws/bind-reclaim.test.ts \
  api/src/index.ts api/src/routes/workspaces.ts api/openapi/openapi.yaml
git commit -m "feat(daemon): reclaim bind by daemonId and interrupt turns on disconnect"
```

---

## Task 3: CLI WS reconnect + heartbeat (el daemon ya no se suicida)

**Files:**

- Create: `cli/src/ws/presence-constants.ts`
- Create: `cli/src/ws/reconnect.ts`
- Test: `cli/src/ws/reconnect.test.ts`
- Modify: `cli/src/ws/client.ts`
- Modify: `cli/src/ws/daemon.ts`
- Modify: `cli/src/workspace.ts`
- Modify: `cli/package.json`

Cierra Reconnect lado cliente y deja de matar el proceso en un corte corto. El ping de 20s + `shutdown()` es el bug.

- [ ] Añadir `"test": "bun test"` en `cli/package.json` `scripts` si no existe (dejar `start`/`dev` intactos).

- [ ] Crear `cli/src/ws/presence-constants.ts` (mismos strings que API; no importar `api/`):

```ts
export const NO_DAEMON_ERROR =
  "No daemon bound for this workspace. Run: chavez headless workspace open";
export const DAEMON_STANDBY_NOTE =
  "Another daemon is already primary for this workspace; this connection is standby";
export const TURN_INTERRUPTED = "Turn interrupted: daemon disconnected";
export const HEARTBEAT_INTERVAL_MS = 2000;
export const RECONNECT_BASE_MS = 500;
export const RECONNECT_MAX_MS = 8000;
export const RECONNECT_JITTER_MS = 250;
```

- [ ] Crear `cli/src/ws/reconnect.ts`:

```ts
import {
  RECONNECT_BASE_MS,
  RECONNECT_JITTER_MS,
  RECONNECT_MAX_MS,
} from "./presence-constants";

export function reconnectDelayMs(attempt: number): number {
  const exp = RECONNECT_BASE_MS * 2 ** Math.max(0, attempt);
  return Math.min(RECONNECT_MAX_MS, exp);
}

export function reconnectDelayWithJitter(
  attempt: number,
  rand = Math.random(),
): number {
  return reconnectDelayMs(attempt) + Math.floor(rand * RECONNECT_JITTER_MS);
}
```

- [ ] Test `cli/src/ws/reconnect.test.ts`:

  - attempt 0 → 500; 1 → 1000; 2 → 2000; 3 → 4000; 4 → 8000; 5 → 8000.
  - jitter con `rand = 0` igual al base; `rand = 1` → base + 249 (floor).

- [ ] Extender `cli/src/workspace.ts` `WorkspaceState`:

```ts
export type WorkspaceState = {
  path: string;
  pid: number;
  openedAt: string;
  workspaceId?: string;
  daemonId?: string;
};
```

Añadir helper:

```ts
import { randomUUID } from "node:crypto";

export function ensureDaemonId(path = cwdPath()): string {
  const st = readWorkspaceState(path);
  if (st?.daemonId) return st.daemonId;
  const daemonId = randomUUID();
  if (st) writeWorkspaceState({ ...st, daemonId });
  return daemonId;
}
```

`writeWorkspaceState` en `daemon.ts` (Task 3 sigue) persistirá `daemonId` junto a pid. `ensureDaemonId` genera uno estable **por proceso**: el daemon lo crea al arrancar y lo escribe; reconnects leen el mismo. Si no hay state file todavía, `daemon.ts` genera UUID en memoria y luego lo escribe.

- [ ] Extender `cli/src/ws/client.ts`:

  1. `WsRequest` gana `hostname?: string`, `daemonId?: string`.
  2. Campos privados: `closedByUser = false`, `reconnectTimer`, `reconnectAttempt = 0`, `bindOpts: { path: string; clientKind: "client" | "daemon"; hostname?: string; daemonId?: string } | null = null`, `statusHandlers`, `dropHandlers`.
  3. `enableAutoReconnect(opts)` guarda `bindOpts` y resetea `closedByUser = false`.
  4. `bind()` envía hostname (siempre, `node:os`) y `daemonId` si `clientKind === "daemon"` (argumento opcional o `bindOpts.daemonId`):

```ts
import { hostname } from "node:os";

async bind(
  path = cwdPath(),
  clientKind: "client" | "daemon" = "client",
  extra?: { daemonId?: string },
): Promise<WsResponse> {
  const daemonId = extra?.daemonId ?? this.bindOpts?.daemonId;
  return this.request({
    type: "workspace.bind",
    path,
    clientKind,
    hostname: hostname(),
    daemonId: clientKind === "daemon" ? daemonId : undefined,
  });
}
```

  5. `close()`: `this.closedByUser = true`; clear reconnect timer; close socket.
  6. `dropForTest()`: cierra el socket **sin** `closedByUser = true` (simula corte de red). El listener `close` dispara reconnect.
  7. En el listener `close` existente, **después** de rechazar pending:

```ts
this.ws = null;
if (!this.closedByUser && this.bindOpts) {
  this.scheduleReconnect();
}
```

  8. `scheduleReconnect` (privado):

```ts
private scheduleReconnect() {
  if (this.closedByUser || this.reconnectTimer) return;
  const delay = reconnectDelayWithJitter(this.reconnectAttempt);
  this.reconnectAttempt += 1;
  this.reconnectTimer = setTimeout(() => {
    this.reconnectTimer = null;
    void this.reconnectNow();
  }, delay);
}
```

  9. `reconnectNow`: `connect()`; `bind(bindOpts.path, bindOpts.clientKind, { daemonId: bindOpts.daemonId })`; si ok, `reconnectAttempt = 0` y emitir status `"bound"`; si falla, `scheduleReconnect` otra vez. No `process.exit`.
  10. `request()`: si el socket no está OPEN y hay `bindOpts`, esperar reconnect hasta `timeoutMs` (el mismo del request) en vez de un `connect()` suelto que dejaría la conn unbound. Implementación mínima: loop `await connect(); if (bindOpts) await bind(...)` una vez; si `connect` tira, `scheduleReconnect` y `reject` el request actual (el caller reintenta o el heartbeat lo hará). No hace falta una cola mágica: el daemon no RPC-ea durante el hueco salvo heartbeat.

- [ ] Reescribir el keepalive de `cli/src/ws/daemon.ts`. **Borrar** el `setInterval` de ping 20s que llama `shutdown()`. Sustituir por:

```ts
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { HEARTBEAT_INTERVAL_MS, DAEMON_STANDBY_NOTE } from "./presence-constants";
import { ensureDaemonId, writeWorkspaceState } from "../workspace";

const daemonId = randomUUID();
client.enableAutoReconnect({
  path,
  clientKind: "daemon",
  hostname: hostname(),
  daemonId,
});
const bound = await client.bind(path, "daemon", { daemonId });
// ... existing fail/exit on first bind fail (arranque: si no hay API, sí exit)

writeWorkspaceState({
  path,
  pid: process.pid,
  openedAt: new Date().toISOString(),
  workspaceId: workspace?.id,
  daemonId,
});

const role = (bound.data as { role?: string })?.role;
if (role === "standby") {
  console.error(DAEMON_STANDBY_NOTE);
}

setInterval(() => {
  void client
    .request({ type: "daemon.heartbeat", daemonId })
    .catch((err) => {
      log(`heartbeat fail: ${err instanceof Error ? err.message : String(err)}`);
    });
}, HEARTBEAT_INTERVAL_MS);

// SIGINT/SIGTERM siguen llamando client.close() (closedByUser) + exit
```

El `onPush` de dispatch: si el payload trae `daemonConnectionId` y no coincide con el nuestro, **no** ejecutar (cinturón; la API ya no despacha a standby). Leer `role` en cada bind ok (reconnect) y actualizar un `let daemonRole`.

- [ ] Correr:

```bash
cd cli && bun test src/ws/reconnect.test.ts
```

- [ ] Commit:

```bash
git add cli/src/ws/presence-constants.ts cli/src/ws/reconnect.ts \
  cli/src/ws/reconnect.test.ts cli/src/ws/client.ts cli/src/ws/daemon.ts \
  cli/src/workspace.ts cli/package.json
git commit -m "feat(daemon): reconnect with backoff and 2s heartbeat instead of exit"
```

---

## Task 4: Turn en curso + sleep — abort explícito, no busy eterno

**Files:**

- Create: `cli/src/llm/turn-abort.ts` (o Modify si invariants Task 5 ya lo creó)
- Test: `cli/src/llm/turn-abort.test.ts`
- Modify: `cli/src/llm/claude-runner.ts`
- Modify: `cli/src/llm/publish-turn.ts`
- Modify: `cli/src/ws/daemon.ts`
- Modify: `tui/src/App.tsx`

Cierra el escenario «Turn en curso y sleep». Decisión de producto (congelada): **no se reanuda**. Al despertar / al drop, el turn es `TURN_INTERRUPTED`. El usuario manda otro prompt.

- [ ] Crear `cli/src/llm/turn-abort.ts` si no existe (si invariants lo tiene, úsalo; añade `interruptTurn` que aborta **y** recuerda el motivo):

```ts
import { TURN_INTERRUPTED } from "../ws/presence-constants";

const byChat = new Map<string, AbortController>();

export function beginTurnAbort(chatId: string): AbortController {
  byChat.get(chatId)?.abort();
  const ac = new AbortController();
  byChat.set(chatId, ac);
  return ac;
}

export function abortTurn(chatId: string): boolean {
  const ac = byChat.get(chatId);
  if (!ac) return false;
  ac.abort();
  return true;
}

export function abortAllTurns(): string[] {
  const ids = [...byChat.keys()];
  for (const id of ids) byChat.get(id)?.abort();
  return ids;
}

export function endTurnAbort(chatId: string): void {
  byChat.delete(chatId);
}

export { TURN_INTERRUPTED };
```

- [ ] Test `cli/src/llm/turn-abort.test.ts`: `beginTurnAbort` + `abortTurn` marca `signal.aborted`; `abortAllTurns` aborta dos chats; `endTurnAbort` + `abortTurn` → `false`.

- [ ] En `cli/src/llm/claude-runner.ts`, `RunClaudeTurnInput` gana `abortController?: AbortController`. Pasarlo a `query({ ..., abortController: input.abortController })`. Dentro del `for await`, si `input.abortController?.signal.aborted`, `throw new Error(TURN_INTERRUPTED)` (importar de `presence-constants` o `turn-abort`). Si el plan 2 ya puso `permissionMode: "default"`, **no** volver a `bypassPermissions`.

- [ ] En `cli/src/llm/publish-turn.ts`:

  1. `const ac = input.abortController ?? beginTurnAbort(input.chatId)`.
  2. Pasar `abortController: ac` a `runClaudeTurn`.
  3. `finally`: `endTurnAbort(chatId)` y `await client.request({ type: "agent.turn.ended", chatId, streamId })` (si el request tira porque el WS está caído, log y seguir).
  4. `catch`: si `ac.signal.aborted`, el mensaje de `chat.stream.error` es `TURN_INTERRUPTED` (no el stack del SDK). Si el usuario canceló vía plan 16, ese plan usa `TURN_CANCELLED`; aquí, disconnect usa `TURN_INTERRUPTED`. Distinguir: `abortTurn` genérico no sabe el motivo — `publishAgentTurn` acepta `interruptReason?: string` default `TURN_INTERRUPTED` cuando `signal.aborted` y el caller no pasó `TURN_CANCELLED`.

```ts
  } catch (err) {
    const message = ac.signal.aborted
      ? (input.interruptReason ?? TURN_INTERRUPTED)
      : err instanceof Error
        ? err.message
        : String(err);
    try {
      await client.request({
        type: "chat.stream.error",
        chatId,
        streamId,
        content: message,
      });
    } catch {
      // WS down — API sweep already broadcast TURN_INTERRUPTED
    }
    throw new Error(message);
  } finally {
    endTurnAbort(chatId);
    try {
      await client.request({ type: "agent.turn.ended", chatId, streamId });
    } catch {
      // ignore
    }
  }
```

- [ ] En `cli/src/ws/daemon.ts`, registrar un handler de close/reconnect:

  - Al detectar drop (`client` emite close y va a reconectar): `const interrupted = abortAllTurns();` y `turnBusy = false`.
  - Tras reconnect bind ok: **no** llamar `publishAgentTurn` otra vez. El turn muerto no se reanuda.
  - El `onPush` de dispatch existente: si `turnBusy`, ignore (igual que ahora). Tras interrupt, `turnBusy` es false y un **nuevo** dispatch (nuevo request del usuario) sí corre.

Si `ChavezWsClient` no emite un evento de drop, añade `onClose(handler: (info: { userInitiated: boolean }) => void)` y el daemon se suscribe:

```ts
client.onClose(({ userInitiated }) => {
  if (userInitiated) return;
  abortAllTurns();
  turnBusy = false;
  log("socket dropped — in-flight turn interrupted, will reconnect");
});
```

- [ ] En `tui/src/App.tsx` (el TUI **es** daemon):

  1. Importar `abortAllTurns` / `beginTurnAbort` igual que el headless.
  2. `turnBusyRef` + `busy` se ponen `false` en `onClose` no user-initiated.
  3. `publishAgentTurn` recibe el `AbortController` de `beginTurnAbort(activeChatId)`.
  4. Banner: si `status === "reconnecting"`, línea amarilla `WS reconnecting…`; el bubble live de streaming se oculta cuando llega `chat.stream.error` (el handler de push ya debería bajar `busy`; si solo mira `chat.stream.end`, añadir `chat.stream.error` y `agent.turn.ended`).
  5. **No** reenviar el prompt al reconectar.

- [ ] Correr:

```bash
cd cli && bun test src/llm/turn-abort.test.ts src/ws/reconnect.test.ts
```

- [ ] Commit:

```bash
git add cli/src/llm/turn-abort.ts cli/src/llm/turn-abort.test.ts \
  cli/src/llm/claude-runner.ts cli/src/llm/publish-turn.ts \
  cli/src/ws/daemon.ts cli/src/ws/client.ts tui/src/App.tsx
git commit -m "fix(daemon): interrupt in-flight turn on disconnect instead of eternal busy"
```

---

## Task 5: TUI — reconnect, standby, presencia en header

**Files:**

- Modify: `tui/src/App.tsx`

Cierra Presencia (TUI) y Dos daemons (TUI no duplica tools).

- [ ] Estado nuevo:

```ts
const [status, setStatus] = useState<
  "connecting" | "bound" | "reconnecting" | "error"
>("connecting");
const [daemonRole, setDaemonRole] = useState<"primary" | "standby" | null>(null);
const [daemonHostname, setDaemonHostname] = useState<string>("");
const [lastSeen, setLastSeen] = useState<string | null>(null);
```

- [ ] Tras crear `ChavezWsClient`, **antes** de `connect`:

```ts
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { DAEMON_STANDBY_NOTE } from "../../cli/src/ws/presence-constants";

const daemonId = randomUUID();
c.enableAutoReconnect({
  path: cwd.replace(/\\/g, "/"),
  clientKind: "daemon",
  hostname: hostname(),
  daemonId,
});
c.onClose(({ userInitiated }) => {
  if (cancelled || userInitiated) return;
  setStatus("reconnecting");
  abortAllTurns();
  turnBusyRef.current = false;
  setBusy(false);
});
```

Tras `bind` ok, leer `role`, `hostname` de `bound.data`. `setDaemonRole(role === "standby" ? "standby" : "primary")`. `setStatus("bound")`. Heartbeat: `setInterval` 2s `c.request({ type: "daemon.heartbeat", daemonId })` mientras `!cancelled`; clear en el cleanup del effect.

El cleanup del effect llama `c.close()` (userInitiated) — correcto al desmontar / quit.

- [ ] Header:

  - `WS: {status}` y si `bound` + `primary` → ` · daemon/runner`.
  - Si `standby` → línea roja con `DAEMON_STANDBY_NOTE` (el string exacto) más `primary` hostname/path si vienen en `bound.data`.
  - `host: {daemonHostname || hostname()} · {cwd}` y si `lastSeen`, `last-seen {lastSeen}`.
  - Si `reconnecting` → `WS reconnecting…` (amarillo). **No** mostrar `daemon/runner` como si estuviera vivo.

- [ ] `sendWithLlm`: si `daemonRole === "standby"`, **no** llamar `publishAgentTurn`. En su lugar:

```ts
const res = await client.request({
  type: "agent.turn.request",
  chatId: activeChatId,
  prompt: text,
});
if (!res.ok) setLog(res.error || "turn failed");
```

El primary (headless u otra TUI) ejecuta; esta TUI observa `chat.stream.*`. Si `role === "primary"`, el camino local actual se mantiene.

- [ ] Handler `agent.turn.dispatch`: si `turnBusyRef` **o** `daemonRole === "standby"`, no ejecutar.

- [ ] `onPush` de `daemon.presence`: si `data.bound === false` y éramos primary, `setStatus("reconnecting")` (el auto-reconnect ya corre). Si `data.bound === true` y `data.daemonId` es el nuestro, `setStatus("bound")` + `setLastSeen(data.lastSeen)`.

- [ ] Commit:

```bash
git add tui/src/App.tsx
git commit -m "feat(tui): reconnect daemon bind and standby without duplicate tools"
```

---

## Task 6: Web presencia + CLI connections + el mismo error de runner

**Files:**

- Create: `web/src/lib/last-seen.ts`
- Test: `web/src/lib/last-seen.test.ts`
- Create: `web/src/components/DaemonPresence.tsx`
- Modify: `web/src/lib/hooks.ts`
- Modify: `web/src/lib/ws-client.ts`
- Modify: `web/src/lib/ws-context.tsx`
- Modify: `web/src/lib/ws-hooks.ts`
- Modify: `web/src/components/WorkspacesPanel.tsx`
- Modify: `web/src/components/WorkspaceDetailPanel.tsx`
- Modify: `web/src/components/ChatDetailPanel.tsx`
- Modify: `web/package.json`
- Modify: `cli/src/commands/headless.ts`

Cierra Presencia (Web + CLI), Reconnect (Web deja de mostrar sin runner) y Heartbeat (picker y turn, mismo error).

- [ ] Añadir `"test": "bun test"` en `web/package.json` si no existe (dejar `dev`/`build`/`preview`/`start`).

- [ ] Crear `web/src/lib/last-seen.ts`:

```ts
export function formatLastSeen(
  iso: string | null | undefined,
  now = Date.now(),
): string {
  if (!iso) return "nunca";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "nunca";
  const ms = now - t;
  if (ms < 2000) return "ahora";
  if (ms < 60_000) return `hace ${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `hace ${Math.floor(ms / 60_000)}m`;
  return `hace ${Math.floor(ms / 3_600_000)}h`;
}
```

- [ ] Test `web/src/lib/last-seen.test.ts`: `null` → `"nunca"`; `now` → `"ahora"`; `now - 3000` → `"hace 3s"`; `now - 120_000` → `"hace 2m"`.

- [ ] Extender tipos en `web/src/lib/hooks.ts`:

```ts
export type Workspace = {
  id: string;
  path?: string;
  name?: string;
  openConnections?: number;
  daemonBound?: boolean;
  daemonHostname?: string | null;
  daemonPath?: string;
  daemonLastSeen?: string | null;
  daemonRole?: string | null;
  userId?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type Connection = {
  connectionId?: string;
  id?: string;
  workspaceId?: string | null;
  path?: string | null;
  clientKind?: "client" | "daemon";
  hostname?: string | null;
  daemonId?: string | null;
  role?: "primary" | "standby" | "client" | string;
  connectedAt?: string;
  firstBoundAt?: string;
  lastSeen?: string;
  turnBusy?: boolean;
};
```

`useConnections`: añadir `refetchInterval: 3000` (cinturón si se pierde un push). `useWorkspaces` igual `refetchInterval: 3000`.

- [ ] Crear `web/src/components/DaemonPresence.tsx`:

```tsx
import { formatLastSeen } from "../lib/last-seen";

export const NO_DAEMON_ERROR =
  "No daemon bound for this workspace. Run: chavez headless workspace open";
export const NO_RUNNER_LABEL = "sin runner";

export function DaemonPresence(props: {
  bound?: boolean;
  hostname?: string | null;
  path?: string | null;
  lastSeen?: string | null;
  error?: string | null;
}) {
  if (!props.bound) {
    return (
      <p className="error" data-testid="runner-status">
        {NO_RUNNER_LABEL} — {props.error || NO_DAEMON_ERROR}
      </p>
    );
  }
  return (
    <p data-testid="runner-status">
      <span className="badge ok">daemon</span>{" "}
      <code>
        {props.hostname || "daemon"} · {props.path || "—"}
      </code>
      {" · last-seen "}
      {formatLastSeen(props.lastSeen)}
    </p>
  );
}
```

El copy **sin runner** es el del Gherkin. El error largo es el mismo que `agent.turn.request`.

- [ ] `web/src/lib/ws-client.ts`: añadir auto-reconnect de **cliente** (no daemon). `enableAutoReconnect` con `clientKind: "client"` y `path` opcional (último bind). `close()` marca userInitiated. En `on close`, si no user y hay listener de status, `setStatus("closed")` y `scheduleReconnect` → `connect()` (y `bind` si había path). `WsRequest` gana `hostname?`, `daemonId?`, `query?` si attach-files aún no los puso.

- [ ] `web/src/lib/ws-context.tsx`:

  1. Tras `new ChavezWsClient()`, `c.enableAutoReconnect({ clientKind: "client" })`.
  2. En el `onPush` global, si `msg.type === "daemon.presence"`: `invalidateQueries` de `queryKeys.workspaces`, `queryKeys.connections` y `queryKeys.workspaceSessions`.
  3. Si `msg.type === "chat.stream.error"` o `agent.turn.ended`, invalidate `queryKeys.chat` (el panel también lo hace; el invalidate reconstruye).
  4. Tras un `bind` ok, guardar el path en el client para re-bind post-reconnect (`enableAutoReconnect({ clientKind: "client", path })`).

- [ ] `web/src/components/WorkspacesPanel.tsx`:

  - Cada workspace: `<DaemonPresence bound={w.daemonBound} hostname={w.daemonHostname} path={w.daemonPath || w.path} lastSeen={w.daemonLastSeen} />` **además** del badge `openConnections`.
  - Lista «Connections abiertas»: cada fila `{c.hostname || "—"} · {c.path || "unbound"} · {c.clientKind} · {c.role} · last-seen {formatLastSeen(c.lastSeen)}`. Los daemons se distinguen por `clientKind === "daemon"`.

- [ ] `web/src/components/WorkspaceDetailPanel.tsx`: bajo el path del workspace, el mismo `<DaemonPresence>` con `detail.data.workspace`.

- [ ] `web/src/components/ChatDetailPanel.tsx`:

  1. `useWorkspaceSessions` **o** leer presencia de `useConnections` filtrando daemons cuyo `workspaceId` coincide. Más simple: `useWorkspaces` + el `workspaceId` del session (ya se navega session→chat). Si no hay workspace en el chat GET, usar `useConnections` y tomar el daemon `role === "primary"` cuyo path coincida; si ninguno, `bound: false`.
  2. Encima del composer: `<DaemonPresence … />`.
  3. Submit de `agent.turn.request` **no** se oculta, pero si `mutate` falla, `formatQueryError` ya pinta el string. Assert en UI: si el error es `NO_DAEMON_ERROR`, se muestra **tal cual** (no un wrap distinto).
  4. Si attach-files ya tiene picker `@`: el empty/error del picker usa **el mismo** `NO_DAEMON_ERROR` cuando `fs.complete` falla (hoy el plan attach usa un copy largo de “No hay filesystem…”. **Esta fase unifica**: si `res.error === NO_DAEMON_ERROR` o el mutate tira ese string, el picker muestra `NO_DAEMON_ERROR` (y puede dejar el hint de abrir TUI debajo, pero el error primario es el mismo que `agent.turn`).
  5. `onPush`: `daemon.presence` con `bound: false` → el badge pasa a **sin runner** sin esperar el refetch (setState local `runnerBound` inicializado desde workspaces, pisado por el push).
  6. `chat.stream.error` con `TURN_INTERRUPTED` → `setStreaming(false)`, mensaje de error visible, **no** dejar el bubble live.

Si `useWsFsComplete` no existe todavía (attach-files no merged), no lo inventes: documenta en el picker del Task attach que el error debe ser `NO_DAEMON_ERROR`. En **este** plan, `agent.turn.request` y el badge son suficientes para el Gherkin Heartbeat. Cuando `fs.complete` exista, Task 7 smoke lo cubre.

- [ ] En `cli/src/commands/headless.ts` grupo `connections`: no solo JSON crudo. Imprimir también una tabla texto que **lista el daemon**:

```ts
if (group === "connections") {
  const data = await apiFetch<{ connections: Array<{
    connectionId: string;
    clientKind?: string;
    role?: string;
    hostname?: string | null;
    path?: string | null;
    lastSeen?: string;
    turnBusy?: boolean;
  }> }>("/connections");
  const rows = data.connections ?? [];
  const daemons = rows.filter((c) => c.clientKind === "daemon");
  if (daemons.length === 0) {
    console.log("daemons: (none)");
  } else {
    console.log("daemons:");
    for (const d of daemons) {
      console.log(
        `  ${d.hostname || "—"}  ${d.path || "—"}  ${d.role || "?"}  last-seen ${d.lastSeen || "—"}  busy=${Boolean(d.turnBusy)}  ${d.connectionId}`,
      );
    }
  }
  console.log(JSON.stringify(data, null, 2));
  return;
}
```

Gherkin: «CLI connections lista el daemon» — la línea `daemons:` con hostname/path/last-seen cumple. El JSON se conserva para scripts.

- [ ] Correr:

```bash
cd web && bun test src/lib/last-seen.test.ts
```

- [ ] Commit:

```bash
git add web/src/lib/last-seen.ts web/src/lib/last-seen.test.ts \
  web/src/components/DaemonPresence.tsx web/src/lib/hooks.ts \
  web/src/lib/ws-client.ts web/src/lib/ws-context.tsx web/src/lib/ws-hooks.ts \
  web/src/components/WorkspacesPanel.tsx \
  web/src/components/WorkspaceDetailPanel.tsx \
  web/src/components/ChatDetailPanel.tsx web/package.json \
  cli/src/commands/headless.ts
git commit -m "feat(daemon): show hostname path last-seen and sin runner on presence loss"
```

---

## Task 7: Smokes Gherkin — reconnect, sleep/stale, presencia, two-daemons, heartbeat

**Files:**

- Test: `cli/scripts/daemon-reconnect-smoke.ts`
- Test: `cli/scripts/daemon-stale-turn-smoke.ts`
- Test: `cli/scripts/daemon-presence-smoke.ts`
- Test: `cli/scripts/daemon-first-wins-smoke.ts` (crear; si invariants ya lo tiene, **extenderlo** con reclaim + heartbeat, no duplicar)
- Modify: `cli/package.json`
- Modify: `api/package.json`

Cada script sale `0` con `SMOKE PASS` o `1` con mensaje. Necesitan API arriba y `CHAVEZ_ACCESS_TOKEN` (mismo patrón que `cli/scripts/tui-sync-smoke.ts`).

- [ ] Añadir scripts (dejar los existentes):

`cli/package.json`:

```json
"test:daemon-reconnect": "bun run scripts/daemon-reconnect-smoke.ts",
"test:daemon-stale": "bun run scripts/daemon-stale-turn-smoke.ts",
"test:daemon-presence": "bun run scripts/daemon-presence-smoke.ts",
"test:daemon-first-wins": "bun run scripts/daemon-first-wins-smoke.ts"
```

- [ ] `cli/scripts/daemon-reconnect-smoke.ts` — escenario Reconnect:

  1. `viewer` (client) y `daemon` (daemon) con el mismo token. `daemon.enableAutoReconnect({ path, clientKind: "daemon", daemonId })`. Bind daemon. Viewer bind client.
  2. Viewer espera `daemon.presence` `bound: true` (timeout 5s).
  3. `GET /workspaces` → el workspace del path tiene `daemonBound === true` y `daemonHostname` string no vacío.
  4. `daemon.dropForTest()` (corte corto). Viewer recibe `daemon.presence` con `bound: false` **o** el refetch de `/workspaces` en ≤ 6s (`HEARTBEAT_STALE_MS` + sweep) da `daemonBound === false`.
  5. Esperar reconnect (máx 10s). Viewer recibe `daemon.presence` `bound: true` otra vez (mismo `daemonId` si el payload lo trae).
  6. `agent.turn.request` desde viewer → `ok: true` (el runner volvió). No hace falta ejecutar el LLM: basta que `accepted === true` y el daemon reciba `agent.turn.dispatch` (resolver un Promise en `onPush`).
  7. Print `SMOKE PASS`.

- [ ] `cli/scripts/daemon-stale-turn-smoke.ts` — escenario Turn en curso y sleep (simulado: deja de latir, no duerme la laptop):

  1. Bind daemon **sin** heartbeat interval (no `enableAutoReconnect` aún; o enable pero **no** mandar `daemon.heartbeat`). Marcar `turnBusy` vía un `agent.turn.request` cuyo dispatch el daemon **acepta y no termina** (`await new Promise(() => {})` en el handler, con `AbortController` local).
  2. No enviar heartbeats. Esperar `HEARTBEAT_STALE_MS + HEARTBEAT_SWEEP_MS + 1500` (≈ 7.5s).
  3. Viewer debe recibir `chat.stream.error` con `error === "Turn interrupted: daemon disconnected"` **y** `agent.turn.ended`.
  4. Un segundo `agent.turn.request` **antes** de que el daemon reconecte → `ok: false` y `error === NO_DAEMON_ERROR`.
  5. Arrancar heartbeat + reconnect (o un **nuevo** bind del mismo proceso con el mismo `daemonId`). Presence `bound: true`.
  6. El handler colgado **no** publica un segundo assistant (abort). Un `agent.turn.request` nuevo sí despacha **una** vez.
  7. `GET /connections`: `turnBusy === false` en el daemon.
  8. `SMOKE PASS`.

  Para no colgar el proceso: el dispatch handler usa `AbortController`; el sweep del server cierra el WS → `onClose` del client aborta.

- [ ] `cli/scripts/daemon-presence-smoke.ts` — escenario Presencia:

  1. Bind daemon con hostname real (`os.hostname()`).
  2. `GET /connections` → hay un item `clientKind === "daemon"` con `hostname`, `path` igual al cwd posix, `lastSeen` ISO parseable, `role === "primary"`.
  3. `GET /workspaces` → `daemonHostname`, `daemonPath`, `daemonLastSeen`, `daemonBound: true`.
  4. Simular lo que imprime CLI: el filtro `daemons:` tendría length 1.
  5. Unbind/close daemon. Tras ≤ 6s, `daemonBound === false`.
  6. `SMOKE PASS`.

- [ ] `cli/scripts/daemon-first-wins-smoke.ts` — escenario Dos daemons + Heartbeat:

  1. `d1.bind(path, "daemon", { daemonId: "id-1" })` → `role === "primary"`.
  2. `d2.bind(path, "daemon", { daemonId: "id-2" })` → `role === "standby"` y `standbyReason` contiene `"primary"` o es exactamente `DAEMON_STANDBY_NOTE`.
  3. Contar `agent.turn.dispatch` en d1 y d2. `agent.turn.request` desde un tercer client → **un solo** dispatch, en d1. d2 recibe 0.
  4. `d1.dropForTest()` y **no** reconectar d1 (`close()` userInitiated tras el drop, o no `enableAutoReconnect` en d1). Esperar stale/close. Presence: d2 es primary (`GET /connections` role). Nuevo turn despacha a d2.
  5. Cerrar d2. `agent.turn.request` → `ok: false`, `error === NO_DAEMON_ERROR`.
  6. `fs.complete` si el handler existe: mismo `error === NO_DAEMON_ERROR`. Si el case no está (attach-files no merged), wrap en try y `console.warn("fs.complete not implemented — skipped")` **solo** ese assert; el de `agent.turn` es obligatorio.
  7. `SMOKE PASS`.

- [ ] Correr unitarios + smokes (API en `CHAVEZ_API_URL`, token en config):

```bash
cd api && bun test src/ws/hub.test.ts src/ws/heartbeat.test.ts src/ws/bind-reclaim.test.ts
cd cli && bun test src/ws/reconnect.test.ts src/llm/turn-abort.test.ts
cd web && bun test src/lib/last-seen.test.ts
bun run cli/scripts/daemon-reconnect-smoke.ts
bun run cli/scripts/daemon-stale-turn-smoke.ts
bun run cli/scripts/daemon-presence-smoke.ts
bun run cli/scripts/daemon-first-wins-smoke.ts
```

Esperado: los 5 escenarios Gherkin pasan.

Mapeo:

| Escenario | Dónde se demuestra |
|---|---|
| Reconnect | `daemon-reconnect-smoke.ts` + Web `DaemonPresence` deja de decir sin runner al llegar `daemon.presence` bound |
| Turn en curso y sleep | `daemon-stale-turn-smoke.ts` (`TURN_INTERRUPTED`, `turnBusy` false, no auto-resume) |
| Presencia | `daemon-presence-smoke.ts` + `chavez headless connections` + `WorkspacesPanel` |
| Dos daemons | `daemon-first-wins-smoke.ts` (standby, un dispatch) + TUI Task 5 no llama `publishAgentTurn` |
| Heartbeat | stale ≤ 6s → sin runner; `agent.turn` y `fs.complete` = `NO_DAEMON_ERROR` |

- [ ] Commit:

```bash
git add cli/scripts/daemon-reconnect-smoke.ts \
  cli/scripts/daemon-stale-turn-smoke.ts \
  cli/scripts/daemon-presence-smoke.ts \
  cli/scripts/daemon-first-wins-smoke.ts \
  cli/package.json api/package.json
git commit -m "test(daemon): smokes for reconnect, stale turn, presence, first-wins"
```

---

## Verificación manual (no sustituye los smokes)

Tras las 7 tasks, en una máquina real:

1. `chavez headless workspace open` en el cwd. Web → workspace: badge daemon, `hostname · path · last-seen ahora`.
2. `chavez headless connections`: sección `daemons:` con esa fila.
3. Cortar red ~3–8s (o `kill -STOP` del pid del daemon y `CONT`). Web muestra **sin runner** en segundos; al volver, el badge daemon reaparece **sin** relanzar el proceso.
4. Con un turn largo, suspender la laptop. Al despertar: timeline con `Turn interrupted: daemon disconnected`, composer acepta un turn nuevo, no se queda en streaming.
5. Segunda TUI en el mismo path: banner `DAEMON_STANDBY_NOTE`; un prompt en la standby **no** lanza un segundo SDK (se reenvía como `agent.turn.request`).
6. `chavez headless workspace close`. Picker `@` (si existe) y `agent.turn.request` fallan con el **mismo** `No daemon bound for this workspace. Run: chavez headless workspace open`.
