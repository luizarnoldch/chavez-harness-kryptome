# Web fetch Implementation Plan

> **For agentic workers:** Execute task-by-task. Do not skip tests. Do not implement Cursor cloud, allowlist de hosts, “siempre permitir”, lote de approvals, voz, extensión IDE, upload desde el navegador, WebSearch, ni browsers MCP de [plan 19](../mcp-skills-subagents/plan.md). Spec: [`plan.md`](./plan.md). Depende del gate de red de [`sandbox-network`](../sandbox-network/implementation.md) (`gateWebFetch` / `gateNetwork` / `NETWORK_DENIED_*`), del contrato de tools en [`agent-tools`](../agent-tools/implementation.md), modos ([`execution-modes`](../execution-modes/implementation.md)) y aprobaciones ([`approvals`](../approvals/implementation.md)). Si un sibling ya creó un archivo citado, **extiéndelo**; no lo reescribas.

**Goal:** El agente tiene una tool HTTP **visible** para leer docs fuera del repo. Corre **en el daemon** (máquina del workspace), no en el servidor Chavez ni en el navegador. En `ask` la URL entra en `awaiting_approval` (pide red, una a una); el resultado es **texto acotado** y se pinta en la timeline como tool. En `auto` se niega con el string de plan 26 (`NETWORK_DENIED_AUTO`). No es MCP de usuario: funciona sin `.mcp.json`. MCP puede añadir browsers más ricos (plan 19) **sin reemplazar** esta tool. SSRF: no se fetchea el origin de la API ni metadata cloud.

**Architecture:** El socket HTTP sale del proceso daemon (`cli/src/ws/daemon.ts` o TUI `clientKind: "daemon"`). La API **no** tiene ruta proxy y **no** llama `fetch(url)` del usuario. El Claude Agent SDK trae un `WebFetch` in-process que **ignora** `sandbox.network` (plan 26): esta fase lo **desactiva** y lo redirige a un host tool Chavez que hace GET + SSRF + truncado.

```
Composer (Web | TUI | CLI ask)
        |
        v
  agent.turn.request  --WS-->  API  --dispatch-->  daemon
        |
        v
  query({ tools: DEFAULT_CLAUDE_TOOLS + mcp__chavez-web__fetch,
          disallowedTools: [WebFetch, WebSearch],
          toolAliases: { WebFetch: mcp__chavez-web__fetch },
          mcpServers: { …, chavez-web: alwaysLoad },
          canUseTool: decideCanUseTool })
        |
        |  modelo emite WebFetch | mcp__chavez-web__fetch | web_fetch
        |     1. denyIfSsrf          → SSRF_DENIED (0 paquetes)
        |     2. gateMutation        → plan: other/write deny
        |     3. gateWebFetch        → auto: NETWORK_DENIED_AUTO
        |                            → plan: NETWORK_DENIED_PLAN
        |                            → ask:  awaiting_approval { kind: fetch, url, pide red }
        |     4. approve             → runWebFetch(url) EN EL DAEMON
        |        deny/timeout        → NETWORK_DENIED_ASK; 0 paquetes
        |     5. HTML/JSON/text      → texto acotado FETCH_BODY_MAX_CHARS
        |        binary              → "binary content omitted …"
        v
  chat.tool.start / update / result  →  Web ToolCard | TUI | CLI watch
```

Estado actual que este plan extiende (no reescribir):

- `cli/src/llm/claude-runner.ts` llama `query()` con `cwd` y hoy `permissionMode: "bypassPermissions"`. Planes 2–3/26 lo pasan a `"default"` + `canUseTool` / `decideCanUseTool`. **No** volver a `bypassPermissions`. **No** pasa `WebFetch` en `tools`. El SDK **sí** tiene WebFetch in-process (no respeta `sandbox.network`).
- Plan 26 exporta `gateWebFetch(mode, url)` y clasifica `WebFetch` / `WebSearch` / `WebBrowser` como red. **No** implementa el GET, ni SSRF, ni truncado HTTP. Esta fase **llama** `gateWebFetch`; no reimplementa el modo.
- Plan 26 ya añadió `ApprovalPrompt` `{ kind: "fetch"; url; needsNetwork: true }` y headline `pide red · fetch · <url>`. Si ese kind **no** está, esta fase lo añade (no reescribe write/edit/bash).
- `cli/src/llm/tool-names.ts` (plan 2): `DEFAULT_CLAUDE_TOOLS` son las 6 de FS. Canonical `WebFetch` → hoy caería a `webfetch`. Esta fase mapea a `fetch`.
- `cli/src/llm/publish-turn.ts` emite `chat.tool.start` / `result` (y `update` si planes 3/13 existen). **No** estampa `kind: "fetch"`.
- API: `chat.tool.*` ya persiste `role=tool` + metadata jsonb. **Sin** ruta HTTP nueva. **Sin** migración.
- Web `ChatDetailPanel.tsx` `ToolCard`: nombre + status. Plan 13/26 pintan `awaiting_approval` y `pide red`. Falta la URL como dato de primer nivel si el prompt fetch no está.
- TUI `App.tsx` / CLI `watch`: headline canónico si plan 2 aterrizó; si no, JSON/`role: content`.
- Cursor `cli/src/llm/cursor-runner.ts` (plan 4): `tools: DEFAULT_CURSOR_TOOLS` **sin** fetch. Custom tools (`local.customTools`) **saltan** el approval del SDK Cursor: el handler Chavez **debe** llamar el mismo gate.
- Plan 19 carga MCP de `.mcp.json`. Esta tool **no** vive ahí. Un browser MCP de usuario se **suma**; no pisa `chavez-web`.

**Tech Stack:** Bun (`Bun.fetch` / `Bun.serve` en tests; `dns.promises.lookup`), Hono WebSocket hub (fan-out existente, **sin** ruta proxy), Drizzle `chat_messages.metadata` jsonb (**sin** tabla nueva, **sin** migración), Claude Agent SDK `query` (`createSdkMcpServer` + `tool`, `disallowedTools`, `toolAliases`, `mcpServers`, `canUseTool`, `permissionMode: "default"`), Cursor SDK `local.customTools` **solo** si el runner del plan 4 existe (`local: { cwd }`, **nunca** `cloud`), Ink TUI, Astro/React web. Tests: `bun test`. Web **no** importa CLI: duplicar labels (`web/src/lib/fetch-display.ts`, comentario keep-in-sync). Zod ya está en `cli/package.json`. **Sin** cheerio / jsdom / mozilla-readability / undici extra. **Sin** allowlist persistente.

**Global Constraints:**

1. El GET sale **solo** del daemon (cwd del workspace, proceso CLI/TUI). API y browser no abren el socket al destino. No hay `POST /fetch` ni proxy en `api/src/routes/`.
2. Sin daemon bound, `agent.turn.request` falla con el string existente `"No daemon bound for this workspace. Run: chavez headless workspace open"`. No queda un waiter ni un GET huérfano.
3. En **ask**, el agente pide URL → `awaiting_approval` con la **URL visible** + `needsNetwork: true` + label `pide red`. Aprobación **una a una**. Approve → GET en el daemon. Deny / timeout → `NETWORK_DENIED_ASK`, **cero paquetes**.
4. En **auto**, `gateWebFetch` → `NETWORK_DENIED_AUTO`. El assistant ve ese string como tool error. **No** hay allowlist ni “siempre permitir” (fuera de alcance).
5. En **plan**, red denegada (`NETWORK_DENIED_PLAN` o `PLAN_MUTATION_DENIED` si `gateMutation` gana primero). Disco y red del host intactos.
6. **No es MCP de usuario.** Funciona con `mcpServers` de proyecto vacío / sin `.mcp.json`. El servidor host `chavez-web` es `alwaysLoad: true`, igual que `chavez-git`. `metadata.kind === "fetch"` (nunca `"mcp"`). Plan 19 puede añadir Playwright/browser MCP **sin** borrar este servidor.
7. SSRF: no se fetchea el **origin de la API Chavez** (`CHAVEZ_API_URL`, default `http://localhost:25001`) ni **metadata cloud** (`169.254.0.0/16`, hostnames de metadata). Loopback de **otros puertos** (p.ej. docs locales `:3000`) **sí** se puede pedir en ask. Cada redirect se re-chequea. `file:` / `ftp:` / `gopher:` / `unix:` denegados.
8. Resultado = **texto acotado**. HTML se convierte a texto. JSON/text se pasan. Binario/imagen se omiten con un mensaje corto. Truncado `FETCH_BODY_MAX_CHARS` (= `TOOL_OUTPUT_MAX_CHARS` = 8000) **antes** de persistir, broadcast y devolver al LLM.
9. Lecturas FS (read/grep/glob) no cambian. Write/edit/bash siguen el modo. Fetch **no** es una lectura de FS: siempre es red.
10. Web, TUI y CLI `watch` ven el mismo contrato: `tool · fetch · <status>  <url>` + output acotado. Reload reconstruye desde `chat.get`.
11. 1 turn por daemon. Claude es ejecutable. Cursor, si el plan 4 ya corre, reutiliza `runWebFetch` + el mismo gate; nunca `cloud`.
12. Fuera de alcance: Cursor cloud, voz, extensión IDE, upload desde el navegador, WebSearch, allowlist, “siempre permitir”, notificaciones OS/email, cola, worktrees paralelos.

**Constantes (congeladas, no inventar otras):**

| Nombre | Valor |
|---|---|
| `WEB_FETCH_MCP_SERVER` | `"chavez-web"` |
| `WEB_FETCH_TOOL_ID` | `"fetch"` |
| `WEB_FETCH_SDK_NAME` | `"mcp__chavez-web__fetch"` |
| `WEB_FETCH_CURSOR_NAME` | `"web_fetch"` |
| `WEB_FETCH_DISALLOWED` | `["WebFetch", "WebSearch"]` (built-ins in-process del SDK Claude) |
| `WEB_FETCH_TOOL_ALIASES` | `{ WebFetch: "mcp__chavez-web__fetch" }` |
| `FETCH_BODY_MAX_CHARS` | `8000` (igual a `TOOL_OUTPUT_MAX_CHARS`; **no** otro número) |
| `FETCH_MAX_BYTES` | `1_000_000` |
| `FETCH_TIMEOUT_MS` | `15_000` |
| `FETCH_MAX_REDIRECTS` | `5` |
| `FETCH_USER_AGENT` | `"Chavez-Fetch/1.0"` |
| `SSRF_DENIED` | `"Fetch blocked: URL is not allowed (SSRF)."` |
| `SSRF_DENIED_API` | `"Fetch blocked: Chavez API origin is not allowed."` |
| `SSRF_DENIED_METADATA` | `"Fetch blocked: cloud metadata and link-local addresses are not allowed."` |
| `SSRF_DENIED_SCHEME` | `"Fetch blocked: only http and https URLs are allowed."` |
| `FETCH_BINARY_OMITTED` | `` `binary content omitted (type=${type}, bytes=${n})` `` |
| `FETCH_EMPTY` | `"Fetch returned no text content."` |
| `NETWORK_DENIED_AUTO` | reusar plan 26, mismo literal |
| `NETWORK_DENIED_PLAN` | reusar plan 26, mismo literal |
| `NETWORK_DENIED_ASK` | reusar plan 26, mismo literal |
| `NETWORK_REQUEST_LABEL` | `"pide red"` (reusar plan 26) |
| `NO_DAEMON_ERROR` | `"No daemon bound for this workspace. Run: chavez headless workspace open"` |
| `TOOL_OUTPUT_MAX_CHARS` | `8000` (reusar plan 2; **no** cambiar) |

