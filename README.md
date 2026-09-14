# Chavez Harness

CLI + API + TUI + Web hub para auth Chavez, providers (Claude/Cursor) y workspaces con WebSocket (sessions/chats sync).

## Stack

- **Runtime:** Bun
- **API:** Hono · Drizzle · PostgreSQL · Better Auth · WebSocket `/ws`
- **CLI:** Bun (`chavez`) headless + launcher TUI
- **TUI:** React + Ink (`tui/`)
- **Web:** Astro + React (`web/`) — hub de consola (auth, device, providers, workspaces)

## Arranque local

```bash
cp .env.example .env
cp web/.env.example web/.env   # opcional; mismos PUBLIC_*
docker compose up -d           # Postgres :25000
bun install
bun run db:migrate             # o: cd api && bunx drizzle-kit push
bun run dev:api                # API :25001
bun run dev:web                # Hub :25002
```

**Swagger UI:** [http://localhost:25001/docs](http://localhost:25001/docs) · spec JSON [http://localhost:25001/openapi.json](http://localhost:25001/openapi.json)

**Puertos fijos del stack** (sin fallback silencioso a `26000+`; si `25001` está ocupado, la API falla con mensaje claro — alinea `PORT` / `BETTER_AUTH_URL` / `PUBLIC_CHAVEZ_API_URL` / `CHAVEZ_API_URL`):

| Servicio | Puerto |
|----------|--------|
| PostgreSQL | **25000** |
| API | **25001** |
| Web | **25002** |
| Siguiente app | **25003**, … |

Si defines `PORT` / `WEB_PORT`, se respetan. `WEB_ORIGIN` debe coincidir con el origen del hub (CORS + `trustedOrigins`). El hub usa **TanStack React Query** contra `PUBLIC_CHAVEZ_API_URL` con cookies (`credentials: include`).

**Env:** cada paquete valida variables con Zod en `src/lib/config.ts` (`env.server` privado / `env.public`). Copia `.env.example` → `.env` antes de arrancar.

```bash
cd cli
bun run src/index.ts login
bun run src/index.ts whoami   # muestra cwd
```

### Auth (dos caminos, misma cuenta por email)

| Canal | Cómo |
|-------|------|
| **Web** | Hub `/sign-in`: email + contraseña (crear cuenta / entrar) **o** magic link |
| **CLI** | `chavez login` → device code → en el browser magic link o password → aprobar → Bearer en `~/.chavez/config.json` **y** cookie de sesión en el hub |

Si la cuenta nació solo con magic link, en `/sign-in` (con sesión) puedes **definir contraseña** (`POST /me/password`). Luego magic link y password autentican al mismo usuario.

### Vincular Claude / Cursor

Tras sesión en el hub (`/providers`) o con Bearer del CLI:

- **OAuth:** `chavez provider link claude` (`claude setup-token` → vault)
- **API key:** `chavez provider link claude --api-key` o hub web `/providers?provider=claude` (también `API /providers/link` redirige ahí)

### Workspace WebSocket

Protocolo: `ws://<API>/ws` con cookie de sesión (hub web) o `?token=<harnessAccessToken>` (CLI).

1. Cliente conecta con Bearer token en query.
2. `workspace.bind` con `path` (daemon: `clientKind: "daemon"`).
3. CRUD sync: `session.*`, `chat.*`, `ping`/`pong` — las mutaciones hacen **broadcast** (`message.appended`, etc.).
4. Live agent: `agent.turn.request` → API despacha al daemon → `chat.stream.*` / `chat.tool.*` + mensaje assistant.
5. Timeline en hub `/chats/:id` (mensajes + tools + stream) y CLI `chat watch`.

**Flujo CLI (daemon + sync)**

```bash
chavez login
cd <repo>
chavez headless workspace open      # daemon agent runner + presencia
chavez headless session create
chavez headless chat create <sessionId>
chavez headless chat ask <chatId> "explica este repo"
chavez headless chat watch <chatId> # eventos push en vivo
chavez headless chat append <chatId> "nota manual"
chavez headless connections
chavez headless workspace close
```

**TUI:** se registra como **daemon/runner** del workspace al abrir (`clientKind: daemon`). Web puede hacer `agent.turn.request` con la TUI abierta; si también hay `headless workspace open`, gana el primer daemon. Appends y turns remotos refrescan Messages vía push WS. Cada turn del agente carga el historial del chat desde la DB (`chat.get`) y lo inyecta en el prompt del LLM para mantener contexto entre preguntas.

**Validar overview del workspace (web)**

1. Login en el hub + TUI (`chavez tui`) o `chavez headless workspace open` en el path del workspace.
2. Abrir `/workspaces/<id>` → sessions con chats anidados y preview de últimos mensajes.
3. Append o `agent.turn` → el preview se actualiza (WS invalidate).
4. Click en un chat → timeline completa en `/chats/<id>`.

### HTTP (lectura, Bearer auth)

| Método | Ruta | Respuesta |
|--------|------|-----------|
| `GET` | `/workspaces` | workspaces del user (+ `openConnections`) |
| `GET` | `/workspaces/:workspaceId/sessions` | sessions del workspace |
| `GET` | `/sessions/:sessionId` | detalle session (+ path workspace) |
| `GET` | `/sessions/:sessionId/chats` | lista chats |
| `GET` | `/chats/:chatId` | chat + mensajes ordenados |
| `GET` | `/connections` | sockets WS abiertos del user |

Sin `Authorization: Bearer …` → `401`. Recurso de otro user → `404`.

### Magic link + password

Resend (`RESEND_API_KEY`). En no-prod también `api/.dev-magic-link.txt`.
**Mismo email = misma cuenta** entre magic link, password y device/CLI. El primer magic link o sign-up crea el usuario; después cualquiera de los métodos autentica.

### Variables

Ver `.env.example` (`DATABASE_URL`, `BETTER_AUTH_*`, `PROVIDER_SECRETS_KEY`, `RESEND_*`, `CHAVEZ_API_URL`).

## Comandos CLI (resumen)

| Comando | Descripción |
|---------|-------------|
| `chavez login` / `logout` / `whoami` | Auth harness (+ cwd en whoami) |
| `chavez provider …` | Vault Claude/Cursor |
| `chavez headless workspace open\|close\|status` | Presencia WS por cwd |
| `chavez headless session\|chat …` | Sessions/chats + `ask`/`watch` sync |
| `chavez headless connections` | Lista sockets WS abiertos (`GET /connections`) |
| `chavez tui` | Vista Ink (daemon turn o runner local) |

## Smoke test auth

```bash
cd api && bun run test:e2e
```

## Fuera de alcance (siguiente)

LLM Agent SDK, streaming `chat.stream.*`, web React DOM, machineId multi-host.
