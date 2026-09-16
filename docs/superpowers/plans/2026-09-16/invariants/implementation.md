# Invariants Implementation Plan

> **For agentic workers:** Execute task-by-task. Do not skip tests. Do not implement Cursor cloud, voz, extensión IDE, upload desde el navegador, org/roles, cola de turns (plan 29), reconnect/heartbeat (plan 17), thinking/steer (plan 16), gitignore (plan 8) ni Cursor ejecutable (plan 4). Spec: [`plan.md`](./plan.md). Si un sibling (`attach-files`, `agent-tools`, `cursor-provider`) ya creó un archivo citado, **extiéndelo**; no lo reescribas.

**Goal:** El armazón que hace que `@`, tools y Cursor sirvan no se rompe al sumar esos planes. Web y CLI operan la **misma cuenta**. Un workspace tiene **un solo runner** (TUI o headless), identificado por **hostname + path**. Sin daemon, hidratar `@` y ejecutar tools falla con el mismo error visible. Web, TUI y `chat watch` ven el **mismo chat en vivo** y un reload reconstruye la timeline sin duplicar. Cada turn reinyecta **historial de DB + prompt + attaches hidratados**; las tools históricas van como **contexto**, no como invocaciones nuevas. Busy, cancel y conexiones abiertas son visibles. El agente **no es root**: paths no salen del cwd, el vault no viaja al LLM ni a la timeline, el output se redacta si parece una key, y Web solo recibe resultados acotados.

**Architecture:** Auth ya es Better Auth (cookie web + Bearer CLI + device-code) sobre el mismo `user`. El filesystem y el SDK viven en el proceso daemon (`cli/src/ws/daemon.ts` o TUI con `clientKind: "daemon"`). La API es hub: sesión, vault, persistencia, `findDaemon` (el **primero** gana), fan-out WS. Esta fase cierra huecos de ese hub; no mueve I/O de disco al browser ni al server.

```
Web cookie ─┐
CLI Bearer ─┼─► Better Auth session ─► mismo userId
            │         │
            │         ▼
            │   GET /providers  PUT credentials  GET /connections
            │         │
            ▼         ▼
TUI / headless workspace open
        workspace.bind { clientKind: "daemon", hostname, path }
        │
        ▼
API hub.findDaemon  (connectedAt ASC, tie-break connectionId)
        │  1º = primary  →  recibe agent.turn.dispatch
        │  2º = standby  →  no ejecuta; banner visible
        │  0  = fail NO_DAEMON_ERROR
        ▼
publishAgentTurn
        │  historyFromChatMessages (user/assistant/system + tool-as-context)
        │  attachments del mensaje actual (snapshot, no re-leer disco)
        │  query({ abortController, cwd })  |  Cursor cuando plan 4 exista
        │  redact(output) antes de persistir
        ▼
chat.stream.* / message.appended / agent.turn.started|ended
        │
        ▼
Web + TUI + CLI watch  (mergeTimeline por id, deltas por seq)
```

Estado actual que este plan extiende (no reescribir):

- `api/src/auth.ts`: magic link + password + deviceAuthorization + bearer. `api/src/index.ts` `/me` y `/ws` ya exigen sesión (WS 401 sin token).
- CLI `chavez login` (device-code) guarda Bearer en `~/.chavez/config.json`. `chavez whoami` pega `/me`.
- Hub providers: `api/src/index.ts` redirige `/providers/link?provider=&token=` a `web/src/pages/providers.astro`. `ProvidersPanel.tsx` ya lee `?token=` y manda `Authorization: Bearer`.
- `hub.findDaemon` recorre el `Map` y devuelve el **primero insertado**. No hay `hostname`. Segundo daemon también es `clientKind: "daemon"` y **no** recibe dispatch (sendTo al primero), pero nadie se lo dice. Si TUI es el segundo y el usuario escribe, `sendWithLlm` ejecuta **en local** → turns duplicados. Eso se cierra aquí.
- Cerrar daemon: `hub.remove` en `onClose`; el siguiente `agent.turn.request` falla con `"No daemon bound for this workspace. Run: chavez headless workspace open"`. Web no se entera hasta el siguiente request (no hay `daemon.presence`).
- Sync: `session.created` / `chat.created` / `message.appended` / `chat.stream.*` ya se broadcast. TUI recarga `chat.get` entero. Web concatena deltas **sin seq**. Reload usa GET `/chats/:id`. Riesgo de duplicar el bubble live + el assistant persistido.
- `cli/src/llm/history.ts` **tira** filas `role=tool` y **ignora** `metadata` (attachments). Correcto para no re-ejecutar; incorrecto para el Gherkin de “tools históricas como contexto” y attaches hidratados.
- Busy: TUI `busy` + banner `… generando respuesta`. Web solo `streaming`. No hay `agent.turn.cancel`. Escape en TUI **mata la TUI**. Claude SDK sí acepta `options.abortController`.
- `GET /connections` lista `connectionId, workspaceId, path, clientKind, connectedAt` — OpenAPI omite `clientKind`; nadie envía `hostname`.
- Vault: `GET /providers/:provider/credentials` devuelve `secret` (el daemon lo necesita). `ProvidersPanel` puede Reveal. `publish-turn` no escribe el secret en el chat, pero no hay redacción de output ni sandbox de path en este árbol (los planes 1–2 los añaden; esta fase los exige o los crea).
- Web **no** tiene endpoint de árbol completo. Mantenerlo así.

**Tech Stack:** Bun, Better Auth (cookie + bearer + device-code), Hono + Drizzle, WebSocket hub in-memory, Claude Agent SDK `query({ abortController })`, Ink TUI, Astro/React web.

**Global Constraints:**

1. El filesystem real vive en el daemon (cwd del workspace). API y browser no listan ni hidratan el disco. Web solo recibe picker/turn acotados (máx. 10 candidatos si existe `fs.complete`; nunca un dump del árbol).
2. Un turn solo corre si hay daemon **primary** bound. Sin daemon, el error es exactamente `NO_DAEMON_ERROR`. El mismo string para `agent.turn.request`, `agent.turn.cancel` y `fs.complete` (si existe).
3. Un usuario = su vault. Sin org ni roles. Un workspace ajeno es **404** (no 401, no 403). Sin sesión es **401**. El 404 no incluye emails ni ids de otros usuarios.
4. Misma cuenta: magic link o password en Web + device-code en CLI → el mismo `user.id` en `/me`.
5. Bearer del CLI abre el hub de providers y vincula Claude/Cursor **sin** cookie de navegador.
6. 1 turn por daemon. El segundo request falla con `TURN_BUSY_ERROR` (visible). El segundo **daemon** es standby: no ejecuta, el usuario lo ve.
7. Web, TUI y `chat watch` ven el mismo chat (mensajes, stream, tools). Reload reconstruye por `id` sin duplicar.
8. Historial: DB + prompt actual + snapshot de attaches del mensaje actual. Tools históricas = texto de contexto. El SDK **no** recibe `tool_use` viejos; no re-ejecuta.
9. Cancelar Claude usa `AbortController` del SDK. Cancelar Cursor (si el runner del plan 4 existe) aborta el mismo signal / `run.cancel()`. Cancelar **no** es undo. Sin turn, cancel es idempotente (`ok: true, wasRunning: false`).
10. Secrets del vault nunca se appendean al chat, nunca van en `metadata` de mensajes, nunca se loguean. Output de tools se redacta **antes** de persistir y de broadcast.
11. Path traversal (`../`, absoluto fuera del cwd, symlink escape vía `realpathSync`) se rechaza. Attaches y tools no salen del workspace.
12. Claude es el provider ejecutable hoy. Cursor vinculado no ejecuta turns en esta fase; cancel/busy/sync/auth aplican igual. No simular tools de Cursor.
13. Fuera de alcance: Cursor cloud, voz, extensión IDE, upload desde el navegador, notificaciones OS/email, worktrees paralelos, org.

**Constantes (congeladas, no inventar otras):**

| Nombre | Valor |
|---|---|
| `NO_DAEMON_ERROR` | `"No daemon bound for this workspace. Run: chavez headless workspace open"` |
| `TURN_BUSY_ERROR` | `"Turn already running on this daemon"` |
| `TURN_CANCELLED` | `"Turn cancelled"` |
| `DAEMON_STANDBY_NOTE` | `"Another daemon is already primary for this workspace; this connection is standby"` |
| `NO_TURN_RUNNING` | `"No turn running"` |
| `UNAUTHORIZED` | `"Unauthorized"` |
| `NOT_FOUND_WORKSPACE` | `"Workspace not found"` |
| `NOT_FOUND_SESSION` | `"Session not found"` |
| `NOT_FOUND_CHAT` | `"Chat not found"` |
| `TOOL_CONTEXT_PREAMBLE` | `"Historical tool result (do not re-run; context only)"` |
| `ATTACH_CONTEXT_PREAMBLE` | `"Attached workspace snapshot (do not re-read disk unless the user mentions it again)"` |
| `REDACT_REPLACEMENT` | `"***"` |
| `STREAM_SEQ_START` | `1` |