Si `cli/src/llm/network-constants.ts` ya exporta `NETWORK_DENIED_*` / `NETWORK_REQUEST_LABEL`, **importarlos**. No duplicar el string.

Nombres canónicos (timeline):

| SDK `toolName` | Canónico | `metadata.kind` |
|---|---|---|
| `mcp__chavez-web__fetch`, `fetch` | `fetch` | `fetch` |
| `WebFetch` (alias → host) | `fetch` | `fetch` |
| `web_fetch`, `webFetch` (Cursor) | `fetch` | `fetch` |
| `mcp__<user-browser>__*` (plan 19) | `mcp:<server>/<tool>` | `mcp` |

`isAlwaysNetworkTool` (plan 26) debe devolver true para `WEB_FETCH_SDK_NAME`, `WebFetch`, `web_fetch`, `fetch`.

Orden de `decideCanUseTool` (insertar paso 3b; no reordenar el resto):

1. `denyIfEscapes`
2. `denyIfIgnored` (si plan 8 existe)
3. `denyIfBashEscapes`
3b. **`denyIfSsrf`** — si es tool fetch. Deny **antes** de preguntar al usuario. 0 paquetes.
4. `gateMutation`
5. `gateNetwork` / `gateWebFetch`
6. Ask waiter (una a una)
7. Allow → el **handler** llama `runWebFetch` (no el WebFetch in-process del SDK)

Payload `chat_messages.metadata` para fetch:

```ts
{
  toolCallId: string;
  toolName: "fetch";
  sdkName: string;            // WebFetch | mcp__chavez-web__fetch | web_fetch
  kind: "fetch";
  status: "running" | "awaiting_approval" | "done" | "error";
  input: { url: string };
  summary: string;            // la URL, sin secretos
  url: string;
  needsNetwork: true;
  truncated?: boolean;
  prompt?: { kind: "fetch"; url: string; needsNetwork: true };
  output?: string;
}
```

No hay events WS nuevos. No hay HTTP nuevo.

---

## Task 1: Constantes + SSRF (sin I/O de red)

**Files:**

- Create: `cli/src/llm/web-fetch-constants.ts`
- Create: `cli/src/llm/web-fetch-ssrf.ts`
- Test: `cli/src/llm/web-fetch-ssrf.test.ts`
- Modify: `cli/package.json`

Módulos puros. El lookup DNS es **inyectable**. TUI importa desde `cli/src/llm/…`. Web/API **no** importan CLI.

- [ ] Añadir `"test": "bun test"` en `cli/package.json` `scripts` si aún no existe (dejar `start`/`dev`/`bin` intactos):

```json
"scripts": {
  "start": "bun run src/index.ts",
  "dev": "bun run src/index.ts",
  "test": "bun test"
}
```

- [ ] Crear `cli/src/llm/web-fetch-constants.ts`:

```ts
export const WEB_FETCH_MCP_SERVER = "chavez-web";
export const WEB_FETCH_TOOL_ID = "fetch";
export const WEB_FETCH_SDK_NAME = "mcp__chavez-web__fetch";
export const WEB_FETCH_CURSOR_NAME = "web_fetch";

export const WEB_FETCH_DISALLOWED = ["WebFetch", "WebSearch"] as const;

export const WEB_FETCH_TOOL_ALIASES: Record<string, string> = {
  WebFetch: WEB_FETCH_SDK_NAME,
};

export const FETCH_BODY_MAX_CHARS = 8000;
export const FETCH_MAX_BYTES = 1_000_000;
export const FETCH_TIMEOUT_MS = 15_000;
export const FETCH_MAX_REDIRECTS = 5;
export const FETCH_USER_AGENT = "Chavez-Fetch/1.0";

export const SSRF_DENIED =
  "Fetch blocked: URL is not allowed (SSRF).";
export const SSRF_DENIED_API =
  "Fetch blocked: Chavez API origin is not allowed.";
export const SSRF_DENIED_METADATA =
  "Fetch blocked: cloud metadata and link-local addresses are not allowed.";
export const SSRF_DENIED_SCHEME =
  "Fetch blocked: only http and https URLs are allowed.";
export const FETCH_EMPTY = "Fetch returned no text content.";

export const METADATA_HOSTS = new Set([
  "metadata.google.internal",
  "metadata.google.com",
  "metadata.azure.com",
  "instance-data",
  "kubernetes.default",
  "kubernetes.default.svc",
  "kubernetes.default.svc.cluster.local",
]);

export const DEFAULT_CHAVEZ_API_URL = "http://localhost:25001";

export function fetchBinaryOmitted(type: string, bytes: number): string {
  return `binary content omitted (type=${type || "application/octet-stream"}, bytes=${bytes})`;
}

export function isFetchSdkName(sdkName: string): boolean {
  const n = sdkName.toLowerCase();
  if (sdkName === WEB_FETCH_SDK_NAME) return true;
  if (n === "webfetch" || n === "web_fetch" || n === "webfetch") return true;
  if (n === "fetch" || n === WEB_FETCH_CURSOR_NAME) return true;
  if (n.includes("webfetch") || n.includes("web_fetch")) return true;
  if (n === `mcp__${WEB_FETCH_MCP_SERVER}__${WEB_FETCH_TOOL_ID}`) return true;
  return false;
}
```

- [ ] Crear `cli/src/llm/web-fetch-ssrf.ts`:

```ts
import { isIP } from "node:net";
import { promises as dns } from "node:dns";
import {
  DEFAULT_CHAVEZ_API_URL,
  METADATA_HOSTS,
  SSRF_DENIED,
  SSRF_DENIED_API,
  SSRF_DENIED_METADATA,
  SSRF_DENIED_SCHEME,
} from "./web-fetch-constants";

export type LookupFn = (hostname: string) => Promise<string[]>;

export type SsrfEnv = {
  apiUrl?: string;
  lookup?: LookupFn;
};

export type SsrfDeny = { ok: false; message: string };
export type SsrfAllow = { ok: true; url: URL; ips: string[] };
export type SsrfResult = SsrfDeny | SsrfAllow;

function defaultPort(u: URL): string {
  if (u.port) return u.port;
  return u.protocol === "https:" ? "443" : "80";
}

function ipv4ToInt(ip: string): number | null {
  const p = ip.split(".");
  if (p.length !== 4) return null;
  const n = p.map((x) => Number(x));
  if (n.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return null;
  return ((n[0]! << 24) | (n[1]! << 16) | (n[2]! << 8) | n[3]!) >>> 0;
}

function inCidrV4(ip: string, cidr: string): boolean {
  const [base, bitsStr] = cidr.split("/");
  const bits = Number(bitsStr);
  const ipn = ipv4ToInt(ip);
  const bn = ipv4ToInt(base || "");
  if (ipn == null || bn == null || !Number.isInteger(bits)) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipn & mask) === (bn & mask);
}

function stripV4Mapped(ip: string): string {
  const m = ip.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return m ? m[1]! : ip;
}

function isLinkLocalOrMetadataIp(ip: string): boolean {
  const v = stripV4Mapped(ip);
  if (isIP(v) === 4) {
    if (inCidrV4(v, "169.254.0.0/16")) return true;
    if (inCidrV4(v, "0.0.0.0/8")) return true;
    return false;
  }
  const low = v.toLowerCase();
  if (low === "fd00:ec2::254" || low.startsWith("fd00:ec2:")) return true;
  if (low.startsWith("fe80:")) return true;
  return false;
}

function isLoopbackIp(ip: string): boolean {
  const v = stripV4Mapped(ip);
  if (isIP(v) === 4) return inCidrV4(v, "127.0.0.0/8");
  const low = v.toLowerCase();
  return low === "::1" || low === "0:0:0:0:0:0:0:1";
}

async function defaultLookup(hostname: string): Promise<string[]> {
  if (isIP(hostname)) return [stripV4Mapped(hostname)];
  const out = await dns.lookup(hostname, { all: true, verbatim: true });
  return [...new Set(out.map((r) => stripV4Mapped(r.address)))];
}

function parseHttpUrl(raw: string): URL | SsrfDeny {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { ok: false, message: SSRF_DENIED };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, message: SSRF_DENIED_SCHEME };
  }
  if (u.username || u.password) {
    return { ok: false, message: SSRF_DENIED };
  }
  if (!u.hostname) {
    return { ok: false, message: SSRF_DENIED };
  }
  return u;
}

function hostMatchesApi(url: URL, api: URL, urlIps: string[], apiIps: string[]): boolean {
  if (defaultPort(url) !== defaultPort(api)) return false;
  if (url.hostname.toLowerCase() === api.hostname.toLowerCase()) return true;
  const a = new Set(urlIps.map((x) => stripV4Mapped(x).toLowerCase()));
  for (const ip of apiIps) {
    if (a.has(stripV4Mapped(ip).toLowerCase())) return true;
  }
  return false;
}

/**
 * Decide si se puede abrir un socket a `raw`. No fetchea.
 * Metadata / link-local: siempre deny.
 * Origin de la API Chavez (host+puerto, localhost y 127.0.0.1 equivalentes): deny.
 * Loopback en OTRO puerto (docs locales): allow (el modo ask/auto lo decide gateWebFetch).
 */
export async function assertFetchUrlSafe(
  raw: string,
  env: SsrfEnv = {},
): Promise<SsrfResult> {
  const parsed = parseHttpUrl(raw);
  if (!(parsed instanceof URL)) return parsed;
  const url = parsed;
  const host = url.hostname.toLowerCase();

  if (METADATA_HOSTS.has(host)) {
    return { ok: false, message: SSRF_DENIED_METADATA };
  }

  const lookup = env.lookup ?? defaultLookup;
  let ips: string[];
  try {
    ips = await lookup(host);
  } catch {
    return { ok: false, message: SSRF_DENIED };
  }
  if (!ips.length) return { ok: false, message: SSRF_DENIED };

  if (ips.some(isLinkLocalOrMetadataIp)) {
    return { ok: false, message: SSRF_DENIED_METADATA };
  }

  const apiUrl = env.apiUrl || process.env.CHAVEZ_API_URL || DEFAULT_CHAVEZ_API_URL;
  let api: URL;
  try {
    api = new URL(apiUrl);
  } catch {
    api = new URL(DEFAULT_CHAVEZ_API_URL);
  }
  let apiIps: string[] = [];
  try {
    apiIps = await lookup(api.hostname);
  } catch {
    apiIps = isIP(api.hostname) ? [api.hostname] : [];
  }
  if (isLoopbackIp(apiIps[0] || "") || api.hostname === "localhost") {
    apiIps = [...new Set([...apiIps, "127.0.0.1", "::1"])];
  }
  if (hostMatchesApi(url, api, ips, apiIps)) {
    return { ok: false, message: SSRF_DENIED_API };
  }

  return { ok: true, url, ips };
}

export function denyIfSsrf(
  sdkName: string,
  input: Record<string, unknown> | null,
): { behavior: "deny"; message: string } | null {
  // sync wrapper used only to know IF we should run; the async check is assertFetchUrlSafe
  void sdkName;
  void input;
  return null;
}

export function urlFromToolInput(
  input: Record<string, unknown> | null,
): string {
  if (!input) return "";
  const u = input.url ?? input.uri ?? input.href;
  return typeof u === "string" ? u.trim() : "";
}
```

