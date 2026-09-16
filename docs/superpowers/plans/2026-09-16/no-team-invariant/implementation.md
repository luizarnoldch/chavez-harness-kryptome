# No Team Invariant Implementation Plan

> **For agentic workers:** Execute task-by-task. Do not skip tests. Do not implement un producto de equipo, org, roles, invitaciones, workspaces compartidos de escritura, Cursor cloud, voz, extensión IDE, upload desde el navegador, notificaciones OS/email, cola de turns (plan 29), worktrees paralelos (plan 28), ni Cursor ejecutable (plan 4). Spec: [`plan.md`](./plan.md). Si un sibling (`invariants`, `export-share`, `git-workspace`, `agent-tools`) ya creó un archivo citado, **extiéndelo**; no lo reescribas. Esta fase **no** es una carpeta de features de equipo: congela la cuenta personal y cierra agujeros de aislamiento.

**Goal:** Un usuario Chavez = su vault, sus chats, sus daemons. No hay org ni roles de producto. No hay workspaces compartidos de escritura. El [link de solo lectura](../export-share/plan.md) (plan 23) **no** es membresía: quien lo abre ve el timeline y no puede `ask` ni ver vault. El token/sesión de A **no** abre PRs ni tools de B. Recurso ajeno → **404** (nunca 403 de “no eres miembro”). Sin sesión → **401**.

**Architecture:** El filesystem y las tools viven en el daemon de **un** usuario (`cli/src/ws/daemon.ts` o TUI con `clientKind: "daemon"`). La API es hub de esa cuenta: Better Auth (`session.user.id`), vault `provider_credentials` unique `(userId, provider)`, filas `workspaces` / `agent_sessions` / `chats` con `user_id` NOT NULL, `hub.findDaemon(userId, workspaceId)`. No existe tabla de miembros. El viewer de un share (si plan 23 aterrizó) entra por `GET /share/:token` **sin** sesión Better Auth.

```
Cookie Web / Bearer CLI  ──►  Better Auth session.user.id = A
                                      │
          ┌───────────────────────────┼────────────────────────────┐
          v                           v                            v
  HTTP WHERE user_id = A     WS hub.connection.userId = A    vault row.user_id = A
  workspaces/sessions/chats  findDaemon(A, workspaceIdA)     claude|cursor|github
          │                           │                            │
          │                           v                            v
          │                  agent.turn.dispatch ──► daemon A      git_pr PAT de A
          │                  chat.tool.*  (cwd de A)
          │
Share token (plan 23, 32 bytes)
          │
          v
  GET /share/:token     timeline pública + SHARE_READONLY_BANNER
          │             NO session Better Auth
          │             NO workspace.bind
          │             NO GET /providers/*/credentials
          │             NO agent.turn.request
          v
  Viewer B (cookie propia): GET /chats/:idA → 404
                            GET /providers/github/credentials → vault de B, nunca PAT de A
```

Estado actual que este plan extiende (no reescribir):

- `api/src/db/schema.ts`: tablas `user`, `session`, `account`, `verification`, `device_code`, `provider_credentials` (unique `userId+provider`), `user_preferences`, `workspaces` (unique `userId+path`), `agent_sessions`, `chats`, `chat_messages`. Columna `role` **solo** en `chat_messages` (user|assistant|system|tool). **Cero** `organization`, `member`, `invitation`, `team`, `workspace_members`. `session` **no** tiene `activeOrganizationId`.
- `api/src/auth.ts`: plugins `bearer` + `magicLink` + `deviceAuthorization`. **No** `organization()` ni `admin()` de Better Auth. `drizzleAdapter` schema: solo esas cinco tablas de auth.
- `api/src/routes/workspaces.ts` y `api/src/ws/handlers.ts`: filtros `eq(...userId, session.user.id)` / `userId` del upgrade WS. Recurso ajeno → `"Workspace not found"` / `"Session not found"` / `"Chat not found"`. Hueco a cerrar: `chat.list` no comprueba que la session sea del caller (devuelve `[]`); `chat.stream.error` no carga el chat. Nunca 403.
- `api/src/routes/providers.ts`: `GET/PUT/DELETE /:provider/credentials` filtra `eq(providerCredentials.userId, session.user.id)`. `ProviderId = "claude" | "cursor"`. Plan 7 añade `"github"` **en la misma tabla, mismo unique** — no una tabla de org. `GET` descifra el secret del **caller**.
- `api/src/ws/hub.ts`: `findDaemon` / `listForUser` / `broadcastToUser` / `countForWorkspace` filtran `c.userId`. `sendTo` es interno (la API lo llama tras `findDaemon`). El cliente **no** manda `userId` en `ClientMessage` (`api/src/ws/protocol.ts`).
- `cli/src/llm/publish-turn.ts`: `apiFetch("/providers")` y `GET /providers/claude/credentials` con el Bearer del daemon (`~/.chavez/config.json` / `CHAVEZ_ACCESS_TOKEN`). Plan 7 añade `GET /providers/github/credentials` con **el mismo** token de sesión — nunca el `userId` de un workspace ajeno.
- `cli/src/index.ts` usage: `login|logout|whoami|provider|tui|headless`. **No** `org|team|invite|members`.
- TUI `tui/src/App.tsx`: teclas `q` tab flechas `p` `[` `]` `{` `}` compose. **No** invitar.
- Web `web/src/layouts/BaseLayout.astro` nav: Hub, Device, Providers, Workspaces. **No** `/orgs` `/teams` `/invite` `/members`. `GET /me` → `{ user: { id, email, name } }` (`api/src/index.ts`). `web/src/lib/hooks.ts` `MeUser` igual.
- Share (plan 23): **no** hay `chat_share_links` ni `GET /share/:token` ni `web/src/pages/s/[token].astro` en este árbol. Esta fase congela el contrato: si el sibling aterrizó, el token **no** autentica; si no, `GET /share/:x` es 404 (ruta ausente ≠ membresía).
- Plan 5 (`invariants`) puede haber creado `api/src/ws/errors.ts` y `api/src/routes/ownership.ts`. Reusar strings y helpers. Si no existen, crearlos aquí **idénticos**.

**Tech Stack:** Bun, Better Auth (cookie + bearer + device-code; **sin** plugin `organization` / `admin`), Hono + Drizzle Postgres, WebSocket hub in-memory, Ink TUI, Astro/React web. Tests: `bun test`. E2E: `bun run scripts/e2e-no-team.ts` con API arriba. Sin paquete extra. Sin tabla nueva. Sin migración Drizzle. Sin 403 de membresía.

**Global Constraints:**

1. El filesystem real vive en el daemon (cwd del workspace). Esta fase **cero** `readdir` / hidratar `@` / `git` / `query()`. No mueve I/O al browser ni al server.
2. Un turn de agente solo corre si hay daemon bound al workspace **del mismo userId**. Sin daemon: el string existente `"No daemon bound for this workspace. Run: chavez headless workspace open"`. Esta fase no cambia ese texto. `findDaemon` **siempre** recibe el `userId` de la sesión, nunca un id del body.
3. Web, CLI `watch` y TUI ven el mismo chat **del dueño**. El viewer anónimo del share **no** tiene WS. Fan-out `broadcastToUser(userId)` no cruza a otro usuario.
4. Preferencias (`user_preferences`) son por `userId`. A no lee ni escribe las de B.
5. Claude es el provider ejecutable. Cursor vinculado no ejecuta turns aquí. El aislamiento de vault aplica igual a `claude`, `cursor` y `github` (si plan 7 aterrizó; si `Unknown provider`, 404 — nunca el secret de B).
6. Tools por defecto (read/write/edit/grep/glob/bash) corren en el daemon del **caller**. A no puede `chat.tool.start` / `agent.turn.request` / `workspace.git.pr` sobre un chat/workspace de B.
7. Lecturas no piden confirmación (no hay tools nuevas aquí). Write/edit/bash siguen el modo del dueño, no de un “rol de org”.
8. Aprobaciones una a una: no hay “siempre permitir para el equipo”. No hay lote entre usuarios.
9. 1 turn por daemon del **mismo** usuario. El daemon de B no es runner de A.
10. Un usuario = su vault. Sin org ni roles de producto. Link de solo lectura no es membresía. Recurso de otro user → **404** con el mismo body que un id inventado. El 404 **no** incluye emails ni ids ajenos. Nunca **403**.
11. El token de share **no** es un session token Better Auth: `Authorization: Bearer <shareToken>` → 401. `GET /ws?token=<shareToken>` → 401.
12. Fuera de alcance: producto de equipo, invitaciones, SSO de org, audit log multi-user, Cursor cloud, voz, extensión IDE, upload desde el navegador, notificaciones OS/email, GitHub Action.

**Constantes (congeladas, no inventar otras):**

| Nombre | Valor |
|---|---|
| `UNAUTHORIZED` | `"Unauthorized"` |
| `NOT_FOUND_WORKSPACE` | `"Workspace not found"` |
| `NOT_FOUND_SESSION` | `"Session not found"` |
| `NOT_FOUND_CHAT` | `"Chat not found"` |
| `SHARE_NOT_FOUND` | `"Share not found"` |
| `CREDENTIALS_NOT_LINKED` | `"Credentials not linked"` |
| `NO_DAEMON_ERROR` | `"No daemon bound for this workspace. Run: chavez headless workspace open"` |
| `SHARE_READONLY_BANNER` | `"Vista de solo lectura. No es un workspace compartido. No puedes enviar un turn ni ver el vault."` (bit-idéntico a plan 23) |
| `NO_TEAM_PRODUCT` | `"Chavez has no team product. One user = their vault, chats, and daemons."` |
| `SHARE_NOT_MEMBERSHIP` | `"A read-only share link is not membership"` |
| `CROSS_USER_DENIED` | (no se serializa; el caller ve 404) |
| `REDACT_REPLACEMENT` | `"***"` |
| `VAULT_GITHUB` | `"github"` (mismo literal que plan 7) |
| `OWNERSHIP_STATUS_FOREIGN` | `404` |
| `OWNERSHIP_STATUS_UNAUTH` | `401` |
| `FORBIDDEN_STATUS` | `403` — **prohibido** en respuestas de ownership |

