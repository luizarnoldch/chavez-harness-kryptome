# Sandbox network Implementation Plan

> **For agentic workers:** Execute task-by-task. Do not skip tests. Do not implement Cursor cloud, voz, extensión IDE, upload desde el navegador, allowlist persistente, “siempre permitir”, lote de approvals, cola de turns (plan 29), ni el tool HTTP de [web-fetch](../web-fetch/plan.md) (plan 30): este plan **exporta** el gate que plan 30 debe llamar. Spec: [`plan.md`](./plan.md). Path sandbox de Read/Write/Edit/Grep/Glob ya está en [agent-tools](../agent-tools/implementation.md) / [invariants](../invariants/implementation.md) / [attach-files](../attach-files/implementation.md) / [ignore-secrets](../ignore-secrets/implementation.md). Esta fase cierra **red** y **FS de bash**. Depende de modos ([`execution-modes`](../execution-modes/implementation.md)), tools ([`agent-tools`](../agent-tools/implementation.md)) y aprobaciones ([`approvals`](../approvals/implementation.md)). Si un sibling ya creó un archivo citado, **extiéndelo**; no lo reescribas.

**Goal:** En `auto`, bash no habla con internet y no lee/escribe fuera del cwd del workspace. El assistant ve un error de política de red (no un timeout opaco). En `ask`, un curl aparece en `awaiting_approval` como **pide red**; si el usuario aprueba, corre; si rechaza, **no hay paquete saliente**. En `plan`, bash de red no corre. Fetch/browser (plan 30) reutiliza el mismo gate: auto niega; ask pide aprobación.

**Architecture:** El filesystem y el spawn de bash viven en el proceso daemon (`cli/src/ws/daemon.ts` o TUI con `clientKind: "daemon"`). La API **no** ejecuta shell ni abre sockets hacia el destino del curl: persiste `metadata.needsNetwork` y hace fan-out del pedido. El gate corre en `canUseTool` **antes** de que el SDK spawnee. Dos capas: (1) política Chavez — clasifica y deniega/pregunta con mensajes estables; (2) wrap OS — `bwrap --unshare-net` / `unshare --net` / seatbelt, FS bind al cwd. Deny de ask **no llama** a spawn.

```
Composer (Web | TUI | CLI ask)
        |
        v
  agent.turn.request  --WS-->  API  --dispatch-->  daemon
        |
        v
  query({ permissionMode: "default",
          sandbox: sdkSandbox(cwd),          // cinturón SDK
          canUseTool: decideCanUseTool })    // política Chavez
        |
        |  Read/Grep/Glob/LS          → allow (path sandbox planes 2/8)
        |  Write/Edit                 → gate de modo; path sandbox
        |  Bash / shell
        |     1. denyIfEscapes (paths extraídos del command)
        |     2. denyIfIgnored (si plan 8 existe)
        |     3. denyIfBashEscapes (cd /, /etc, ../)
        |     4. gateMutation (plan → PLAN_MUTATION_DENIED, no corre)
        |     5. gateNetwork
        |          auto + needsNetwork → deny NETWORK_DENIED_AUTO
        |                                (no spawn; assistant ve el mensaje)
        |          auto + local        → allow + wrap(network:false)
        |          ask  + needsNetwork → awaiting_approval { needsNetwork: true }
        |                                "pide red" + command
        |                                approve → wrap(network:true)  → corre
        |                                deny    → no spawn            → 0 paquetes
        |          plan                → ya denegado en (4)
        |  WebFetch / WebSearch        → mismo gateNetwork (hook plan 30)
        v
  API persist + broadcast  →  Web ToolCard | TUI banner | CLI watch
```

Estado actual que este plan extiende (no reescribir):

- `cli/src/llm/claude-runner.ts` llama `query()` con `cwd` y `permissionMode: "bypassPermissions"` **hoy**. Los planes 2–3 lo pasan a `"default"` + `canUseTool`. **No** volver a `bypassPermissions`. **No** pasa `sandbox`. Bash del SDK corre sin wrap de red ni de FS.
- `cli/src/llm/tool-sandbox.ts` (plan 2) sandboxea `file_path`/`path`/`notebook_path`. Comentario explícito: *“Bash has no single path field; network/FS de bash es plan 26.”* `denyIfEscapes(cwd, "Bash", { command: "ls" })` es `null`.
- `cli/src/llm/execution-gate.ts` (plan 3): `auto` **allow** write/edit/bash tras path sandbox. No hay capa de red.
- `cli/src/llm/can-use-tool.ts` (plan 3) orden: `denyIfEscapes` → `gateMutation` → ask. Esta fase inserta FS-bash + `gateNetwork` **después** de ignore (plan 8, si existe) y **después** de `gateMutation` para `plan` (bash de red hereda `PLAN_MUTATION_DENIED`).
- `cli/src/llm/approval-prompt.ts` (plan 13): `{ kind: "bash"; command }` **sin** `needsNetwork`. Headline `bash · ${command}`.
- `cli/src/llm/publish-turn.ts` emite `chat.tool.update` `awaiting_approval` con `prompt` + `approvalDeadline`. **No** estampa `needsNetwork`.
- Claude Agent SDK (`cli/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`) ya expone `options.sandbox` (`enabled`, `network.allowedDomains`, `strictAllowlist`, `autoAllowBashIfSandboxed`, `allowUnsandboxedCommands`, `failIfUnavailable`) y Bash.input `dangerouslyDisableSandbox`. WebFetch **in-process no** respeta `sandbox.network` — por eso el gate Chavez es obligatorio para plan 30.
- Cursor `cli/src/llm/cursor-runner.ts` (plan 4, si existe) hace `Agent.create({ local: { cwd } })` **sin** `sandboxOptions`. Docs del SDK Cursor: `local.sandboxOptions.enabled` niega red y limita writes al cwd.
- Web `ChatDetailPanel.tsx` `ToolCard`: nombre + status (+ botones del plan 13). **No** hay badge `pide red`.
- TUI banner de approval (plan 13): command, **no** dice que pide red.
- CLI `chat watch` vuelca JSON o `formatWatchLine` (plan 2). **No** anota red.
- `git_push` / `git_pr` (plan 7) **no** pasan por este gate: son tools dedicadas; auto puede pushear si el usuario lo pidió. Bash `git push` **sí** es red (y plan 7 ya redirige a las tools dedicadas).
- MCP HTTP/SSE declarado en el repo (plan 19) **sí** se conecta (intención explícita). Esta fase no corta ese handshake.

**Tech Stack:** Bun (`Bun.spawn` para el wrap; `bun test`), Hono WebSocket hub, Drizzle `chat_messages.metadata` jsonb (**sin** tabla nueva, **sin** migración), Claude Agent SDK `query` (`canUseTool`, `updatedInput`, `sandbox`, `permissionMode: "default"`, `permissionPrompts: "host"`), Cursor SDK `Agent.create` `local.sandboxOptions` **solo** si el runner del plan 4 existe (`local: { cwd }`, **nunca** `cloud`), Ink TUI, Astro/React web. Tests: `bun test`. Web **no** importa CLI: duplicar `NETWORK_REQUEST_LABEL` + `formatNetworkHeadline` (comentario keep-in-sync). Sin paquete `bubblewrap` npm: el binario del host (`bwrap` / `unshare` / `sandbox-exec`). Sin allowlist en `.cursor/sandbox.json` ni `.claude/settings.json`.

**Global Constraints:**

1. El filesystem y el spawn de bash viven **solo** en el daemon (cwd del workspace). API y browser no ejecutan curl, no abren el socket de destino, no “aprueban en el servidor”.
2. Sin daemon bound, `agent.turn.request` falla con el string existente `"No daemon bound for this workspace. Run: chavez headless workspace open"`. No queda un waiter ni un wrap huérfano.
3. En **auto**, red denegada por defecto. `curl`/`wget`/URL/`git push` vía **Bash** → `NETWORK_DENIED_AUTO`. El assistant recibe ese string como tool error. No se spawnea el comando clasificado.
4. En **ask**, un comando que pide red entra en `awaiting_approval` **una a una** con `metadata.needsNetwork: true` y el copy **`pide red`**. Approve → corre **con** red, FS sigue = cwd. Deny / timeout / cancel → **cero paquetes** (no hay spawn). Sin lote, sin “siempre permitir”, sin persistir hosts.
5. En **plan**, bash no corre (`PLAN_MUTATION_DENIED`). Bash de red tampoco. WebFetch (cuando exista) se deniega con `NETWORK_DENIED_PLAN`. El árbol y la red del host quedan intactos.
6. FS de bash = cwd, **igual que** Read/Write (planes 2 y 8). `cat /etc/passwd`, `cd /`, `../` que escapa, absoluto fuera del cwd → `PATH_ESCAPE_PREFIX`. Si `denyIfIgnored` existe, `cat .env` se deniega como un Read. El wrap OS es defensa en profundidad, no el único gate.
7. Lecturas (`Read`, `Grep`, `Glob`, `LS`) **nunca** piden red ni confirmación. No se clasifican como network tools.
8. Web, TUI y CLI `watch` ven el mismo contrato: `needsNetwork` + label `pide red` en el pedido. Reload reconstruye desde `chat.get` metadata.
9. 1 turn por daemon. Cambiar de modo no cancela el turn en curso; el wrap se decide **por tool call**.
10. Claude es el provider ejecutable. Cursor, si el plan 4 ya corre, reutiliza `gateNetwork` + `sandboxOptions.enabled: true` en auto/plan. En ask, el hook deniega hasta approve; sandbox Cursor se apaga **solo** en el `Agent.create` de un turn ask (las denegadas no se ejecutan → 0 paquetes; las aprobadas con red pueden salir). Nunca `cloud`.
11. Fetch/browser (plan 30) **debe** llamar `gateNetwork`. Esta fase clasifica `WebFetch` / `WebSearch` / `WebBrowser` y cubre el escenario con tests de `decideCanUseTool`. No implementa el fetcher, ni SSRF, ni truncado HTTP.
12. Fuera de alcance: Cursor cloud, voz, extensión IDE, upload desde el navegador, notificaciones OS/email, allowlist de hosts, “siempre permitir”, JSON schema de CI, GitHub Action, cola, worktrees paralelos.

**Constantes (congeladas, no inventar otras):**