`denyIfSsrf` síncrono queda como stub exportado solo para no romper imports; el gate real es async en Task 3 (`denyIfSsrfAsync`).

- [ ] Tests `cli/src/llm/web-fetch-ssrf.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  SSRF_DENIED_API,
  SSRF_DENIED_METADATA,
  SSRF_DENIED_SCHEME,
} from "./web-fetch-constants";
import { assertFetchUrlSafe } from "./web-fetch-ssrf";

const api = "http://localhost:25001";

describe("assertFetchUrlSafe", () => {
  test("rejects file and ftp", async () => {
    expect((await assertFetchUrlSafe("file:///etc/passwd", { apiUrl: api })).ok).toBe(false);
    const ftp = await assertFetchUrlSafe("ftp://example.com/a", { apiUrl: api });
    expect(ftp.ok).toBe(false);
    if (!ftp.ok) expect(ftp.message).toBe(SSRF_DENIED_SCHEME);
  });

  test("rejects credentials in URL", async () => {
    const r = await assertFetchUrlSafe("https://user:pass@example.com/", {
      apiUrl: api,
      lookup: async () => ["93.184.216.34"],
    });
    expect(r.ok).toBe(false);
  });

  test("rejects cloud metadata IP", async () => {
    const r = await assertFetchUrlSafe("http://169.254.169.254/latest/meta-data", {
      apiUrl: api,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toBe(SSRF_DENIED_METADATA);
  });

  test("rejects metadata hostname even if it resolves public", async () => {
    const r = await assertFetchUrlSafe("http://metadata.google.internal/", {
      apiUrl: api,
      lookup: async () => ["8.8.8.8"],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toBe(SSRF_DENIED_METADATA);
  });

  test("rejects DNS that resolves to link-local", async () => {
    const r = await assertFetchUrlSafe("http://evil.example/", {
      apiUrl: api,
      lookup: async () => ["169.254.169.254"],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toBe(SSRF_DENIED_METADATA);
  });

  test("rejects Chavez API localhost origin", async () => {
    const r = await assertFetchUrlSafe("http://localhost:25001/providers", {
      apiUrl: api,
      lookup: async () => ["127.0.0.1"],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toBe(SSRF_DENIED_API);
  });

  test("rejects 127.0.0.1 on the API port", async () => {
    const r = await assertFetchUrlSafe("http://127.0.0.1:25001/vault", {
      apiUrl: api,
      lookup: async (h) => (h === "localhost" ? ["127.0.0.1"] : [h]),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toBe(SSRF_DENIED_API);
  });

  test("allows loopback on another port (local docs)", async () => {
    const r = await assertFetchUrlSafe("http://127.0.0.1:3000/docs", {
      apiUrl: api,
      lookup: async (h) => [h === "localhost" ? "127.0.0.1" : h],
    });
    expect(r.ok).toBe(true);
  });

  test("allows public https", async () => {
    const r = await assertFetchUrlSafe("https://example.com/readme", {
      apiUrl: api,
      lookup: async () => ["93.184.216.34"],
    });
    expect(r.ok).toBe(true);
  });
});
```

- [ ] Correr:

```bash
cd cli && bun test src/llm/web-fetch-ssrf.test.ts
```

Esperado: 8 tests green. Ninguno abre socket.

- [ ] Commit:

```bash
git add cli/package.json cli/src/llm/web-fetch-constants.ts \
  cli/src/llm/web-fetch-ssrf.ts cli/src/llm/web-fetch-ssrf.test.ts
git commit -m "feat(fetch): SSRF deny API origin and cloud metadata"
```

---

## Task 2: HTTP GET en el daemon — texto acotado, redirects re-chequeados

**Files:**

- Create: `cli/src/llm/web-fetch-html.ts`
- Test: `cli/src/llm/web-fetch-html.test.ts`
- Create: `cli/src/llm/web-fetch-http.ts`
- Test: `cli/src/llm/web-fetch-http.test.ts`

El GET usa `globalThis.fetch` (Bun). Tests levantan `Bun.serve` en `127.0.0.1` con puerto efímero — **nunca** el puerto de la API. Inyectar `assertFetchUrlSafe` env con `apiUrl` distinto al server de test.

- [ ] Crear `cli/src/llm/web-fetch-html.ts`:

```ts
const SCRIPT_RE = /<script\b[^>]*>[\s\S]*?<\/script>/gi;
const STYLE_RE = /<style\b[^>]*>[\s\S]*?<\/style>/gi;
const TAG_RE = /<[^>]+>/g;
const WS_RE = /[ \t]+\n/g;

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export function htmlToText(html: string): string {
  const stripped = html
    .replace(SCRIPT_RE, " ")
    .replace(STYLE_RE, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/h[1-6]>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(TAG_RE, " ")
    .replace(/&([a-z]+);/gi, (_, n: string) => ENTITIES[n.toLowerCase()] ?? "")
    .replace(/&#(\d+);/g, (_, d: string) => {
      const c = Number(d);
      return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : "";
    })
    .replace(/\r\n/g, "\n")
    .replace(WS_RE, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return stripped;
}

export function isHtmlContentType(type: string): boolean {
  const t = type.toLowerCase();
  return t.includes("text/html") || t.includes("application/xhtml");
}

export function isTextContentType(type: string): boolean {
  const t = type.toLowerCase();
  if (!t) return true;
  if (t.startsWith("text/")) return true;
  if (t.includes("json") || t.includes("xml") || t.includes("javascript")) {
    return true;
  }
  if (t.includes("markdown") || t.includes("yaml") || t.includes("csv")) {
    return true;
  }
  return false;
}
```

- [ ] Tests `cli/src/llm/web-fetch-html.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { htmlToText, isHtmlContentType, isTextContentType } from "./web-fetch-html";

test("strips tags and scripts", () => {
  const out = htmlToText(
    `<html><head><script>alert(1)</script><style>p{}</style></head><body><h1>Title</h1><p>Hello &amp; world</p></body></html>`,
  );
  expect(out).toContain("Title");
  expect(out).toContain("Hello & world");
  expect(out).not.toContain("alert");
  expect(out).not.toContain("<p>");
});

test("content types", () => {
  expect(isHtmlContentType("text/html; charset=utf-8")).toBe(true);
  expect(isTextContentType("application/json")).toBe(true);
  expect(isTextContentType("image/png")).toBe(false);
});
```

- [ ] Crear `cli/src/llm/web-fetch-http.ts`:

```ts
import {
  FETCH_BODY_MAX_CHARS,
  FETCH_EMPTY,
  FETCH_MAX_BYTES,
  FETCH_MAX_REDIRECTS,
  FETCH_TIMEOUT_MS,
  FETCH_USER_AGENT,
  fetchBinaryOmitted,
} from "./web-fetch-constants";
import { htmlToText, isHtmlContentType, isTextContentType } from "./web-fetch-html";
import {
  assertFetchUrlSafe,
  type SsrfEnv,
} from "./web-fetch-ssrf";

export type WebFetchResult = {
  ok: boolean;
  url: string;
  status?: number;
  contentType?: string;
  text: string;
  truncated: boolean;
  bytes: number;
};

function truncateBody(text: string): { text: string; truncated: boolean } {
  if (text.length <= FETCH_BODY_MAX_CHARS) return { text, truncated: false };
  return {
    text: `${text.slice(0, FETCH_BODY_MAX_CHARS)}\n[truncated: showing ${FETCH_BODY_MAX_CHARS} of ${text.length} chars]`,
    truncated: true,
  };
}

async function readLimited(res: Response): Promise<{ buf: Uint8Array; overflow: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) {
    const ab = new Uint8Array(await res.arrayBuffer());
    return { buf: ab.slice(0, FETCH_MAX_BYTES), overflow: ab.byteLength > FETCH_MAX_BYTES };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let overflow = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    if (total + value.byteLength > FETCH_MAX_BYTES) {
      const room = FETCH_MAX_BYTES - total;
      if (room > 0) chunks.push(value.slice(0, room));
      total = FETCH_MAX_BYTES;
      overflow = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const buf = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    buf.set(c, o);
    o += c.byteLength;
  }
  return { buf, overflow };
}

/**
 * GET http(s) desde el proceso actual (daemon). Re-chequea SSRF en cada hop.
 * Nunca sigue un Location a metadata / API origin.
 */
export async function runWebFetch(
  rawUrl: string,
  env: SsrfEnv = {},
): Promise<WebFetchResult> {
  let current = rawUrl;
  for (let hop = 0; hop <= FETCH_MAX_REDIRECTS; hop++) {
    const safe = await assertFetchUrlSafe(current, env);
    if (!safe.ok) {
      return { ok: false, url: current, text: safe.message, truncated: false, bytes: 0 };
    }
    const url = safe.url.toString();
    let res: Response;
    try {
      res = await fetch(url, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
          "User-Agent": FETCH_USER_AGENT,
          Accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.1",
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, url, text: `Fetch failed: ${msg}`, truncated: false, bytes: 0 };
    }

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) {
        return {
          ok: false,
          url,
          status: res.status,
          text: `Fetch failed: redirect ${res.status} without Location`,
          truncated: false,
          bytes: 0,
        };
      }
      current = new URL(loc, url).toString();
      continue;
    }

    const contentType = res.headers.get("content-type") || "";
    const { buf, overflow } = await readLimited(res);
    const bytes = buf.byteLength;

    if (!isTextContentType(contentType) && !isHtmlContentType(contentType)) {
      return {
        ok: res.ok,
        url,
        status: res.status,
        contentType,
        text: fetchBinaryOmitted(contentType.split(";")[0] || "", bytes),
        truncated: false,
        bytes,
      };
    }

    const raw = new TextDecoder("utf-8", { fatal: false }).decode(buf);
    const body = isHtmlContentType(contentType) ? htmlToText(raw) : raw;
    const cut = truncateBody(body || (overflow ? "" : ""));
    const text =
      cut.text ||
      (overflow
        ? truncateBody("x".repeat(FETCH_BODY_MAX_CHARS + 1)).text
        : FETCH_EMPTY);
    return {
      ok: res.ok,
      url,
      status: res.status,
      contentType,
      text,
      truncated: cut.truncated || overflow,
      bytes,
    };
  }
  return {
    ok: false,
    url: current,
    text: `Fetch failed: more than ${FETCH_MAX_REDIRECTS} redirects`,
    truncated: false,
    bytes: 0,
  };
}
```