Reusar `UNAUTHORIZED` / `NOT_FOUND_*` / `NO_DAEMON_ERROR` de `api/src/ws/errors.ts` si existe (plan 5). `SHARE_READONLY_BANNER` / `SHARE_NOT_FOUND` de `api/src/chats/export-share.ts` si existe (plan 23). Un solo string literal en runtime.

Tablas **permitidas** (freeze; añadir una de equipo es un fail del test):

```
user, session, account, verification, device_code,
provider_credentials, user_preferences,
workspaces, agent_sessions, chats, chat_messages
```

Plan 23 puede añadir `chat_share_links` (`chatId` + token; **sin** `userId` del viewer, **sin** `role`). Plan 6 puede añadir `turn_file_diffs`. Cualquier otra tabla cuyo nombre matchee el freeze de equipo **falla**.

Identificadores de tabla **prohibidos** (pgTable name o `export const`):

```
organization, organizations, member, members, invitation, invitations,
team, teams, team_member, team_members, workspace_member, workspace_members,
org, orgs, role, roles, membership, memberships
```

Columnas **prohibidas** en `user` / `session` / `workspaces` / `agent_sessions` / `chats` / `provider_credentials`:

```
org_id, organization_id, team_id, member_id, member_role,
workspace_role, active_organization_id, activeOrganizationId,
orgId, organizationId, teamId
```

`chat_messages.role` (user|assistant|system|tool) está **permitido**. `HubConnection.role` primary|standby|client del plan 5 es **permitido** (no es rol de org). `aria` `role="tablist"` en Web está **permitido**.

Rutas HTTP **prohibidas** (deben ser 404 de ruta ausente, **no** 401 de “org protegida”):

```
/orgs /organizations /teams /invites /invitations /members
/workspace-members /org /team /invite /memberships
```

Comandos CLI **prohibidos** (`case` en `cli/src/index.ts` y `headless.ts`):

```
org, team, invite, members, member, organization
```

Páginas Web **prohibidas**:

```
web/src/pages/orgs.astro
web/src/pages/orgs/**
web/src/pages/teams.astro
web/src/pages/teams/**
web/src/pages/invite.astro
web/src/pages/members.astro
web/src/pages/organizations/**
```

Tipos (congelados):

```ts
export const FORBIDDEN_TABLE_NAMES = [
  "organization",
  "organizations",
  "member",
  "members",
  "invitation",
  "invitations",
  "team",
  "teams",
  "team_member",
  "team_members",
  "workspace_member",
  "workspace_members",
  "org",
  "orgs",
  "role",
  "roles",
  "membership",
  "memberships",
] as const;

export const FORBIDDEN_COLUMN_NAMES = [
  "org_id",
  "organization_id",
  "team_id",
  "member_id",
  "member_role",
  "workspace_role",
  "active_organization_id",
  "activeOrganizationId",
  "orgId",
  "organizationId",
  "teamId",
] as const;

export const FORBIDDEN_HTTP_PATHS = [
  "/orgs",
  "/organizations",
  "/teams",
  "/invites",
  "/invitations",
  "/members",
  "/workspace-members",
  "/org",
  "/team",
  "/invite",
  "/memberships",
] as const;

export const ALLOWED_AUTH_PLUGIN_NEEDLES = [
  "bearer()",
  "magicLink(",
  "deviceAuthorization(",
] as const;

export const FORBIDDEN_AUTH_NEEDLES = [
  "organization(",
  "admin(",
  "organizationClient(",
  "activeOrganizationId",
] as const;

export type ForeignEntity = "workspace" | "session" | "chat";
```

Nombres de events WS (esta fase **no** añade tipos de equipo):

| Tipo | Semántica de aislamiento |
|---|---|
| `workspace.bind` | Lookup `(userId, path)`. Mismo path, otro user → **otra** fila, otro `id`. Nunca `workspaceId` del cliente sin ownership. |
| `session.create` / `session.list` | `userId` de la conexión. |
| `chat.create` / `chat.list` / `chat.get` / `chat.append` | Session/chat del caller. Ajeno → `"Chat not found"` / `"Session not found"`. |
| `chat.tool.start` / `chat.tool.result` / `agent.turn.request` | Igual. Ajeno → `"Chat not found"`. **No** despacha al daemon de B. |
| `workspace.git.*` (si plan 7 existe) | Ajeno → `"Workspace not found"` o `NO_DAEMON_ERROR`. **Nunca** PAT de B. |
| `chat.share.*` (si plan 23 existe) | Solo el dueño. Viewer usa HTTP público, no estos RPC. |

HTTP (contrato de aislamiento):

| Método | Ruta | A sobre recurso de A | B sobre recurso de A | Sin sesión |
|---|---|---|---|---|
| `GET` | `/me` | `{ user: { id, email, name } }` — **sin** `org`/`role` | n/a (es el user de B) | 401 |
| `GET` | `/workspaces` | solo filas de A | no lista path/id de A | 401 |
| `GET` | `/workspaces/:idA/sessions` | 200 | **404** `Workspace not found` | 401 |
| `GET` | `/sessions/:idA` | 200 | **404** `Session not found` | 401 |
| `GET` | `/chats/:idA` | 200 | **404** `Chat not found` | 401 |
| `GET` | `/providers` | vault de A (linked flags, **sin** secret) | vault de B, no el de A | 401 |
| `GET` | `/providers/:p/credentials` | secret de A | 404 `Credentials not linked` o secret de B si B vinculó el suyo — **nunca** el de A | 401 |
| `GET` | `/connections` | sockets de A | no incluye `connectionId` de A | 401 |
| `GET` | `/share/:token` | (plan 23) timeline pública | mismo payload público; **no** membresía | 200 público o 404 |
| `GET` | `/orgs` (y lista prohibida) | **404** ruta ausente | **404** | **404** (no 401) |

---

## Task 1: Freeze schema + auth — cero org, cero plugin de equipo

**Files:**

- Create: `api/src/lib/no-team.ts`
- Test: `api/src/lib/no-team.test.ts`
- Test: `api/src/db/schema-no-team.test.ts`
- Test: `api/src/auth-no-team.test.ts`
- Modify: `api/src/db/schema.ts`
- Modify: `api/src/auth.ts`
- Modify: `api/openapi/openapi.yaml`
- Modify: `api/package.json`

Cierra el escenario Gherkin “No hay roles ni workspaces compartidos de escritura” a nivel de modelo. No crea tablas. Si alguien añade `organization()` o `pgTable("member"`, estos tests fallan.

- [ ] Añadir `"test": "bun test"` en `api/package.json` `scripts` si no existe (dejar `dev`/`start`/`db:*`/`test:e2e` intactos).

- [ ] Crear `api/src/lib/no-team.ts`:

```ts
export const UNAUTHORIZED = "Unauthorized";
export const NOT_FOUND_WORKSPACE = "Workspace not found";
export const NOT_FOUND_SESSION = "Session not found";
export const NOT_FOUND_CHAT = "Chat not found";
export const SHARE_NOT_FOUND = "Share not found";
export const CREDENTIALS_NOT_LINKED = "Credentials not linked";
export const NO_DAEMON_ERROR =
  "No daemon bound for this workspace. Run: chavez headless workspace open";
export const SHARE_READONLY_BANNER =
  "Vista de solo lectura. No es un workspace compartido. No puedes enviar un turn ni ver el vault.";
export const NO_TEAM_PRODUCT =
  "Chavez has no team product. One user = their vault, chats, and daemons.";
export const SHARE_NOT_MEMBERSHIP =
  "A read-only share link is not membership";
export const OWNERSHIP_STATUS_FOREIGN = 404 as const;
export const OWNERSHIP_STATUS_UNAUTH = 401 as const;
export const FORBIDDEN_STATUS = 403 as const;

export const FORBIDDEN_TABLE_NAMES = [
  "organization",
  "organizations",
  "member",
  "members",
  "invitation",
  "invitations",
  "team",
  "teams",
  "team_member",
  "team_members",
  "workspace_member",
  "workspace_members",
  "org",
  "orgs",
  "role",
  "roles",
  "membership",
  "memberships",
] as const;

export const FORBIDDEN_COLUMN_NAMES = [
  "org_id",
  "organization_id",
  "team_id",
  "member_id",
  "member_role",
  "workspace_role",
  "active_organization_id",
  "activeOrganizationId",
  "orgId",
  "organizationId",
  "teamId",
] as const;

export const FORBIDDEN_HTTP_PATHS = [
  "/orgs",
  "/organizations",
  "/teams",
  "/invites",
  "/invitations",
  "/members",
  "/workspace-members",
  "/org",
  "/team",
  "/invite",
  "/memberships",
] as const;

export const FORBIDDEN_AUTH_NEEDLES = [
  "organization(",
  "admin(",
  "organizationClient(",
  "activeOrganizationId",
] as const;

export const ALLOWED_PG_TABLES = [
  "user",
  "session",
  "account",
  "verification",
  "device_code",
  "provider_credentials",
  "user_preferences",
  "workspaces",
  "agent_sessions",
  "chats",
  "chat_messages",
  "chat_share_links",
  "turn_file_diffs",
] as const;

export const ALLOWED_MESSAGE_ROLES = [
  "user",
  "assistant",
  "system",
  "tool",
] as const;

export function missingJson(entity: "workspace" | "session" | "chat" | "share") {
  const error =
    entity === "workspace"
      ? NOT_FOUND_WORKSPACE
      : entity === "session"
        ? NOT_FOUND_SESSION
        : entity === "share"
          ? SHARE_NOT_FOUND
          : NOT_FOUND_CHAT;
  return { error };
}

export function hasForbiddenTeamToken(text: string): boolean {
  for (const col of FORBIDDEN_COLUMN_NAMES) {
    if (text.includes(col)) return true;
  }
  return false;
}

export function pgTableNames(schemaSrc: string): string[] {
  const names: string[] = [];
  const re = /pgTable\(\s*["']([a-z0-9_]+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(schemaSrc))) names.push(m[1]!);
  return names;
}

export function assertNoForbiddenTables(schemaSrc: string): string[] {
  const found = pgTableNames(schemaSrc);
  return found.filter((n) =>
    (FORBIDDEN_TABLE_NAMES as readonly string[]).includes(n),
  );
}

export function extractBlock(src: string, exportName: string): string {
  const needle = `export const ${exportName}`;
  const start = src.indexOf(needle);
  if (start < 0) return "";
  const next = src.indexOf("export const ", start + needle.length);
  return next < 0 ? src.slice(start) : src.slice(start, next);
}
```