| Nombre | Valor |
|---|---|
| `NETWORK_DENIED_AUTO` | `"Network denied in auto mode. Switch to ask to request network."` |
| `NETWORK_DENIED_PLAN` | `"Plan mode: network is disabled. Switch to ask to request network."` |
| `NETWORK_DENIED_ASK` | `"User denied network for this tool"` |
| `NETWORK_DENIED_RUNTIME` | `"Network denied by workspace sandbox."` |
| `NETWORK_REQUEST_LABEL` | `"pide red"` |
| `PATH_ESCAPE_PREFIX` | `"Path outside workspace: "` (reusar plan 2; **no** cambiar el string) |
| `PLAN_MUTATION_DENIED` | reusar plan 3, mismo literal |
| `ASK_DENIED` | `"User denied this tool"` (reusar; deny de bash sin red sigue este string) |
| `NO_DAEMON_ERROR` | `"No daemon bound for this workspace. Run: chavez headless workspace open"` |

Herramientas que **siempre** piden red (no hace falta mirar el input):

```ts
export const NETWORK_SDK_TOOLS = new Set([
  "WebFetch",
  "WebSearch",
  "WebBrowser",
]);
```

Bash/shell se clasifican por el **command**. `git_push` / `git_pr` / `mcp__chavez-git__*` **no** están en este set.

Tipos de política:

```ts
export type NetworkDecision =
  | { action: "allow"; network: boolean }
  | { action: "deny"; message: string }
  | { action: "ask"; network: true };

export type SandboxBackend = "bwrap" | "unshare" | "seatbelt" | "none";
```

Payload extra en `chat_messages.metadata` cuando el pedido pide red (se **suma** al de plan 13, no lo reemplaza):

```ts
{
  needsNetwork: true;
  prompt: { kind: "bash"; command: string; needsNetwork: true }
      | { kind: "fetch"; url: string; needsNetwork: true } // plan 30
      | { kind: "write" | "edit" | "other"; /* ... */; needsNetwork?: boolean };
}
```

Orden de `decideCanUseTool` (congelado):

1. `denyIfEscapes` (paths de file tools).
2. `denyIfIgnored` si el módulo del plan 8 existe.
3. `denyIfBashEscapes` si la tool es Bash/shell.
4. `gateMutation` — `plan` deniega write/edit/bash aquí (`PLAN_MUTATION_DENIED`).
5. `gateNetwork` — auto deniega; ask anota `needsNetwork`; WebFetch en plan deniega `NETWORK_DENIED_PLAN` si `gateMutation` la dejó pasar (`other` en plan ya deniega, doble seguro).
6. Ask waiter (una a una). Approve de red → `updatedInput` con wrap `network: true`. Deny → no wrap, no spawn.
7. Allow local → `updatedInput` con wrap `network: false`.

No usar `permissionMode: "bypassPermissions"`. No usar `permissionMode: "plan"` del SDK. `sandbox.autoAllowBashIfSandboxed` es **false**: Chavez posee `canUseTool`.

---

## Task 1: Módulos puros — clasificar red, FS de bash, gate por modo

**Files:**

- Create: `cli/src/llm/network-constants.ts`
- Create: `cli/src/llm/network-classify.ts`
- Create: `cli/src/llm/bash-fs.ts`
- Create: `cli/src/llm/network-gate.ts`
- Test: `cli/src/llm/network-classify.test.ts`
- Test: `cli/src/llm/bash-fs.test.ts`
- Test: `cli/src/llm/network-gate.test.ts`
- Modify: `cli/package.json`

Sin I/O de red, sin spawn. TUI importa desde `cli/src/llm/…`. Web y API **no** importan CLI: Task 7 duplica `NETWORK_REQUEST_LABEL`.

- [ ] Añadir `"test": "bun test"` en `cli/package.json` `scripts` si aún no existe (dejar `start`/`dev`/`bin` intactos):

```json
"scripts": {
  "start": "bun run src/index.ts",
  "dev": "bun run src/index.ts",
  "test": "bun test"
}
```

- [ ] Crear `cli/src/llm/network-constants.ts`:

```ts
export const NETWORK_DENIED_AUTO =
  "Network denied in auto mode. Switch to ask to request network.";
export const NETWORK_DENIED_PLAN =
  "Plan mode: network is disabled. Switch to ask to request network.";
export const NETWORK_DENIED_ASK = "User denied network for this tool";
export const NETWORK_DENIED_RUNTIME =
  "Network denied by workspace sandbox.";
export const NETWORK_REQUEST_LABEL = "pide red";

export const NETWORK_SDK_TOOLS = new Set([
  "WebFetch",
  "WebSearch",
  "WebBrowser",
]);

export const BASH_SDK_TOOLS = new Set(["Bash", "bash", "shell", "Shell"]);
```

Si `PATH_ESCAPE_PREFIX` ya vive en `workspace-path.ts` / `tool-sandbox.ts`, **no** redefinir el string; importarlo. Si `PLAN_MUTATION_DENIED` ya vive en `execution-mode.ts`, importarlo.

- [ ] Crear `cli/src/llm/network-classify.ts`:

```ts
import { BASH_SDK_TOOLS, NETWORK_SDK_TOOLS } from "./network-constants";

const NETWORK_BIN = new Set([
  "curl",
  "wget",
  "nc",
  "ncat",
  "netcat",
  "ssh",
  "scp",
  "sftp",
  "telnet",
  "ftp",
  "rsync",
  "nmap",
  "dig",
  "nslookup",
  "host",
  "ping",
  "traceroute",
  "tracepath",
]);

const NETWORK_GIT = new Set(["push", "pull", "fetch", "clone", "ls-remote"]);

const INSTALL_PAIR: Array<[string, Set<string>]> = [
  ["npm", new Set(["install", "i", "add", "ci", "update", "publish"])],
  ["pnpm", new Set(["install", "i", "add", "update", "publish"])],
  ["yarn", new Set(["install", "add", "upgrade", "publish"])],
  ["bun", new Set(["install", "i", "add", "update", "publish"])],
  ["pip", new Set(["install", "download"])],
  ["pip3", new Set(["install", "download"])],
  ["uv", new Set(["pip", "add", "sync"])],
  ["cargo", new Set(["install", "publish", "update"])],
  ["go", new Set(["get", "install", "mod"])],
  ["gem", new Set(["install"])],
  ["composer", new Set(["install", "update", "require"])],
  ["apt", new Set(["install", "update", "upgrade"])],
  ["apt-get", new Set(["install", "update", "upgrade"])],
  ["brew", new Set(["install", "update", "upgrade"])],
];

const URL_RE = /(?:https?|ftp|wss?):\/\//i;
const HOST_FLAG_RE = /\s(?:-h|--host|--hostname)\s+\S+/i;

export function isBashSdkName(sdkName: string): boolean {
  return BASH_SDK_TOOLS.has(sdkName);
}

export function isAlwaysNetworkTool(sdkName: string): boolean {
  if (NETWORK_SDK_TOOLS.has(sdkName)) return true;
  const lower = sdkName.toLowerCase();
  if (lower === "webfetch" || lower === "websearch" || lower === "webbrowser") {
    return true;
  }
  if (lower.includes("webfetch") || lower.includes("web_fetch")) return true;
  return false;
}

export function bashCommandFromInput(
  input: Record<string, unknown> | null,
): string {
  if (!input) return "";
  const c = input.command ?? input.cmd ?? input.script;
  return typeof c === "string" ? c : "";
}

function tokens(command: string): string[] {
  return command
    .replace(/\\\n/g, " ")
    .split(/[\s;|&]+/)
    .map((t) => t.replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

/**
 * True si el command (o la tool) tocaría internet.
 * Conservador: un compuesto con curl en cualquier posición cuenta.
 * `git status` / `git commit` / `git diff` no cuentan.
 */
export function commandNeedsNetwork(command: string): boolean {
  const raw = command.trim();
  if (!raw) return false;
  if (URL_RE.test(raw) || HOST_FLAG_RE.test(raw)) return true;

  const parts = tokens(raw);
  for (let i = 0; i < parts.length; i++) {
    const bin = parts[i].replace(/^.*\//, "").toLowerCase();
    if (NETWORK_BIN.has(bin)) return true;
    if (bin === "git" && NETWORK_GIT.has((parts[i + 1] || "").toLowerCase())) {
      return true;
    }
    for (const [mgr, subs] of INSTALL_PAIR) {
      if (bin === mgr && subs.has((parts[i + 1] || "").toLowerCase())) {
        return true;
      }
    }
  }

  if (/\b(urllib|httpx|requests|fetch\s*\(|http\.client|axios)\b/i.test(raw)) {
    return true;
  }
  return false;
}

export function toolNeedsNetwork(
  sdkName: string,
  input: Record<string, unknown> | null,
): boolean {
  if (isAlwaysNetworkTool(sdkName)) return true;
  if (isBashSdkName(sdkName)) {
    return commandNeedsNetwork(bashCommandFromInput(input));
  }
  const url = input && typeof input.url === "string" ? input.url : "";
  if (url && URL_RE.test(url)) return true;
  return false;
}
```

- [ ] Crear `cli/src/llm/bash-fs.ts`. Reusa `resolveInsideCwd` / `PathEscapeError` de `cli/src/llm/workspace-path.ts`. Si ese archivo **no** existe, copiar el de agent-tools Task 1 **antes** de este módulo (no dejar el path sandbox fuera).