Si `TOOL_OUTPUT_MAX_CHARS` ya existe en `cli/src/llm/tool-display.ts` **y** vale 8000, `FETCH_BODY_MAX_CHARS` se reexporta desde ahí o se deja el literal 8000 (mismo número). No truncar a otro tope.

- [ ] Tests `cli/src/llm/web-fetch-http.test.ts` — servidor local **fuera** del puerto API:

```ts
import { describe, expect, test, afterAll } from "bun:test";
import { FETCH_BODY_MAX_CHARS, SSRF_DENIED_METADATA } from "./web-fetch-constants";
import { runWebFetch } from "./web-fetch-http";

const apiUrl = "http://127.0.0.1:25001";

function startServer(handler: (req: Request) => Response | Promise<Response>) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: handler,
  });
  const origin = `http://127.0.0.1:${server.port}`;
  return { server, origin };
}

describe("runWebFetch", () => {
  const servers: Array<{ stop: () => void }> = [];
  afterAll(() => {
    for (const s of servers) s.stop();
  });

  test("returns bounded text from HTML", async () => {
    const { server, origin } = startServer(
      () =>
        new Response("<html><body><h1>Docs</h1><p>Outside the repo</p></body></html>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    );
    servers.push(server);
    const r = await runWebFetch(`${origin}/readme`, { apiUrl });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("Docs");
    expect(r.text).toContain("Outside the repo");
    expect(r.text).not.toContain("<h1>");
    expect(r.truncated).toBe(false);
  });

  test("truncates huge text", async () => {
    const { server, origin } = startServer(
      () =>
        new Response("y".repeat(FETCH_BODY_MAX_CHARS + 80), {
          headers: { "content-type": "text/plain" },
        }),
    );
    servers.push(server);
    const r = await runWebFetch(`${origin}/big`, { apiUrl });
    expect(r.text).toContain("[truncated:");
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThan(FETCH_BODY_MAX_CHARS + 80);
  });

  test("omits binary", async () => {
    const { server, origin } = startServer(
      () =>
        new Response(new Uint8Array([0, 1, 2, 3]), {
          headers: { "content-type": "application/octet-stream" },
        }),
    );
    servers.push(server);
    const r = await runWebFetch(`${origin}/bin`, { apiUrl });
    expect(r.text.startsWith("binary content omitted")).toBe(true);
  });

  test("refuses redirect to metadata", async () => {
    const { server, origin } = startServer(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data" },
        }),
    );
    servers.push(server);
    const r = await runWebFetch(`${origin}/bounce`, { apiUrl });
    expect(r.ok).toBe(false);
    expect(r.text).toBe(SSRF_DENIED_METADATA);
  });

  test("does not follow redirect to API origin", async () => {
    const { server, origin } = startServer(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1:25001/providers" },
        }),
    );
    servers.push(server);
    const r = await runWebFetch(`${origin}/to-api`, {
      apiUrl,
      lookup: async (h) => [h === "localhost" ? "127.0.0.1" : h],
    });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("Chavez API origin");
  });
});
```

- [ ] Correr:

```bash
cd cli && bun test src/llm/web-fetch-html.test.ts src/llm/web-fetch-http.test.ts
```

Esperado: HTML → texto; truncado con marcador; binario omitido; redirect a metadata/API denegado **sin** que el test-server reciba un segundo hop a esos destinos.

- [ ] Commit:

```bash
git add cli/src/llm/web-fetch-html.ts cli/src/llm/web-fetch-html.test.ts \
  cli/src/llm/web-fetch-http.ts cli/src/llm/web-fetch-http.test.ts
git commit -m "feat(fetch): daemon HTTP GET returns truncated text"
```

---

## Task 3: Gate — SSRF antes de ask; auto niega por plan 26

**Files:**

- Modify: `cli/src/llm/network-classify.ts` (si plan 26 lo creó; si no, crear el mínimo `isAlwaysNetworkTool`)
- Test: `cli/src/llm/network-classify.test.ts` (extender)
- Modify: `cli/src/llm/can-use-tool.ts` (si plan 3/26 lo creó; si no, crear `decideCanUseTool` mínimo)
- Test: `cli/src/llm/can-use-tool.fetch.test.ts`
- Modify: `cli/src/llm/tool-names.ts`
- Test: `cli/src/llm/tool-names.test.ts` (extender)
- Modify: `cli/src/llm/tool-display.ts`
- Test: `cli/src/llm/tool-display.test.ts` (extender)
- Modify: `cli/src/llm/approval-prompt.ts` (si existe)
- Test: `cli/src/llm/approval-prompt.test.ts` (extender o crear)
- Create: `cli/src/llm/web-fetch-gate.ts`
- Test: `cli/src/llm/web-fetch-gate.test.ts`

SSRF **antes** de `gateNetwork`: el usuario no ve un pedido para fetchear metadata. Auto **no** pregunta: `NETWORK_DENIED_AUTO`.

- [ ] En `cli/src/llm/network-classify.ts` `isAlwaysNetworkTool`, **añadir** (dejar el set `NETWORK_SDK_TOOLS` intacto):

```ts
import { isFetchSdkName, WEB_FETCH_SDK_NAME } from "./web-fetch-constants";

export function isAlwaysNetworkTool(sdkName: string): boolean {
  if (NETWORK_SDK_TOOLS.has(sdkName)) return true;
  if (isFetchSdkName(sdkName)) return true;
  if (sdkName === WEB_FETCH_SDK_NAME) return true;
  const lower = sdkName.toLowerCase();
  if (lower === "webfetch" || lower === "websearch" || lower === "webbrowser") {
    return true;
  }
  if (lower.includes("webfetch") || lower.includes("web_fetch")) return true;
  return false;
}
```

Si el archivo **no** existe, crear solo esta función + import del set local:

```ts
const NETWORK_SDK_TOOLS = new Set(["WebFetch", "WebSearch", "WebBrowser"]);
```

y documentar que plan 26 unifica. No implementar clasificación de bash aquí.

- [ ] Crear `cli/src/llm/web-fetch-gate.ts`:

```ts
import type { ExecutionMode } from "./execution-mode";
import { gateWebFetch } from "./network-fetch";
import { isFetchSdkName } from "./web-fetch-constants";
import { assertFetchUrlSafe, urlFromToolInput, type SsrfEnv } from "./web-fetch-ssrf";

export { isFetchSdkName };

export async function denyIfSsrfAsync(
  sdkName: string,
  input: Record<string, unknown> | null,
  env: SsrfEnv = {},
): Promise<{ behavior: "deny"; message: string } | null> {
  if (!isFetchSdkName(sdkName)) return null;
  const url = urlFromToolInput(input);
  if (!url) {
    return { behavior: "deny", message: "Fetch blocked: url is required." };
  }
  const safe = await assertFetchUrlSafe(url, env);
  if (!safe.ok) return { behavior: "deny", message: safe.message };
  return null;
}

/**
 * Política fetch: SSRF luego modo (plan 26). No reimplementa NETWORK_DENIED_*.
 */
export async function decideFetch(
  mode: ExecutionMode,
  sdkName: string,
  input: Record<string, unknown> | null,
  env: SsrfEnv = {},
): Promise<
  | { action: "deny"; message: string }
  | { action: "ask"; url: string }
  | { action: "allow"; url: string }
> {
  const ssrf = await denyIfSsrfAsync(sdkName, input, env);
  if (ssrf) return { action: "deny", message: ssrf.message };
  const url = urlFromToolInput(input);
  const g = gateWebFetch(mode, url);
  if (g.action === "deny") {
    return { action: "deny", message: g.message || "Network denied." };
  }
  if (g.action === "ask") return { action: "ask", url };
  return { action: "allow", url };
}
```

Si `cli/src/llm/network-fetch.ts` **no** existe (plan 26 no mergeado), inlinar el mínimo:

```ts
import { gateNetwork } from "./network-gate";
export function gateWebFetch(mode: ExecutionMode, url: string) {
  return gateNetwork(mode, "WebFetch", { url });
}
```

Si `network-gate.ts` tampoco existe, copiar `gateNetwork` de sandbox-network Task 1 **antes** de seguir (auto → `NETWORK_DENIED_AUTO`, ask → ask, plan → `NETWORK_DENIED_PLAN`). No implementar wrap de bash.

Si `execution-mode.ts` no existe:

```ts
export type ExecutionMode = "plan" | "auto" | "ask";
```

en `web-fetch-gate.ts`.

- [ ] Tests `cli/src/llm/web-fetch-gate.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { NETWORK_DENIED_AUTO, NETWORK_DENIED_PLAN } from "./network-constants";
import { SSRF_DENIED_METADATA } from "./web-fetch-constants";
import { decideFetch } from "./web-fetch-gate";

const env = {
  apiUrl: "http://localhost:25001",
  lookup: async (h: string) => {
    if (h === "example.com") return ["93.184.216.34"];
    if (h === "localhost") return ["127.0.0.1"];
    return [h];
  },
};

test("auto denies public URL (plan 26)", async () => {
  const d = await decideFetch("auto", "WebFetch", { url: "https://example.com/doc" }, env);
  expect(d.action).toBe("deny");
  if (d.action === "deny") expect(d.message).toBe(NETWORK_DENIED_AUTO);
});

test("ask asks for public URL", async () => {
  const d = await decideFetch("ask", "mcp__chavez-web__fetch", { url: "https://example.com/doc" }, env);
  expect(d.action).toBe("ask");
});

test("plan denies", async () => {
  const d = await decideFetch("plan", "WebFetch", { url: "https://example.com/doc" }, env);
  expect(d.action).toBe("deny");
  if (d.action === "deny") {
    expect([NETWORK_DENIED_PLAN].includes(d.message) || d.message.includes("Plan mode")).toBe(true);
  }
});

test("SSRF wins before ask — user never sees metadata approval", async () => {
  const d = await decideFetch(
    "ask",
    "WebFetch",
    { url: "http://169.254.169.254/latest/meta-data" },
    env,
  );
  expect(d.action).toBe("deny");
  if (d.action === "deny") expect(d.message).toBe(SSRF_DENIED_METADATA);
});
```

Si `network-constants.ts` no existe, importar los literales desde sandbox-network (copiar las 3 consts a `web-fetch-constants.ts` **solo entonces**, mismos strings).

- [ ] En `cli/src/llm/can-use-tool.ts` `decideCanUseTool`, **después** de `denyIfBashEscapes` y **antes** de `gateMutation`:

```ts
import { denyIfSsrfAsync } from "./web-fetch-gate";