Si `api/src/ws/errors.ts` ya exporta `UNAUTHORIZED` / `NOT_FOUND_*` / `NO_DAEMON_ERROR`, en `no-team.ts` re-exportarlos:

```ts
export {
  UNAUTHORIZED,
  NOT_FOUND_WORKSPACE,
  NOT_FOUND_SESSION,
  NOT_FOUND_CHAT,
  NO_DAEMON_ERROR,
} from "../ws/errors";
```

y **borrar** las copias locales de esos cinco. `SHARE_*` / `NO_TEAM_PRODUCT` / listas forbidden se quedan en `no-team.ts`. Si `api/src/chats/export-share.ts` exporta `SHARE_READONLY_BANNER` / `SHARE_NOT_FOUND`, re-exportar esos dos desde export-share (un literal).

- [ ] Crear `api/src/lib/no-team.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  FORBIDDEN_STATUS,
  FORBIDDEN_TABLE_NAMES,
  OWNERSHIP_STATUS_FOREIGN,
  OWNERSHIP_STATUS_UNAUTH,
  SHARE_NOT_MEMBERSHIP,
  SHARE_READONLY_BANNER,
  UNAUTHORIZED,
  assertNoForbiddenTables,
  hasForbiddenTeamToken,
  missingJson,
  pgTableNames,
} from "./no-team";

describe("no-team constants", () => {
  test("ownership is 401/404 never 403", () => {
    expect(OWNERSHIP_STATUS_UNAUTH).toBe(401);
    expect(OWNERSHIP_STATUS_FOREIGN).toBe(404);
    expect(FORBIDDEN_STATUS).toBe(403);
    expect(UNAUTHORIZED).toBe("Unauthorized");
    expect(missingJson("workspace")).toEqual({ error: "Workspace not found" });
    expect(missingJson("session")).toEqual({ error: "Session not found" });
    expect(missingJson("chat")).toEqual({ error: "Chat not found" });
    expect(missingJson("share")).toEqual({ error: "Share not found" });
    expect(JSON.stringify(missingJson("chat"))).not.toMatch(/userId|@/);
  });

  test("share banner denies membership", () => {
    expect(SHARE_READONLY_BANNER).toContain("solo lectura");
    expect(SHARE_READONLY_BANNER).toContain("No es un workspace compartido");
    expect(SHARE_NOT_MEMBERSHIP).toContain("not membership");
  });

  test("pgTable scanner flags team tables", () => {
    const dirty = `export const member = pgTable("member", { id: text("id") });`;
    expect(assertNoForbiddenTables(dirty)).toEqual(["member"]);
    expect(pgTableNames(`pgTable("workspaces", {})`)).toEqual(["workspaces"]);
    expect(FORBIDDEN_TABLE_NAMES).toContain("organization");
  });

  test("column freeze", () => {
    expect(hasForbiddenTeamToken("activeOrganizationId")).toBe(true);
    expect(hasForbiddenTeamToken("user_id")).toBe(false);
  });
});
```

- [ ] Crear `api/src/db/schema-no-team.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ALLOWED_PG_TABLES,
  FORBIDDEN_COLUMN_NAMES,
  FORBIDDEN_TABLE_NAMES,
  assertNoForbiddenTables,
  extractBlock,
  pgTableNames,
} from "../lib/no-team";

const schemaSrc = readFileSync(
  join(import.meta.dir, "schema.ts"),
  "utf8",
);

describe("schema freeze: no org", () => {
  test("no forbidden pgTable names", () => {
    expect(assertNoForbiddenTables(schemaSrc)).toEqual([]);
    for (const name of FORBIDDEN_TABLE_NAMES) {
      expect(schemaSrc).not.toMatch(
        new RegExp(`pgTable\\(\\s*["']${name}["']`),
      );
    }
  });

  test("every pgTable is in the allowlist (siblings may add share/diffs)", () => {
    for (const name of pgTableNames(schemaSrc)) {
      expect(ALLOWED_PG_TABLES as readonly string[]).toContain(name);
    }
  });

  test("user/session/workspaces have no org columns or product role", () => {
    const user = extractBlock(schemaSrc, "user");
    const session = extractBlock(schemaSrc, "session");
    const workspaces = extractBlock(schemaSrc, "workspaces");
    for (const block of [user, session, workspaces]) {
      for (const col of FORBIDDEN_COLUMN_NAMES) {
        expect(block).not.toContain(col);
      }
    }
    expect(user).not.toMatch(/\brole\b/);
    expect(session).not.toMatch(/activeOrganizationId|organizationId/);
    expect(workspaces).not.toMatch(/\bmembers\b|\brole\b/);
  });

  test("chat_messages.role is the only role column and is a message role", () => {
    const messages = extractBlock(schemaSrc, "chatMessages");
    expect(messages).toMatch(/role: text\("role"\)/);
    expect(messages).toMatch(/user \| assistant \| system \| tool/);
  });

  test("vault and workspaces are keyed by userId not org", () => {
    expect(schemaSrc).toContain("provider_credentials_user_provider_uidx");
    expect(schemaSrc).toContain("workspaces_user_path_uidx");
    const creds = extractBlock(schemaSrc, "providerCredentials");
    expect(creds).toMatch(/userId: text\("user_id"\)/);
    expect(creds).not.toMatch(/org/i);
  });
});
```

- [ ] Crear `api/src/auth-no-team.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FORBIDDEN_AUTH_NEEDLES } from "./lib/no-team";

const authSrc = readFileSync(join(import.meta.dir, "auth.ts"), "utf8");

describe("auth freeze: no organization plugin", () => {
  test("does not import or register organization/admin", () => {
    for (const needle of FORBIDDEN_AUTH_NEEDLES) {
      expect(authSrc).not.toContain(needle);
    }
    expect(authSrc).toContain("bearer()");
    expect(authSrc).toContain("magicLink(");
    expect(authSrc).toContain("deviceAuthorization(");
  });

  test("drizzleAdapter schema is user/session/account/verification/deviceCode only", () => {
    const start = authSrc.indexOf("schema: {");
    const end = authSrc.indexOf("}", start);
    const block = authSrc.slice(start, end);
    expect(block).toContain("user:");
    expect(block).toContain("session:");
    expect(block).toContain("deviceCode:");
    expect(block).not.toMatch(/organization|member|invitation|team/i);
  });
});
```

- [ ] En `api/src/db/schema.ts`, encima de `export const user`, añadir **solo** este comentario (no nuevas columnas):

```ts
/** Single-user product: one Chavez user = their vault, chats, daemons.
 *  Forbidden: organization, member, invitation, team, workspace_members,
 *  org_id / role-on-user. chat_messages.role is a message role, not an org role.
 */