```ts
import { isAbsolute, relative } from "node:path";
import {
  PathEscapeError,
  resolveInsideCwd,
} from "./workspace-path";

export const PATH_ESCAPE_PREFIX = "Path outside workspace: ";

const CD_OUT_RE = /(?:^|[;&|]|&&|\|\|)\s*cd\s+(?:\/|~|\$HOME|"\/|'\/)/;
const ABS_RE = /(?:^|[\s"'=<>])(\/(?:etc|usr|var|home|root|tmp|proc|sys|dev)\/[^\s"'`;|&<>]*)/g;
const TRAVERSAL_RE = /(?:^|[\s"'=])(\.\.\/[^\s"'`;|&<>]*)/g;

function escapeMessage(rel: string): { behavior: "deny"; message: string } {
  return { behavior: "deny", message: `${PATH_ESCAPE_PREFIX}${rel}` };
}

/**
 * Extrae candidatos a path del command. No es un parser sh completo:
 * basta para `cat /etc/passwd`, `cd /`, `cat ../../.ssh/id_rsa`.
 */
export function extractBashPaths(command: string): string[] {
  const out: string[] = [];
  for (const re of [ABS_RE, TRAVERSAL_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(command))) {
      if (m[1]) out.push(m[1]);
    }
  }
  return out;
}

export function denyIfBashEscapes(
  cwd: string,
  sdkName: string,
  input: Record<string, unknown> | null,
): { behavior: "deny"; message: string } | null {
  if (sdkName !== "Bash" && sdkName !== "bash" && sdkName !== "shell" && sdkName !== "Shell") {
    return null;
  }
  const command =
    input && typeof input.command === "string"
      ? input.command
      : input && typeof input.cmd === "string"
        ? input.cmd
        : "";
  if (!command.trim()) return null;
  if (CD_OUT_RE.test(command)) {
    return escapeMessage("cd /");
  }
  for (const p of extractBashPaths(command)) {
    if (isAbsolute(p) || p.startsWith("..")) {
      try {
        resolveInsideCwd(cwd, p);
      } catch (err) {
        const rel = err instanceof PathEscapeError ? err.relPath : p;
        return escapeMessage(rel);
      }
      // absoluto DENTRO del cwd (el SDK a veces manda paths absolutos): ok
      const rel = relative(cwd, p);
      if (rel.startsWith("..") || isAbsolute(rel)) {
        return escapeMessage(p);
      }
    }
  }
  return null;
}
```

Si `PATH_ESCAPE_PREFIX` ya está exportado de `workspace-path.ts` con el mismo literal, importarlo y **borrar** la const local.

- [ ] Crear `cli/src/llm/network-gate.ts`:

```ts
import type { ExecutionMode } from "./execution-mode";
import {
  NETWORK_DENIED_ASK,
  NETWORK_DENIED_AUTO,
  NETWORK_DENIED_PLAN,
} from "./network-constants";
import { toolNeedsNetwork } from "./network-classify";

export type NetworkAction = "allow" | "deny" | "ask";

export type NetworkGate = {
  action: NetworkAction;
  network: boolean;
  message?: string;
};

/**
 * Capa de red. Se llama DESPUÉS de gateMutation:
 * - plan + Bash ya salió con PLAN_MUTATION_DENIED (no llega aquí).
 * - plan + WebFetch (si gateMutation la dejó como other/deny) — si llega, deny PLAN.
 * - auto + needsNetwork → deny AUTO (no spawn).
 * - auto + local → allow network:false (wrap OS).
 * - ask + needsNetwork → ask (awaiting_approval "pide red").
 * - ask + local → allow network:false; el waiter de mutación (bash) lo decide gateMutation.
 */
export function gateNetwork(
  mode: ExecutionMode,
  sdkName: string,
  input: Record<string, unknown> | null,
): NetworkGate {
  const needs = toolNeedsNetwork(sdkName, input);
  if (!needs) {
    return { action: "allow", network: false };
  }
  if (mode === "plan") {
    return {
      action: "deny",
      network: false,
      message: NETWORK_DENIED_PLAN,
    };
  }
  if (mode === "auto") {
    return {
      action: "deny",
      network: false,
      message: NETWORK_DENIED_AUTO,
    };
  }
  return { action: "ask", network: true };
}

export function networkDenyMessage(mode: ExecutionMode): string {
  if (mode === "plan") return NETWORK_DENIED_PLAN;
  if (mode === "auto") return NETWORK_DENIED_AUTO;
  return NETWORK_DENIED_ASK;
}
```

Si `cli/src/llm/execution-mode.ts` **no** existe, inlinar:

```ts
export type ExecutionMode = "plan" | "auto" | "ask";
```

en `network-gate.ts` (no implementar el picker de modos).

- [ ] Tests `cli/src/llm/network-classify.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  commandNeedsNetwork,
  toolNeedsNetwork,
} from "./network-classify";

describe("commandNeedsNetwork", () => {
  test("curl to internet", () => {
    expect(commandNeedsNetwork("curl https://example.com")).toBe(true);
    expect(commandNeedsNetwork("curl -s http://1.1.1.1")).toBe(true);
  });

  test("wget / nc / ssh", () => {
    expect(commandNeedsNetwork("wget https://x")).toBe(true);
    expect(commandNeedsNetwork("nc -zv example.com 443")).toBe(true);
    expect(commandNeedsNetwork("ssh git@github.com")).toBe(true);
  });

  test("git network vs local", () => {
    expect(commandNeedsNetwork("git push origin HEAD")).toBe(true);
    expect(commandNeedsNetwork("git fetch")).toBe(true);
    expect(commandNeedsNetwork("git pull")).toBe(true);
    expect(commandNeedsNetwork("git clone https://github.com/a/b")).toBe(true);
    expect(commandNeedsNetwork("git status")).toBe(false);
    expect(commandNeedsNetwork("git diff")).toBe(false);
    expect(commandNeedsNetwork("git commit -m ok")).toBe(false);
  });

  test("package install", () => {
    expect(commandNeedsNetwork("npm install")).toBe(true);
    expect(commandNeedsNetwork("pip install requests")).toBe(true);
    expect(commandNeedsNetwork("npm test")).toBe(false);
  });

  test("local bash does not need network", () => {
    expect(commandNeedsNetwork("ls")).toBe(false);
    expect(commandNeedsNetwork("echo hello")).toBe(false);
    expect(commandNeedsNetwork("python -m pytest")).toBe(false);
    expect(commandNeedsNetwork("cat src/index.ts")).toBe(false);
  });
});

describe("toolNeedsNetwork", () => {
  test("WebFetch always", () => {
    expect(toolNeedsNetwork("WebFetch", { url: "https://x" })).toBe(true);
    expect(toolNeedsNetwork("WebSearch", { query: "x" })).toBe(true);
  });

  test("Bash delegates to command", () => {
    expect(toolNeedsNetwork("Bash", { command: "curl https://x" })).toBe(true);
    expect(toolNeedsNetwork("Bash", { command: "ls" })).toBe(false);
  });

  test("Read never", () => {
    expect(toolNeedsNetwork("Read", { file_path: "a.ts" })).toBe(false);
  });
});
```

- [ ] Tests `cli/src/llm/bash-fs.test.ts`:

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { denyIfBashEscapes, extractBashPaths } from "./bash-fs";

const cwd = mkdtempSync(join(tmpdir(), "chavez-bashfs-"));
mkdirSync(join(cwd, "src"));
writeFileSync(join(cwd, "src", "a.ts"), "ok");

describe("denyIfBashEscapes", () => {
  test("local command allowed", () => {
    expect(denyIfBashEscapes(cwd, "Bash", { command: "ls src" })).toBeNull();
    expect(denyIfBashEscapes(cwd, "Bash", { command: "cat src/a.ts" })).toBeNull();
  });

  test("cat /etc/passwd denied", () => {
    const d = denyIfBashEscapes(cwd, "Bash", { command: "cat /etc/passwd" });
    expect(d?.behavior).toBe("deny");
    expect(d?.message.startsWith("Path outside workspace:")).toBe(true);
  });

  test("cd / denied", () => {
    const d = denyIfBashEscapes(cwd, "Bash", { command: "cd / && ls" });
    expect(d?.behavior).toBe("deny");
  });

  test("traversal denied", () => {
    const d = denyIfBashEscapes(cwd, "Bash", {
      command: "cat ../../.ssh/id_rsa",
    });
    expect(d?.behavior).toBe("deny");
    expect(d?.message.includes("Path outside workspace:")).toBe(true);
  });

  test("Read is not this layer", () => {
    expect(
      denyIfBashEscapes(cwd, "Read", { file_path: "/etc/passwd" }),
    ).toBeNull();
  });
});

describe("extractBashPaths", () => {
  test("finds abs and traversal", () => {
    expect(extractBashPaths("cat /etc/passwd")).toContain("/etc/passwd");
    expect(extractBashPaths("cat ../secret")).toContain("../secret");
  });
});
```

- [ ] Tests `cli/src/llm/network-gate.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  NETWORK_DENIED_AUTO,
  NETWORK_DENIED_PLAN,
} from "./network-constants";
import { gateNetwork } from "./network-gate";

describe("gateNetwork", () => {
  test("auto + curl denies with stable message", () => {
    const g = gateNetwork("auto", "Bash", {
      command: "curl https://example.com",
    });
    expect(g).toEqual({
      action: "deny",
      network: false,
      message: NETWORK_DENIED_AUTO,
    });
  });

  test("auto + ls allows without network", () => {
    const g = gateNetwork("auto", "Bash", { command: "ls" });
    expect(g).toEqual({ action: "allow", network: false });
  });

  test("ask + curl asks for network", () => {
    const g = gateNetwork("ask", "Bash", {
      command: "curl https://example.com",
    });
    expect(g).toEqual({ action: "ask", network: true });
  });

  test("plan + curl denies", () => {
    const g = gateNetwork("plan", "Bash", {
      command: "curl https://example.com",
    });
    expect(g.action).toBe("deny");
    expect(g.message).toBe(NETWORK_DENIED_PLAN);
  });

  test("auto + WebFetch denies (plan 30 hook)", () => {
    const g = gateNetwork("auto", "WebFetch", { url: "https://example.com" });
    expect(g.action).toBe("deny");
    expect(g.message).toBe(NETWORK_DENIED_AUTO);
  });

  test("ask + WebFetch asks", () => {
    const g = gateNetwork("ask", "WebFetch", { url: "https://example.com" });
    expect(g).toEqual({ action: "ask", network: true });
  });

  test("plan + WebFetch denies", () => {
    expect(gateNetwork("plan", "WebFetch", { url: "https://x" }).message).toBe(
      NETWORK_DENIED_PLAN,
    );
  });
});
```

- [ ] Correr:

```bash
cd cli && bun test src/llm/network-classify.test.ts src/llm/bash-fs.test.ts src/llm/network-gate.test.ts
```

Esperado: todos pasan. `curl` en auto → `NETWORK_DENIED_AUTO`. `cat /etc/passwd` → `Path outside workspace:`.

- [ ] Commit:

```bash
git add cli/package.json \
  cli/src/llm/network-constants.ts \
  cli/src/llm/network-classify.ts cli/src/llm/network-classify.test.ts \
  cli/src/llm/bash-fs.ts cli/src/llm/bash-fs.test.ts \
  cli/src/llm/network-gate.ts cli/src/llm/network-gate.test.ts \
  cli/src/llm/workspace-path.ts
git commit -m "feat(sandbox): classify bash network and workspace FS policy"
```

No incluir `workspace-path.ts` si ya venía de agent-tools/attach-files sin cambios.

---

## Task 2: Wrap OS — FS = cwd, red off a menos que se otorgue

**Files:**

