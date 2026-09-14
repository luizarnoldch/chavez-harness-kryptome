# Chavez Harness

CLI + API + TUI para auth Chavez, providers (Claude/Cursor) y workspaces con WebSocket (sessions/chats sync).

## Stack

- **Runtime:** Bun
- **API:** Hono · Drizzle · PostgreSQL · Better Auth · WebSocket `/ws`
- **CLI:** Bun (`chavez`) headless + launcher TUI
- **TUI:** React + Ink (`tui/`)

## Arranque local

```bash
cp .env.example .env
docker compose up -d
bun install
cd api && bunx drizzle-kit push && bun run src/index.ts
```

```bash
cd cli
bun run src/index.ts login
bun run src/index.ts whoami   # muestra cwd
```

### Vincular Claude

- **OAuth:** `chavez provider link claude` (`claude setup-token` → vault)
- **API key:** `chavez provider link claude --api-key` o web `/providers/link?provider=claude`

### Workspace WebSocket

Protocolo: `ws://<API>/ws?token=<harnessAccessToken>` (servidor: Hono Bun WebSocket Helper — `upgradeWebSocket` + `websocket` de `hono/bun`).

1. Cliente conecta con Bearer token en query.
2. Envía `{ "type": "workspace.bind", "id": "1", "path": "<cwd absoluto>" }`.
3. Request/response sync: `session.*`, `chat.*`, `ping`/`pong`.
4. Reservado (futuro streaming): `chat.stream.start|delta|end|error`.

**Flujo CLI (socket abierto)**

```bash
chavez login
cd <repo>
chavez headless workspace open      # abre WS daemon + bind cwd
chavez headless workspace status
chavez headless session list
chavez headless chat list <sessionId>
chavez headless chat get <chatId>
chavez headless connections         # sockets WS abiertos del user (HTTP)
chavez headless workspace close
```

**TUI (interactiva)** — abre WS al entrar, cierra al salir (`q` / Ctrl+C):

```bash
chavez tui
```

Teclas: `p` provider, `[`/`]` modelo, `{`/`}` effort, `s` session, `c` chat, `m` mensaje (llama al LLM Claude localmente), `q` salir.

Cabecera muestra provider vinculado, modelo, effort y precios aprox. $/MTok.

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

### Magic link

Resend (`RESEND_API_KEY`). En no-prod también `api/.dev-magic-link.txt`.

### Variables

Ver `.env.example` (`DATABASE_URL`, `BETTER_AUTH_*`, `PROVIDER_SECRETS_KEY`, `RESEND_*`, `CHAVEZ_API_URL`).

## Comandos CLI (resumen)

| Comando | Descripción |
|---------|-------------|
| `chavez login` / `logout` / `whoami` | Auth harness (+ cwd en whoami) |
| `chavez provider …` | Vault Claude/Cursor |
| `chavez headless workspace open\|close\|status` | Presencia WS por cwd |
| `chavez headless session\|chat …` | Sessions/chats sync vía WS |
| `chavez headless connections` | Lista sockets WS abiertos (`GET /connections`) |
| `chavez tui` | Vista Ink (WS lifecycle = UI) |

## Smoke test auth

```bash
cd api && bun run test:e2e
```

## Fuera de alcance (siguiente)

LLM Agent SDK, streaming `chat.stream.*`, web React DOM, machineId multi-host.