```

No tocar unique indexes. `workspaces_user_path_uidx` **permite** el mismo `path` para dos `userId` (dos cuentas, dos filas) — eso **no** es un workspace compartido.

- [ ] En `api/src/auth.ts`, encima de `plugins: [`, añadir:

```ts
  // Plan 33: do not add organization() or admin(). One user = one vault.
```

No registrar plugins nuevos.

- [ ] En `api/openapi/openapi.yaml`:

  - En `info.description`, añadir un párrafo: `Un usuario = su vault. Sin org ni roles. Recurso ajeno → 404. Link de solo lectura (si existe) no es membresía.`
  - `MeResponse.properties.user.properties` **solo** `id`, `email`, `name`. No añadir `role`, `orgId`, `organization`.
  - No crear paths `/orgs`, `/teams`, `/members`, `/invites`.
  - `ErrorBody` permanece `{ error: string }`.

- [ ] Correr:

```bash
cd api && bun test src/lib/no-team.test.ts src/db/schema-no-team.test.ts src/auth-no-team.test.ts
```

Esperado: PASS. Cero tablas/plugins de equipo.

- [ ] Commit:

```bash
git add api/src/lib/no-team.ts api/src/lib/no-team.test.ts \
  api/src/db/schema-no-team.test.ts api/src/auth-no-team.test.ts \
  api/src/db/schema.ts api/src/auth.ts api/openapi/openapi.yaml \
  api/package.json
git commit -m "test(no-team): freeze schema and auth without org"
```

---

## Task 2: Ownership HTTP + WS — 404 ajeno, nunca 403, hub no cruza userId

**Files:**

- Create: `api/src/routes/ownership.ts` (si plan 5 no lo creó; si existe, **extender**)
- Test: `api/src/routes/ownership.test.ts`
- Modify: `api/src/routes/workspaces.ts`
- Modify: `api/src/ws/handlers.ts`
- Modify: `api/src/ws/hub.ts`
- Test: `api/src/ws/hub.test.ts`
- Test: `api/src/ws/protocol-no-team.test.ts`
- Modify: `api/src/index.ts`

Cierra “No hay … workspaces compartidos de escritura” en runtime. Dos usuarios, mismo path de disco → dos filas. El token de B no escribe en las filas de A.

- [ ] Crear `api/src/routes/ownership.ts` (o fusionar con el de plan 5; mismas firmas):

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
  missingJson,
} from "../lib/no-team";

export { missingJson, NOT_FOUND_CHAT, NOT_FOUND_SESSION, NOT_FOUND_WORKSPACE };

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
```

Si plan 5 ya tiene este archivo, **añadir** `missingJson` importado desde `no-team.ts` (o dejar el local si es bit-idéntico) y no duplicar loaders.

- [ ] Crear o extender `api/src/routes/ownership.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { missingJson } from "./ownership";
import {
  FORBIDDEN_STATUS,
  NOT_FOUND_CHAT,
  NOT_FOUND_SESSION,
  NOT_FOUND_WORKSPACE,
  OWNERSHIP_STATUS_FOREIGN,
  UNAUTHORIZED,
} from "../lib/no-team";

describe("ownership errors", () => {
  test("foreign resource is 404 with a single error key", () => {
    expect(OWNERSHIP_STATUS_FOREIGN).not.toBe(FORBIDDEN_STATUS);
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

  test("unauthenticated string is Unauthorized not Forbidden", () => {
    expect(UNAUTHORIZED).toBe("Unauthorized");
    expect(UNAUTHORIZED).not.toBe("Forbidden");
  });
});
```

- [ ] En `api/src/routes/workspaces.ts`:

  1. Importar `loadOwnedWorkspace`, `loadOwnedSession`, `loadOwnedChat`, `missingJson`.
  2. Sustituir el select duplicado de `GET /:workspaceId/sessions` por `loadOwnedWorkspace`; si null → `c.json(missingJson("workspace"), 404)`.
  3. `GET /sessions/:sessionId` y `GET /sessions/:sessionId/chats`: `loadOwnedSession`; 404 `missingJson("session")`.
  4. `GET /chats/:chatId`: `loadOwnedChat`; 404 `missingJson("chat")`.
  5. **No** cambiar los 401 `if (!session)`.
  6. **No** devolver 403 en ningún branch.
  7. `GET /` sigue `eq(workspaces.userId, session.user.id)` — B no ve filas de A.

- [ ] En `api/src/index.ts` `/me` y `/me/password` y el upgrade `/ws`: usar `UNAUTHORIZED` importado (`c.json({ error: UNAUTHORIZED }, 401)` en HTTP; `c.text(UNAUTHORIZED, 401)` en WS). El texto permanece `"Unauthorized"`.

- [ ] En `api/src/ws/protocol.ts` **no** añadir `userId` / `orgId` / `memberId` a `ClientMessage`. El userId sale **solo** de `resolveWsUserId`.

- [ ] Crear `api/src/ws/protocol-no-team.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(import.meta.dir, "protocol.ts"), "utf8");
const handlers = readFileSync(join(import.meta.dir, "handlers.ts"), "utf8");

describe("WS protocol has no client-supplied userId", () => {
  test("ClientMessage type has no userId/orgId", () => {
    const block = src.slice(
      src.indexOf("export type ClientMessage"),
      src.indexOf("export type ServerMessage"),
    );
    expect(block).not.toMatch(/\buserId\b/);
    expect(block).not.toMatch(/\borgId\b|\borganizationId\b|\bteamId\b/);
  });

  test("handlers use connection userId not msg.userId", () => {
    expect(handlers).not.toContain("msg.userId");
    expect(handlers).toContain("handleWsMessage(");
    expect(handlers).toMatch(/userId: string/);
  });
});
```

- [ ] En `api/src/ws/handlers.ts`:

  1. Importar `loadOwnedChat` / `loadOwnedSession` (o dejar `loadChatForUser` si es la misma query; unificar a `loadOwnedChat`).
  2. `chat.list`: **antes** del select de chats, `loadOwnedSession(msg.sessionId, userId)`; si null → `fail(type, id, "Session not found")`. Hoy un sessionId ajeno devuelve `{ chats: [] }` — eso se cierra (sigue sin filtrar chats de A; ahora 404).
  3. `chat.stream.error`: `loadOwnedChat(msg.chatId, userId)`; si null → `fail(type, id, "Chat not found")`. No broadcast si el chat no es del caller.
  4. `chat.create` ya filtra session.userId — dejarlo.
  5. `agent.turn.request`: `workspaceIdForChat` ya usa `loadChatForUser` + session.userId. Dejar el `fail(..., NO_DAEMON_ERROR)` con el string existente. `hub.findDaemon(userId, ctx.workspaceId)` — **no** cambiar a `findDaemon(ctx.session.userId)` distinto del caller (son el mismo).
  6. `chat.tool.start` / `chat.tool.result` / `chat.get` / `chat.append` / streams: ya cargan el chat por userId. Dejar.
  7. `workspace.bind`: lookup `eq(workspaces.userId, userId)` + `eq(workspaces.path, path)`. **Prohibido** aceptar `msg.workspaceId` para unirse a la fila de otro user. Si un sibling ya añadió `workspaceId` opcional, resolverlo con `loadOwnedWorkspace(msg.workspaceId, userId)` o ignorarlo.

- [ ] En `api/src/ws/hub.ts`, no cambiar la firma de `findDaemon(userId, workspaceId)`. Añadir encima del objeto `hub`:

```ts
/** Isolation: every lookup takes userId from the Better Auth session.
 *  Never find a daemon / broadcast across users. Plan 33. */
```

`broadcastToUser` ya hace `if (c.userId !== userId) continue`. Dejarlo.

- [ ] Crear o extender `api/src/ws/hub.test.ts`. Mock `{ send: () => {} } as unknown as WSContext`. Cubrir:

```ts
import { describe, expect, test } from "bun:test";
import type { WSContext } from "hono/ws";
import { hub } from "./hub";

function mockWs(sent: unknown[] = []): WSContext {
  return {
    send: (data: string) => {
      sent.push(JSON.parse(data));
    },
  } as unknown as WSContext;
}

describe("hub user isolation", () => {
  test("findDaemon does not return another user's daemon", () => {
    const sentA: unknown[] = [];
    const sentB: unknown[] = [];
    hub.add({
      connectionId: "ca",
      userId: "user-a",
      workspaceId: "ws-shared-id",
      ws: mockWs(sentA),
      clientKind: "daemon",
    });
    hub.add({
      connectionId: "cb",
      userId: "user-b",
      workspaceId: "ws-shared-id",
      ws: mockWs(sentB),
      clientKind: "daemon",
    });
    expect(hub.findDaemon("user-a", "ws-shared-id")?.connectionId).toBe("ca");
    expect(hub.findDaemon("user-b", "ws-shared-id")?.connectionId).toBe("cb");
    expect(hub.findDaemon("user-a", "ws-of-b")).toBeNull();
    hub.broadcastToUser("user-a", hub.pushEvent("x", { n: 1 }));
    expect(sentA.length).toBe(1);
    expect(sentB.length).toBe(0);
    expect(hub.listForUser("user-a").map((c) => c.connectionId)).toEqual(["ca"]);
    hub.remove("ca");
    hub.remove("cb");
  });
});
```

Si `hub.add` exige más campos (`path`, `connectedAt`), pasarlos (`path: "/tmp/a"`, omitir `connectedAt` si tiene default). Si el test de plan 5 ya cubre first-wins, **añadir** este caso de dos `userId`, no borrar el otro.

- [ ] Correr:

```bash
cd api && bun test src/routes/ownership.test.ts src/ws/hub.test.ts src/ws/protocol-no-team.test.ts
```

Esperado: PASS. `findDaemon` no cruza usuarios. Protocolo sin `userId` en el mensaje.

- [ ] Commit:

```bash
git add api/src/routes/ownership.ts api/src/routes/ownership.test.ts \
  api/src/routes/workspaces.ts api/src/ws/handlers.ts api/src/ws/hub.ts \
  api/src/ws/hub.test.ts api/src/ws/protocol-no-team.test.ts api/src/index.ts \
  api/src/ws/protocol.ts
git commit -m "fix(no-team): ownership 404 and hub isolation"
```

---

## Task 3: Link de solo lectura no es membresía

**Files:**

- Create: `api/src/lib/share-not-membership.ts`
- Test: `api/src/lib/share-not-membership.test.ts`
- Modify: `api/src/index.ts` (solo si `GET /share/:token` ya existe; si no, no crear la ruta)
- Modify: `api/src/chats/export-share.ts` (si existe)
- Modify: `web/src/pages/s/[token].astro` (si existe)
- Test: `web/src/lib/share-not-membership.test.ts`

Cierra el escenario “Link de solo lectura (plan 23) no es membresía”. **No** implementa export/share (eso es plan 23). Congela: el token no crea session, no añade al workspace, no abre vault, no dispara `ask`.

- [ ] Crear `api/src/lib/share-not-membership.ts`:

```ts
import {
  SHARE_NOT_MEMBERSHIP,
  SHARE_READONLY_BANNER,
} from "./no-team";

export { SHARE_NOT_MEMBERSHIP, SHARE_READONLY_BANNER };

const VAULT_KEYS = [
  "ciphertext",
  "secret",
  "api_key",
  "accessToken",
  "access_token",
  "password",
] as const;

export function sharePayloadLeaksVault(payload: unknown): boolean {
  const raw = JSON.stringify(payload);
  for (const k of VAULT_KEYS) {
    if (raw.includes(`"${k}"`)) return true;
  }
  return false;
}

export function sharePayloadLooksLikeMembership(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const o = payload as Record<string, unknown>;
  if ("members" in o || "role" in o || "orgId" in o) return true;
  if ("workspaceId" in o || "userId" in o) return true;
  if (typeof o.banner === "string" && o.banner === SHARE_READONLY_BANNER) {
    return false;
  }
  return false;
}

export function assertPublicShareView(payload: unknown): void {
  if (sharePayloadLeaksVault(payload)) {
    throw new Error("share payload must not include vault keys");
  }
  if (sharePayloadLooksLikeMembership(payload)) {
    throw new Error(SHARE_NOT_MEMBERSHIP);
  }
  const o = payload as { banner?: string };
  if (o && typeof o === "object" && "banner" in o) {
    if (o.banner !== SHARE_READONLY_BANNER) {
      throw new Error("share banner mismatch");
    }
  }
}

/** Share tokens never authenticate. A 32-byte hex is not a Better Auth session. */
export function shareTokenMustNotBeSession(): true {
  return true;
}
```

- [ ] Crear `api/src/lib/share-not-membership.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SHARE_READONLY_BANNER,
  SHARE_NOT_FOUND,
} from "./no-team";
import {
  assertPublicShareView,
  sharePayloadLeaksVault,
  sharePayloadLooksLikeMembership,
} from "./share-not-membership";

describe("share is not membership", () => {
  test("public view rejects vault and membership fields", () => {
    expect(
      sharePayloadLeaksVault({ title: "x", secret: "sk-ant-x" }),
    ).toBe(true);
    expect(
      sharePayloadLooksLikeMembership({
        title: "x",
        userId: "u-a",
        banner: SHARE_READONLY_BANNER,
      }),
    ).toBe(true);
    expect(() =>
      assertPublicShareView({
        title: "Fix",
        createdAt: "2026-09-16T00:00:00.000Z",
        messages: [],
        banner: SHARE_READONLY_BANNER,
      }),
    ).not.toThrow();
  });

  test("banner constant matches plan 23 if that module exists", () => {
    const p = join(import.meta.dir, "../chats/export-share.ts");
    if (!existsSync(p)) return;
    const src = readFileSync(p, "utf8");
    expect(src).toContain(SHARE_READONLY_BANNER);
    expect(src).toContain(SHARE_NOT_FOUND);
    expect(src).toContain("No es un workspace compartido");
  });
});
```

- [ ] Si `GET /share/:token` **ya existe** en `api/src/index.ts` o `api/src/routes/workspaces.ts` (plan 23):

  1. Tras armar el JSON, llamar `assertPublicShareView(body)` **antes** de `c.json`.
  2. La ruta **no** llama `requireSession`. Un `Authorization` presente **no** convierte al viewer en miembro: sigue el mismo payload; `GET /chats/:id` del chat dueño con esa cookie (si es B) sigue 404.
  3. **Prohibido** `auth.api.getSession` → `insert workspace_members`. No hay esa tabla.
  4. **Prohibido** set-cookie de sesión al abrir el link.
  5. Token revocado o inventado → `c.json(missingJson("share"), 404)` — mismo body que “nunca existió”.

  Si la ruta **no** existe, **no la crees**. El e2e de Task 6 trata 404 como “no membresía”.

- [ ] Si `web/src/pages/s/[token].astro` existe: debe pintar `SHARE_READONLY_BANNER` y **no** importar el compositor de `ChatDetailPanel` (`agent.turn.request`). No añadir input de ask. Si el archivo no existe, no lo crees.

- [ ] Crear `web/src/lib/share-not-membership.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SHARE_READONLY_BANNER =
  "Vista de solo lectura. No es un workspace compartido. No puedes enviar un turn ni ver el vault.";

describe("web share page is not a team workspace", () => {
  test("no org/invite pages", () => {
    const pages = join(import.meta.dir, "../pages");
    for (const rel of [
      "orgs.astro",
      "teams.astro",
      "invite.astro",
      "members.astro",
      "organizations.astro",
    ]) {
      expect(existsSync(join(pages, rel))).toBe(false);
    }
  });

  test("share viewer has no ask and no vault if present", () => {
    const p = join(import.meta.dir, "../pages/s/[token].astro");
    if (!existsSync(p)) return;
    const src = readFileSync(p, "utf8");
    expect(src).toContain(SHARE_READONLY_BANNER);
    expect(src).not.toContain("agent.turn.request");
    expect(src).not.toContain("/providers/");
  });
});
```

Añadir `"test": "bun test"` en `web/package.json` `scripts` si no existe (dejar `dev`/`build`/`preview`/`start`).

- [ ] Correr:

```bash
cd api && bun test src/lib/share-not-membership.test.ts
cd ../web && bun test src/lib/share-not-membership.test.ts
```

Esperado: PASS. Sin páginas de org. Banner niega membresía.

- [ ] Commit:

```bash
git add api/src/lib/share-not-membership.ts \
  api/src/lib/share-not-membership.test.ts \
  web/src/lib/share-not-membership.test.ts web/package.json
# más api/src/index.ts web/src/pages/s/[token].astro api/src/chats/export-share.ts
# solo si el sibling ya los tenía y se extendieron
git commit -m "test(no-team): share link is not membership"
```

---

## Task 4: Token de A no abre vault, PRs ni tools de B

**Files:**

- Modify: `api/src/routes/providers.ts`
- Create: `api/src/routes/vault-ownership.ts`
- Test: `api/src/routes/vault-ownership.test.ts`
- Modify: `cli/src/llm/publish-turn.ts`
- Test: `cli/src/llm/vault-token.test.ts`
- Modify: `cli/package.json`
- Modify: `cli/src/ws/daemon.ts`

Cierra “El token de A no abre PRs ni tools de B”. El PAT de GitHub y el secret de Claude/Cursor se resuelven con la **sesión del proceso daemon**, no con el `userId` de un workspace en el body.

- [ ] Crear `api/src/routes/vault-ownership.ts`:

```ts
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { providerCredentials } from "../db/schema";
import { CREDENTIALS_NOT_LINKED } from "../lib/no-team";

export { CREDENTIALS_NOT_LINKED };

export async function loadOwnedCredential(
  userId: string,
  provider: string,
) {
  const rows = await db
    .select()
    .from(providerCredentials)
    .where(
      and(
        eq(providerCredentials.userId, userId),
        eq(providerCredentials.provider, provider),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export function credentialsMissingJson() {
  return { error: CREDENTIALS_NOT_LINKED };
}
```

- [ ] En `api/src/routes/providers.ts` `GET/DELETE /:provider/credentials` (y el find de `PUT`): sustituir el `select` + `existing.find` por `loadOwnedCredential(session.user.id, providerParam)`. **Nunca** `loadOwnedCredential(body.userId, …)` ni `c.req.query("userId")`. El unique `(userId, provider)` impide que A overwrite el row de B: el `PUT` inserta/actualiza **solo** la fila del caller.

  Dejar `isProvider` como está (`claude` | `cursor`). Si plan 7 ya acepta `github`, `loadOwnedCredential` funciona igual — no tocar `PUT /providers/active` (sigue rechazando github).

- [ ] Crear `api/src/routes/vault-ownership.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CREDENTIALS_NOT_LINKED } from "../lib/no-team";
import { credentialsMissingJson } from "./vault-ownership";

const providersSrc = readFileSync(
  join(import.meta.dir, "providers.ts"),
  "utf8",
);

describe("vault is per session user", () => {
  test("missing credentials body", () => {
    expect(credentialsMissingJson()).toEqual({
      error: CREDENTIALS_NOT_LINKED,
    });
  });

  test("providers route does not take a foreign userId", () => {
    expect(providersSrc).toContain("loadOwnedCredential");
    expect(providersSrc).not.toMatch(
      /loadOwnedCredential\(\s*(body|msg|c\.req)\./,
    );
    expect(providersSrc).toContain("session.user.id");
  });
});
```

- [ ] En `cli/src/llm/publish-turn.ts`, extraer (o dejar junto al `getGitHubToken` de plan 7 si ya está):

```ts
export async function loadSessionVaultSecret(
  provider: "claude" | "cursor" | "github",
  sessionToken?: string,
): Promise<string | null> {
  try {
    const creds = await apiFetch<{ secret: string }>(
      `/providers/${provider}/credentials`,
      {},
      sessionToken,
    );
    return creds.secret || null;
  } catch {
    return null;
  }
}
```

Usarlo para Claude (el `apiFetch` actual de `/providers/claude/credentials`) y, si plan 7 añadió `getGitHubToken`, que sea:

```ts
async function getGitHubToken(token?: string): Promise<string | null> {
  return loadSessionVaultSecret("github", token);
}
```

**Prohibido** `loadSessionVaultSecret("github", ownerUserId)`. El tercer argumento es Bearer, no un id.

El `token` que llega a `publishAgentTurn` es el del daemon (`config.accessToken` / argumento). `cli/src/ws/daemon.ts` **no** lee un userId del dispatch para ir al vault: sigue usando `loadConfig().accessToken`. Si el payload de `agent.turn.dispatch` trae `userId`, **ignorarlo**.

- [ ] En `cli/src/ws/daemon.ts`, en el `onPush` de `agent.turn.dispatch`, documentar con un comentario junto a `publishAgentTurn`:

```ts
  // Vault + tools run as this daemon's logged-in user (config.accessToken).
  // Ignore any userId on the dispatch payload — plan 33.
```

Pasar `token: config.accessToken` a `publishAgentTurn` si aún no se pasa (hoy el parámetro existe). No usar `data.userId`.

- [ ] Añadir `"test": "bun test"` en `cli/package.json` `scripts` si no existe.

- [ ] Crear `cli/src/llm/vault-token.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const publish = readFileSync(
  join(import.meta.dir, "publish-turn.ts"),
  "utf8",
);
const daemon = readFileSync(
  join(import.meta.dir, "../ws/daemon.ts"),
  "utf8",
);

describe("daemon vault uses session token not foreign userId", () => {
  test("publish-turn credentials path is /providers/:p/credentials", () => {
    expect(publish).toMatch(/\/providers\/\$\{provider\}\/credentials|\/providers\/claude\/credentials/);
    expect(publish).not.toMatch(/\/providers\/.*\?userId/);
    expect(publish).toContain("loadSessionVaultSecret");
  });

  test("daemon does not pass dispatch userId into the vault", () => {
    expect(daemon).not.toMatch(/publishAgentTurn\([\s\S]*userId:\s*data\.userId/);
    expect(daemon).toContain("accessToken");
  });
});
```

Si el rename a `loadSessionVaultSecret` se omite porque plan 7 ya tiene `getGitHubToken` con la misma firma `(token?: string)`, el test de publish-turn acepta **o** `loadSessionVaultSecret` **o** `getGitHubToken` — en ese caso cambiar el expect a:

```ts
expect(publish).toMatch(/loadSessionVaultSecret|getGitHubToken|\/providers\/claude\/credentials/);
```

y exigir que `getGitHubToken` / fetch de credentials reciba `token` (Bearer), no un id. El archivo `publish-turn.ts` debe contener `sessionToken` o el tercer arg de `apiFetch(..., {}, token)`.

- [ ] Correr:

```bash
cd api && bun test src/routes/vault-ownership.test.ts
cd ../cli && bun test src/llm/vault-token.test.ts
```

Esperado: PASS. Credentials siempre por `session.user.id`. Daemon no impersona.

- [ ] Commit:

```bash
git add api/src/routes/vault-ownership.ts api/src/routes/vault-ownership.test.ts \
  api/src/routes/providers.ts cli/src/llm/publish-turn.ts \
  cli/src/llm/vault-token.test.ts cli/src/ws/daemon.ts cli/package.json
git commit -m "fix(no-team): vault and tools stay on the session user"
```

---

## Task 5: Superficies Web / CLI / TUI sin producto de equipo

**Files:**

- Modify: `cli/src/index.ts`
- Test: `cli/src/no-team-cli.test.ts`
- Modify: `cli/src/commands/headless.ts`
- Modify: `cli/src/commands/whoami.ts`
- Modify: `tui/src/App.tsx`
- Test: `tui/src/no-team-tui.test.ts`
- Modify: `tui/package.json`
- Modify: `web/src/layouts/BaseLayout.astro`
- Modify: `web/src/components/NavAuth.tsx`
- Modify: `web/src/components/HubPanel.tsx`
- Test: `web/src/no-team-ui.test.ts`
- Modify: `web/src/lib/hooks.ts`

Cierra la parte visible: ninguna superficie ofrece org, roles, invitaciones ni “workspace compartido” de escritura. El link de share (si existe) se etiqueta de solo lectura.

- [ ] En `cli/src/index.ts` `usage()`, **no** añadir comandos `org|team|invite|members`. Encima del `switch (cmd)`, no hay default que enrute a un módulo de equipo. Dejar el `default` actual (`Comando desconocido` + `usage(1)`).

- [ ] En `cli/src/commands/whoami.ts`, el JSON de `/me` se imprime `User` / `Name` / id. **No** imprimir `org` / `role`. Si el body trajera `organization` (regresión), ignorarlo: tipar `{ user: { id, email, name } }` como ahora.

- [ ] En `cli/src/commands/headless.ts`, el router de subcomandos **no** gana `org` / `share-team` / `invite`. `chat share` (plan 23) es del dueño sobre **su** chat — permitido cuando ese sibling aterrice; no es membresía.

- [ ] Crear `cli/src/no-team-cli.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const indexSrc = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
const headlessSrc = readFileSync(
  join(import.meta.dir, "commands/headless.ts"),
  "utf8",
);
const whoamiSrc = readFileSync(
  join(import.meta.dir, "commands/whoami.ts"),
  "utf8",
);

describe("CLI has no team product", () => {
  test("no org/team/invite commands", () => {
    for (const cmd of ["org", "team", "invite", "members", "organization"]) {
      expect(indexSrc).not.toContain(`case "${cmd}"`);
      expect(indexSrc).not.toContain(`chavez ${cmd}`);
    }
    expect(indexSrc).toContain("chavez login");
    expect(indexSrc).toContain("chavez whoami");
  });

  test("headless has no member router", () => {
    expect(headlessSrc).not.toMatch(/case ["']org["']|case ["']invite["']/);
  });

  test("whoami is a single user", () => {
    expect(whoamiSrc).toContain("me.user.email");
    expect(whoamiSrc).not.toMatch(/organization|orgId|memberRole/);
  });
});
```

- [ ] En `tui/src/App.tsx`: **no** añadir tecla de invitar ni panel “miembros”. El header sigue siendo cwd + cuenta implícita (token). Si hay un overlay de share (tecla `E` del plan 23), el copy debe incluir que no es workspace compartido — no implementar E aquí.

- [ ] Añadir `"test": "bun test"` en `tui/package.json` `scripts` si no existe.

- [ ] Crear `tui/src/no-team-tui.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const app = readFileSync(join(import.meta.dir, "App.tsx"), "utf8");

describe("TUI has no team surface", () => {
  test("no invite/org copy or keys", () => {
    expect(app).not.toMatch(/invitar|invite teammate|team workspace|miembros del workspace/i);
    expect(app).not.toContain('ch === "I"');
    expect(app).not.toContain("organizationId");
  });
});
```

- [ ] En `web/src/layouts/BaseLayout.astro` nav: Hub, Device, Providers, Workspaces (y API docs). **No** links a `/orgs`, `/teams`, `/invite`, `/members`.

- [ ] En `web/src/components/NavAuth.tsx`: muestra `me.data.email` y Salir. **No** selector de org. **No** badge de rol.

- [ ] En `web/src/components/HubPanel.tsx`: copy de consola personal. **No** “tu equipo”. Dejar el texto actual de paridad API/CLI/TUI.

- [ ] En `web/src/lib/hooks.ts` `MeUser`: `{ id: string; email: string; name?: string }`. **No** añadir `role` ni `orgId`. (`ChatMessage.role` se queda — es el rol del mensaje.)

- [ ] Crear `web/src/no-team-ui.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const layout = readFileSync(
  join(import.meta.dir, "layouts/BaseLayout.astro"),
  "utf8",
);
const hooks = readFileSync(join(import.meta.dir, "lib/hooks.ts"), "utf8");
const nav = readFileSync(
  join(import.meta.dir, "components/NavAuth.tsx"),
  "utf8",
);

describe("web has no team product", () => {
  test("nav has no org links", () => {
    expect(layout).toContain('href="/workspaces"');
    expect(layout).toContain('href="/providers"');
    expect(layout).not.toContain('href="/orgs"');
    expect(layout).not.toContain('href="/teams"');
    expect(layout).not.toContain('href="/invite"');
    expect(layout).not.toContain('href="/members"');
  });

  test("MeUser is a person not a member", () => {
    const block = hooks.slice(
      hooks.indexOf("export type MeUser"),
      hooks.indexOf("export type EffortLevel"),
    );
    expect(block).toContain("id: string");
    expect(block).toContain("email: string");
    expect(block).not.toMatch(/\brole\b|\borgId\b|\borganization\b/);
    expect(nav).toContain("me.data.email");
    expect(nav).not.toMatch(/org|invite/i);
  });

  test("forbidden pages absent", () => {
    const pages = join(import.meta.dir, "pages");
    expect(existsSync(join(pages, "orgs.astro"))).toBe(false);
    expect(existsSync(join(pages, "teams.astro"))).toBe(false);
    expect(existsSync(join(pages, "invite.astro"))).toBe(false);
    expect(existsSync(join(pages, "members.astro"))).toBe(false);
  });
});
```

- [ ] Correr:

```bash
cd cli && bun test src/no-team-cli.test.ts
cd ../tui && bun test src/no-team-tui.test.ts
cd ../web && bun test src/no-team-ui.test.ts src/lib/share-not-membership.test.ts
```

Esperado: PASS. Ninguna superficie enseña org/roles/invitar.

- [ ] Commit:

```bash
git add cli/src/index.ts cli/src/no-team-cli.test.ts \
  cli/src/commands/headless.ts cli/src/commands/whoami.ts \
  tui/src/App.tsx tui/src/no-team-tui.test.ts tui/package.json \
  web/src/layouts/BaseLayout.astro web/src/components/NavAuth.tsx \
  web/src/components/HubPanel.tsx web/src/lib/hooks.ts \
  web/src/no-team-ui.test.ts
git commit -m "test(no-team): web cli tui have no team surface"
```

---

## Task 6: E2E dos usuarios — los tres escenarios Gherkin

**Files:**

- Create: `api/scripts/e2e-no-team.ts`
- Modify: `api/package.json`

Demuestra en caliente: (1) no hay roles ni workspaces compartidos de escritura, (2) el link de solo lectura no es membresía, (3) el token de A no abre PRs ni tools de B. Requiere API arriba (`CHAVEZ_API_URL`, default `http://localhost:25001`). Reusar el patrón de `api/scripts/e2e-phase1.ts` (`cookieFromResponse`, sign-up email+password). `process.exit(1)` si cualquier assert falla. Al final imprimir `NO-TEAM INVARIANT PASS`.

- [ ] Añadir en `api/package.json` `scripts`: `"test:no-team": "bun run scripts/e2e-no-team.ts"` (dejar `test:e2e` intacto).

- [ ] Crear `api/scripts/e2e-no-team.ts` con este cuerpo (completo, sin huecos):

```ts
/**
 * Plan 33 — no org / no membership / cross-user vault isolation.
 * Run with API up: bun run scripts/e2e-no-team.ts
 */
import {
  CREDENTIALS_NOT_LINKED,
  FORBIDDEN_HTTP_PATHS,
  FORBIDDEN_STATUS,
  NOT_FOUND_CHAT,
  NOT_FOUND_SESSION,
  NOT_FOUND_WORKSPACE,
  SHARE_NOT_FOUND,
  SHARE_READONLY_BANNER,
  UNAUTHORIZED,
} from "../src/lib/no-team";

const API = process.env.CHAVEZ_API_URL || "http://localhost:25001";
const PASSWORD = "test-pass-12345";
const stamp = Date.now();

function cookieFromResponse(res: Response): string {
  const setCookie = res.headers.getSetCookie?.() ?? [];
  const joined = setCookie.map((c) => c.split(";")[0]).join("; ");
  if (joined) return joined;
  const single = res.headers.get("set-cookie");
  if (!single) throw new Error("no Set-Cookie in response");
  return single.split(";")[0]!;
}

function bearerFromCookie(cookie: string): string {
  const part = cookie
    .split(";")
    .map((s) => s.trim())
    .find((s) => s.toLowerCase().includes("session_token="));
  if (!part) throw new Error("no session_token in cookie");
  const raw = part.slice(part.indexOf("=") + 1);
  return decodeURIComponent(raw);
}

async function signUp(email: string, name: string) {
  const res = await fetch(`${API}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", Origin: API },
    body: JSON.stringify({ email, password: PASSWORD, name }),
  });
  if (!res.ok) throw new Error(`sign-up ${email} ${res.status} ${await res.text()}`);
  const cookie = cookieFromResponse(res);
  const meRes = await fetch(`${API}/me`, { headers: { cookie } });
  if (!meRes.ok) throw new Error(`/me ${meRes.status}`);
  const me = (await meRes.json()) as {
    user: { id: string; email: string; name: string; role?: unknown; orgId?: unknown };
  };
  if (me.user.role !== undefined || me.user.orgId !== undefined) {
    throw new Error("/me leaked org role");
  }
  if (!me.user.id || me.user.email !== email) throw new Error("bad /me");
  return { cookie, bearer: bearerFromCookie(cookie), me: me.user };
}