- Create: `cli/src/llm/sandbox-wrap.ts`
- Test: `cli/src/llm/sandbox-wrap.test.ts`

Este módulo **sí** spawnea en tests marcados. La política de Task 1 no spawnea; este wrap es el cinturón para un `python urllib` que el clasificador no vio, y el FS bind para `cat /etc/passwd` que se colara.

- [ ] Crear `cli/src/llm/sandbox-wrap.ts`:

```ts
import { existsSync } from "node:fs";
import { delimiter } from "node:path";
import { NETWORK_DENIED_RUNTIME } from "./network-constants";

export type SandboxBackend = "bwrap" | "unshare" | "seatbelt" | "none";

export type WrapOpts = {
  cwd: string;
  network: boolean;
  command: string;
};

export type SpawnFn = (
  cmd: string[],
  opts: { cwd: string; stdout: "pipe"; stderr: "pipe" },
) => {
  exited: Promise<number>;
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
};

function which(bin: string): string | null {
  const dirs = (process.env.PATH || "").split(delimiter);
  for (const d of dirs) {
    const p = `${d}/${bin}`;
    if (existsSync(p)) return p;
  }
  return null;
}

export function detectSandboxBackend(): SandboxBackend {
  if (process.platform === "linux") {
    if (which("bwrap")) return "bwrap";
    if (which("unshare")) return "unshare";
    return "none";
  }
  if (process.platform === "darwin" && which("sandbox-exec")) {
    return "seatbelt";
  }
  return "none";
}

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function linuxBinds(cwd: string, network: boolean): string[] {
  const ro = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc"];
  const args: string[] = [];
  for (const p of ro) {
    if (existsSync(p)) args.push("--ro-bind", p, p);
  }
  args.push("--bind", cwd, cwd, "--chdir", cwd);
  args.push("--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp");
  args.push("--die-with-parent");
  if (!network) args.unshift("--unshare-net");
  return args;
}

function seatbeltProfile(cwd: string, network: boolean): string {
  const net = network
    ? "(allow network*)"
    : "(deny network*)\n(deny network-outbound)\n(deny network-inbound)";
  return `(version 1)
(deny default)
(allow process-exec)
(allow process-fork)
(allow signal)
(allow sysctl-read)
(allow file-read* (subpath "${cwd}") (subpath "/usr") (subpath "/bin") (subpath "/opt") (subpath "/Library") (subpath "/System") (subpath "/private/etc") (subpath "/dev") (subpath "/tmp"))
(allow file-write* (subpath "${cwd}") (subpath "/tmp") (subpath "/dev"))
(allow file-ioctl (subpath "/dev"))
${net}
`;
}

/**
 * argv que hay que spawnear. `none` → `["bash","-lc", command]` en cwd
 * (la política de Task 1 sigue siendo el hard gate; Windows cae aquí).
 */
export function wrapArgv(opts: WrapOpts, backend = detectSandboxBackend()): string[] {
  const { cwd, network, command } = opts;
  if (backend === "bwrap") {
    return [
      "bwrap",
      ...linuxBinds(cwd, network),
      "--",
      "/bin/bash",
      "-lc",
      command,
    ];
  }
  if (backend === "unshare") {
    const ns = network ? [] : ["--net"];
    return [
      "unshare",
      ...ns,
      "--map-root-user",
      "--fork",
      "/bin/bash",
      "-lc",
      `cd ${shQuote(cwd)} && ${command}`,
    ];
  }
  if (backend === "seatbelt") {
    return [
      "sandbox-exec",
      "-p",
      seatbeltProfile(cwd, network),
      "/bin/bash",
      "-lc",
      `cd ${shQuote(cwd)} && ${command}`,
    ];
  }
  return ["/bin/bash", "-lc", command];
}

/**
 * Prefijo inyectable en Bash.command vía updatedInput.
 * El SDK ejecuta este string con su propio bash -lc; por eso devolvemos
 * una línea que re-exec el wrap (no un argv).
 */
export function wrapCommandString(
  opts: WrapOpts,
  backend = detectSandboxBackend(),
): string {
  const argv = wrapArgv(opts, backend);
  return argv.map(shQuote).join(" ");
}

export async function runSandboxedBash(
  opts: WrapOpts,
  spawn: SpawnFn = ((cmd, o) =>
    Bun.spawn(cmd, o) as unknown as ReturnType<SpawnFn>),
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const argv = wrapArgv(opts);
  const proc = spawn(argv, {
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    proc.stdout ? new Response(proc.stdout).text() : Promise.resolve(""),
    proc.stderr ? new Response(proc.stderr).text() : Promise.resolve(""),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

export function annotateNetworkFailure(stderr: string, stdout: string): string {
  const body = (stderr || stdout || "").trim();
  if (!body) return NETWORK_DENIED_RUNTIME;
  if (/network denied by workspace sandbox/i.test(body)) return body;
  return `${NETWORK_DENIED_RUNTIME}\n${body}`;
}
```

- [ ] Tests `cli/src/llm/sandbox-wrap.test.ts`. Los de spawn real se saltan si `detectSandboxBackend() === "none"` (Windows CI sin bwrap). Los de argv **siempre** corren.

```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  annotateNetworkFailure,
  detectSandboxBackend,
  runSandboxedBash,
  wrapArgv,
} from "./sandbox-wrap";
import { NETWORK_DENIED_RUNTIME } from "./network-constants";

const cwd = mkdtempSync(join(tmpdir(), "chavez-wrap-"));
writeFileSync(join(cwd, "in.txt"), "hello");

describe("wrapArgv", () => {
  test("bwrap unshares net when network=false", () => {
    const argv = wrapArgv(
      { cwd, network: false, command: "curl https://example.com" },
      "bwrap",
    );
    expect(argv[0]).toBe("bwrap");
    expect(argv).toContain("--unshare-net");
    expect(argv).toContain(cwd);
  });

  test("bwrap keeps net when network=true", () => {
    const argv = wrapArgv(
      { cwd, network: true, command: "curl https://example.com" },
      "bwrap",
    );
    expect(argv).not.toContain("--unshare-net");
  });

  test("unshare --net when network=false", () => {
    const argv = wrapArgv(
      { cwd, network: false, command: "curl https://x" },
      "unshare",
    );
    expect(argv).toContain("--net");
  });
});

describe("runSandboxedBash", () => {
  const backend = detectSandboxBackend();

  test("echo inside cwd works", async () => {
    if (backend === "none") return;
    const r = await runSandboxedBash({
      cwd,
      network: false,
      command: "cat in.txt",
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("hello");
  });

  test("curl to internet fails when network=false", async () => {
    if (backend === "none") return;
    const r = await runSandboxedBash({
      cwd,
      network: false,
      command: "curl -sS --max-time 3 https://example.com",
    });
    expect(r.exitCode).not.toBe(0);
  });

  test("cat /etc/passwd fails when FS is confined (bwrap/seatbelt)", async () => {
    if (backend !== "bwrap" && backend !== "seatbelt") return;
    const r = await runSandboxedBash({
      cwd,
      network: false,
      command: "cat /etc/passwd",
    });
    expect(r.exitCode).not.toBe(0);
  });
});

describe("annotateNetworkFailure", () => {
  test("prefixes runtime message", () => {
    const s = annotateNetworkFailure("Could not resolve host", "");
    expect(s.startsWith(NETWORK_DENIED_RUNTIME)).toBe(true);
    expect(s).toContain("Could not resolve host");
  });
});
```

- [ ] Correr:

```bash
cd cli && bun test src/llm/sandbox-wrap.test.ts
```

Esperado: argv contiene `--unshare-net` cuando `network: false`. En Linux con `bwrap`/`unshare`, curl sale ≠ 0. En `none`, esos tests `return` y el resto pasa.

- [ ] Commit:

```bash
git add cli/src/llm/sandbox-wrap.ts cli/src/llm/sandbox-wrap.test.ts
git commit -m "feat(sandbox): wrap bash with net-off and cwd-only FS"
```

---

## Task 3: `canUseTool` + sandbox SDK + wrap por invocación

**Files:**

- Create: `cli/src/llm/can-use-tool.ts` (si el plan 3 **no** lo creó; si existe, **extenderlo**)
- Test: `cli/src/llm/can-use-tool.network.test.ts`
- Modify: `cli/src/llm/claude-runner.ts`
- Test: `cli/src/llm/claude-runner.sandbox.test.ts`

El SDK **no** ejecuta Bash hasta que `canUseTool` resuelve `allow`. Deny de red **no** llama wrap ni spawn. `updatedInput.command` es el wrap; el SDK corre **ese** string.

- [ ] Extraer / extender `cli/src/llm/can-use-tool.ts`. Si el archivo ya tiene `decideCanUseTool` (plan 3), **insertar** los pasos 3 y 5; no borrar path sandbox ni el waiter. Forma final:

```ts
import { denyIfEscapes } from "./tool-sandbox";
import { denyIfBashEscapes } from "./bash-fs";
import { gateMutation } from "./execution-gate";
import { gateNetwork } from "./network-gate";
import { wrapCommandString } from "./sandbox-wrap";
import { bashCommandFromInput, isBashSdkName } from "./network-classify";
import {
  ASK_DENIED,
  ASK_TIMEOUT_DENIED,
  PLAN_MUTATION_DENIED,
  type ExecutionMode,
} from "./execution-mode";
import { NETWORK_DENIED_ASK } from "./network-constants";

export type PermissionDecision =
  | {
      behavior: "allow";
      updatedInput?: Record<string, unknown>;
      needsNetwork?: boolean;
    }
  | { behavior: "deny"; message: string };

export type AskFn = (req: {
  needsNetwork: boolean;
}) => Promise<"approve" | "deny" | "timeout" | "cancelled">;

export async function decideCanUseTool(input: {
  cwd: string;
  executionMode: ExecutionMode;
  toolName: string;
  toolInput: Record<string, unknown>;
  ask?: AskFn;
  denyIfIgnored?: (
    cwd: string,
    sdkName: string,
    toolInput: Record<string, unknown> | null,
  ) => { behavior: "deny"; message: string } | null;
}): Promise<PermissionDecision> {
  const denied = denyIfEscapes(input.cwd, input.toolName, input.toolInput);
  if (denied) return denied;

  if (input.denyIfIgnored) {
    const ign = input.denyIfIgnored(
      input.cwd,
      input.toolName,
      input.toolInput,
    );
    if (ign) return ign;
  }

  const bashFs = denyIfBashEscapes(input.cwd, input.toolName, input.toolInput);
  if (bashFs) return bashFs;

  const g = gateMutation(input.executionMode, input.toolName);
  if (g.decision === "deny") {
    return { behavior: "deny", message: g.message || PLAN_MUTATION_DENIED };
  }

  const net = gateNetwork(
    input.executionMode,
    input.toolName,
    input.toolInput,
  );
  if (net.action === "deny") {
    return { behavior: "deny", message: net.message || PLAN_MUTATION_DENIED };
  }

  let grantedNetwork = false;
  if (g.decision === "ask" || net.action === "ask") {
    const outcome = (await input.ask?.({ needsNetwork: net.network })) ?? "deny";
    if (outcome !== "approve") {
      const message =
        outcome === "timeout"
          ? ASK_TIMEOUT_DENIED
          : net.action === "ask"
            ? NETWORK_DENIED_ASK
            : ASK_DENIED;
      return { behavior: "deny", message };
    }
    grantedNetwork = net.network;
  }

  if (isBashSdkName(input.toolName)) {
    const command = bashCommandFromInput(input.toolInput);
    const wrapped = wrapCommandString({
      cwd: input.cwd,
      network: grantedNetwork,
      command,
    });
    return {
      behavior: "allow",
      needsNetwork: grantedNetwork,
      updatedInput: {
        ...input.toolInput,
        command: wrapped,
        dangerouslyDisableSandbox: grantedNetwork,
      },
    };
  }

  return { behavior: "allow", needsNetwork: grantedNetwork };
}
```