Si `api/src/ws/tool-protocol.ts` (plan 2) ya exporta `NO_DAEMON_ERROR` / `TURN_BUSY_ERROR`, re-exportarlos desde `api/src/ws/errors.ts` y borrar el duplicado. Un solo string literal en runtime.

---

## Task 1: Auth compartida — 401 / 404 / misma cuenta / Bearer en hub

**Files:**

- Create: `api/src/ws/errors.ts`
- Create: `api/src/routes/ownership.ts`
- Test: `api/src/routes/ownership.test.ts`
- Modify: `api/src/routes/workspaces.ts`
- Modify: `api/src/routes/providers.ts`
- Modify: `api/src/index.ts`
- Modify: `web/src/lib/ws-client.ts`
- Modify: `web/src/lib/hooks.ts`
- Modify: `web/src/components/ProvidersPanel.tsx`
- Test: `api/scripts/e2e-invariants-auth.ts`
- Modify: `api/package.json`

Cierra los tres escenarios Gherkin de auth. Las rutas ya comprueban `session.user.id`; esta task unifica 401 vs 404, cubre WS, y hace que `?token=` del CLI alcance HTTP **y** WS en el hub.

- [ ] Añadir `"test": "bun test"` en `api/package.json` `scripts` si no existe (dejar `dev`/`start`/`db:*`/`test:e2e` intactos). Añadir `"test:invariants-auth": "bun run scripts/e2e-invariants-auth.ts"`.

- [ ] Crear `api/src/ws/errors.ts`:

```ts
export const NO_DAEMON_ERROR =
  "No daemon bound for this workspace. Run: chavez headless workspace open";
export const TURN_BUSY_ERROR = "Turn already running on this daemon";
export const TURN_CANCELLED = "Turn cancelled";
export const DAEMON_STANDBY_NOTE =
  "Another daemon is already primary for this workspace; this connection is standby";
export const NO_TURN_RUNNING = "No turn running";
export const UNAUTHORIZED = "Unauthorized";
export const NOT_FOUND_WORKSPACE = "Workspace not found";
export const NOT_FOUND_SESSION = "Session not found";
export const NOT_FOUND_CHAT = "Chat not found";
```

Si `api/src/ws/tool-protocol.ts` ya define `NO_DAEMON_ERROR` / `TURN_BUSY_ERROR`, sustituir esas constantes por `export { NO_DAEMON_ERROR, TURN_BUSY_ERROR } from "./errors";` (o al revés: errors re-exporta y tool-protocol deja de duplicar). El texto debe ser **idéntico** al que ya usa `agent.turn.request`.

- [ ] Crear `api/src/routes/ownership.ts`:

```ts
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import {
  agentSessions,
  chats,
  workspaces,
} from "../db/schema";
import {
  NOT_FOUND_CHAT,
  NOT_FOUND_SESSION,
  NOT_FOUND_WORKSPACE,
} from "../ws/errors";

export { NOT_FOUND_CHAT, NOT_FOUND_SESSION, NOT_FOUND_WORKSPACE };

export async function loadOwnedWorkspace(workspaceId: string, userId: string) {
  const rows = await db
    .select()
    .from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), eq(workspaces.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function loadOwnedSession(sessionId: string, userId: string) {
  const rows = await db
    .select()
    .from(agentSessions)
    .where(
      and(eq(agentSessions.id, sessionId), eq(agentSessions.userId, userId)),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function loadOwnedChat(chatId: string, userId: string) {
  const rows = await db
    .select()
    .from(chats)
    .where(and(eq(chats.id, chatId), eq(chats.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

export function missingJson(entity: "workspace" | "session" | "chat") {
  const error =
    entity === "workspace"
      ? NOT_FOUND_WORKSPACE
      : entity === "session"
        ? NOT_FOUND_SESSION
        : NOT_FOUND_CHAT;
  return { error };
}
```

- [ ] Crear `api/src/routes/ownership.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { missingJson } from "./ownership";
import {
  NOT_FOUND_CHAT,
  NOT_FOUND_SESSION,
  NOT_FOUND_WORKSPACE,
  UNAUTHORIZED,
} from "../ws/errors";

describe("ownership errors", () => {
  test("404 bodies never include foreign identifiers", () => {
    for (const entity of ["workspace", "session", "chat"] as const) {
      const body = missingJson(entity);
      expect(Object.keys(body)).toEqual(["error"]);
      expect(JSON.stringify(body)).not.toMatch(/@/);
      expect(JSON.stringify(body)).not.toMatch(/userId/);
    }
    expect(missingJson("workspace").error).toBe(NOT_FOUND_WORKSPACE);
    expect(missingJson("session").error).toBe(NOT_FOUND_SESSION);
    expect(missingJson("chat").error).toBe(NOT_FOUND_CHAT);
  });

  test("unauthenticated string is Unauthorized", () => {
    expect(UNAUTHORIZED).toBe("Unauthorized");
  });
});
```

- [ ] En `api/src/routes/workspaces.ts`, sustituir los `c.json({ error: "Workspace not found" }, 404)` (y equivalentes de session/chat) por `c.json(missingJson("workspace"), 404)` etc. Importar `loadOwnedWorkspace` / `loadOwnedSession` / `loadOwnedChat` / `missingJson`. **No** cambiar el 401 de `if (!session)`. El mensaje de un recurso ajeno es el mismo 404 que el de un id inventado.

- [ ] En `api/src/routes/providers.ts` y `api/src/index.ts` (`/me`, `/me/password`, `/ws`): el 401 debe ser `c.json({ error: UNAUTHORIZED }, 401)` en HTTP y `c.text(UNAUTHORIZED, 401)` en el upgrade WS (el upgrade actual usa `c.text("Unauthorized", 401)` — dejar el **mismo** texto; importar `UNAUTHORIZED` para no drift).

- [ ] En `web/src/lib/ws-client.ts`, `wsBaseUrl()` debe honrar `?token=` (hub abierto desde CLI):

```ts
function wsBaseUrl(): string {
  const base =
    env.public.apiUrl.replace(/\/$/, "").replace(/^http/, "ws") + "/ws";
  if (typeof window === "undefined") return base;
  const token = new URLSearchParams(window.location.search).get("token");
  if (!token) return base;
  return `${base}?token=${encodeURIComponent(token)}`;
}
```

- [ ] En `web/src/lib/hooks.ts` `useMe`: si hay `token` en `window.location.search`, llamar `apiJson<{ user: MeUser }>("/me", { headers: authHeaders(token) })` **antes** de rendirse a `null`. Así el hub con Bearer pinta la misma cuenta.

- [ ] En `web/src/components/ProvidersPanel.tsx`: el flujo `?token=` ya llama `useProviders(token)` y `useLinkProvider(token)`. Verificar que el formulario de link (Claude y Cursor) usa esas mutaciones y **no** exige `me.data` para habilitar el submit cuando hay token. Si el botón está `disabled={!signedIn}` y `signedIn` ya es `Boolean(me.data) || Boolean(token)`, dejarlo. Si algún control exige cookie, cambiarlo a `signedIn`.

- [ ] Crear `api/scripts/e2e-invariants-auth.ts`. Requiere API arriba (`CHAVEZ_API_URL`, default `http://localhost:25001`). Flujo:

  1. Sign-up email+password usuario A. Cookie A. `GET /me` → `{ user.id, email }`.
  2. Device-code: `device.code` → claim+approve con cookie A → `device.token` → Bearer. `GET /me` con `Authorization: Bearer` → **el mismo** `user.id` que el paso 1.
  3. `PUT /providers/claude/credentials` con ese Bearer (`authKind: "api_key", secret: "sk-ant-e2e-not-real"`) → 200. `GET /providers` con Bearer → `providers.claude.linked === true`.
  4. Sin cookie ni Bearer: `GET /me`, `GET /providers`, `GET /workspaces`, `GET /connections` → **401** y body `{ error: "Unauthorized" }`. `GET /ws` → **401**.
  5. Sign-up usuario B. Cookie B. A crea un workspace vía WS `workspace.bind` (o insert HTTP no existe: usar WS de A). `GET /workspaces/{idA}/sessions` con cookie B → **404** `{ error: "Workspace not found" }`. El body **no** contiene el email de A. `GET /chats/{chatIdA}` con cookie B → 404 `Chat not found`.
  6. `GET /workspaces` con cookie B **no** lista el path de A.

  Reutilizar helpers de `api/scripts/e2e-phase1.ts` (`cookieFromResponse`, device flow). `process.exit(1)` si cualquier assert falla. Al final imprimir `INVARIANTS AUTH PASS`.

- [ ] Correr:

```bash
bun test api/src/routes/ownership.test.ts
# API arriba:
bun run --filter @chavez/api test:invariants-auth
```