async function json(
  path: string,
  init: RequestInit & { cookie?: string; bearer?: string } = {},
) {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.bearer) headers.set("Authorization", `Bearer ${init.bearer}`);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const res = await fetch(`${API}${path}`, { ...init, headers });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data, text, setCookie: res.headers.getSetCookie?.() ?? [] };
}

type WsReply = { type: string; id: string; ok: boolean; data?: unknown; error?: string };

async function withWs<T>(
  bearer: string,
  fn: (rpc: (payload: Record<string, unknown>) => Promise<WsReply>) => Promise<T>,
): Promise<T> {
  const url = `${API.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(bearer)}`;
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("ws timeout")), 10_000);
    ws.addEventListener("open", () => {
      clearTimeout(t);
      resolve();
    });
    ws.addEventListener("error", () => {
      clearTimeout(t);
      reject(new Error("ws error"));
    });
  });
  const pending = new Map<string, (v: WsReply) => void>();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(String(ev.data)) as WsReply & { push?: boolean };
    if (msg.push) return;
    const wait = pending.get(msg.id);
    if (wait) wait(msg);
  });
  const rpc = (payload: Record<string, unknown>) =>
    new Promise<WsReply>((resolve, reject) => {
      const id = crypto.randomUUID();
      pending.set(id, resolve);
      ws.send(JSON.stringify({ ...payload, id }));
      setTimeout(() => reject(new Error(`rpc timeout ${payload.type}`)), 10_000);
    });
  try {
    return await fn(rpc);
  } finally {
    ws.close();
  }
}