const ssrf = await denyIfSsrfAsync(input.toolName, input.toolInput, {
  apiUrl: process.env.CHAVEZ_API_URL,
});
if (ssrf) return ssrf;
```

No mover `gateNetwork`. Fetch en auto sigue muriendo en el paso 5 con `NETWORK_DENIED_AUTO`.

Si `decideCanUseTool` **no** existe, crear el archivo con: path sandbox (si `denyIfEscapes` existe) → SSRF → `gateMutation` (si existe) → `gateNetwork`/`decideFetch` → ask inyectable. Copiar la firma de sandbox-network Task 3. No implementar wrap `bwrap`.

- [ ] Test `cli/src/llm/can-use-tool.fetch.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { decideCanUseTool } from "./can-use-tool";
import { NETWORK_DENIED_AUTO, NETWORK_DENIED_ASK } from "./network-constants";
import { SSRF_DENIED_METADATA } from "./web-fetch-constants";

const cwd = process.cwd();

test("auto + WebFetch denies without calling ask", async () => {
  let asked = 0;
  const r = await decideCanUseTool({
    cwd,
    executionMode: "auto",
    toolName: "WebFetch",
    toolInput: { url: "https://example.com" },
    ask: async () => {
      asked += 1;
      return "approve";
    },
  });
  expect(r.behavior).toBe("deny");
  expect(r.message).toBe(NETWORK_DENIED_AUTO);
  expect(asked).toBe(0);
});

test("ask + metadata never asks", async () => {
  let asked = 0;
  const r = await decideCanUseTool({
    cwd,
    executionMode: "ask",
    toolName: "WebFetch",
    toolInput: { url: "http://169.254.169.254/latest" },
    ask: async () => {
      asked += 1;
      return "approve";
    },
  });
  expect(r.behavior).toBe("deny");
  expect(r.message).toBe(SSRF_DENIED_METADATA);
  expect(asked).toBe(0);
});

test("ask + fetch deny = 0 packets (no allow)", async () => {
  const r = await decideCanUseTool({
    cwd,
    executionMode: "ask",
    toolName: "mcp__chavez-web__fetch",
    toolInput: { url: "https://example.com" },
    ask: async () => "deny",
  });
  expect(r.behavior).toBe("deny");
  expect(r.message).toBe(NETWORK_DENIED_ASK);
  expect("updatedInput" in r ? r.updatedInput : undefined).toBeUndefined();
});
```

El test de auto asume que `https://example.com` pasa SSRF (lookup real o mock). Si el entorno no resuelve, inyectar lookup vía arg opcional `ssrfEnv` en `decideCanUseTool`:

```ts
ssrfEnv?: SsrfEnv;
```

y en el test pasar `lookup: async () => ["93.184.216.34"]`. Añadir el arg si hace falta; default `process.env.CHAVEZ_API_URL`.

- [ ] En `cli/src/llm/tool-names.ts` extender `CANONICAL`:

```ts
WebFetch: "fetch",
web_fetch: "fetch",
webFetch: "fetch",
"mcp__chavez-web__fetch": "fetch",
```

`toolClass("WebFetch")` debe ser `"other"` (no read). No meter fetch en `READ_SDK`. Tests: `canonicalToolName("WebFetch") === "fetch"`, `canonicalToolName("mcp__chavez-web__fetch") === "fetch"`.

Si `tool-names.ts` no existe, crear solo el mapa fetch + `canonicalToolName` fallback `toLowerCase()`, y dejar que plan 2 lo unifique.

- [ ] En `cli/src/llm/tool-display.ts` `summarizeToolInput`, **antes** del fallback JSON:

```ts
if (name === "fetch" || canonicalToolName(sdkName) === "fetch") {
  const url = str(rec.url) || str(rec.uri) || "";
  return url ? redactSecrets(url).slice(0, 200) : "fetch";
}
```

Test: `summarizeToolInput("WebFetch", { url: "https://example.com/a" }) === "https://example.com/a"`.

- [ ] En `cli/src/llm/approval-prompt.ts`, si el kind `fetch` del plan 26 **no** está, añadirlo. `buildApprovalPrompt("WebFetch", { url }, null, true)` → `{ kind: "fetch", url: "…", needsNetwork: true }`. `formatApprovalHeadline` contiene `pide red` y la URL.

- [ ] Correr:

```bash
cd cli && bun test src/llm/web-fetch-gate.test.ts src/llm/can-use-tool.fetch.test.ts \
  src/llm/tool-names.test.ts src/llm/tool-display.test.ts src/llm/approval-prompt.test.ts \
  src/llm/network-classify.test.ts
```

Omitir archivos de test que no existan. Esperado: auto niega sin ask; metadata no pregunta; deny ask sin `updatedInput`; canonical `fetch`.

- [ ] Commit:

```bash
git add cli/src/llm/web-fetch-gate.ts cli/src/llm/web-fetch-gate.test.ts \
  cli/src/llm/can-use-tool.ts cli/src/llm/can-use-tool.fetch.test.ts \
  cli/src/llm/network-classify.ts cli/src/llm/network-classify.test.ts \
  cli/src/llm/tool-names.ts cli/src/llm/tool-names.test.ts \
  cli/src/llm/tool-display.ts cli/src/llm/tool-display.test.ts \
  cli/src/llm/approval-prompt.ts cli/src/llm/approval-prompt.test.ts \
  cli/src/llm/network-fetch.ts cli/src/llm/network-gate.ts \
  cli/src/llm/network-constants.ts cli/src/llm/execution-mode.ts
git commit -m "feat(fetch): gate SSRF then plan-26 network policy"
```

No añadir archivos que no se hayan creado.

---

## Task 4: Host tool Claude — no es MCP de usuario; alias WebFetch

**Files:**

- Create: `cli/src/llm/web-fetch-mcp.ts`
- Test: `cli/src/llm/web-fetch-mcp.test.ts`
- Modify: `cli/src/llm/claude-runner.ts`
- Test: `cli/src/llm/claude-runner.fetch.test.ts`

El SDK Claude **no** ejecuta su WebFetch in-process. `toolAliases` redirige `WebFetch` → `mcp__chavez-web__fetch`. `disallowedTools` bloquea el built-in. El servidor host no se lee de `.mcp.json`.

- [ ] Crear `cli/src/llm/web-fetch-mcp.ts`:

```ts
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  WEB_FETCH_MCP_SERVER,
  WEB_FETCH_TOOL_ID,
} from "./web-fetch-constants";
import { runWebFetch } from "./web-fetch-http";
import type { SsrfEnv } from "./web-fetch-ssrf";

function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], isError };
}

export type WebFetchMcpContext = {
  ssrfEnv?: SsrfEnv;
};

export function createWebFetchMcpServer(ctx: WebFetchMcpContext = {}) {
  return createSdkMcpServer({
    name: WEB_FETCH_MCP_SERVER,
    version: "1.0.0",
    alwaysLoad: true,
    instructions:
      "Use fetch to read http(s) docs outside the repo. Not a browser. User MCP browsers do not replace this tool.",
    tools: [
      tool(
        WEB_FETCH_TOOL_ID,
        "Fetch an http(s) URL from the daemon machine and return truncated text. Use for docs outside the workspace. Never fetch localhost of the Chavez API or cloud metadata.",
        { url: z.string() },
        async (args) => {
          const url = String(args.url || "");
          const r = await runWebFetch(url, ctx.ssrfEnv);
          return textResult(r.text, !r.ok);
        },
      ),
    ],
  });
}

export function mergeWebFetchMcp<T extends Record<string, unknown>>(
  existing: T | undefined,
): T & Record<string, ReturnType<typeof createWebFetchMcpServer>> {
  const src = { ...(existing || {}) } as Record<string, unknown>;
  if (src[WEB_FETCH_MCP_SERVER]) {
    src[`${WEB_FETCH_MCP_SERVER}-project`] = src[WEB_FETCH_MCP_SERVER];
  }
  src[WEB_FETCH_MCP_SERVER] = createWebFetchMcpServer();
  return src as T & Record<string, ReturnType<typeof createWebFetchMcpServer>>;
}
```

El handler **vuelve a** correr `runWebFetch` (SSRF defensa en profundidad). `canUseTool` ya negó auto/plan/SSRF; si el SDK llama el handler sin gate, el GET público en auto **no** debe ocurrir porque `canUseTool` deny corta antes. Test de Task 3 cubre el deny.

- [ ] Tests `cli/src/llm/web-fetch-mcp.test.ts` — no llaman `query()`:

```ts
import { describe, expect, test } from "bun:test";
import {
  WEB_FETCH_DISALLOWED,
  WEB_FETCH_MCP_SERVER,
  WEB_FETCH_SDK_NAME,
  WEB_FETCH_TOOL_ALIASES,
} from "./web-fetch-constants";
import { mergeWebFetchMcp } from "./web-fetch-mcp";

test("host server is present without project MCP", () => {
  const merged = mergeWebFetchMcp(undefined);
  expect(merged[WEB_FETCH_MCP_SERVER]).toBeTruthy();
});

test("project MCP does not replace host fetch", () => {
  const fake = { name: "user-browser" };
  const merged = mergeWebFetchMcp({
    [WEB_FETCH_MCP_SERVER]: fake,
    playwright: { name: "playwright" },
  } as Record<string, unknown>);
  expect(merged.playwright).toEqual({ name: "playwright" });
  expect(merged[`${WEB_FETCH_MCP_SERVER}-project`]).toEqual(fake);
  expect(merged[WEB_FETCH_MCP_SERVER]).not.toEqual(fake);
});

test("alias and disallowed built-ins", () => {
  expect(WEB_FETCH_TOOL_ALIASES.WebFetch).toBe(WEB_FETCH_SDK_NAME);
  expect(WEB_FETCH_DISALLOWED).toContain("WebFetch");
  expect(WEB_FETCH_DISALLOWED).toContain("WebSearch");
});
```

- [ ] En `cli/src/llm/claude-runner.ts` options de `query` (después de `tools` / `allowedTools` / `canUseTool` de planes 2–3/26):

```ts
import {
  WEB_FETCH_DISALLOWED,
  WEB_FETCH_SDK_NAME,
  WEB_FETCH_TOOL_ALIASES,
} from "./web-fetch-constants";
import { mergeWebFetchMcp } from "./web-fetch-mcp";

options.mcpServers = mergeWebFetchMcp(
  (options.mcpServers as Record<string, unknown> | undefined) ?? {},
);
const allowed = new Set<string>([
  ...((options.allowedTools as string[]) || []),
  ...((options.tools as string[]) || []),
  WEB_FETCH_SDK_NAME,
]);
options.allowedTools = [...allowed];
options.disallowedTools = [
  ...new Set([
    ...((options.disallowedTools as string[]) || []),
    ...WEB_FETCH_DISALLOWED,
  ]),
];
options.toolAliases = {
  ...((options.toolAliases as Record<string, string>) || {}),
  ...WEB_FETCH_TOOL_ALIASES,
};
```

`DEFAULT_CLAUDE_TOOLS` **sigue siendo las 6 de FS**. Fetch se añade en `allowedTools`, no se mete en el array de las 6 (plan 2 no se reescribe). `settingSources: []` se mantiene: no se carga `~/.claude/mcp.json`.

`canUseTool` ya delega en `decideCanUseTool`. No volver a `bypassPermissions`.