Esperado: ambos PASS. Device-code del usuario A opera el mismo `user.id` que la cookie web. Sin sesión = 401. Recurso ajeno = 404.

- [ ] Commit:

```bash
git add api/src/ws/errors.ts api/src/routes/ownership.ts \
  api/src/routes/ownership.test.ts api/src/routes/workspaces.ts \
  api/src/routes/providers.ts api/src/index.ts api/package.json \
  api/scripts/e2e-invariants-auth.ts \
  web/src/lib/ws-client.ts web/src/lib/hooks.ts \
  web/src/components/ProvidersPanel.tsx
git commit -m "fix(invariants): shared auth 401/404 and CLI bearer hub"
```

---

## Task 2: Un runner por workspace — bind daemon, first-wins, close, hostname+path

**Files:**

- Modify: `api/src/ws/protocol.ts`
- Modify: `api/src/ws/hub.ts`
- Test: `api/src/ws/hub.test.ts`
- Modify: `api/src/ws/handlers.ts`
- Modify: `api/src/index.ts`
- Modify: `api/src/routes/workspaces.ts`
- Modify: `api/openapi/openapi.yaml`
- Modify: `cli/src/ws/client.ts`
- Modify: `cli/src/ws/daemon.ts`
- Modify: `tui/src/App.tsx`
- Modify: `web/src/lib/hooks.ts`
- Modify: `web/src/lib/ws-context.tsx`
- Modify: `web/src/components/WorkspacesPanel.tsx`
- Modify: `web/src/components/WorkspaceDetailPanel.tsx`
- Modify: `web/src/components/ChatDetailPanel.tsx`
- Test: `cli/scripts/daemon-first-wins-smoke.ts`

Cierra los cuatro escenarios de “un solo runner”. Si `attach-files` ya añadió `hostname` al hub, **no** duplicar campos: reutilizar `setHostname` y extender `role`.

- [ ] En `api/src/ws/protocol.ts`, añadir a `ClientMessage`:

```ts
  hostname?: string;
  role?: string;
```

Dejar el resto. `role` aquí es el bind role (`primary` | `standby`), no el role de chat.

- [ ] En `api/src/ws/hub.ts`:

  - Añadir a `HubConnection` y `ConnectionPublic`: `hostname: string | null` y `role: "primary" | "standby" | "client"`.
  - Default en `add`: `hostname: null`, `role: "client"` (mismo patrón que `clientKind: "client"`). Extender el `Omit`/`Partial`.
  - `setHostname(connectionId, hostname: string | null)`.
  - `setRole(connectionId, role: HubConnection["role"])`.
  - `listForUser` mapea `hostname` y `role` (y `clientKind`, que ya mapea).
  - Reemplazar `findDaemon` por:

```ts
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
        a.connectedAt.localeCompare(b.connectedAt) ||
        a.connectionId.localeCompare(b.connectionId),
    );
},
findDaemon(userId: string, workspaceId: string): HubConnection | null {
  return this.findDaemons(userId, workspaceId)[0] ?? null;
},
```

Regla determinista: **el más antiguo** (`connectedAt` ASC, tie-break `connectionId`). El primero que hizo bind gana. Tras un disconnect, el que queda pasa a ser `[0]`.

- [ ] Crear `api/src/ws/hub.test.ts`. Mock de `WSContext`: `{ send: () => {} } as unknown as WSContext`. Cubrir:

  - `findDaemon` sin daemons → `null`.
  - Dos daemons mismo workspace: el de `connectedAt` más viejo gana, **aunque se inserte segundo en el Map** (set `connectedAt` a mano tras `add` si hace falta, o insertar en orden y comprobar).
  - Un daemon de otro `userId` no gana.
  - `listForUser` incluye `hostname` y `role`.
  - Tras `remove` del primary, `findDaemon` devuelve el standby restante.

- [ ] En `api/src/ws/handlers.ts` `workspace.bind`:

  1. Tras `hub.setWorkspace` + `hub.setClientKind`, si `typeof msg.hostname === "string" && msg.hostname.trim()`, `hub.setHostname(connectionId, msg.hostname.trim())`; si no, `null`.
  2. Si `clientKind === "daemon"`:
     - `const peers = hub.findDaemons(userId, workspace.id).filter((c) => c.connectionId !== connectionId);`
     - `const primary = peers[0] ?? hub.get(connectionId)!;`
     - Si `peers[0]` existe → `hub.setRole(connectionId, "standby")`, `role = "standby"`.
     - Si no → `hub.setRole(connectionId, "primary")`, `role = "primary"`.
  3. Si `clientKind !== "daemon"` → `hub.setRole(connectionId, "client")`.
  4. Respuesta `ok(type, id, { workspace, clientKind, hostname: hub.get(connectionId)?.hostname ?? null, role, primaryConnectionId: hub.findDaemon(userId, workspace.id)?.connectionId ?? connectionId, standbyReason: role === "standby" ? DAEMON_STANDBY_NOTE : undefined })`.
  5. `broadcast(userId, "daemon.presence", { workspaceId: workspace.id, bound: true, hostname: hub.findDaemon(userId, workspace.id)?.hostname ?? null, path: hub.findDaemon(userId, workspace.id)?.path ?? path, connectionId: hub.findDaemon(userId, workspace.id)?.connectionId, role: "primary", viewerRole: role })`.

- [ ] En `agent.turn.request` (mismo archivo): seguir usando `hub.findDaemon`. Si `null` → `fail(type, id, NO_DAEMON_ERROR)` (importar la constante; **el texto no cambia**). Si el daemon tiene `turnBusy` (campo que añade el plan 2; si no existe aún, añadirlo en Task 5 y aquí solo el miss de daemon). Incluir en el dispatch: `hostname: daemon.hostname`, `path: workspace?.path || daemon.path`, `daemonConnectionId: daemon.connectionId`.

- [ ] En `api/src/index.ts` `onClose` del WS, **antes** o justo después de `hub.remove`:

```ts
onClose() {
  const conn = hub.get(connectionId);
  hub.remove(connectionId);
  if (conn?.workspaceId) {
    const next = hub.findDaemon(conn.userId, conn.workspaceId);
    hub.broadcastToUser(
      conn.userId,
      hub.pushEvent("daemon.presence", {
        workspaceId: conn.workspaceId,
        bound: Boolean(next),
        hostname: next?.hostname ?? null,
        path: next?.path ?? null,
        connectionId: next?.connectionId ?? null,
        role: next ? "primary" : null,
        reason: "disconnected",
      }),
    );
  }
},
```

Tras quitar el primary, `findDaemon` ya apunta al standby restante (o `null`). Web deja de poder despachar si `bound: false`.

- [ ] En `api/src/routes/workspaces.ts` `GET /`:

```ts
workspaces: rows.map((w) => {
  const daemon = hub.findDaemon(session.user.id, w.id);
  return {
    ...w,
    openConnections: hub.countForWorkspace(session.user.id, w.id),
    daemonBound: Boolean(daemon),
    daemonHostname: daemon?.hostname ?? null,
    daemonPath: daemon?.path ?? w.path,
  };
}),
```

Mismo trío en `GET /:workspaceId/sessions` (junto a `openConnections` que ya existe).

- [ ] En `api/openapi/openapi.yaml`:

  - `ConnectionPublic`: añadir `clientKind` (`client` | `daemon`), `hostname` (nullable), `role` (`primary` | `standby` | `client`).
  - `WorkspaceWithConnections`: añadir `daemonBound` (boolean), `daemonHostname` (nullable), `daemonPath`.
  - `WsClientWorkspaceBind`: properties `clientKind`, `hostname`.
  - Descripción de `/ws`: mencionar `daemon.presence`.

- [ ] En `cli/src/ws/client.ts` `bind`:

```ts
async bind(
  path = cwdPath(),
  clientKind: "client" | "daemon" = "client",
): Promise<WsResponse> {
  const { hostname } = await import("node:os");
  return this.request({
    type: "workspace.bind",
    path,
    clientKind,
    hostname: hostname(),
  });
}
```

TUI y headless daemon reutilizan este `bind`: ambos envían hostname sin código extra.

- [ ] En `cli/src/ws/daemon.ts`, tras un bind ok, loguear `role` y `hostname` de `bound.data`. Si `role === "standby"`, `console.error(DAEMON_STANDBY_NOTE)` (copiar el string; el daemon no importa de `api/`). **No** ejecutar `agent.turn.dispatch` si el payload trae `daemonConnectionId` distinto de esta conexión (cinturón: la API ya no se lo envía). El `onPush` actual solo mira `agent.turn.dispatch`; dejarlo.