function expectStatus(label: string, got: number, want: number) {
  if (got !== want) throw new Error(`${label}: status ${got} want ${want}`);
}

function expectError(label: string, data: unknown, error: string) {
  const body = data as { error?: string };
  if (!body || body.error !== error) {
    throw new Error(`${label}: body ${JSON.stringify(data)} want error=${error}`);
  }
  if (JSON.stringify(data).includes("userId")) {
    throw new Error(`${label}: 404 leaked userId`);
  }
}

async function main() {
  console.log("0) forbidden team routes are absent (404 not 401/403)");
  for (const path of FORBIDDEN_HTTP_PATHS) {
    const r = await json(path);
    if (r.status !== 404) {
      throw new Error(`${path} status ${r.status} — team route must not exist`);
    }
    if (r.status === FORBIDDEN_STATUS) {
      throw new Error(`${path} returned 403 — membership must not exist`);
    }
  }

  console.log("1) sign-up A and B");
  const A = await signUp(`e2e-nta-${stamp}@chavez.dev`, "NoTeam A");
  const B = await signUp(`e2e-ntb-${stamp}@chavez.dev`, "NoTeam B");
  if (A.me.id === B.me.id) throw new Error("A and B are the same user");

  const unauth = await json("/me");
  expectStatus("GET /me unauth", unauth.status, 401);
  expectError("GET /me unauth", unauth.data, UNAUTHORIZED);

  console.log("2) vault isolation (claude always; github if linked)");
  const putA = await json("/providers/claude/credentials", {
    method: "PUT",
    cookie: A.cookie,
    body: JSON.stringify({ authKind: "api_key", secret: "sk-ant-USER-A-SECRET" }),
  });
  expectStatus("PUT claude A", putA.status, 200);

  const putB = await json("/providers/claude/credentials", {
    method: "PUT",
    cookie: B.cookie,
    body: JSON.stringify({ authKind: "api_key", secret: "sk-ant-USER-B-SECRET" }),
  });
  expectStatus("PUT claude B", putB.status, 200);

  const credA = await json("/providers/claude/credentials", { cookie: A.cookie });
  const credBviaA = await json("/providers/claude/credentials", { cookie: B.cookie });
  const secretA = (credA.data as { secret?: string }).secret;
  const secretB = (credBviaA.data as { secret?: string }).secret;
  if (secretA !== "sk-ant-USER-A-SECRET") throw new Error("A vault mismatch");
  if (secretB !== "sk-ant-USER-B-SECRET") throw new Error("B vault mismatch");
  if (secretB === secretA) throw new Error("B received A's secret");

  const credAwithB = await json("/providers/claude/credentials", {
    bearer: B.bearer,
  });
  const s = (credAwithB.data as { secret?: string }).secret;
  if (s === "sk-ant-USER-A-SECRET") {
    throw new Error("Bearer B opened Claude vault of A");
  }

  const ghA = await json("/providers/github/credentials", {
    method: "PUT",
    cookie: A.cookie,
    body: JSON.stringify({ authKind: "api_key", secret: "ghp_USER_A_PAT_VALUE" }),
  });
  const ghB = await json("/providers/github/credentials", {
    method: "PUT",
    cookie: B.cookie,
    body: JSON.stringify({ authKind: "api_key", secret: "ghp_USER_B_PAT_VALUE" }),
  });
  if (ghA.status === 200 && ghB.status === 200) {
    const gotB = await json("/providers/github/credentials", { bearer: B.bearer });
    const gotAwithB = (gotB.data as { secret?: string }).secret;
    if (gotAwithB === "ghp_USER_A_PAT_VALUE") {
      throw new Error("token of B opened GitHub PAT of A");
    }
    const gotA = await json("/providers/github/credentials", { cookie: A.cookie });
    if ((gotA.data as { secret?: string }).secret !== "ghp_USER_A_PAT_VALUE") {
      throw new Error("A github vault mismatch");
    }
  } else if (ghA.status === 404) {
    const err = (ghA.data as { error?: string }).error;
    if (err !== "Unknown provider" && err !== CREDENTIALS_NOT_LINKED) {
      throw new Error(`unexpected github PUT ${ghA.status} ${ghA.text}`);
    }
    console.log("   github provider not landed — Claude isolation still holds");
  } else {
    throw new Error(`github PUT A ${ghA.status} ${ghA.text}`);
  }

  console.log("3) workspaces are not shared for write");
  const pathA = `/tmp/chavez-no-team-a-${stamp}`;
  const pathB = `/tmp/chavez-no-team-b-${stamp}`;
  const createdA = await withWs(A.bearer, async (rpc) => {
    const bind = await rpc({ type: "workspace.bind", path: pathA, clientKind: "daemon" });
    if (!bind.ok) throw new Error(`bind A ${bind.error}`);
    const workspace = (bind.data as { workspace: { id: string; userId: string; path: string } }).workspace;
    if (workspace.userId && workspace.userId !== A.me.id) {
      throw new Error("workspace A userId mismatch");
    }
    const sess = await rpc({ type: "session.create", title: "S-A" });
    if (!sess.ok) throw new Error(`session A ${sess.error}`);
    const session = (sess.data as { session: { id: string } }).session;
    const chat = await rpc({
      type: "chat.create",
      sessionId: session.id,
      title: "C-A",
    });
    if (!chat.ok) throw new Error(`chat A ${chat.error}`);
    const chatRow = (chat.data as { chat: { id: string } }).chat;
    return { workspaceId: workspace.id, sessionId: session.id, chatId: chatRow.id };
  });

  const createdB = await withWs(B.bearer, async (rpc) => {
    const samePath = await rpc({
      type: "workspace.bind",
      path: pathA,
      clientKind: "client",
    });
    if (!samePath.ok) throw new Error(`bind B same path ${samePath.error}`);
    const wsBsame = (samePath.data as { workspace: { id: string } }).workspace;
    if (wsBsame.id === createdA.workspaceId) {
      throw new Error("B bound A's workspace row — shared write");
    }
    const bind = await rpc({ type: "workspace.bind", path: pathB, clientKind: "daemon" });
    if (!bind.ok) throw new Error(`bind B ${bind.error}`);
    return (bind.data as { workspace: { id: string } }).workspace.id;
  });
  if (createdB === createdA.workspaceId) throw new Error("A and B share workspace id");

  const listB = await json("/workspaces", { cookie: B.cookie });
  expectStatus("GET /workspaces B", listB.status, 200);
  const workspacesB = (listB.data as { workspaces: Array<{ id: string; path: string }> }).workspaces;
  if (workspacesB.some((w) => w.id === createdA.workspaceId)) {
    throw new Error("B listed A's workspace");
  }
  if (workspacesB.some((w) => w.path === pathA && w.id === createdA.workspaceId)) {
    throw new Error("B listed A's workspace path as shared");
  }

  const foreignWs = await json(`/workspaces/${createdA.workspaceId}/sessions`, {
    cookie: B.cookie,
  });
  expectStatus("B GET workspace A", foreignWs.status, 404);
  expectError("B GET workspace A", foreignWs.data, NOT_FOUND_WORKSPACE);
  if (foreignWs.status === FORBIDDEN_STATUS) throw new Error("got 403 — no membership");

  const foreignSess = await json(`/sessions/${createdA.sessionId}`, { cookie: B.cookie });
  expectStatus("B GET session A", foreignSess.status, 404);
  expectError("B GET session A", foreignSess.data, NOT_FOUND_SESSION);

  const foreignChat = await json(`/chats/${createdA.chatId}`, { cookie: B.cookie });
  expectStatus("B GET chat A", foreignChat.status, 404);
  expectError("B GET chat A", foreignChat.data, NOT_FOUND_CHAT);

  const connB = await json("/connections", { cookie: B.cookie });
  const conns = (connB.data as { connections: Array<{ workspaceId?: string }> }).connections ?? [];
  if (conns.some((c) => c.workspaceId === createdA.workspaceId)) {
    throw new Error("B listed A's daemon connection");
  }

  console.log("4) token of B does not run tools/PRs on A's chat");
  await withWs(B.bearer, async (rpc) => {
    const list = await rpc({ type: "chat.list", sessionId: createdA.sessionId });
    if (list.ok && Array.isArray((list.data as { chats?: unknown[] }).chats) && (list.data as { chats: unknown[] }).chats.length) {
      throw new Error("B listed A's chats");
    }
    if (list.ok) throw new Error("chat.list of foreign session must fail");
    if (list.error !== NOT_FOUND_SESSION) {
      throw new Error(`chat.list foreign: ${list.error}`);
    }
    const get = await rpc({ type: "chat.get", chatId: createdA.chatId });
    if (get.ok) throw new Error("B chat.get A's chat");
    if (get.error !== NOT_FOUND_CHAT) throw new Error(`chat.get foreign ${get.error}`);
    const tool = await rpc({
      type: "chat.tool.start",
      chatId: createdA.chatId,
      toolCallId: "tc-x",
      toolName: "bash",
    });
    if (tool.ok) throw new Error("B started a tool on A's chat");
    if (tool.error !== NOT_FOUND_CHAT) throw new Error(`tool.start foreign ${tool.error}`);
    const turn = await rpc({
      type: "agent.turn.request",
      chatId: createdA.chatId,
      prompt: "open a PR",
    });
    if (turn.ok) throw new Error("B dispatched a turn on A's chat");
    if (turn.error !== NOT_FOUND_CHAT) {
      throw new Error(`turn.request foreign ${turn.error}`);
    }
    const pr = await rpc({
      type: "workspace.git.pr",
      title: "should not open",
    });
    if (pr.ok) throw new Error("B opened a PR RPC without A's daemon/vault");
  });

  console.log("5) share link is not membership");
  const createShare = await json(`/chats/${createdA.chatId}/share`, {
    method: "POST",
    cookie: A.cookie,
  });
  if (createShare.status === 404) {
    const anon = await json(`/share/not-a-real-token`);
    if (anon.status !== 404) {
      throw new Error(`GET /share/missing status ${anon.status}`);
    }
    const asSession = await json("/me", { bearer: "not-a-real-token" });
    expectStatus("share token as Bearer", asSession.status, 401);
    expectError("share token as Bearer", asSession.data, UNAUTHORIZED);
    console.log("   share routes not landed — absent link is still not membership");
  } else if (createShare.status === 200) {
    const token = (createShare.data as { token?: string }).token;
    if (!token) throw new Error("share create missing token");
    const pub = await json(`/share/${token}`);
    expectStatus("GET share anon", pub.status, 200);
    const body = pub.data as {
      banner?: string;
      userId?: unknown;
      members?: unknown;
      secret?: unknown;
    };
    if (body.banner !== SHARE_READONLY_BANNER) {
      throw new Error("share banner mismatch");
    }
    if (body.userId || body.members || body.secret) {
      throw new Error("share payload looks like membership/vault");
    }
    if (pub.setCookie.length) throw new Error("share set a session cookie");
    const meWithShare = await json("/me", { bearer: token });
    expectStatus("share token is not a session", meWithShare.status, 401);
    const wsShare = await fetch(`${API}/ws?token=${encodeURIComponent(token)}`);
    if (wsShare.status !== 401) {
      throw new Error(`share token opened WS (${wsShare.status})`);
    }
    const bSeesChat = await json(`/chats/${createdA.chatId}`, { cookie: B.cookie });
    expectStatus("B still 404 after opening share", bSeesChat.status, 404);
    expectError("B still 404 after opening share", bSeesChat.data, NOT_FOUND_CHAT);
    const bVault = await json("/providers/claude/credentials", { cookie: B.cookie });
    if ((bVault.data as { secret?: string }).secret === "sk-ant-USER-A-SECRET") {
      throw new Error("opening share leaked A's vault to B");
    }
    const ask = await withWs(B.bearer, (rpc) =>
      rpc({
        type: "agent.turn.request",
        chatId: createdA.chatId,
        prompt: "hi",
      }),
    );
    if (ask.ok) throw new Error("B asked on A's chat via share");
    const missing = await json("/share/revoked-or-random");
    expectStatus("bad share token", missing.status, 404);
    expectError("bad share token", missing.data, SHARE_NOT_FOUND);
  } else if (createShare.status === 401) {
    throw new Error("owner could not POST share (unexpected 401)");
  } else {
    throw new Error(`POST share ${createShare.status} ${createShare.text}`);
  }

  console.log("\nNO-TEAM INVARIANT PASS");
}