- [ ] Test `cli/src/llm/claude-runner.fetch.test.ts` — **no** llama Anthropic. Extraer `buildClaudeQueryOptions(input)` si el runner no es testeable; si no se quiere extraer, testear un helper exportado `claudeFetchToolOptions(base)` en `web-fetch-mcp.ts`:

```ts
export function applyWebFetchToQueryOptions(options: Record<string, unknown>) {
  options.mcpServers = mergeWebFetchMcp(
    (options.mcpServers as Record<string, unknown> | undefined) ?? {},
  );
  // … mismo bloque allowed/disallowed/aliases
  return options;
}
```

El runner llama `applyWebFetchToQueryOptions(options)` para no duplicar. Test:

```ts
test("empty project MCP still has host fetch", () => {
  const o = applyWebFetchToQueryOptions({
    tools: ["Read", "Write", "Edit", "Grep", "Glob", "Bash"],
    allowedTools: ["Read", "Write", "Edit", "Grep", "Glob", "Bash"],
    mcpServers: {},
  });
  expect((o.allowedTools as string[]).includes("mcp__chavez-web__fetch")).toBe(true);
  expect((o.disallowedTools as string[]).includes("WebFetch")).toBe(true);
  expect((o.toolAliases as Record<string, string>).WebFetch).toBe(
    "mcp__chavez-web__fetch",
  );
  expect((o.mcpServers as Record<string, unknown>)["chavez-web"]).toBeTruthy();
});
```

- [ ] Correr:

```bash
cd cli && bun test src/llm/web-fetch-mcp.test.ts src/llm/claude-runner.fetch.test.ts
```

- [ ] Commit:

```bash
git add cli/src/llm/web-fetch-mcp.ts cli/src/llm/web-fetch-mcp.test.ts \
  cli/src/llm/claude-runner.ts cli/src/llm/claude-runner.fetch.test.ts
git commit -m "feat(fetch): host WebFetch on daemon, not user MCP"
```

---

## Task 5: Cursor — mismo `runWebFetch`, nunca cloud

**Files:**

- Modify: `cli/src/llm/cursor-tools.ts` (si plan 4 lo creó)
- Modify: `cli/src/llm/cursor-runner.ts` (solo si existe)
- Test: `cli/src/llm/cursor-runner.fetch.test.ts`
- Create: `cli/src/llm/web-fetch-cursor.ts`
- Test: `cli/src/llm/web-fetch-cursor.test.ts`

Si `cli/src/llm/cursor-runner.ts` **no** existe, esta task crea `web-fetch-cursor.ts` + tests del handler y **no** toca un runner inexistente. Cuando plan 4 aterrice, el runner importa `cursorWebFetchCustomTool`.

Cursor `local.customTools` **salta** el approval del SDK: el `execute` **debe** llamar `decideFetch` / waiter. **Nunca** `cloud`.

- [ ] Crear `cli/src/llm/web-fetch-cursor.ts`:

```ts
import { WEB_FETCH_CURSOR_NAME } from "./web-fetch-constants";
import { decideFetch } from "./web-fetch-gate";
import { runWebFetch } from "./web-fetch-http";
import type { ExecutionMode } from "./execution-mode";
import { NETWORK_DENIED_ASK } from "./network-constants";
import { ASK_TIMEOUT_DENIED } from "./execution-mode";
import type { SsrfEnv } from "./web-fetch-ssrf";

export type CursorFetchAsk = () => Promise<"approve" | "deny" | "timeout" | "cancelled">;

export function cursorWebFetchCustomTool(opts: {
  executionMode: ExecutionMode;
  ask?: CursorFetchAsk;
  ssrfEnv?: SsrfEnv;
}) {
  return {
    [WEB_FETCH_CURSOR_NAME]: {
      description:
        "Fetch an http(s) URL from the daemon machine and return truncated text. Not a cloud browser.",
      inputSchema: {
        type: "object",
        properties: { url: { type: "string", description: "http(s) URL" } },
        required: ["url"],
      },
      annotations: {
        title: "fetch",
        readOnlyHint: true,
        openWorldHint: true,
      },
      async execute(args: Record<string, unknown>) {
        const url = String(args.url || "");
        const d = await decideFetch(
          opts.executionMode,
          WEB_FETCH_CURSOR_NAME,
          { url },
          opts.ssrfEnv,
        );
        if (d.action === "deny") return d.message;
        if (d.action === "ask") {
          const outcome = (await opts.ask?.()) ?? "deny";
          if (outcome !== "approve") {
            return outcome === "timeout" ? ASK_TIMEOUT_DENIED : NETWORK_DENIED_ASK;
          }
        }
        const r = await runWebFetch(url, opts.ssrfEnv);
        return r.text;
      },
    },
  };
}
```

Si `ASK_TIMEOUT_DENIED` no está en `execution-mode.ts`, usar el literal `"Approval timed out after 300s — tool denied"`.

- [ ] Tests `cli/src/llm/web-fetch-cursor.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { NETWORK_DENIED_AUTO, NETWORK_DENIED_ASK } from "./network-constants";
import { cursorWebFetchCustomTool } from "./web-fetch-cursor";

const env = { apiUrl: "http://localhost:25001", lookup: async () => ["93.184.216.34"] };

test("auto execute does not GET", async () => {
  const tools = cursorWebFetchCustomTool({ executionMode: "auto", ssrfEnv: env });
  const out = await tools.web_fetch.execute({ url: "https://example.com/doc" });
  expect(out).toBe(NETWORK_DENIED_AUTO);
});

test("ask deny does not GET", async () => {
  const tools = cursorWebFetchCustomTool({
    executionMode: "ask",
    ssrfEnv: env,
    ask: async () => "deny",
  });
  const out = await tools.web_fetch.execute({ url: "https://example.com/doc" });
  expect(out).toBe(NETWORK_DENIED_ASK);
});
```

- [ ] Si `cursor-runner.ts` existe, en `Agent.create`:

```ts
import { cursorWebFetchCustomTool } from "./web-fetch-cursor";

local: {
  cwd: input.cwd,
  store,
  customTools: {
    ...cursorWebFetchCustomTool({
      executionMode: input.executionMode,
      ask: input.onAskPermission
        ? async () =>
            input.onAskPermission!({
              toolCallId: crypto.randomUUID(),
              toolName: "web_fetch",
              input: { url: "" },
              signal: input.signal ?? new AbortController().signal,
              needsNetwork: true,
            })
        : undefined,
      ssrfEnv: { apiUrl: process.env.CHAVEZ_API_URL },
    }),
  },
}
```

El `ask` real debe recibir el `url` del `execute` (closure por call, no el `{ url: "" }` de create). Implementar el custom tool **dentro** de `runCursorTurn` **o** pasar `ask` que ignore el url de create y lea el de `execute` — `cursorWebFetchCustomTool` ya usa el `url` de `args` en `decideFetch`; el waiter de publish-turn necesita ese url en `onAskPermission.input`. Cambiar `CursorFetchAsk` a:

```ts
export type CursorFetchAsk = (req: {
  url: string;
}) => Promise<"approve" | "deny" | "timeout" | "cancelled">;
```

y en `execute`, `opts.ask?.({ url })`. En el runner:

```ts
ask: async ({ url }) =>
  input.onAskPermission!({
    toolCallId: crypto.randomUUID(),
    toolName: "web_fetch",
    input: { url },
    signal: input.signal ?? new AbortController().signal,
    needsNetwork: true,
  }),
```

**Nunca** pasar `cloud` / `repos` / `autoCreatePR`. Si el plan 4 lista `tools: [...DEFAULT_CURSOR_TOOLS]`, **no** añadir `"webFetch"` al allowlist (nombre desconocido → `ConfigurationError`). El custom tool se descubre solo.

- [ ] Si `canonicalCursorToolName` existe, mapear `web_fetch` / `webFetch` → `fetch`.

- [ ] Test runner (solo si el archivo existe) `cli/src/llm/cursor-runner.fetch.test.ts`: `createAgent` inyectable; `local.customTools.web_fetch` definido; `cloud` undefined.

- [ ] Correr:

```bash
cd cli && bun test src/llm/web-fetch-cursor.test.ts src/llm/cursor-runner.fetch.test.ts
```

Omitir el segundo si el runner no existe.

- [ ] Commit:

```bash
git add cli/src/llm/web-fetch-cursor.ts cli/src/llm/web-fetch-cursor.test.ts \
  cli/src/llm/cursor-runner.ts cli/src/llm/cursor-runner.fetch.test.ts \
  cli/src/llm/cursor-tools.ts
git commit -m "feat(fetch): Cursor local web_fetch uses the same SSRF gate"
```

No incluir `cursor-runner.ts` si no cambió.

---

## Task 6: Timeline — `kind=fetch`, URL en awaiting_approval, output acotado

**Files:**

- Modify: `cli/src/llm/publish-turn.ts`
- Test: `cli/src/llm/publish-turn.fetch.test.ts`
- Modify: `cli/src/llm/watch-format.ts` (si existe)
- Test: `cli/src/llm/watch-format.test.ts` (extender)
- Modify: `api/src/ws/handlers.ts` (solo si `chat.tool.update` **no** hace spread de `metadata`; entonces spread `kind`/`url`/`needsNetwork`/`prompt`)
- Test: `api/src/ws/tool-protocol.test.ts` (extender si existe)

La API no fetchea. Solo persiste lo que el daemon manda.

- [ ] En `cli/src/llm/publish-turn.ts`, al emitir `chat.tool.start` / `update` / `result`, si `isFetchSdkName(sdkName)`:

```ts
kind: "fetch",
url: urlFromToolInput(asRecord(input)),
needsNetwork: true,
```

`content` / headline = `toolHeadline(sdkName, status, input)` si existe; si no, `tool · fetch · ${status}  ${url}`.

`onAskPermission` (si el plan 3/13/26 lo cableó): para fetch, `prompt = { kind: "fetch", url, needsNetwork: true }` y `status: "awaiting_approval"`. Reusar `buildApprovalPrompt` si existe.

Output: `stringifyToolOutput` / `truncateToolText` **ya** acotan a 8000. El handler ya acota; un segundo corte es idempotente si el marcador ya está.

- [ ] Test `cli/src/llm/publish-turn.fetch.test.ts` — extraer `fetchToolMetadata(sdkName, input, status, output?)` a `cli/src/llm/web-fetch-display.ts` para no mockear WS:

```ts
import { describe, expect, test } from "bun:test";
import { fetchToolMetadata } from "./web-fetch-display";

test("awaiting_approval carries URL", () => {
  const m = fetchToolMetadata("WebFetch", { url: "https://example.com/doc" }, "awaiting_approval");
  expect(m.kind).toBe("fetch");
  expect(m.toolName).toBe("fetch");
  expect(m.url).toBe("https://example.com/doc");
  expect(m.needsNetwork).toBe(true);
  expect(m.prompt).toEqual({
    kind: "fetch",
    url: "https://example.com/doc",
    needsNetwork: true,
  });
  expect(m.status).toBe("awaiting_approval");
});

test("done output stays truncated", () => {
  const big = "z".repeat(9000);
  const m = fetchToolMetadata("mcp__chavez-web__fetch", { url: "https://x" }, "done", big);
  expect(String(m.output)).toContain("[truncated:");
  expect(m.truncated).toBe(true);
});
```