- [ ] En `tui/src/App.tsx`:

  - Estado `daemonRole: "primary" | "standby" | null"` y `daemonHostname: string`.
  - Tras `c.bind(...)`, leer `role` y `hostname` de `bound.data`.
  - Header: `daemon/runner` si `role === "primary"`; si `standby`, línea roja con `DAEMON_STANDBY_NOTE` + `primary hostname/path` si vienen.
  - **`sendWithLlm`:** si `daemonRole === "standby"`, **no** llamar `publishAgentTurn`. En su lugar `client.request({ type: "agent.turn.request", chatId: activeChatId, prompt: text })`. El primary (headless u otra TUI) ejecuta; esta TUI observa el stream. Si `role === "primary"`, el camino local actual se mantiene.
  - Handler `agent.turn.dispatch`: si `turnBusyRef` o si `daemonRole === "standby"`, no ejecutar (standby no debería recibirlo).

- [ ] En `web/src/lib/hooks.ts`: extender `Workspace` con `daemonBound?: boolean; daemonHostname?: string | null; daemonPath?: string`. Extender `Connection` con `clientKind?: "client" | "daemon"; hostname?: string | null; role?: string`.

- [ ] En `web/src/lib/ws-context.tsx`, en el `onPush` global, si `msg.type === "daemon.presence"`: `invalidateQueries` de `queryKeys.workspaces`, `queryKeys.connections` y `queryKeys.workspaceSessions`.

- [ ] En `web/src/components/WorkspacesPanel.tsx`:

  - Cada workspace: `{w.daemonHostname || "—"} · {w.daemonPath || w.path}` y badge `daemon` (ok) o `sin runner` (err) según `w.daemonBound`.
  - Lista de connections: `{c.hostname || "—"} · {c.path || "unbound"} · {c.clientKind} · {c.role}`.

- [ ] En `web/src/components/WorkspaceDetailPanel.tsx` y `ChatDetailPanel.tsx`: línea visible `Runner: {hostname} · {path}` o el error `NO_DAEMON_ERROR` cuando `daemonBound === false`. En ChatDetailPanel, deshabilitar el submit de `agent.turn.request` no basta: si el mutate falla con ese string, mostrarlo tal cual (ya pasa por `formatQueryError`). Añadir el texto de ayuda: `Sin daemon no se hidrata @ ni se ejecutan tools.`

- [ ] Crear `cli/scripts/daemon-first-wins-smoke.ts` (necesita API + login):

  1. Dos `ChavezWsClient` con el mismo token, `bind(path, "daemon")`.
  2. El primero: `role === "primary"`. El segundo: `role === "standby"` y `standbyReason` contiene `primary`.
  3. `agent.turn.request` desde un tercer client: **un solo** `agent.turn.dispatch` llega (contar pushes). El standby no recibe dispatch.
  4. `primary.close()`. Esperar. `GET /connections` (apiFetch): el restante es daemon. Nuevo `agent.turn.request` despacha al restante.
  5. Cerrar el restante. `agent.turn.request` → `ok: false` y `error === NO_DAEMON_ERROR`.

```bash
bun run cli/scripts/daemon-first-wins-smoke.ts
bun test api/src/ws/hub.test.ts
```

Esperado: first-wins, hostname en bind/list, close → error explícito, sin turns duplicados.

- [ ] Commit:

```bash
git add api/src/ws/protocol.ts api/src/ws/hub.ts api/src/ws/hub.test.ts \
  api/src/ws/handlers.ts api/src/index.ts api/src/routes/workspaces.ts \
  api/openapi/openapi.yaml cli/src/ws/client.ts cli/src/ws/daemon.ts \
  cli/scripts/daemon-first-wins-smoke.ts tui/src/App.tsx \
  web/src/lib/hooks.ts web/src/lib/ws-context.tsx \
  web/src/components/WorkspacesPanel.tsx \
  web/src/components/WorkspaceDetailPanel.tsx \
  web/src/components/ChatDetailPanel.tsx
git commit -m "fix(invariants): one primary daemon with hostname and path"
```

---

## Task 3: Sync de chat — create/append en vivo, deltas ordenados, reload sin duplicar

**Files:**

- Create: `cli/src/llm/timeline.ts`
- Test: `cli/src/llm/timeline.test.ts`
- Create: `web/src/lib/timeline.ts`
- Test: `web/src/lib/timeline.test.ts`
- Modify: `api/src/ws/protocol.ts`
- Modify: `api/src/ws/handlers.ts`
- Modify: `cli/src/llm/publish-turn.ts`
- Modify: `cli/src/ws/client.ts`
- Modify: `web/src/lib/ws-client.ts`
- Modify: `tui/src/App.tsx`
- Modify: `web/src/components/ChatDetailPanel.tsx`
- Modify: `web/src/lib/ws-context.tsx`
- Modify: `api/openapi/openapi.yaml`
- Modify: `cli/package.json`
- Modify: `web/package.json`

Cierra los cuatro escenarios de sync. CLI `session create` / `chat create` / `chat append` ya broadcast; TUI y Web ya escuchan. Esta task evita duplicados y ordena deltas.

- [ ] Añadir `"test": "bun test"` en `cli/package.json` y `web/package.json` si no existe (dejar el resto).

- [ ] Crear `cli/src/llm/timeline.ts` (TUI lo importa):

```ts
export type TimelineMessage = {
  id: string;
  role: string;
  content: string;
  metadata?: Record<string, unknown> | null;
  createdAt?: string | Date;
  chatId?: string;
};

export function mergeTimeline(
  existing: TimelineMessage[],
  incoming: TimelineMessage | TimelineMessage[],
): TimelineMessage[] {
  const map = new Map<string, TimelineMessage>();
  for (const m of existing) map.set(m.id, m);
  const list = Array.isArray(incoming) ? incoming : [incoming];
  for (const m of list) {
    if (!m?.id) continue;
    const prev = map.get(m.id);
    map.set(m.id, prev ? { ...prev, ...m } : m);
  }
  return [...map.values()].sort((a, b) => {
    const ta = new Date(a.createdAt ?? 0).getTime();
    const tb = new Date(b.createdAt ?? 0).getTime();
    if (ta !== tb) return ta - tb;
    return a.id.localeCompare(b.id);
  });
}

export function applyStreamDelta(
  prev: string,
  delta: string,
  seq: number | undefined,
  state: { nextSeq: number; buffer: Map<number, string> },
): string {
  if (seq == null || !Number.isFinite(seq)) return prev + delta;
  state.buffer.set(seq, delta);
  let out = prev;
  while (state.buffer.has(state.nextSeq)) {
    out += state.buffer.get(state.nextSeq)!;
    state.buffer.delete(state.nextSeq);
    state.nextSeq += 1;
  }
  return out;
}

export function shouldShowLiveAssistant(
  messages: TimelineMessage[],
  streamId: string | null,
  streaming: boolean,
): boolean {
  if (!streaming) return false;
  if (!streamId) return true;
  return !messages.some(
    (m) =>
      m.role === "assistant" &&
      m.metadata &&
      String((m.metadata as { streamId?: unknown }).streamId) === streamId,
  );
}
```

- [ ] Crear `cli/src/llm/timeline.test.ts` con bun:test:

  - `mergeTimeline` no duplica el mismo `id`; un incoming con `updated` pisa `content`.
  - Orden por `createdAt` luego `id`.
  - `applyStreamDelta` con seq 2 luego 1 concatena `"ab"` no `"ba"`.
  - Sin seq, concatena en orden de llegada.
  - `shouldShowLiveAssistant` es false si ya hay assistant con ese `streamId`.

- [ ] Copiar las **mismas tres funciones** a `web/src/lib/timeline.ts` y el mismo test a `web/src/lib/timeline.test.ts` (Web no importa `cli/`; `web/tsconfig.json` solo incluye `web/src`). No extraer a un paquete nuevo.

- [ ] En `api/src/ws/protocol.ts`, añadir `seq?: number` a `ClientMessage`.

- [ ] En `api/src/ws/handlers.ts` `chat.stream.delta`: incluir `seq: typeof msg.seq === "number" ? msg.seq : undefined` en el payload broadcast. No inventar seq en la API (el daemon es la fuente). `chat.stream.start` y `chat.stream.end` ya llevan `streamId`; dejarlos.

- [ ] En `cli/src/llm/publish-turn.ts`, el `onEvent` de `stream_delta` debe enviar seq monótono por turn:

```ts
let seq = 1; // STREAM_SEQ_START
// ...
if (ev.kind === "stream_delta") {
  await client.request({
    type: "chat.stream.delta",
    chatId,
    streamId,
    delta: ev.text,
    seq,
  });
  seq += 1;
}
```

Añadir `seq?: number` a `WsRequest` en `cli/src/ws/client.ts` y `web/src/lib/ws-client.ts`.