Si `tool-sandbox.ts` no existe, copiar `denyIfEscapes` + `extractToolPath` de agent-tools Task 1 **antes** de este archivo. Si `execution-gate.ts` no existe, copiar `gateMutation` de execution-modes Task 1. Si `denyIfIgnored` del plan 8 existe, `publish-turn` / runner lo pasan; si no, omitir el arg (el `?` lo hace no-op).

`dangerouslyDisableSandbox: true` **solo** cuando el usuario aprobó red. El wrap propio sigue confinando FS. `allowUnsandboxedCommands` en options SDK (abajo) es lo que permite ese flag; sin red otorgada el SDK sandbox + wrap `network:false` se quedan.

- [ ] Tests `cli/src/llm/can-use-tool.network.test.ts`. **No** mockea `query`. Usa `decideCanUseTool` con `ask` inyectable y un `cwd` tmp.

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { decideCanUseTool } from "./can-use-tool";
import {
  NETWORK_DENIED_ASK,
  NETWORK_DENIED_AUTO,
} from "./network-constants";
import { PLAN_MUTATION_DENIED } from "./execution-mode";

const cwd = mkdtempSync(join(tmpdir(), "chavez-net-"));
mkdirSync(join(cwd, "src"));
writeFileSync(join(cwd, "src", "a.ts"), "ok");

describe("decideCanUseTool network", () => {
  test("auto + curl denies; ask callback never runs; no wrap", async () => {
    let asked = false;
    const r = await decideCanUseTool({
      cwd,
      executionMode: "auto",
      toolName: "Bash",
      toolInput: { command: "curl https://example.com" },
      ask: async () => {
        asked = true;
        return "approve";
      },
    });
    expect(r).toEqual({
      behavior: "deny",
      message: NETWORK_DENIED_AUTO,
    });
    expect(asked).toBe(false);
  });

  test("auto + ls allows with wrap network=false", async () => {
    const r = await decideCanUseTool({
      cwd,
      executionMode: "auto",
      toolName: "Bash",
      toolInput: { command: "ls" },
    });
    expect(r.behavior).toBe("allow");
    if (r.behavior === "allow") {
      expect(r.needsNetwork).toBe(false);
      expect(String(r.updatedInput?.command)).toContain("ls");
      expect(r.updatedInput?.dangerouslyDisableSandbox).toBe(false);
    }
  });

  test("ask + curl waits; deny → NETWORK_DENIED_ASK", async () => {
    const r = await decideCanUseTool({
      cwd,
      executionMode: "ask",
      toolName: "Bash",
      toolInput: { command: "curl https://example.com" },
      ask: async ({ needsNetwork }) => {
        expect(needsNetwork).toBe(true);
        return "deny";
      },
    });
    expect(r).toEqual({
      behavior: "deny",
      message: NETWORK_DENIED_ASK,
    });
  });

  test("ask + curl approve → wrap with network", async () => {
    const r = await decideCanUseTool({
      cwd,
      executionMode: "ask",
      toolName: "Bash",
      toolInput: { command: "curl https://example.com" },
      ask: async () => "approve",
    });
    expect(r.behavior).toBe("allow");
    if (r.behavior === "allow") {
      expect(r.needsNetwork).toBe(true);
      expect(r.updatedInput?.dangerouslyDisableSandbox).toBe(true);
      const cmd = String(r.updatedInput?.command || "");
      expect(cmd.includes("curl")).toBe(true);
      expect(cmd.includes("--unshare-net")).toBe(false);
    }
  });

  test("plan + curl never asks", async () => {
    let asked = false;
    const r = await decideCanUseTool({
      cwd,
      executionMode: "plan",
      toolName: "Bash",
      toolInput: { command: "curl https://example.com" },
      ask: async () => {
        asked = true;
        return "approve";
      },
    });
    expect(r.behavior).toBe("deny");
    if (r.behavior === "deny") {
      expect(
        r.message === PLAN_MUTATION_DENIED ||
          r.message.includes("Plan mode"),
      ).toBe(true);
    }
    expect(asked).toBe(false);
  });

  test("auto + cat /etc/passwd sandboxes FS", async () => {
    const r = await decideCanUseTool({
      cwd,
      executionMode: "auto",
      toolName: "Bash",
      toolInput: { command: "cat /etc/passwd" },
    });
    expect(r.behavior).toBe("deny");
    if (r.behavior === "deny") {
      expect(r.message.startsWith("Path outside workspace:")).toBe(true);
    }
  });

  test("auto + WebFetch denies (plan 30)", async () => {
    const r = await decideCanUseTool({
      cwd,
      executionMode: "auto",
      toolName: "WebFetch",
      toolInput: { url: "https://example.com" },
    });
    expect(r).toEqual({
      behavior: "deny",
      message: NETWORK_DENIED_AUTO,
    });
  });

  test("ask + WebFetch deny does not allow", async () => {
    const r = await decideCanUseTool({
      cwd,
      executionMode: "ask",
      toolName: "WebFetch",
      toolInput: { url: "https://example.com" },
      ask: async () => "deny",
    });
    expect(r.behavior).toBe("deny");
    if (r.behavior === "deny") {
      expect(r.message).toBe(NETWORK_DENIED_ASK);
    }
  });
});
```

Red otorgada: el wrap **no** lleva `--unshare-net`. `dangerouslyDisableSandbox: true` deja pasar el cinturón SDK; el wrap propio sigue confinando FS al cwd. En backend `none` (Windows) el command sigue conteniendo `curl` y no hay `--unshare-net`.

- [ ] En `cli/src/llm/claude-runner.ts`:

  1. `permissionMode: "default"`. **Eliminar** `"bypassPermissions"` si aún está.
  2. `permissionPrompts: "host"`.
  3. `canUseTool` **delega** en `decideCanUseTool`. Propagar `updatedInput` al SDK.
  4. Añadir `sandbox` en options:

```ts
import { decideCanUseTool } from "./can-use-tool";

function sdkSandbox(cwd: string): Record<string, unknown> {
  return {
    enabled: true,
    failIfUnavailable: false,
    autoAllowBashIfSandboxed: false,
    allowUnsandboxedCommands: true,
    network: {
      allowedDomains: [],
      strictAllowlist: true,
    },
    filesystem: {
      allowWrite: [cwd],
    },
  };
}

const options: Record<string, unknown> = {
  model: input.model,
  cwd: input.cwd,
  env: cleanEnv,
  settingSources: [],
  tools: [...DEFAULT_CLAUDE_TOOLS],
  allowedTools: [...DEFAULT_CLAUDE_TOOLS],
  permissionMode: "default",
  permissionPrompts: "host",
  sandbox: sdkSandbox(input.cwd),
  canUseTool: async (
    toolName: string,
    toolInput: Record<string, unknown>,
    toolOpts: { signal: AbortSignal; toolUseID?: string },
  ) => {
    const decision = await decideCanUseTool({
      cwd: input.cwd,
      executionMode: input.executionMode,
      toolName,
      toolInput,
      ask: input.onAskPermission
        ? async ({ needsNetwork }) =>
            input.onAskPermission!({
              toolCallId: String(toolOpts.toolUseID || crypto.randomUUID()),
              toolName,
              input: toolInput,
              signal: toolOpts.signal,
              needsNetwork,
            })
        : undefined,
    });
    if (decision.behavior === "deny") return decision;
    return {
      behavior: "allow" as const,
      updatedInput: decision.updatedInput,
    };
  },
};
```

Si `DEFAULT_CLAUDE_TOOLS` no existe, inlinar `["Read","Write","Edit","Grep","Glob","Bash"]`. Si `RunClaudeTurnInput` no tiene `executionMode` / `onAskPermission`, añadirlos como en execution-modes Task 3 **y** extender `AskPermission` con `needsNetwork?: boolean`.

  5. `failIfUnavailable: false` porque el wrap de Task 2 es el hard gate portable. El sandbox SDK es cinturón extra en Linux/macOS. **No** silenciar un deny de `canUseTool`.

- [ ] Tests `cli/src/llm/claude-runner.sandbox.test.ts` — **no** llaman a Anthropic. Extraer `sdkSandbox` a export (o testear vía `can-use-tool`). Contrato:

```ts
import { describe, expect, test } from "bun:test";
import { sdkSandbox } from "./claude-runner";