```ts
// cli/src/llm/web-fetch-display.ts
import { canonicalToolName } from "./tool-names";
import { stringifyToolOutput, TOOL_OUTPUT_MAX_CHARS } from "./tool-display";
import { isFetchSdkName } from "./web-fetch-constants";
import { urlFromToolInput } from "./web-fetch-ssrf";

export function fetchToolMetadata(
  sdkName: string,
  input: Record<string, unknown> | null,
  status: string,
  output?: string,
) {
  const url = urlFromToolInput(input);
  const out = output != null ? stringifyToolOutput(output) : undefined;
  return {
    sdkName,
    toolName: isFetchSdkName(sdkName) ? "fetch" : canonicalToolName(sdkName),
    kind: "fetch" as const,
    status,
    input: { url },
    url,
    summary: url,
    needsNetwork: true as const,
    prompt: { kind: "fetch" as const, url, needsNetwork: true as const },
    output: out,
    truncated: typeof output === "string" && output.length > TOOL_OUTPUT_MAX_CHARS,
  };
}
```

Si `tool-display.ts` no existe, truncar con `FETCH_BODY_MAX_CHARS` y el mismo marcador `[truncated: showing ${max} of ${n} chars]`.

`publish-turn` usa `fetchToolMetadata` en start/update/result de fetch (spread sobre el metadata existente).

- [ ] Si `cli/src/llm/watch-format.ts` existe, en `awaiting_approval` + fetch:

```
tool · fetch · awaiting_approval  pide red · <url>
```

Test: la línea contiene la URL y `pide red`. Si el archivo no existe, no crearlo (el JSON de watch ya lleva `metadata.url`).

- [ ] En `api/src/ws/handlers.ts` `chat.tool.update` / `start`: el spread de `msg.metadata` del plan 2 **debe** conservar `kind`, `url`, `needsNetwork`, `prompt`. Si hoy se construye un objeto fijo que **tira** keys extra, añadir esas cuatro. **No** llamar `fetch()` en la API.

- [ ] Correr:

```bash
cd cli && bun test src/llm/publish-turn.fetch.test.ts src/llm/watch-format.test.ts
```

- [ ] Commit:

```bash
git add cli/src/llm/web-fetch-display.ts cli/src/llm/publish-turn.ts \
  cli/src/llm/publish-turn.fetch.test.ts cli/src/llm/watch-format.ts \
  cli/src/llm/watch-format.test.ts api/src/ws/handlers.ts \
  api/src/ws/tool-protocol.ts api/src/ws/tool-protocol.test.ts
git commit -m "feat(fetch): timeline shows URL, pide red, truncated text"
```

---

## Task 7: Web — ToolCard pinta URL, approval y texto acotado

**Files:**

- Create: `web/src/lib/fetch-display.ts`
- Test: `web/src/lib/fetch-display.test.ts`
- Modify: `web/src/lib/tool-display.ts` (si plan 2 lo creó)
- Test: `web/src/lib/tool-display.test.ts` (extender)
- Modify: `web/src/components/ChatDetailPanel.tsx`
- Modify: `web/src/components/WorkspaceDetailPanel.tsx`
- Modify: `web/src/styles/global.css`
- Modify: `web/package.json`

Web **no** importa CLI. Keep-in-sync: canonical `fetch`, label `pide red`, truncado 8000.

- [ ] Añadir `"test": "bun test"` en `web/package.json` si falta (dejar `dev`/`build`/`start`).

- [ ] Crear `web/src/lib/fetch-display.ts`:

```ts
// keep-in-sync: cli/src/llm/web-fetch-constants.ts, cli/src/llm/web-fetch-display.ts
export const NETWORK_REQUEST_LABEL = "pide red";
export const FETCH_BODY_MAX_CHARS = 8000;

export function isFetchTool(meta: Record<string, unknown> | null | undefined): boolean {
  if (!meta) return false;
  const kind = String(meta.kind || "");
  const name = String(meta.toolName || meta.sdkName || "").toLowerCase();
  return kind === "fetch" || name === "fetch" || name === "webfetch" || name === "web_fetch";
}

export function fetchUrlFromMeta(meta: Record<string, unknown> | null | undefined): string {
  if (!meta) return "";
  if (typeof meta.url === "string" && meta.url) return meta.url;
  const prompt = meta.prompt as { url?: string } | undefined;
  if (prompt && typeof prompt.url === "string") return prompt.url;
  const input = meta.input as { url?: string } | undefined;
  if (input && typeof input.url === "string") return input.url;
  return "";
}

export function fetchHeadline(meta: Record<string, unknown>): string {
  const status = String(meta.status || "running");
  const url = fetchUrlFromMeta(meta);
  const net =
    meta.needsNetwork === true || status === "awaiting_approval"
      ? `${NETWORK_REQUEST_LABEL} · `
      : "";
  return url
    ? `tool · fetch · ${status}  ${net}${url}`
    : `tool · fetch · ${status}`;
}
```

- [ ] Tests `web/src/lib/fetch-display.test.ts`: URL en awaiting_approval; headline contiene `pide red` y `https://example.com/doc`.

- [ ] Si `web/src/lib/tool-display.ts` existe, `summarizeToolInput` para fetch = URL (mismo que CLI). Si no, `ChatDetailPanel` usa `fetchHeadline`.

- [ ] En `ChatDetailPanel.tsx` `ToolCard`:

  1. Si `isFetchTool(meta)`, el badge usa `fetchHeadline(meta)` (no JSON crudo de input como único título).
  2. Mostrar la URL en un `<code className="fetch-url">`.
  3. Si `status === "awaiting_approval"`, los botones Aprobar/Denegar del plan 13 **siguen** (una a una). No añadir “siempre permitir”.
  4. Output en `<pre>`: el string ya viene truncado; no rehidratar HTML.
  5. Badge `pide red` si `needsNetwork === true` (plan 26). Si el badge ya existe, no duplicarlo.

- [ ] En `WorkspaceDetailPanel.tsx` `previewLabel`, si role tool y fetch: `tool · fetch · ${status}` (no pegar el body).

- [ ] CSS mínimo en `web/src/styles/global.css`:

```css
.fetch-url {
  display: block;
  margin-top: 0.35rem;
  font-family: var(--mono);
  font-size: 0.8rem;
  color: var(--muted);
  word-break: break-all;
}
```

- [ ] Correr:

```bash
cd web && bun test src/lib/fetch-display.test.ts src/lib/tool-display.test.ts
```

Omitir el segundo si no existe.

- [ ] Commit:

```bash
git add web/package.json web/src/lib/fetch-display.ts \
  web/src/lib/fetch-display.test.ts web/src/lib/tool-display.ts \
  web/src/lib/tool-display.test.ts web/src/components/ChatDetailPanel.tsx \
  web/src/components/WorkspaceDetailPanel.tsx web/src/styles/global.css
git commit -m "feat(fetch): Web ToolCard shows URL and truncated body"
```

---

## Task 8: TUI + CLI watch — misma URL en vivo

**Files:**

- Modify: `tui/src/App.tsx`
- Modify: `tui/package.json`
- Test: `tui/src/fetch-format.test.ts`
- Modify: `cli/src/commands/headless.ts` (solo si watch no usa `formatWatchLine` y hay que anotar fetch; preferir Task 6)
- Modify: `cli/src/llm/watch-format.ts` (si Task 6 no lo cerró)

TUI ya importa `cli/src/llm/*`. Reusar `toolHeadline` / `fetchHeadline` CLI.

- [ ] Extraer en `tui/src/App.tsx` (o importar de CLI) el pintado de tool fetch:

```ts
import { canonicalToolName } from "../../cli/src/llm/tool-names";
import { toolHeadline } from "../../cli/src/llm/tool-display";
import { isFetchSdkName } from "../../cli/src/llm/web-fetch-constants";
import { NETWORK_REQUEST_LABEL } from "../../cli/src/llm/network-constants";
```

Si `tool-display.ts` no existe, helper local:

```ts
function formatFetchLine(meta: Record<string, unknown>): string {
  const status = String(meta.status || "running");
  const url = String(meta.url || (meta.input as { url?: string } | undefined)?.url || "");
  const net = meta.needsNetwork === true ? `${NETWORK_REQUEST_LABEL} · ` : "";
  return `tool · fetch · ${status}  ${net}${url}`.trim();
}
```

En `formatTuiMessage`, si `isFetchSdkName(sdkName) || meta.kind === "fetch"`, usar esa línea. Color: `awaiting_approval` magenta, `error` red, `done` cyan, `running` yellow.

El compositor busy del plan 2/13 permanece. Un fetch `awaiting_approval` muestra la URL en el banner si el plan 13 ya tiene banner de approval; **añadir** la URL si el banner solo dice el nombre de la tool:

```tsx
{pendingFetchUrl ? (
  <Text color="magenta">
    pide red · fetch · {pendingFetchUrl}  [y]/[n]
  </Text>
) : null}
```

`pendingFetchUrl` = primer mensaje tool del chat activo con `status === "awaiting_approval"` y kind fetch. Approve/deny **una a una** (teclas del plan 13). No lote.

- [ ] Test puro `tui/src/fetch-format.test.ts` del helper (mover el helper a `tui/src/lib/fetch-format.ts` si hace falta para testear sin Ink):

```ts
import { describe, expect, test } from "bun:test";
import { formatFetchLine } from "./lib/fetch-format";

test("shows url while awaiting", () => {
  const line = formatFetchLine({
    kind: "fetch",
    status: "awaiting_approval",
    url: "https://example.com/doc",
    needsNetwork: true,
  });
  expect(line).toContain("https://example.com/doc");
  expect(line).toContain("awaiting_approval");
  expect(line).toContain("pide red");
});
```

Añadir `"test": "bun test"` en `tui/package.json` si falta.

- [ ] CLI `chat watch`: si `formatWatchLine` existe, Task 6 ya cubre. Si watch vuelca JSON, el event `chat.tool.update` con `metadata.url` basta — no parsear HTML. **Nunca** auto-aprobar headless.

- [ ] Correr:

```bash
cd tui && bun test src/fetch-format.test.ts src/lib/fetch-format.test.ts
```

- [ ] Commit:

```bash
git add tui/package.json tui/src/App.tsx tui/src/lib/fetch-format.ts \
  tui/src/fetch-format.test.ts tui/src/lib/fetch-format.test.ts \
  cli/src/llm/watch-format.ts cli/src/commands/headless.ts
git commit -m "feat(fetch): TUI and watch show fetch URL live"
```

---

## Task 9: Verificación Gherkin + smoke (daemon, no API)

**Files:**

- Create: `cli/scripts/web-fetch-smoke.ts`
- Modify: `cli/package.json`
- Test: `cli/src/llm/web-fetch-gherkin.test.ts`