- [ ] En `tui/src/App.tsx`:

  - Tipo `Message` = `TimelineMessage` (añadir `metadata?`).
  - Estado `streamText`, `streaming`, `streamIdRef`, `deltaStateRef = { nextSeq: 1, buffer: new Map() }`.
  - En `onPush`:
    - `session.created` → ya refresca `session.list` (mantener). Cubrir también creates desde CLI (mismo evento).
    - `chat.created` → ya refresca chats de la session activa (mantener).
    - `message.appended` → `setMessages((prev) => mergeTimeline(prev, data.message))` si `data.chatId === activeChatId`. **No** `loadChat` completo en cada append (evita parpadeo y duplicados). Si `data.updated === true`, merge pisa el id.
    - `chat.stream.start` → reset `streamText`, `nextSeq = 1`, `buffer.clear()`, `streaming = true`, guardar `streamId`.
    - `chat.stream.delta` → `setStreamText((prev) => applyStreamDelta(prev, data.delta, data.seq, deltaStateRef.current))`.
    - `chat.stream.end` / `error` → `streaming = false`; si `data.message` (assistant persistido), `mergeTimeline`; `streamText = ""`.
  - Render: `messages` vía `mergeTimeline` (ids únicos). Bubble live solo si `shouldShowLiveAssistant(messages, streamId, streaming)`.
  - Tras `sendWithLlm` / dispatch, **un** `loadChat` al terminar sigue siendo válido (reconstruye desde DB).

- [ ] En `web/src/components/ChatDetailPanel.tsx`:

  - Mismo patrón: `applyStreamDelta` + `shouldShowLiveAssistant`.
  - En `message.appended`, `qc.setQueryData(queryKeys.chat(chatId), prev => prev ? { ...prev, messages: mergeTimeline(prev.messages, data.message) } : prev)` **además** del invalidate (el invalidate reconstruye; merge evita el hueco).
  - Reload de página = `useChat` GET `/chats/:id` que ya devuelve user/tool/assistant. Deduplicar al pintar: `mergeTimeline([], messages)`.

- [ ] En `web/src/lib/ws-context.tsx`: `session.created` y `chat.created` ya invalidan. Añadir `daemon.presence` si Task 2 no lo hizo. No duplicar `message.appended` en dos sitios de forma que se inserte dos veces: el panel hace merge por id; el context solo invalida.

- [ ] OpenAPI `ChatMessage.role` enum debe incluir `tool`. Añadir `metadata` (object, nullable). Documentar `chat.stream.delta.seq`.

- [ ] Correr:

```bash
bun test cli/src/llm/timeline.test.ts
bun test web/src/lib/timeline.test.ts
```

Esperado: deltas 2-luego-1 salen `"ab"`; merge no duplica ids; live assistant se oculta si el persistido ya está.

- [ ] Commit:

```bash
git add cli/src/llm/timeline.ts cli/src/llm/timeline.test.ts \
  cli/src/llm/publish-turn.ts cli/src/ws/client.ts cli/package.json \
  web/src/lib/timeline.ts web/src/lib/timeline.test.ts \
  web/src/lib/ws-client.ts web/src/lib/ws-context.tsx \
  web/src/components/ChatDetailPanel.tsx web/package.json \
  tui/src/App.tsx api/src/ws/protocol.ts api/src/ws/handlers.ts \
  api/openapi/openapi.yaml
git commit -m "fix(invariants): live chat sync with ordered deltas and dedup"
```

---

## Task 4: Composición del prompt — historial + attaches + tools como contexto

**Files:**

- Modify: `cli/src/llm/history.ts`
- Test: `cli/src/llm/history.test.ts`
- Modify: `cli/src/llm/publish-turn.ts`
- Modify: `cli/src/llm/claude-runner.ts`
- Modify: `cli/scripts/history-smoke.ts`

Cierra los cuatro escenarios de composición. El SDK sigue recibiendo **un string** (o el mismo `query({ prompt })` de hoy). Nada de reinyectar bloques `tool_use` del turno anterior.

- [ ] Reemplazar el cuerpo de `cli/src/llm/history.ts` para conservar tools y attachments como texto. API pública a mantener: `historyFromChatMessages`, `promptWithHistory`, `MAX_HISTORY_MESSAGES`, `MAX_HISTORY_CHARS`. Extender tipos:

```ts
export const MAX_HISTORY_MESSAGES = 40;
export const MAX_HISTORY_CHARS = 100_000;

export const TOOL_CONTEXT_PREAMBLE =
  "Historical tool result (do not re-run; context only)";
export const ATTACH_CONTEXT_PREAMBLE =
  "Attached workspace snapshot (do not re-read disk unless the user mentions it again)";

export type HistoryRole = "user" | "assistant" | "system";

export type HistoryMessage = {
  role: HistoryRole;
  content: string;
};

type DbMessage = {
  role?: string | null;
  content?: string | null;
  metadata?: Record<string, unknown> | null;
};

function formatToolContext(m: DbMessage): string {
  const meta = (m.metadata || {}) as Record<string, unknown>;
  const name = String(meta.toolName || m.content || "tool");
  const status = String(meta.status || "");
  const input = meta.input == null ? "" : JSON.stringify(meta.input);
  const output = String(meta.output ?? m.content ?? "");
  return [
    TOOL_CONTEXT_PREAMBLE,
    `tool=${name} status=${status}`,
    input ? `input=${input}` : "",
    output ? `output=${output}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function formatAttachments(meta: Record<string, unknown> | null | undefined): string {
  const atts = meta?.attachments;
  if (!Array.isArray(atts) || atts.length === 0) return "";
  const blocks = atts.map((raw) => {
    const a = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const path = String(a.path || a.relPath || "attach");
    const status = String(a.status || "ok");
    const body =
      typeof a.text === "string"
        ? a.text
        : typeof a.content === "string"
          ? a.content
          : typeof a.listing === "string"
            ? a.listing
            : "";
    return `@${path} (${status})\n${body}`.trim();
  });
  return `${ATTACH_CONTEXT_PREAMBLE}\n${blocks.join("\n\n")}`;
}

export function historyFromChatMessages(
  messages: DbMessage[],
  currentPrompt: string,
): HistoryMessage[] {
  const text: HistoryMessage[] = [];
  for (const m of messages) {
    const role = String(m.role || "");
    if (role === "tool") {
      const content = formatToolContext(m);
      if (content.trim()) text.push({ role: "system", content });
      continue;
    }
    if (role !== "user" && role !== "assistant" && role !== "system") continue;
    const attach = role === "user" ? formatAttachments(m.metadata) : "";
    const base = typeof m.content === "string" ? m.content : "";
    const content = [base, attach].filter((s) => s.trim()).join("\n\n");
    if (!content.trim()) continue;
    text.push({ role, content });
  }

  if (
    text.length > 0 &&
    text[text.length - 1]!.role === "user" &&
    text[text.length - 1]!.content === currentPrompt
  ) {
    text.pop();
  }

  let sliced = text.slice(-MAX_HISTORY_MESSAGES);
  let total = sliced.reduce((n, m) => n + m.content.length, 0);
  while (sliced.length > 1 && total > MAX_HISTORY_CHARS) {
    const removed = sliced.shift()!;
    total -= removed.content.length;
  }
  if (sliced.length === 1 && total > MAX_HISTORY_CHARS) {
    const only = sliced[0]!;
    sliced = [{ role: only.role, content: only.content.slice(-MAX_HISTORY_CHARS) }];
  }
  return sliced;
}