main().catch((err) => {
  console.error("NO-TEAM INVARIANT FAIL", err);
  process.exit(1);
});
```

El script no arranca daemons de producto ni llama a GitHub de verdad: el RPC `workspace.git.pr` de B sobre el socket de B, sin bind al workspace de A, no puede usar el PAT de A. `agent.turn.request` sobre el `chatId` de A falla `"Chat not found"` **antes** de `findDaemon`.

- [ ] Correr unitarios + e2e:

```bash
cd api && bun test src/lib/no-team.test.ts src/db/schema-no-team.test.ts \
  src/auth-no-team.test.ts src/routes/ownership.test.ts \
  src/ws/hub.test.ts src/ws/protocol-no-team.test.ts \
  src/lib/share-not-membership.test.ts src/routes/vault-ownership.test.ts
cd ../cli && bun test src/no-team-cli.test.ts src/llm/vault-token.test.ts
cd ../tui && bun test src/no-team-tui.test.ts
cd ../web && bun test src/no-team-ui.test.ts src/lib/share-not-membership.test.ts
# API arriba:
cd ../api && bun run test:no-team
```

Esperado: unitarios PASS. E2E imprime `NO-TEAM INVARIANT PASS`. A y B no comparten fila de workspace. Bearer de B no descifra el vault de A. Share (si existe) no autentica y no convierte a B en miembro. Rutas `/orgs` `/teams` `/members` `/invites` son 404.

- [ ] Commit:

```bash
git add api/scripts/e2e-no-team.ts api/package.json
git commit -m "test(no-team): e2e two-user isolation"
```

---

## Verificación final (los tres escenarios)

| Escenario Gherkin | Dónde queda cerrado |
|---|---|
| No hay roles ni workspaces compartidos de escritura | Task 1 freeze schema/auth; Task 2 ownership 404 + bind `(userId, path)` crea **otra** fila; Task 5 sin UI de roles; Task 6 e2e A/B |
| Link de solo lectura (plan 23) no es membresía | Task 3 contrato + banner; Task 6: share token ≠ Bearer, no Set-Cookie, B sigue 404 en `/chats/:idA`, sin vault de A |
| El token de A no abre PRs ni tools de B | Task 4 vault por sesión; hub `findDaemon(userId)`; Task 6: `chat.tool.start` / `agent.turn.request` / `workspace.git.pr` de B sobre ids de A fallan; PAT github de A no sale con Bearer de B |

No se entrega producto de equipo. No hay 403 de membresía. Un usuario Chavez = su vault, sus chats, sus daemons.