describe("sdkSandbox", () => {
  test("enabled, no auto-allow bash, empty allowlist", () => {
    const s = sdkSandbox("/tmp/ws");
    expect(s.enabled).toBe(true);
    expect(s.autoAllowBashIfSandboxed).toBe(false);
    expect(s.allowUnsandboxedCommands).toBe(true);
    expect((s.network as { allowedDomains: string[] }).allowedDomains).toEqual(
      [],
    );
    expect((s.network as { strictAllowlist: boolean }).strictAllowlist).toBe(
      true,
    );
    expect((s.filesystem as { allowWrite: string[] }).allowWrite).toEqual([
      "/tmp/ws",
    ]);
  });
});
```

Exportar `sdkSandbox` desde `claude-runner.ts`. Si el archivo se vuelve circular, mover `sdkSandbox` a `cli/src/llm/sandbox-wrap.ts` y reexportar.

- [ ] Correr:

```bash
cd cli && bun test src/llm/can-use-tool.network.test.ts src/llm/claude-runner.sandbox.test.ts src/llm/network-gate.test.ts
```

Esperado: auto+curl deny sin ask; ask+curl deny → `NETWORK_DENIED_ASK`; plan+curl deny; WebFetch auto deny; `sdkSandbox` con allowlist vacía.

- [ ] Commit:

```bash
git add cli/src/llm/can-use-tool.ts cli/src/llm/can-use-tool.network.test.ts \
  cli/src/llm/claude-runner.ts cli/src/llm/claude-runner.sandbox.test.ts \
  cli/src/llm/tool-sandbox.ts
git commit -m "feat(sandbox): deny auto network in canUseTool before spawn"
```

No incluir `tool-sandbox.ts` si no cambió.

---

## Task 4: `awaiting_approval` dice que pide red

**Files:**

- Modify: `cli/src/llm/approval-prompt.ts` (si plan 13 lo creó; si no, crearlo aquí con el type mínimo)
- Test: `cli/src/llm/approval-prompt.test.ts` (extender o crear)
- Modify: `cli/src/llm/publish-turn.ts`
- Test: `cli/src/llm/publish-turn.network.test.ts`
- Modify: `cli/src/llm/watch-format.ts` (si existe)
- Test: `cli/src/llm/watch-format.test.ts` (extender)

Web/TUI pintan `metadata.needsNetwork`. El daemon lo estampa **antes** de `waitForApproval`.

- [ ] Extender `ApprovalPrompt` en `cli/src/llm/approval-prompt.ts`:

```ts
export type ApprovalPrompt =
  | { kind: "write"; path: string; diff: string; truncated: boolean; needsNetwork?: boolean }
  | { kind: "edit"; path: string; diff: string; truncated: boolean; needsNetwork?: boolean }
  | { kind: "bash"; command: string; needsNetwork?: boolean }
  | { kind: "fetch"; url: string; needsNetwork: true }
  | { kind: "other"; summary: string; needsNetwork?: boolean };
```

`buildApprovalPrompt(sdkName, input, proposedPreview, needsNetwork?)`:

- Bash: `{ kind: "bash", command, needsNetwork: Boolean(needsNetwork) }`.
- `WebFetch` / `WebSearch`: `{ kind: "fetch", url: String(input.url || input.query || ""), needsNetwork: true }`.
- Resto: igual que plan 13, copiar `needsNetwork` si viene.

`formatApprovalHeadline`:

```ts
import { NETWORK_REQUEST_LABEL } from "./network-constants";

export function formatApprovalHeadline(prompt: ApprovalPrompt): string {
  const net =
    prompt.needsNetwork === true ? `${NETWORK_REQUEST_LABEL} · ` : "";
  if (prompt.kind === "bash") return `${net}bash · ${prompt.command}`;
  if (prompt.kind === "fetch") return `${net}fetch · ${prompt.url}`;
  if (prompt.kind === "other") return `${net}${prompt.summary}`;
  return `${net}${prompt.kind} · ${prompt.path}`;
}
```

- [ ] Tests (añadir a `approval-prompt.test.ts`):

```ts
test("bash curl headline says pide red", () => {
  const p = buildApprovalPrompt(
    "Bash",
    { command: "curl https://example.com" },
    null,
    true,
  );
  expect(p).toEqual({
    kind: "bash",
    command: "curl https://example.com",
    needsNetwork: true,
  });
  expect(formatApprovalHeadline(p!)).toContain("pide red");
  expect(formatApprovalHeadline(p!)).toContain("curl https://example.com");
});

test("bash ls without network has no pide red", () => {
  const p = buildApprovalPrompt("Bash", { command: "ls" }, null, false);
  expect(formatApprovalHeadline(p!)).not.toContain("pide red");
});
```

Si `approval-prompt.ts` no existe, crearlo con **solo** bash/fetch (write/edit pueden ser `{ kind: "other", summary }`). No reimplementar diffs del plan 6.

- [ ] En `cli/src/llm/publish-turn.ts`, el `onAskPermission` (plan 3/13) recibe `needsNetwork` y lo persiste:

```ts
onAskPermission: async ({
  toolCallId,
  toolName,
  input: toolInput,
  signal,
  needsNetwork,
}) => {
  const prompt = buildApprovalPrompt(
    toolName,
    toolInput,
    null,
    Boolean(needsNetwork),
  );
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
      needsNetwork: Boolean(needsNetwork),
      prompt,
    },
  });
  const outcome = await waitForApproval(toolCallId, chatId, {
    timeoutMs: ASK_APPROVAL_TIMEOUT_MS,
    signal,
  });
  return outcome;
},
```

Si `chat.tool.update` aún no existe en el API (plan 2 no mergeado), el fallback `chat.tool.start` + `status: "awaiting_approval"` **debe** llevar los mismos `needsNetwork` + `prompt`. No auto-aprobar.

Headless **no** llama `resolveApproval(..., "approve")`. Un curl en ask espera Web / TUI / `chat watch`.

- [ ] Test `cli/src/llm/publish-turn.network.test.ts`. Extraer el builder del metadata a `buildAskMetadata(...)` si hace falta para no mockear WS:

```ts
import { describe, expect, test } from "bun:test";
import { buildAskMetadata } from "./publish-turn";
// o desde un helper exportado en approval-prompt / un archivo ask-metadata.ts

test("ask curl metadata flags needsNetwork", () => {
  const meta = buildAskMetadata({
    toolName: "Bash",
    toolInput: { command: "curl https://example.com" },
    executionMode: "ask",
    needsNetwork: true,
  });
  expect(meta.needsNetwork).toBe(true);
  expect(meta.status ?? "awaiting_approval").toBeDefined();
  expect(JSON.stringify(meta)).toContain("pide red");
});
```

Si exportar desde `publish-turn.ts` acopla demasiado, poner `buildAskMetadata` en `cli/src/llm/ask-metadata.ts` e importarlo en `publish-turn`. **No** dejar el flag solo en el headline: `needsNetwork` es boolean de primer nivel.

- [ ] Si `cli/src/llm/watch-format.ts` existe, en `chat.tool.update` / `start` con `status === "awaiting_approval"` y `needsNetwork`:

```
tool · bash · awaiting_approval  pide red  curl https://example.com
```

Test: la línea contiene `pide red` y el command; un `ls` en ask (sin red) **no** contiene `pide red`.

Si `watch-format.ts` no existe, Task 6 (CLI watch) usa JSON crudo: `data.metadata.needsNetwork === true` basta (el test de Task 8 lo lee). No crear `watch-format.ts` solo para esto.

- [ ] Correr:

```bash
cd cli && bun test src/llm/approval-prompt.test.ts src/llm/publish-turn.network.test.ts src/llm/watch-format.test.ts
```

Si `watch-format.test.ts` no existe, omitirlo. Esperado: headline con `pide red`; metadata.needsNetwork true; ls sin el label.

- [ ] Commit:

```bash
git add cli/src/llm/approval-prompt.ts cli/src/llm/approval-prompt.test.ts \
  cli/src/llm/publish-turn.ts cli/src/llm/publish-turn.network.test.ts \
  cli/src/llm/ask-metadata.ts cli/src/llm/watch-format.ts \
  cli/src/llm/watch-format.test.ts
git commit -m "feat(sandbox): awaiting_approval announces network requests"
```

No añadir archivos que no se hayan creado.

---

## Task 5: Cursor — mismo gate, sandbox local, nunca cloud

**Files:**

- Modify: `cli/src/llm/cursor-runner.ts` (solo si el plan 4 ya lo creó)
- Test: `cli/src/llm/cursor-runner.sandbox.test.ts`
- Modify: `cli/src/llm/publish-turn.ts` (branch Cursor ya existente)

Si `cli/src/llm/cursor-runner.ts` **no** existe, **esta task es no-op**: crear el archivo de test vacío no. Documentar en el commit message no aplica; pasar a Task 6. Cuando el plan 4 aterrice, reabre esta task.

- [ ] En `runCursorTurn` / `Agent.create`:

```ts
const sandboxEnabled =
  input.executionMode !== "ask";

agent = await Agent.create({
  apiKey: input.auth.secret,
  model: modelSel,
  tools: [...DEFAULT_CURSOR_TOOLS],
  local: {
    cwd: input.cwd,
    store,
    sandboxOptions: { enabled: sandboxEnabled },
  },
});
```

**Nunca** pasar `cloud`, `repos`, `autoCreatePR`. En **auto/plan** `sandboxOptions.enabled: true` (red denegada, writes al cwd — docs Cursor). En **ask** `enabled: false` porque el SDK Cursor no permite agujero de red por tool call; el hook de abajo **no ejecuta** hasta approve, así que deny = 0 paquetes y approve-con-red puede salir.

- [ ] Hooks `preToolUse` / `beforeShellExecution` (el que exista en `@cursor/sdk`). Mapear `shell` → `Bash`. Llamar `decideCanUseTool` **antes** de que el SDK toque el disco o abra socket:

```ts
async function cursorCanUse(
  name: string,
  args: Record<string, unknown>,
): Promise<"allow" | "deny"> {
  const sdkName = name === "shell" || name === "Shell" ? "Bash" : name;
  const d = await decideCanUseTool({
    cwd: input.cwd,
    executionMode: input.executionMode,
    toolName: sdkName,
    toolInput: args,
    ask: input.onAskPermission
      ? async ({ needsNetwork }) =>
          input.onAskPermission!({
            toolCallId: crypto.randomUUID(),
            toolName: sdkName,
            input: args,
            signal: input.signal ?? new AbortController().signal,
            needsNetwork,
          })
      : undefined,
  });
  return d.behavior === "allow" ? "allow" : "deny";
}
```

Si el hook permite devolver un mensaje, pasar `d.message` para que el assistant Cursor vea `NETWORK_DENIED_AUTO`. Si el SDK solo tiene allow/deny, emitir `onEvent({ kind: "tool_result", status: "error", output: message })` en deny.

- [ ] Test de contrato con `createAgent` inyectable (el plan 4 ya lo pide):

```ts
test("auto enables sandboxOptions and never cloud", async () => {
  const creates: Array<Record<string, unknown>> = [];
  await runCursorTurn({
    ...minimalInput,
    executionMode: "auto",
    createAgent: async (opts) => {
      creates.push(opts as Record<string, unknown>);
      return fakeAgent;
    },
  });
  expect(creates[0]).not.toHaveProperty("cloud");
  const local = creates[0].local as {
    cwd: string;
    sandboxOptions: { enabled: boolean };
  };
  expect(local.cwd).toBe(minimalInput.cwd);
  expect(local.sandboxOptions.enabled).toBe(true);
});