export function promptWithHistory(
  prompt: string,
  history: HistoryMessage[],
  currentAttachments?: string,
): string {
  const current = [prompt, currentAttachments].filter((s) => s && s.trim()).join("\n\n");
  if (history.length === 0) return current;

  const prior = history
    .map((m) => `${m.role.toUpperCase()}:\n${m.content}`)
    .join("\n\n");

  return [
    "Previous conversation in this chat (source of truth; use it to stay consistent):",
    "",
    prior,
    "",
    "---",
    "",
    "Current user message:",
    current,
  ].join("\n");
}
```

Punto clave: `role === "tool"` se convierte en `system` con `TOOL_CONTEXT_PREAMBLE`. **Nunca** se devuelve `{ role: "tool" }` ni un bloque SDK `tool_use`. `runClaudeTurn` sigue pasando un `string` a `query({ prompt })`.

- [ ] Crear `cli/src/llm/history.test.ts`:

  - Historial user+assistant+tool+user actual: la tool aparece como `system` y el content incluye `Historical tool result (do not re-run`.
  - El user actual igual a `currentPrompt` se recorta.
  - Attachments en metadata del user histórico se inlinan; el follow-up **no** necesita releer disco (el test no toca `fs`).
  - `promptWithHistory` concatena prior + current. Un content de tool **no** incluye `"type":"tool_use"`.
  - Truncado por `MAX_HISTORY_CHARS` conserva el más reciente.

- [ ] En `cli/src/llm/publish-turn.ts`, `chat.get` debe leer `metadata`. Tras `historyFromChatMessages(dbMessages, prompt)`:

```ts
const lastUser = [...dbMessages].reverse().find((m) => m.role === "user");
const currentAttachments = formatAttachments(
  (lastUser as { metadata?: Record<string, unknown> } | undefined)?.metadata,
);
```

Exportar `formatAttachments` desde `history.ts` (añadir `export` a la función de arriba). Pasar `currentAttachments` a `runClaudeTurn` / `promptWithHistory`.

Si el plan attach-files ya hidrata y persiste `metadata.attachments` **antes** de `runClaudeTurn`, este código las reinyecta. Si aún no hay attachments, `formatAttachments` devuelve `""` y el prompt es el de hoy.

- [ ] En `cli/src/llm/claude-runner.ts`, `promptWithHistory(input.prompt, input.history ?? [])` debe aceptar el tercer argumento si `publish-turn` lo calcula; o bien `publish-turn` pasa el prompt ya compuesto. Elegir **una**: `publish-turn` llama `promptWithHistory(prompt, history, currentAttachments)` y `runClaudeTurn` recibe `prompt` ya final **o** `runClaudeTurn` recibe `attachmentsText` y compone. No componer dos veces. Recomendado: componer en `runClaudeTurn` añadiendo `attachmentsText?: string` a `RunClaudeTurnInput` y `promptWithHistory(input.prompt, input.history ?? [], input.attachmentsText)`.

- [ ] Actualizar `cli/scripts/history-smoke.ts` unidad: el caso con `{ role: "tool", content: "noise" }` **ya no** espera `hist.length === 2`. Esperar que exista un `system` cuyo content matchea `/do not re-run/` y que **no** exista un history item con `role: "tool"`. El smoke live de dos turns (marker) se queda: el follow-up debe devolver el marker (historial de DB + prompt actual).

- [ ] Correr:

```bash
bun test cli/src/llm/history.test.ts
bun run cli/scripts/history-smoke.ts
```

Esperado: tools históricas en el string; ningún `tool_use` reinyectado; el segundo turn recuerda el marker.

- [ ] Commit:

```bash
git add cli/src/llm/history.ts cli/src/llm/history.test.ts \
  cli/src/llm/publish-turn.ts cli/src/llm/claude-runner.ts \
  cli/scripts/history-smoke.ts
git commit -m "fix(invariants): rehydrate history and attachments without re-running tools"
```

---

## Task 5: Busy, cancel y conexiones listables

**Files:**

- Modify: `api/src/ws/hub.ts`
- Modify: `api/src/ws/hub.test.ts`
- Modify: `api/src/ws/protocol.ts`
- Modify: `api/src/ws/handlers.ts`
- Modify: `api/openapi/openapi.yaml`
- Modify: `cli/src/llm/claude-runner.ts`
- Modify: `cli/src/llm/publish-turn.ts`
- Create: `cli/src/llm/turn-abort.ts`
- Test: `cli/src/llm/turn-abort.test.ts`
- Modify: `cli/src/ws/daemon.ts`
- Modify: `cli/src/ws/client.ts`
- Modify: `cli/src/commands/headless.ts`
- Modify: `cli/src/index.ts`
- Modify: `tui/src/App.tsx`
- Modify: `web/src/lib/ws-hooks.ts`
- Modify: `web/src/components/ChatDetailPanel.tsx`
- Modify: `web/src/components/WorkspacesPanel.tsx`

Cierra busy + cancel Claude/Cursor + `chavez headless connections`. Si el plan 2 ya añadió `turnBusy` / `agent.turn.ended`, extender. Si el plan 4 ya aborta Cursor, reutilizar el `AbortSignal`.

- [ ] En `api/src/ws/hub.ts`, si aún no existen, añadir `turnBusy: boolean` y `turnChatId: string | null` a `HubConnection` (default `false` / `null` en `add`). Métodos:

```ts
setTurnBusy(connectionId: string, busy: boolean, chatId: string | null = null) {
  const c = connections.get(connectionId);
  if (!c) return;
  c.turnBusy = busy;
  c.turnChatId = busy ? chatId : null;
},
isTurnBusy(userId: string, workspaceId: string): boolean {
  return Boolean(this.findDaemon(userId, workspaceId)?.turnBusy);
},
```

Test: `setTurnBusy` + `isTurnBusy` true/false.

- [ ] En `api/src/ws/protocol.ts`, `ClientMessage` ya tiene `chatId`. No hace falta campo nuevo para cancel.

- [ ] En `api/src/ws/handlers.ts`:

  `agent.turn.request` (después de `findDaemon`, antes de `sendTo`):

```ts
if (daemon.turnBusy) {
  return fail(type, id, TURN_BUSY_ERROR);
}
hub.setTurnBusy(daemon.connectionId, true, msg.chatId);
broadcast(userId, "agent.turn.started", {
  chatId: msg.chatId,
  daemonConnectionId: daemon.connectionId,
  hostname: daemon.hostname,
  path: daemon.path,
});
```

Si `sendTo` falla, `hub.setTurnBusy(daemon.connectionId, false)` y `fail(..., "Daemon connection unavailable")`.

  Nuevo case `agent.turn.ended` (lo envía el daemon):

```ts
case "agent.turn.ended": {
  if (!msg.chatId) return fail(type, id, "chatId is required");
  const ctx = await workspaceIdForChat(msg.chatId, userId);
  if (!ctx) return fail(type, id, NOT_FOUND_CHAT);
  const daemon = hub.findDaemon(userId, ctx.workspaceId);
  if (daemon) hub.setTurnBusy(daemon.connectionId, false);
  const payload = { chatId: msg.chatId, streamId: msg.streamId };
  broadcast(userId, "agent.turn.ended", payload);
  return ok(type, id, payload);
}
```

  Nuevo case `agent.turn.cancel`:

```ts
case "agent.turn.cancel": {
  if (!msg.chatId) return fail(type, id, "chatId is required");
  const ctx = await workspaceIdForChat(msg.chatId, userId);
  if (!ctx) return fail(type, id, NOT_FOUND_CHAT);
  const daemon = hub.findDaemon(userId, ctx.workspaceId);
  if (!daemon) return fail(type, id, NO_DAEMON_ERROR);
  const wasRunning = Boolean(daemon.turnBusy && daemon.turnChatId === msg.chatId);
  const sent = hub.sendTo(
    daemon.connectionId,
    hub.pushEvent("agent.turn.cancel", {
      chatId: msg.chatId,
      requestId: id,
    }),
  );
  if (!sent) return fail(type, id, "Daemon connection unavailable");
  return ok(type, id, { cancelled: true, wasRunning });
}
```

Idempotente: si no hay turn, `ok` con `wasRunning: false` (no uses `NO_TURN_RUNNING` como fail; la UI de cancel no debe 500).

- [ ] OpenAPI: documentar `agent.turn.started`, `agent.turn.ended`, `agent.turn.cancel` en la sección WebSocket. `GET /connections` ya existe; asegurar `clientKind` + `hostname` + `role` (Task 2).

- [ ] Crear `cli/src/llm/turn-abort.ts`:

```ts
const byChat = new Map<string, AbortController>();

export function beginTurnAbort(chatId: string): AbortSignal {
  byChat.get(chatId)?.abort();
  const ac = new AbortController();
  byChat.set(chatId, ac);
  return ac.signal;
}

export function abortTurn(chatId: string): boolean {
  const ac = byChat.get(chatId);
  if (!ac) return false;
  ac.abort();
  return true;
}

export function endTurnAbort(chatId: string): void {
  byChat.delete(chatId);
}
```

- [ ] Test `cli/src/llm/turn-abort.test.ts`: `beginTurnAbort` + `abortTurn` marca `signal.aborted`; segundo `beginTurnAbort` aborta el anterior; `endTurnAbort` + `abortTurn` → `false`.

- [ ] En `cli/src/llm/claude-runner.ts`, `RunClaudeTurnInput` gana `abortController?: AbortController`. Pasarlo a `query`:

```ts
const options: Record<string, unknown> = {
  model: input.model,
  cwd: input.cwd,
  env: cleanEnv,
  settingSources: [],
  permissionMode: "bypassPermissions",
  abortController: input.abortController,
};
```

Si el plan 2 ya cambió `permissionMode` a `"default"`, **no** volver a `bypassPermissions`. Solo añadir `abortController`. Dentro del `for await`, si `input.abortController?.signal.aborted`, `throw new Error(TURN_CANCELLED)` (`"Turn cancelled"`).

- [ ] En `cli/src/llm/publish-turn.ts`:

```ts
import { beginTurnAbort, endTurnAbort } from "./turn-abort";
import { TURN_CANCELLED } from "./history"; // o constante local "Turn cancelled"
```

Definir `export const TURN_CANCELLED = "Turn cancelled";` en `cli/src/llm/turn-abort.ts` (un solo lugar en CLI).

```ts
export async function publishAgentTurn(input: {
  client: ChavezWsClient;
  chatId: string;
  prompt: string;
  cwd: string;
  token?: string;
  skipUserAppend?: boolean;
  abortController?: AbortController;
}): Promise<string> {
  const signal = input.abortController?.signal ?? beginTurnAbort(input.chatId);
  const abortController =
    input.abortController ??
    (signal as AbortSignal & { controller?: AbortController }).controller ??
    new AbortController();
```

Más simple: `beginTurnAbort` devuelve el `AbortController` entero:

```ts
export function beginTurnAbort(chatId: string): AbortController {
  byChat.get(chatId)?.abort();
  const ac = new AbortController();
  byChat.set(chatId, ac);
  return ac;
}
```

Luego:

```ts
  const ac = input.abortController ?? beginTurnAbort(input.chatId);
  try {
    // ... runClaudeTurn({ ..., abortController: ac })
  } catch (err) {
    const message =
      ac.signal.aborted
        ? TURN_CANCELLED
        : err instanceof Error
          ? err.message
          : String(err);
    await client.request({
      type: "chat.stream.error",
      chatId,
      streamId,
      content: message,
    });
    throw new Error(message);
  } finally {
    endTurnAbort(input.chatId);
    await client.request({ type: "agent.turn.ended", chatId });
  }
```

Si el provider activo no es Claude (Cursor stub), el throw actual se mantiene; el `finally` **siempre** manda `agent.turn.ended` para no dejar busy eterno. Si existe `runCursorTurn` (plan 4), pasarle el mismo `AbortSignal` / `run.cancel()`.

- [ ] En `cli/src/ws/daemon.ts`:

```ts
import { abortTurn, beginTurnAbort } from "../llm/turn-abort";

let turnBusy = false;

client.onPush(async (msg: WsPushMessage) => {
  if (msg.type === "agent.turn.cancel") {
    const chatId = (msg.data as { chatId?: string } | undefined)?.chatId;
    if (chatId) abortTurn(chatId);
    return;
  }
  if (msg.type !== "agent.turn.dispatch") return;
  // ...
  if (turnBusy) {
    log("turn already running — ignoring dispatch");
    return;
  }
  turnBusy = true;
  const ac = beginTurnAbort(data.chatId);
  try {
    await publishAgentTurn({
      client,
      chatId: data.chatId,
      prompt: data.prompt,
      cwd: data.path || path,
      token: config.accessToken!,
      abortController: ac,
    });
  } finally {
    turnBusy = false;
  }
});
```

- [ ] En `cli/src/commands/headless.ts`, acción `chat cancel`:

```ts
if (action === "cancel") {
  const chatId = rest[0];
  if (!chatId) throw new Error("Uso: … chat cancel <chatId>");
  const res = await client.request({ type: "agent.turn.cancel", chatId });
  if (!res.ok) throw new Error(res.error);
  console.log(JSON.stringify(res.data, null, 2));
  return;
}
```

El usage de `chat` pasa a `<create|list|append|get|ask|watch|cancel>`. `connections` ya existe (`chavez headless connections`); imprimir JSON que ahora incluye `hostname`, `clientKind`, `role`.

- [ ] En `cli/src/index.ts` usage line de headless chat, añadir `cancel`.

- [ ] En `tui/src/App.tsx`:

  - Banner busy existente se queda. Añadir: si `busy`, texto `Esc cancela el turn (no cierra la TUI)`.
  - `useInput` **ya no** hace `exit()` en Escape cuando `busy`:

```ts
if (key.ctrl && ch === "c") {
  client?.close();
  exit();
  return;
}
if (key.escape) {
  if (busy && activeChatId && client) {
    abortTurn(activeChatId);
    void client.request({ type: "agent.turn.cancel", chatId: activeChatId });
    setLog("Turn cancelled");
    return;
  }
  if (mode === "compose") {
    setMode("command");
    setInput("");
    return;
  }
  client?.close();
  exit();
  return;
}
```

  - `sendWithLlm` / dispatch: `const ac = beginTurnAbort(chatId); await publishAgentTurn({ ..., abortController: ac })`.
  - Escuchar `agent.turn.started` / `agent.turn.ended` para `setBusy` cuando el turn lo ejecuta **otro** primary (esta TUI en standby).
  - `q` en command mode sigue saliendo.

- [ ] En `web/src/lib/ws-hooks.ts`:

```ts
export function useWsAgentCancel() {
  const ws = useWs();
  return useMutation({
    mutationFn: (input: { chatId: string }) =>
      ws.request({ type: "agent.turn.cancel", chatId: input.chatId }),
  });
}
```

- [ ] En `web/src/components/ChatDetailPanel.tsx`:

  - Estado `turnBusy` a partir de `agent.turn.started` / `ended` (además de `streaming`).
  - Badge `busy` amarillo mientras `turnBusy || streaming`.
  - Botón `Cancelar turn` visible si `turnBusy`, llama `useWsAgentCancel`. Disabled si WS no `open`.
  - El submit del agente se deshabilita si `turnBusy`.

- [ ] En `web/src/components/WorkspacesPanel.tsx`, connections ya muestran hostname (Task 2). Añadir `clientKind` si faltó.

- [ ] Correr:

```bash
bun test cli/src/llm/turn-abort.test.ts
bun test api/src/ws/hub.test.ts
```

Esperado: abort marca signal; busy se limpia en `ended`; cancel sin daemon = `NO_DAEMON_ERROR`; cancel sin turn = `ok wasRunning: false`.

- [ ] Commit:

```bash
git add api/src/ws/hub.ts api/src/ws/hub.test.ts api/src/ws/protocol.ts \
  api/src/ws/handlers.ts api/openapi/openapi.yaml \
  cli/src/llm/claude-runner.ts cli/src/llm/publish-turn.ts \
  cli/src/llm/turn-abort.ts cli/src/llm/turn-abort.test.ts \
  cli/src/ws/daemon.ts cli/src/ws/client.ts \
  cli/src/commands/headless.ts cli/src/index.ts \
  tui/src/App.tsx web/src/lib/ws-hooks.ts \
  web/src/components/ChatDetailPanel.tsx \
  web/src/components/WorkspacesPanel.tsx
git commit -m "feat(invariants): turn busy, cancel, and listable connections"
```

---

## Task 6: Seguridad transversal — sandbox, vault, redacción, Web acotada

**Files:**

- Create: `cli/src/llm/workspace-path.ts` (solo si **no** existe con `resolveInsideCwd` / `PathEscapeError`)
- Test: `cli/src/llm/workspace-path.test.ts` (crear o extender)
- Create: `cli/src/llm/redact.ts`
- Test: `cli/src/llm/redact.test.ts`
- Create: `api/src/lib/redact.ts`
- Test: `api/src/lib/redact.test.ts`
- Modify: `cli/src/llm/publish-turn.ts`
- Modify: `api/src/ws/handlers.ts`
- Modify: `api/src/routes/providers.ts`
- Modify: `web/src/components/ProvidersPanel.tsx`

Cierra los cuatro escenarios de “el agente no es root”. Ignore/gitignore (plan 8) no entra: aquí solo sandbox de path, redacción de keys y no filtrar el vault ni el FS completo.

- [ ] Si `cli/src/llm/workspace-path.ts` **no** existe, crearlo:

```ts
import { realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

export const PATH_ESCAPE_PREFIX = "Path outside workspace: ";

export class PathEscapeError extends Error {
  readonly code = "PATH_ESCAPE" as const;
  constructor(public readonly relPath: string) {
    super(`${PATH_ESCAPE_PREFIX}${relPath}`);
  }
}

export function resolveInsideCwd(cwd: string, relPath: string): string {
  const trimmed = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!trimmed || trimmed === ".") throw new PathEscapeError(relPath);
  if (isAbsolute(relPath) || /^[A-Za-z]:/.test(relPath)) {
    throw new PathEscapeError(relPath);
  }
  const cwdReal = realpathSync(cwd);
  let resolved: string;
  try {
    resolved = realpathSync(join(cwdReal, trimmed));
  } catch {
    const lexical = join(cwdReal, trimmed);
    const rel = relative(cwdReal, lexical);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new PathEscapeError(relPath);
    return lexical;
  }
  const rel = relative(cwdReal, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new PathEscapeError(relPath);
  return resolved;
}
```

Tests: `../etc/passwd` lanza `PathEscapeError`; `src/index.ts` (archivo que exista bajo `cwd`) resuelve dentro; absoluto `/etc/passwd` lanza. Si el archivo **ya** existe (planes 1–2), no tocarlo; asegurar que los tests cubren esos tres casos.

`publish-turn` / hydrate (si existe) deben usar `resolveInsideCwd` antes de leer. Si hydrate aún no existe, exportar el helper y usarlo en cualquier `readFileSync` futuro; en esta task, usarlo en un guard de `publishAgentTurn` que recorra `metadata.attachments[].path` y tire `PathEscapeError` (convertido a `chat.stream.error`, **sin** llamar al LLM).

- [ ] Crear `cli/src/llm/redact.ts` **y** el mismo módulo en `api/src/lib/redact.ts` (API no importa CLI):

```ts
export const REDACT_REPLACEMENT = "***";

const KEY_NAME =
  /^(api[_-]?key|token|secret|password|authorization|credential|access[_-]?token)$/i;

const PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_\-]+/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /ghp_[A-Za-z0-9]+/g,
  /github_pat_[A-Za-z0-9_]+/g,
  /gho_[A-Za-z0-9]+/g,
  /xox[baprs]-[A-Za-z0-9-]+/g,
  /AKIA[0-9A-Z]{16}/g,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g,
];

export function redactText(input: string): string {
  let out = input;
  for (const re of PATTERNS) {
    out = out.replace(new RegExp(re.source, re.flags), REDACT_REPLACEMENT);
  }
  return out;
}

export function redactJson(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redactJson);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = KEY_NAME.test(k) ? REDACT_REPLACEMENT : redactJson(v);
    }
    return out;
  }
  return value;
}
```

- [ ] Tests (cli y api): `sk-ant-api03-abc` → `***`; `ghp_abc` → `***`; `{ api_key: "x", file: "a.ts" }` → `{ api_key: "***", file: "a.ts" }`; texto inocente `"hello src/auth.ts"` intacto.

- [ ] En `cli/src/llm/publish-turn.ts`, **antes** de `chat.tool.result` / `chat.stream.end` / `chat.append` de assistant: `content` y `metadata.output` / `metadata.input` pasan por `redactText` / `redactJson`. El secret de `GET /providers/claude/credentials` se guarda en variable local `creds.secret` y **solo** se pasa a `runClaudeTurn` vía env. Nunca `JSON.stringify(creds)` a logs ni a `chat.append`. En el `catch`, si `message` contiene `creds.secret`, sustituirlo por `***` antes de `chat.stream.error`.

- [ ] En `api/src/ws/handlers.ts`, cinturón en `chat.append`, `chat.stream.end`, `chat.tool.start`, `chat.tool.result`: redactar `msg.content` y `msg.metadata` con `redactText`/`redactJson` **antes** de insertar y de broadcast. Así un cliente malicioso no persiste una key cruda. Importar desde `api/src/lib/redact.ts`.

- [ ] En `api/src/routes/providers.ts` `GET /:provider/credentials`: se queda (el daemon lo necesita). Añadir header de respuesta `Cache-Control: no-store`. **No** incluir `secret` en `GET /providers` (hoy no se incluye; test e2e de Task 1 ya lista providers — ampliar en Task 7 a `JSON.stringify(list).includes("sk-ant-e2e") === false`).

- [ ] En `web/src/components/ProvidersPanel.tsx`: Reveal sigue siendo opt-in. El secret revelado **no** se copia a ningún `chat.append`. No añadir un explorador de archivos. No crear `GET /workspaces/:id/files` ni WS `fs.tree` en esta fase (el árbol es el plan 18). Si existe `fs.complete` (plan 1), su respuesta ya está acotada a 10; no ampliar el límite.

- [ ] Correr:

```bash
bun test cli/src/llm/redact.test.ts
bun test api/src/lib/redact.test.ts
bun test cli/src/llm/workspace-path.test.ts
```

Esperado: keys redactadas; `../` lanza; `GET /providers` sin secretos.

- [ ] Commit:

```bash
git add cli/src/llm/workspace-path.ts cli/src/llm/workspace-path.test.ts \
  cli/src/llm/redact.ts cli/src/llm/redact.test.ts \
  cli/src/llm/publish-turn.ts api/src/lib/redact.ts api/src/lib/redact.test.ts \
  api/src/ws/handlers.ts api/src/routes/providers.ts \
  web/src/components/ProvidersPanel.tsx