Cierra los cuatro escenarios. **No** llama a Anthropic. **No** hay proceso API fetcheando.

- [ ] Crear `cli/src/llm/web-fetch-gherkin.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { decideCanUseTool } from "./can-use-tool";
import { NETWORK_DENIED_AUTO, NETWORK_DENIED_ASK } from "./network-constants";
import { SSRF_DENIED_API, SSRF_DENIED_METADATA, WEB_FETCH_MCP_SERVER } from "./web-fetch-constants";
import { applyWebFetchToQueryOptions, mergeWebFetchMcp } from "./web-fetch-mcp";
import { fetchToolMetadata } from "./web-fetch-display";
import { runWebFetch } from "./web-fetch-http";

const cwd = process.cwd();
const ssrfEnv = {
  apiUrl: "http://localhost:25001",
  lookup: async (h: string) => {
    if (h === "example.com") return ["93.184.216.34"];
    if (h === "localhost") return ["127.0.0.1"];
    return [h];
  },
};

describe("Gherkin: Fetch web", () => {
  test("ask: URL in awaiting_approval, bounded text, timeline tool", async () => {
    const r = await decideCanUseTool({
      cwd,
      executionMode: "ask",
      toolName: "WebFetch",
      toolInput: { url: "https://example.com/doc" },
      ssrfEnv,
      ask: async () => "approve",
    });
    expect(r.behavior).toBe("allow");
    const meta = fetchToolMetadata(
      "WebFetch",
      { url: "https://example.com/doc" },
      "awaiting_approval",
    );
    expect(meta.status).toBe("awaiting_approval");
    expect(meta.url).toBe("https://example.com/doc");
    expect(meta.kind).toBe("fetch");
    const done = fetchToolMetadata(
      "WebFetch",
      { url: "https://example.com/doc" },
      "done",
      "x".repeat(9000),
    );
    expect(String(done.output)).toContain("[truncated:");
    expect(done.toolName).toBe("fetch");
  });

  test("auto: denied by plan 26, no allowlist", async () => {
    const r = await decideCanUseTool({
      cwd,
      executionMode: "auto",
      toolName: "mcp__chavez-web__fetch",
      toolInput: { url: "https://example.com/doc" },
      ssrfEnv,
      ask: async () => "approve",
    });
    expect(r.behavior).toBe("deny");
    expect(r.message).toBe(NETWORK_DENIED_AUTO);
  });

  test("not MCP: works with empty project mcpServers; user browser does not replace host", () => {
    const o = applyWebFetchToQueryOptions({ mcpServers: {}, allowedTools: [] });
    expect((o.mcpServers as Record<string, unknown>)[WEB_FETCH_MCP_SERVER]).toBeTruthy();
    const merged = mergeWebFetchMcp({
      playwright: { command: "npx" },
    } as Record<string, unknown>);
    expect(merged.playwright).toBeTruthy();
    expect(merged[WEB_FETCH_MCP_SERVER]).toBeTruthy();
  });

  test("SSRF: API localhost and cloud metadata; destination is not the API process", async () => {
    const meta = await decideCanUseTool({
      cwd,
      executionMode: "ask",
      toolName: "WebFetch",
      toolInput: { url: "http://169.254.169.254/latest/meta-data" },
      ssrfEnv,
      ask: async () => "approve",
    });
    expect(meta.behavior).toBe("deny");
    expect(meta.message).toBe(SSRF_DENIED_METADATA);

    const api = await decideCanUseTool({
      cwd,
      executionMode: "ask",
      toolName: "WebFetch",
      toolInput: { url: "http://localhost:25001/providers" },
      ssrfEnv,
      ask: async () => "approve",
    });
    expect(api.behavior).toBe("deny");
    expect(api.message).toBe(SSRF_DENIED_API);

    const blocked = await runWebFetch("http://127.0.0.1:25001/providers", ssrfEnv);
    expect(blocked.ok).toBe(false);
  });

  test("ask deny = NETWORK_DENIED_ASK and no updatedInput", async () => {
    const r = await decideCanUseTool({
      cwd,
      executionMode: "ask",
      toolName: "WebFetch",
      toolInput: { url: "https://example.com/doc" },
      ssrfEnv,
      ask: async () => "deny",
    });
    expect(r.behavior).toBe("deny");
    expect(r.message).toBe(NETWORK_DENIED_ASK);
    expect("updatedInput" in r ? r.updatedInput : undefined).toBeUndefined();
  });
});
```

Si `decideCanUseTool` no acepta `ssrfEnv`, usar el arg añadido en Task 3.

- [ ] Smoke `cli/scripts/web-fetch-smoke.ts`. GET real solo contra `Bun.serve` en 127.0.0.1 puerto efímero (no es el origin API). Auto no abre ese server porque el gate niega antes:

```ts
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideCanUseTool } from "../src/llm/can-use-tool";
import { NETWORK_DENIED_AUTO } from "../src/llm/network-constants";
import { SSRF_DENIED_API, SSRF_DENIED_METADATA } from "../src/llm/web-fetch-constants";
import { applyWebFetchToQueryOptions } from "../src/llm/web-fetch-mcp";
import { runWebFetch } from "../src/llm/web-fetch-http";
import { fetchToolMetadata } from "../src/llm/web-fetch-display";

const cwd = mkdtempSync(join(tmpdir(), "chavez-fetch-smoke-"));
mkdirSync(join(cwd, "src"));

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch() {
    return new Response("<html><body><p>docs outside repo</p></body></html>", {
      headers: { "content-type": "text/html" },
    });
  },
});
const origin = `http://127.0.0.1:${server.port}`;
const apiUrl = "http://127.0.0.1:25001";

const auto = await decideCanUseTool({
  cwd,
  executionMode: "auto",
  toolName: "WebFetch",
  toolInput: { url: `${origin}/readme` },
  ssrfEnv: { apiUrl },
});
if (auto.behavior !== "deny" || auto.message !== NETWORK_DENIED_AUTO) {
  fail(`auto: ${JSON.stringify(auto)}`);
}

const got = await runWebFetch(`${origin}/readme`, { apiUrl });
if (!got.ok || !got.text.includes("docs outside repo") || got.text.includes("<p>")) {
  fail(`daemon GET: ${got.text}`);
}

const awaiting = fetchToolMetadata("WebFetch", { url: `${origin}/readme` }, "awaiting_approval");
if (awaiting.url !== `${origin}/readme` || awaiting.kind !== "fetch") {
  fail(`timeline: ${JSON.stringify(awaiting)}`);
}

const md = await runWebFetch("http://169.254.169.254/latest/meta-data", { apiUrl });
if (md.ok || md.text !== SSRF_DENIED_METADATA) fail(`metadata: ${md.text}`);

const apiHit = await runWebFetch("http://127.0.0.1:25001/providers", { apiUrl });
if (apiHit.ok || apiHit.text !== SSRF_DENIED_API) fail(`api origin: ${apiHit.text}`);

const opts = applyWebFetchToQueryOptions({ mcpServers: {}, allowedTools: [] });
if (!(opts.mcpServers as Record<string, unknown>)["chavez-web"]) {
  fail("host fetch missing without MCP config");
}

server.stop();
console.log("web-fetch smoke ok");
```

- [ ] Script en `cli/package.json` (dejar el resto):

```json
"smoke:web-fetch": "bun run scripts/web-fetch-smoke.ts"
```

- [ ] Correr:

```bash
cd cli && bun test src/llm/web-fetch-gherkin.test.ts src/llm/web-fetch-ssrf.test.ts \
  src/llm/web-fetch-http.test.ts src/llm/web-fetch-gate.test.ts \
  src/llm/can-use-tool.fetch.test.ts src/llm/web-fetch-mcp.test.ts \
  src/llm/web-fetch-cursor.test.ts src/llm/publish-turn.fetch.test.ts
cd cli && bun run smoke:web-fetch
```

Esperado:

| Escenario Gherkin | Verificación |
|---|---|
| Fetch en ask | `decideCanUseTool` ask+approve → allow; metadata `awaiting_approval` + URL; output truncado; `kind=fetch` |
| Fetch en auto | `NETWORK_DENIED_AUTO`; ask no se llama; sin allowlist |
| No es MCP | `mcpServers: {}` aún tiene `chavez-web`; `playwright` de usuario no lo pisa |
| SSRF | metadata + origin API deny; GET real solo al `Bun.serve` del daemon; API no tiene ruta proxy |

- [ ] Commit:

```bash
git add cli/scripts/web-fetch-smoke.ts cli/package.json \
  cli/src/llm/web-fetch-gherkin.test.ts
git commit -m "test(fetch): Gherkin ask/auto/MCP/SSRF on the daemon"
```

---

## Self-review

1. **Spec coverage:** Ask (URL + awaiting_approval + texto acotado + timeline tool) → Tasks 2, 3, 6–9. Auto deny plan 26 → Tasks 3, 9. No MCP de usuario + browsers MCP no reemplazan → Tasks 4, 9. SSRF API localhost + metadata + destino daemon → Tasks 1, 2, 9.
2. **Placeholder scan:** Sin TBD/TODO. Lookups y `ssrfEnv` tienen default (`CHAVEZ_API_URL` / `dns.lookup`).
3. **Type consistency:** `WEB_FETCH_SDK_NAME`, `NETWORK_DENIED_*`, `FETCH_BODY_MAX_CHARS=8000`, `kind: "fetch"` idénticos en CLI/Web.
4. **Completeness:** `canUseTool` niega auto **antes** del handler; el handler vuelve a SSRF. Cursor custom tool no se salta el gate. Redirects re-chequeados.
5. **Scope:** No WebSearch, no allowlist, no always-allow, no proxy API, no Cursor cloud, no browsers MCP (plan 19).
6. **Gaps:** Si plan 26 no mergeó `gateWebFetch`, Task 3 inlinea el mínimo. Si plan 4 no mergeó Cursor, Task 5 deja el handler listo. Si plan 2 no mergeó `tool-display`, Tasks 6–8 usan `web-fetch-display` / helper TUI.

**Riesgos / notas:**

1. Claude SDK WebFetch in-process ignora `sandbox.network` — por eso `disallowedTools` + `toolAliases`, no “confiar en el built-in”.
2. `toolAliases` es single-hop; no aliasar `mcp__chavez-web__fetch` de vuelta a `WebFetch`.
3. Colisión `.mcp.json` `chavez-web`: se renombra a `chavez-web-project`; el host gana (mismo patrón que git).
4. Loopback `:3000` permitido en ask (docs locales). Origin API (`:25001` default) no.
5. `Bun.fetch` + `redirect: "manual"` es el único GET. Tests no dependen de internet público (lookup inyectado + `Bun.serve`).
6. Zod v4 en `tool()`: igual que plan 7. No añadir cheerio.
7. Web keep-in-sync: si se cambia `NETWORK_REQUEST_LABEL` o el canonical, editar `web/src/lib/fetch-display.ts` en el mismo PR.
8. 1 turn por daemon: el GET corre dentro del turn; no hay fetch paralelo.