test("ask disables sandboxOptions so an approved curl can run", async () => {
  const creates: Array<Record<string, unknown>> = [];
  await runCursorTurn({
    ...minimalInput,
    executionMode: "ask",
    createAgent: async (opts) => {
      creates.push(opts as Record<string, unknown>);
      return fakeAgent;
    },
  });
  const local = creates[0].local as { sandboxOptions: { enabled: boolean } };
  expect(local.sandboxOptions.enabled).toBe(false);
});
```

`fakeAgent` = el del plan 4 (`send` → stream vacío, `wait` finished). No pegarle a Cursor cloud.

- [ ] Correr:

```bash
cd cli && bun test src/llm/cursor-runner.sandbox.test.ts src/llm/cursor-runner.test.ts
```

Esperado: `cloud` ausente; auto sandbox on; ask sandbox off.

- [ ] Commit:

```bash
git add cli/src/llm/cursor-runner.ts cli/src/llm/cursor-runner.sandbox.test.ts \
  cli/src/llm/publish-turn.ts
git commit -m "feat(sandbox): Cursor local sandbox honors auto/ask network gate"
```

---

## Task 6: TUI y CLI watch — el pedido dice `pide red`

**Files:**

- Modify: `tui/src/App.tsx`
- Modify: `cli/src/commands/headless.ts`
- Modify: `cli/src/llm/watch-format.ts` (si existe y Task 4 no lo cerró)
- Test: `tui/src/network-banner.test.ts` (helper puro; no montar Ink si no hace falta)

TUI importa `formatApprovalHeadline` / `NETWORK_REQUEST_LABEL` desde `cli/src/llm/…`. No duplicar el string.

- [ ] Banner de approval (plan 13). Si el plan 13 **no** aterrizó, pintar el primer `role === "tool"` con `metadata.status === "awaiting_approval"` igual. Añadir el label cuando `meta.needsNetwork === true` o `prompt.needsNetwork === true`:

```tsx
import { NETWORK_REQUEST_LABEL } from "../../cli/src/llm/network-constants";
import {
  formatApprovalHeadline,
  type ApprovalPrompt,
} from "../../cli/src/llm/approval-prompt";

const needsNet = meta.needsNetwork === true || prompt?.needsNetwork === true;
// en el Text amarillo:
<Text color="yellow">
  awaiting approval {needsNet ? `${NETWORK_REQUEST_LABEL} ` : ""}
  {left} — [y] sí  [n] no (uno a uno)
</Text>
<Text>{head}</Text>
```

`head` ya incluye `pide red` si Task 4 actualizó `formatApprovalHeadline`. El banner **también** lo dice por si `prompt` viene viejo sin el flag en el kind.

`[y]` / `[n]` siguen siendo **un** toolCallId. Deny de un curl **no** llama nada más: `agent.tool.deny` → daemon `resolveApproval(..., "deny")` → `canUseTool` retorna deny → SDK no spawnea.

- [ ] Extraer `bannerNeedsNetwork(meta)` a función pura y testearla:

```ts
export function bannerNeedsNetwork(meta: Record<string, unknown>): boolean {
  if (meta.needsNetwork === true) return true;
  const prompt = meta.prompt as { needsNetwork?: boolean } | undefined;
  return prompt?.needsNetwork === true;
}
```

Vive en `cli/src/llm/network-constants.ts` (junto al label) o `cli/src/llm/network-classify.ts`. Test: `{ needsNetwork: true }` → true; `{ prompt: { kind: "bash", command: "ls" } }` → false.

- [ ] CLI `chat watch` en `cli/src/commands/headless.ts`. Si ya usa `formatWatchLine`, Task 4 cubre el copy. Si aún vuelca JSON, **no** cambiar a format aún (eso es plan 2): el JSON incluye `metadata.needsNetwork` porque Task 4 lo persistió. Añadir un `console.error` **una** vez por pedido, sin romper el JSON stdout:

```ts
const data = msg.data as {
  chatId?: string;
  metadata?: { needsNetwork?: boolean; status?: string };
  status?: string;
} | undefined;
const meta = data?.metadata;
if (
  msg.type === "chat.tool.update" &&
  (meta?.status === "awaiting_approval" || data?.status === "awaiting_approval") &&
  meta?.needsNetwork
) {
  console.error("pide red");
}
```

Stderr, no stdout. Tests de consumers JSON siguen verdes.

- [ ] Correr:

```bash
cd cli && bun test src/llm/network-classify.test.ts src/llm/approval-prompt.test.ts
```

Esperado: `bannerNeedsNetwork` / headline cubiertos. TUI no tiene runner de Ink obligatorio; el import no debe romper `tui` (`tui` ya importa `cli/src/llm/publish-turn`).

- [ ] Commit:

```bash
git add tui/src/App.tsx cli/src/commands/headless.ts \
  cli/src/llm/network-constants.ts cli/src/llm/watch-format.ts
git commit -m "feat(sandbox): TUI and watch show pide red on network ask"
```

---

## Task 7: Web — badge `pide red` en el ToolCard

**Files:**

- Create: `web/src/lib/network-constants.ts`
- Test: `web/src/lib/network-constants.test.ts`
- Modify: `web/src/lib/approval-prompt.ts` (si plan 13 lo creó; si no, crear solo `formatNetworkHeadline`)
- Test: `web/src/lib/approval-prompt.test.ts` (extender o crear)
- Modify: `web/src/components/ChatDetailPanel.tsx`
- Modify: `web/src/components/WorkspaceDetailPanel.tsx`
- Modify: `web/src/styles/global.css`
- Modify: `web/package.json`

Web **no** importa `cli/`. Keep-in-sync: el string **es** `"pide red"`.

- [ ] Añadir `"test": "bun test"` en `web/package.json` scripts si falta (dejar `dev`/`build`/`preview`/`start`).

- [ ] Crear `web/src/lib/network-constants.ts`:

```ts
/** keep-in-sync: cli/src/llm/network-constants.ts */
export const NETWORK_REQUEST_LABEL = "pide red";

export function bannerNeedsNetwork(meta: Record<string, unknown>): boolean {
  if (meta.needsNetwork === true) return true;
  const prompt = meta.prompt as { needsNetwork?: boolean } | undefined;
  return prompt?.needsNetwork === true;
}
```

Test: `bannerNeedsNetwork({ needsNetwork: true }) === true`; `bannerNeedsNetwork({ status: "awaiting_approval" }) === false`.

- [ ] En `web/src/lib/approval-prompt.ts`, si existe `formatApprovalHeadline`, anteponer `pide red · ` cuando `prompt.needsNetwork`. Si el archivo no existe:

```ts
/** keep-in-sync: cli/src/llm/approval-prompt.ts formatApprovalHeadline */
import { NETWORK_REQUEST_LABEL } from "./network-constants";

export function formatNetworkHeadline(input: {
  needsNetwork?: boolean;
  summary?: string;
  command?: string;
  url?: string;
}): string {
  const net = input.needsNetwork ? `${NETWORK_REQUEST_LABEL} · ` : "";
  const body = input.command || input.url || input.summary || "";
  return `${net}${body}`.trim();
}
```

Test: `{ needsNetwork: true, command: "curl https://x" }` contiene `pide red` y `curl`.

- [ ] `ToolCard` en `web/src/components/ChatDetailPanel.tsx`. Reusar botones Aprobar/Rechazar del plan 13 si están. Añadir el badge **solo** cuando `awaiting && bannerNeedsNetwork(meta)`:

```tsx
import {
  NETWORK_REQUEST_LABEL,
  bannerNeedsNetwork,
} from "../lib/network-constants";