git commit -m "fix(invariants): path sandbox, vault isolation, and secret redaction"
```

---

## Task 7: Verificación cruzada de los escenarios Gherkin

**Files:**

- Create: `api/scripts/e2e-invariants.ts`
- Modify: `api/package.json`
- Modify: `cli/scripts/tui-sync-smoke.ts`

Un script que, con API arriba y un usuario logueado, recorre las seis características. No sustituye las units; las ata.

- [ ] Añadir en `api/package.json`: `"test:invariants": "bun run scripts/e2e-invariants.ts"`.

- [ ] Crear `api/scripts/e2e-invariants.ts`:

  Setup: reutilizar sign-up + device-code de `e2e-invariants-auth.ts` (extraer helpers a `api/scripts/e2e-helpers.ts` si se duplican más de 20 líneas; si no, copiar lo mínimo). Un Bearer. Un path tmp `mkdtemp`.

  **Auth:** `GET /me` cookie === Bearer `user.id`. `GET /providers` 401 sin token. Recurso ajeno 404.

  **Daemon:** client A `bind(path, "daemon")` → `role=primary`, `hostname` no vacío. Client B `bind(path, "daemon")` → `standby`. `GET /workspaces` incluye `daemonHostname` y `daemonBound: true`. `agent.turn.request` (chat creado) → un solo dispatch al primary. B.close no desbindea el primary. A.close → `daemon.presence bound: false`. Siguiente `agent.turn.request` → `NO_DAEMON_ERROR`.

  **Sync:** con un daemon de nuevo: `session.create` en client CLI-like; un observer (tercer WS, `clientKind: "client"`) recibe `session.created`. `chat.create` → `chat.created`. `chat.append` → `message.appended` en observer. Simular stream: el daemon manda `chat.stream.start`, delta seq=2, delta seq=1, `chat.stream.end` con content `"ab"`. Observer concatena con `applyStreamDelta` importado de `cli/src/llm/timeline.ts` y obtiene `"ab"`. `chat.get` tiene un solo assistant con ese content (no dos).

  **Prompt:** `historyFromChatMessages` con tool row → system context. Assert `TOOL_CONTEXT_PREAMBLE`.

  **Busy/cancel:** `agent.turn.cancel` sin turn → `ok wasRunning: false`. `GET /connections` con Bearer → items con `connectionId`, `clientKind`, `path` o `hostname`.

  **Seguridad:** `redactText("sk-ant-api03-aaaa") === "***"`. Un `chat.append` con content que incluye `ghp_secretsecretsecret` se persiste redactado (leer `chat.get` y assert no contiene `ghp_`). `GET /providers` body no contiene el secret puesto en credentials.

  Imprimir `INVARIANTS E2E PASS` o `process.exit(1)`.

- [ ] Extender `cli/scripts/tui-sync-smoke.ts`: tras bind daemon, assert `(db.data as { hostname?: string }).hostname` truthy y `(db.data as { role?: string }).role === "primary"`.

- [ ] Correr:

```bash
bun test api/src/routes/ownership.test.ts
bun test api/src/ws/hub.test.ts
bun test api/src/lib/redact.test.ts
bun test cli/src/llm/history.test.ts
bun test cli/src/llm/timeline.test.ts
bun test cli/src/llm/turn-abort.test.ts
bun test cli/src/llm/redact.test.ts
bun test cli/src/llm/workspace-path.test.ts
bun test web/src/lib/timeline.test.ts
# API arriba:
bun run --filter @chavez/api test:invariants-auth
bun run --filter @chavez/api test:invariants
```

Esperado: todo PASS. Los escenarios Gherkin de `plan.md` quedan cubiertos por units + e2e.

- [ ] Commit:

```bash
git add api/scripts/e2e-invariants.ts api/scripts/e2e-helpers.ts \
  api/package.json cli/scripts/tui-sync-smoke.ts
git commit -m "test(invariants): cross-surface gherkin coverage"
```

---

## Mapa escenario → task

| Gherkin | Task |
|---|---|
| Misma cuenta (magic/password + device-code) | 1, 7 |
| Sin sesión → 401; ajeno → 404 | 1, 7 |
| Bearer CLI en hub de providers | 1 |
| TUI se registra como daemon y Web despacha | 2, 5 |
| Headless workspace open es daemon; first-wins; sin duplicar | 2, 7 |
| Cerrar daemon → no hidratar @ ni tools, error explícito | 2 |
| Hostname + path visibles; dos máquinas no se confunden | 2 |
| Crear session/chat en CLI aparece en TUI y Web | 3 |
| Append en Web aparece en TUI | 3 |
| Stream deltas en orden | 3, 7 |
| Recargar Web reconstruye timeline sin duplicar | 3 |
| Historial DB + prompt actual | 4 |
| Attaches del mensaje actual hidratados | 4 |
| Tools del turn actual no se re-ejecutan al reinyectar | 4 |
| Tools históricas = contexto, no invocaciones | 4 |
| Indicador busy TUI/Web | 5 |
| Cancelar turn Claude o Cursor | 5 |
| Conexiones listables (CLI connections / API) | 2, 5 |
| Attaches y tools no salen del workspace | 6 |
| Vault nunca al LLM ni a la timeline | 6, 7 |
| Output de tools se redacta si parece key | 6 |
| Web no recibe el filesystem completo | 6 |