// junto al badge de status:
{awaiting && bannerNeedsNetwork(meta) ? (
  <span className="badge warn" data-testid="needs-network">
    {NETWORK_REQUEST_LABEL}
  </span>
) : null}
```

Sin botón “siempre permitir”. Un click = un `toolCallId`. Deny manda `agent.tool.deny`; el daemon no spawnea.

Lecturas **no** pintan el badge ni los botones (plan 13 `isReadTool`).

- [ ] `WorkspaceDetailPanel.tsx` preview: si el label es `tool · ${name}` y el último tool está `awaiting_approval` con `needsNetwork`, usar `tool · bash · awaiting_approval · pide red`. Si el preview no tiene metadata de tools, no inventar un explorador.

- [ ] CSS: reusar `.badge.warn` del plan 13. Si no está:

```css
.badge.warn {
  color: #f0c36d;
  border-color: color-mix(in srgb, #f0c36d 40%, var(--border));
}
```

- [ ] Correr:

```bash
cd web && bun test src/lib/network-constants.test.ts src/lib/approval-prompt.test.ts
```

Esperado: label exacto `pide red`; needsNetwork false no lo pinta.

- [ ] Commit:

```bash
git add web/package.json web/src/lib/network-constants.ts \
  web/src/lib/network-constants.test.ts web/src/lib/approval-prompt.ts \
  web/src/lib/approval-prompt.test.ts \
  web/src/components/ChatDetailPanel.tsx \
  web/src/components/WorkspaceDetailPanel.tsx \
  web/src/styles/global.css
git commit -m "feat(sandbox): Web ToolCard shows pide red for network asks"
```

---

## Task 8: Fetch hook + verificación Gherkin

**Files:**

- Create: `cli/src/llm/network-fetch.ts`
- Test: `cli/src/llm/network-fetch.test.ts`
- Create: `cli/scripts/sandbox-network-smoke.ts`
- Modify: `cli/package.json`
- Modify: `cli/src/llm/can-use-tool.network.test.ts` (casos Gherkin restantes)

Cierra los cinco escenarios. Plan 30 importa `gateWebFetch` y **no** reimplementa el modo.

- [ ] Crear `cli/src/llm/network-fetch.ts`:

```ts
import type { ExecutionMode } from "./execution-mode";
import { gateNetwork, type NetworkGate } from "./network-gate";

/**
 * Plan 30 llama esto ANTES de fetch() en el daemon.
 * Auto → deny. Plan → deny. Ask → ask (el waiter vive en canUseTool).
 * SSRF (localhost, metadata cloud) es plan 30, no este módulo.
 */
export function gateWebFetch(
  mode: ExecutionMode,
  url: string,
): NetworkGate {
  return gateNetwork(mode, "WebFetch", { url });
}

export function shouldSpawnFetch(gate: NetworkGate): boolean {
  return gate.action === "allow" && gate.network === true;
}
```

`shouldSpawnFetch` es false para auto/plan/ask-pendiente. Plan 30 **solo** llama `fetch(url)` después de `canUseTool` allow. Ask deny → `shouldSpawnFetch` ni se consulta porque `decideCanUseTool` ya retornó deny.

- [ ] Tests `cli/src/llm/network-fetch.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { NETWORK_DENIED_AUTO, NETWORK_DENIED_PLAN } from "./network-constants";
import { gateWebFetch, shouldSpawnFetch } from "./network-fetch";

describe("gateWebFetch", () => {
  test("auto denies internet fetch", () => {
    const g = gateWebFetch("auto", "https://example.com");
    expect(g.action).toBe("deny");
    expect(g.message).toBe(NETWORK_DENIED_AUTO);
    expect(shouldSpawnFetch(g)).toBe(false);
  });

  test("ask requires approval", () => {
    const g = gateWebFetch("ask", "https://example.com");
    expect(g.action).toBe("ask");
    expect(g.network).toBe(true);
    expect(shouldSpawnFetch(g)).toBe(false);
  });

  test("plan denies", () => {
    const g = gateWebFetch("plan", "https://example.com");
    expect(g.message).toBe(NETWORK_DENIED_PLAN);
    expect(shouldSpawnFetch(g)).toBe(false);
  });
});
```

- [ ] Completar la matriz Gherkin en `cli/src/llm/can-use-tool.network.test.ts` (añadir si faltan):

| Escenario | Test |
|---|---|
| Auto sin red | `auto + curl` → deny `NETWORK_DENIED_AUTO`; `ask` no se llama |
| Assistant ve el error | el `message` es exactamente `NETWORK_DENIED_AUTO` (el SDK lo reenvía como tool_result error; publish-turn ya persiste `status: "error"`) |
| Ask pide red | `ask + curl` → `ask({ needsNetwork: true })` |
| Ask apruebo, corre | approve → `behavior: "allow"`, `needsNetwork: true`, `dangerouslyDisableSandbox: true` |
| Ask rechazo, 0 paquetes | deny → `NETWORK_DENIED_ASK`; **no** hay `updatedInput` (nada que el SDK spawnee) |
| Plan no muta ni sale | `plan + curl` → deny; ask no se llama |
| FS = workspace | `auto + cat /etc/passwd` → `Path outside workspace:` |
| Fetch plan 30 | `auto + WebFetch` → `NETWORK_DENIED_AUTO`; `ask + WebFetch` deny → `NETWORK_DENIED_ASK` |

Añadir un test de “0 paquetes” con spawn inyectado en wrap. **No** hace falta sniffers:

```ts
test("ask deny never builds a wrap (no spawn)", async () => {
  const r = await decideCanUseTool({
    cwd,
    executionMode: "ask",
    toolName: "Bash",
    toolInput: { command: "curl https://example.com" },
    ask: async () => "deny",
  });
  expect(r.behavior).toBe("deny");
  expect("updatedInput" in r ? r.updatedInput : undefined).toBeUndefined();
});
```

- [ ] Smoke `cli/scripts/sandbox-network-smoke.ts`. **No** llama a Anthropic ni a internet de verdad para el caso auto (el gate es síncrono). Usa un cwd tmp:

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideCanUseTool } from "../src/llm/can-use-tool";
import { NETWORK_DENIED_AUTO, NETWORK_DENIED_ASK } from "../src/llm/network-constants";
import { PLAN_MUTATION_DENIED } from "../src/llm/execution-mode";
import { gateWebFetch } from "../src/llm/network-fetch";
import { detectSandboxBackend, runSandboxedBash } from "../src/llm/sandbox-wrap";

const cwd = mkdtempSync(join(tmpdir(), "chavez-net-smoke-"));
mkdirSync(join(cwd, "src"));
writeFileSync(join(cwd, "src", "a.ts"), "ok");

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const autoCurl = await decideCanUseTool({
  cwd,
  executionMode: "auto",
  toolName: "Bash",
  toolInput: { command: "curl https://example.com" },
});
if (autoCurl.behavior !== "deny" || autoCurl.message !== NETWORK_DENIED_AUTO) {
  fail(`auto curl: ${JSON.stringify(autoCurl)}`);
}

const askDeny = await decideCanUseTool({
  cwd,
  executionMode: "ask",
  toolName: "Bash",
  toolInput: { command: "curl https://example.com" },
  ask: async () => "deny",
});
if (askDeny.behavior !== "deny" || askDeny.message !== NETWORK_DENIED_ASK) {
  fail(`ask deny: ${JSON.stringify(askDeny)}`);
}

const planCurl = await decideCanUseTool({
  cwd,
  executionMode: "plan",
  toolName: "Bash",
  toolInput: { command: "curl https://example.com" },
});
if (planCurl.behavior !== "deny") fail(`plan curl ran: ${JSON.stringify(planCurl)}`);

const autoEtc = await decideCanUseTool({
  cwd,
  executionMode: "auto",
  toolName: "Bash",
  toolInput: { command: "cat /etc/passwd" },
});
if (autoEtc.behavior !== "deny" || !String((autoEtc as { message: string }).message).startsWith("Path outside workspace:")) {
  fail(`fs escape: ${JSON.stringify(autoEtc)}`);
}

const fetchAuto = gateWebFetch("auto", "https://example.com");
if (fetchAuto.action !== "deny") fail("fetch auto allowed");

const backend = detectSandboxBackend();
if (backend !== "none") {
  const r = await runSandboxedBash({
    cwd,
    network: false,
    command: "curl -sS --max-time 3 https://example.com",
  });
  if (r.exitCode === 0) fail("wrap allowed curl with network=false");
}

console.log("sandbox-network smoke ok");
```

Si `PLAN_MUTATION_DENIED` no se puede importar (plan 3 ausente), comparar `planCurl.behavior === "deny"` basta.

- [ ] Añadir en `cli/package.json`: `"test:sandbox-network": "bun run scripts/sandbox-network-smoke.ts"`.

- [ ] Correr:

```bash
cd cli && bun test src/llm/network-classify.test.ts src/llm/bash-fs.test.ts \
  src/llm/network-gate.test.ts src/llm/sandbox-wrap.test.ts \
  src/llm/can-use-tool.network.test.ts src/llm/network-fetch.test.ts \
  src/llm/claude-runner.sandbox.test.ts src/llm/approval-prompt.test.ts
cd cli && bun run test:sandbox-network
```

Esperado: matriz Gherkin verde; smoke imprime `sandbox-network smoke ok`; curl en wrap `network:false` ≠ 0 cuando hay backend.

- [ ] Commit:

```bash
git add cli/src/llm/network-fetch.ts cli/src/llm/network-fetch.test.ts \
  cli/src/llm/can-use-tool.network.test.ts \
  cli/scripts/sandbox-network-smoke.ts cli/package.json
git commit -m "test(sandbox): gherkin network policy, FS bash, fetch hook"
```

---

## Orden de ejecución

1. Task 1 (política pura) — no depende del SDK ni de API.
2. Task 2 (wrap OS) — no depende de `canUseTool`.
3. Task 3 (runner) — depende de 1–2 y de `denyIfEscapes` / `gateMutation` (copiar mínimos si faltan).
4. Task 4 (awaiting_approval `pide red`) — depende de Task 3 y del waiter de planes 3/13 (crear waiter mínimo si falta; **no** auto-aprobar).
5. Task 5 (Cursor) — depende de Task 3; no-op si no hay `cursor-runner.ts`.
6. Task 6 (TUI / watch) — depende de Task 4.
7. Task 7 (Web) — depende de Task 4 (el flag viaja en metadata).
8. Task 8 (fetch hook + smoke) — después de 1–3; idealmente al final.

Tasks 5, 6 y 7 son paralelizables entre sí una vez 3–4 están mergeadas.

## Verificación Gherkin → task

| Escenario | Dónde se cubre |
|---|---|
| Auto sin red: bash curl falla por política | Task 1 `gateNetwork` + Task 3 `decideCanUseTool` deny `NETWORK_DENIED_AUTO` + Task 8 smoke |
| El assistant ve el error | Task 3 deny `message` → SDK tool_result error → `chat.tool.result` status error (contrato plan 2) |
| Ask puede pedir red | Task 1 ask + Task 4 `needsNetwork` + headline `pide red` + Tasks 6/7 UI |
| Si apruebo, corre | Task 3 approve → `updatedInput` wrap `network: true` + `dangerouslyDisableSandbox: true` |
| Si rechazo, no hay paquete saliente | Task 3 deny sin `updatedInput`; Task 8 test “never builds a wrap”; waiter no llama spawn |
| Plan no muta ni sale a red | Task 3 `gateMutation` / `NETWORK_DENIED_PLAN`; ask no se llama; disco intacto |
| FS = workspace (auto bash) | Task 1 `denyIfBashEscapes` + Task 2 wrap bind cwd + Task 8 `cat /etc/passwd` |
| Igual que read/write (planes 2 y 8) | `denyIfEscapes` primero; `denyIfIgnored` si existe; mismo `PATH_ESCAPE_PREFIX` |
| Fetch/browser (plan 30) respeta lo mismo | Task 1 `WebFetch` + Task 8 `gateWebFetch`; auto deny; ask aprueba; plan deny |

## Fuera de este plan (no implementar)

- Tool HTTP visible, truncado, SSRF localhost/metadata → [web-fetch](../web-fetch/plan.md). **Debe** llamar `gateWebFetch` / `decideCanUseTool`.
- Allowlist de hosts, `.cursor/sandbox.json`, “siempre permitir”, lote.
- Cursor cloud, voz, extensión IDE, upload desde el navegador.
- MCP HTTP handshake del repo → [mcp-skills-subagents](../mcp-skills-subagents/plan.md) (intención explícita; no cortar).
- `git_push` / `git_pr` dedicadas → [git-workspace](../git-workspace/plan.md) (auto puede pushear si el usuario lo pidió). Bash `git push` **sí** es red aquí.
- Cola de turns → [turn-queue](../turn-queue/plan.md).
- PTY interactivo → [pty-terminal](../pty-terminal/plan.md).
- Slash `/mode` → [slash-commands](../slash-commands/plan.md).
