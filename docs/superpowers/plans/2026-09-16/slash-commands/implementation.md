# Slash commands Implementation Plan

> **For agentic workers:** Execute task-by-task. Do not skip tests. Do not implement Cursor cloud, voz, extensión IDE, upload desde el navegador, `/git` (plan 7), `/rules` (plan 9), MCP/skills (plan 19), cola de turns (plan 29), ni notificaciones OS/email. Spec: [`plan.md`](./plan.md). Si un sibling (`execution-modes`, `cursor-provider`, `context-compact`, `checkpoints-undo`, `usage-cost`, `attach-files`) ya creó un archivo citado, **extiéndelo**; no lo reescribas. Esta fase **no** reimplementa compact, undo, modos ni catálogos: los dispara.

**Goal:** El usuario opera el harness sin salir del chat. En TUI y Web, `/` abre un picker de **comandos** (nunca archivos) y no se confunde con `@`. Los comandos mínimos (`/mode`, `/model`, `/provider`, `/compact`, `/clear`, `/undo`, `/cost`, `/help`, `/plan`) se ejecutan en el compositor; no van al LLM. `/mode` / `/provider` / `/model` persisten preferencias y el siguiente turn las respeta en todas las superficies. `/compact` y `/undo` reutilizan los planes 10 y 12 con feedback en el chat. `/cost` muestra usage o `sin datos`. CLI headless tiene flags y subcomandos equivalentes **sin TTY**.

**Architecture:** El filesystem y el runner viven en el daemon (`cli/src/ws/daemon.ts` o TUI con `clientKind: "daemon"`). Slash **no** es un RPC nuevo: el compositor parsea `/`, el dispatcher llama HTTP/WS que ya existen. La API no interpreta el texto del prompt como comando (un `agent.turn.request` con prompt `/mode auto` sería un bug de esta fase: el cliente debe interceptar). Web duplica el parser (`web/` no importa `cli/`). TUI importa los módulos CLI.

```
Composer (Web | TUI)
        |  tecla "/"  → picker de comandos (máx 10)
        |  tecla "@"  → picker de archivos (plan 1); NUNCA a la vez
        v
  parseSlash(input)            — módulo puro
        |  unknown → feedback "Unknown command. Try /help"  (NO LLM)
        |  /mode|/provider|/model|/plan
        |       PUT /providers/preferences | PUT /providers/active
        |       prefs.updated  → Web, TUI, CLI watch
        |  /compact  → chat.compact          (plan 10)
        |  /undo     → agent.turn.undo       (plan 12)
        |  /cost     → chat.get + formatCost (plan 15 o "sin datos")
        |  /clear    → chat.create (mismo session); compositor vacío
        |  /help     → lista comandos y modos
        v
  chat.append system { kind: "slash_result" }   — timeline + watch
  historyFromChatMessages SALTA slash_result     — el LLM no los ve

CLI headless (sin TTY, sin picker)
  chavez mode [plan|auto|ask]
  chavez provider set <claude|cursor>
  chavez model [id]
  chavez headless chat compact|undo|cost|clear|ask [--mode|--provider|--model]
  chavez headless chat ask <id> /compact     — el prompt entero es slash
```

Estado actual que este plan extiende (no reescribir):

- Web compositor (`web/src/components/ChatDetailPanel.tsx`): `<textarea>` plano (o `MentionComposer` si attach-files aterrizó). Enter en el form dispara `agent.turn.request` con el texto crudo. **No** hay picker `/`.
- TUI compose (`tui/src/App.tsx`): concatena caracteres; Enter llama `sendWithLlm`. Si context-compact aterrizó, intercepta el string exacto `/compact`. Si attach-files aterrizó, `activeMention` abre picker `@` con `lastIndexOf("@")`. **No** hay picker `/` genérico. Tecla `p`/`[`/`]`/`o` ciclan provider/model/modo **fuera** de compose.
- CLI `cli/src/index.ts`: `login|logout|whoami|provider|tui|headless`. **No** hay `chavez model`. `chavez mode` lo añade execution-modes; si aún no existe, esta fase lo crea (mismo contrato).
- CLI `cli/src/commands/headless.ts` chat: `create|list|append|get|ask|watch` (+ `compact`/`undo`/`retry` si planes 10/12 aterrizaron). **No** hay `cost` ni `clear`. `ask` manda cualquier prompt al LLM, incluido `/mode auto`.
- `PUT /providers/preferences` y `PUT /providers/active` ya persisten provider/model/effort (y `activeExecutionMode` si plan 3 aterrizó). `prefs.updated` se broadcast si plan 3 aterrizó; si no, esta fase lo añade al PUT de preferences (no inventar otro event).
- Validación provider/model imposible (`claude-sonnet-4-6` + `cursor` → 400) la añade cursor-provider (`api/src/llm/prefs-validate.ts`). Si aún no existe, el dispatcher **rechaza en cliente** contra el catálogo de `GET /providers` con el mismo string `INVALID_PROVIDER_MODEL`.
- `chat.compact` (plan 10) y `agent.turn.undo` (plan 12): si los handlers no existen, `/compact` y `/undo` fallan con el error del RPC y se muestra en el chat; **no** se reimplementa el algoritmo aquí.
- `cli/src/llm/history.ts` mete `role=system` al LLM. Los `slash_result` **no** deben ir al modelo.
- Cursor `runnable: false` hoy. `/provider cursor` y `/model` de Cursor **sí** persisten; no simular un turn Cursor.
- CLI interactivo **es** la TUI. Headless no tiene picker; parsea el prompt entero si empieza por `/`, o usa flags.

**Tech Stack:** Bun, Hono WebSocket hub (sin event nuevo de slash), Drizzle `chat_messages.metadata` jsonb (sin migración), `PUT /providers/preferences`, Ink TUI, Astro/React web. Tests: `bun test`. Web no importa CLI: duplicar `slash.ts` (mismo source, comentario keep-in-sync).

**Global Constraints:**

1. El filesystem se lee **solo** en el daemon. Slash **no** lista archivos. El picker `/` no llama `fs.complete` ni `completeWorkspace`.
2. `/` y `@` son triggers **mutuamente excluyentes**. Con `/` activo no se abre el picker de archivos. Con `@` activo no se abre el de comandos. Un path `src/lib` o un email `user@host` no es slash.
3. Un comando `/` **nunca** se envía como `agent.turn.request`. El compositor intercepta Enter. Headless `chat ask` cuyo prompt recortado empieza por `/` despacha slash, no el LLM.
4. Preferencias (modo, provider, modelo) se persisten en `user_preferences` y se respetan en Web, TUI y el **siguiente** turn. Cambiar modo **no** cancela el turn en curso.
5. `/provider` + `/model` incompatibles se rechazan con mensaje que nombra ambos. Un modelo Claude con provider `cursor` no se guarda.
6. `/compact` dispara el RPC del plan 10. `/undo` dispara el RPC del plan 12. Feedback en el chat (marcador existente o `slash_result` si el RPC aún no appendea). Sin daemon: el string existente `"No daemon bound for this workspace. Run: chavez headless workspace open"`.
7. `/clear` crea un chat nuevo en la **misma session** (Web navega; TUI cambia `activeChatId`; CLI imprime el id). **No** corre git, **no** borra el workspace, **no** hace `rm`. El compositor queda vacío.
8. `/cost` lee usage ya persistido (plan 15: JSON crudo por provider). Si no hay datos, exactamente `sin datos` — no es error, no bloquea el chat.
9. `/help` lista los 9 comandos y los 3 modos. Un comando desconocido explica `/help` con `UNKNOWN_SLASH`. No adivina typos hacia un attach.
10. Picker: máximo **10** candidatos; se afina con el prefijo; selección **de uno en uno** (inserta el comando; otro `/` para otro). Args de `/model` también máx 10 ids del catálogo **del provider activo**.
11. Lecturas no piden confirmación. Slash no es una tool del modelo y no entra en `canUseTool`.
12. Claude es el provider ejecutable hoy. Cursor vinculado puede seleccionarse; un turn Cursor sigue las reglas del plan 4 (si `runnable: false`, el turn falla con el error existente, no con un stub).
13. Web, TUI y CLI `watch` ven el mismo `slash_result` (y los mismos markers de compact/undo). Un reload de `chat.get` reconstruye el feedback.
14. CLI headless **no** requiere TTY para mode/provider/model/compact: subcomandos y flags. No hay prompts interactivos en esos paths.
15. Fuera de alcance: Cursor cloud, voz, extensión IDE, upload desde el navegador, notificaciones OS/email, `/git`, `/rules`, skills/MCP como slash, lote, “siempre permitir”.

**Constantes (congeladas, no inventar otras):**

| Nombre | Valor |
|---|---|
| `SLASH_COMMAND_IDS` | `"mode"` \| `"model"` \| `"provider"` \| `"compact"` \| `"clear"` \| `"undo"` \| `"cost"` \| `"help"` \| `"plan"` |
| `SLASH_PICKER_LIMIT` | `10` |
| `SLASH_RESULT_KIND` | `"slash_result"` |
| `UNKNOWN_SLASH` | `"Unknown command. Try /help"` |
| `NO_USAGE_TEXT` | `"sin datos"` |
| `CLEAR_OK` | `"Nuevo chat. El repo no se tocó."` |
| `SLASH_USAGE_MODE` | `"Usage: /mode ask\|auto\|plan"` |
| `SLASH_USAGE_PROVIDER` | `"Usage: /provider claude\|cursor"` |
| `SLASH_USAGE_MODEL` | `"Usage: /model <id>"` |
| `MODE_SET` | `` `Mode → ${mode}` `` |
| `PROVIDER_SET` | `` `Provider → ${provider}` `` |
| `MODEL_SET` | `` `Model → ${modelId}` `` |
| `HELP_HEADER` | `"Commands:"` |
| `HELP_MODES` | `"Modes: plan · auto · ask"` |
| `NO_DAEMON_ERROR` | `"No daemon bound for this workspace. Run: chavez headless workspace open"` |
| `TURN_BUSY_ERROR` | `"Turn already running on this daemon"` |
| `INVALID_MODE_ERROR` | `"executionMode must be plan, auto, or ask"` (reusar plan 3 si existe) |
| `INVALID_PROVIDER_MODEL` | `` `modelId "${model}" does not belong to provider ${provider}` `` (reusar plan 4 si existe) |
| `PROVIDER_MUST` | `"provider must be claude or cursor"` |
| `NO_CHAT_ERROR` | `"No hay chat activo"` |
| `NO_SESSION_ERROR` | `"No hay session activa"` |

Reusar `NO_DAEMON_ERROR` / `TURN_BUSY_ERROR` / `INVALID_MODE_ERROR` / `UNDO_REQUIRES_GIT` / `COMPACT_NO_HISTORY` si ya existen; **no** cambiar esos strings.

Catálogo del picker (`id`, `usage`, `summary`) — orden fijo:

| id | usage | summary |
|---|---|---|
| `mode` | `/mode ask\|auto\|plan` | Cambia el modo de ejecución y lo persiste |
| `plan` | `/plan` | Atajo a `/mode plan` |
| `provider` | `/provider claude\|cursor` | Cambia el provider activo |
| `model` | `/model <id>` | Cambia el modelo del provider activo |
| `compact` | `/compact` | Compacta el contexto de este chat |
| `clear` | `/clear` | Empieza un chat nuevo (no borra el repo) |
| `undo` | `/undo` | Deshace el último turn vía git |
| `cost` | `/cost` | Muestra usage del chat/turn |
| `help` | `/help` | Lista comandos y modos |

Args que el picker completa (además de los ids):

| Comando | Args |
|---|---|
| `/mode` | `ask`, `auto`, `plan` |
| `/provider` | `claude`, `cursor` |
| `/model` | ids del catálogo del **provider activo**, máx 10, filtrados por prefijo |
| `/plan`, `/compact`, `/clear`, `/undo`, `/cost`, `/help` | ninguno |

Nombres de events WS (ninguno nuevo de slash):

| Tipo | Dirección | Quién lo emite |
|---|---|---|
| `prefs.updated` | API → broadcast | PUT `/providers/preferences` (plan 3; añadir si falta) |
| `chat.compact` / `chat.compact.done` | plan 10 | `/compact` |
| `agent.turn.undo` / `chat.checkpoint.undone` | plan 12 | `/undo` |
| `chat.create` / `chat.created` | ya existe | `/clear` |
| `chat.append` / `message.appended` | ya existe | `slash_result` |
| `chat.get` | ya existe | `/cost` |

`slash_result` metadata:

```ts
type SlashResultMeta = {
  kind: "slash_result";
  command: string;      // "mode" | "unknown" | …
  ok: boolean;
};
```

`content` es el texto que ve el usuario (`Mode → auto`, `Unknown command. Try /help`, `sin datos`, help multilínea).

---

## Task 1: Parser, catálogo y picker — módulo puro CLI

**Files:**

- Create: `cli/src/llm/slash.ts`
- Test: `cli/src/llm/slash.test.ts`
- Modify: `cli/package.json`

Sin I/O de red ni filesystem. TUI importa desde aquí. Web **no** importa CLI: Task 6 copia el archivo.

- [ ] Añadir `"test": "bun test"` en `cli/package.json` `scripts` si aún no existe (dejar `start`/`dev`/`bin` intactos):

```json
"scripts": {
  "start": "bun run src/index.ts",
  "dev": "bun run src/index.ts",
  "test": "bun test"
}
```

- [ ] Crear `cli/src/llm/slash.ts`:

```ts
export const SLASH_PICKER_LIMIT = 10;
export const SLASH_RESULT_KIND = "slash_result";

export const UNKNOWN_SLASH = "Unknown command. Try /help";
export const NO_USAGE_TEXT = "sin datos";
export const CLEAR_OK = "Nuevo chat. El repo no se tocó.";
export const SLASH_USAGE_MODE = "Usage: /mode ask|auto|plan";
export const SLASH_USAGE_PROVIDER = "Usage: /provider claude|cursor";
export const SLASH_USAGE_MODEL = "Usage: /model <id>";
export const HELP_HEADER = "Commands:";
export const HELP_MODES = "Modes: plan · auto · ask";
export const NO_CHAT_ERROR = "No hay chat activo";
export const NO_SESSION_ERROR = "No hay session activa";
export const PROVIDER_MUST = "provider must be claude or cursor";

export const SLASH_COMMAND_IDS = [
  "mode",
  "model",
  "provider",
  "compact",
  "clear",
  "undo",
  "cost",
  "help",
  "plan",
] as const;

export type SlashCommandId = (typeof SLASH_COMMAND_IDS)[number];

export type SlashCatalogEntry = {
  id: SlashCommandId;
  usage: string;
  summary: string;
};

export const SLASH_CATALOG: SlashCatalogEntry[] = [
  {
    id: "mode",
    usage: "/mode ask|auto|plan",
    summary: "Cambia el modo de ejecución y lo persiste",
  },
  {
    id: "plan",
    usage: "/plan",
    summary: "Atajo a /mode plan",
  },
  {
    id: "provider",
    usage: "/provider claude|cursor",
    summary: "Cambia el provider activo",
  },
  {
    id: "model",
    usage: "/model <id>",
    summary: "Cambia el modelo del provider activo",
  },
  {
    id: "compact",
    usage: "/compact",
    summary: "Compacta el contexto de este chat",
  },
  {
    id: "clear",
    usage: "/clear",
    summary: "Empieza un chat nuevo (no borra el repo)",
  },
  {
    id: "undo",
    usage: "/undo",
    summary: "Deshace el último turn vía git",
  },
  {
    id: "cost",
    usage: "/cost",
    summary: "Muestra usage del chat/turn",
  },
  {
    id: "help",
    usage: "/help",
    summary: "Lista comandos y modos",
  },
];

const ID_SET = new Set<string>(SLASH_COMMAND_IDS);

export function isSlashCommandId(v: string): v is SlashCommandId {
  return ID_SET.has(v);
}

export function modeSetText(mode: string): string {
  return `Mode → ${mode}`;
}

export function providerSetText(provider: string): string {
  return `Provider → ${provider}`;
}

export function modelSetText(modelId: string): string {
  return `Model → ${modelId}`;
}

export function invalidProviderModel(model: string, provider: string): string {
  return `modelId "${model}" does not belong to provider ${provider}`;
}

/** True when the whole trimmed composer is a slash command (execute on Enter). */
export function isSlashInput(text: string): boolean {
  return text.trimStart().startsWith("/");
}

/**
 * Active `/` token at the cursor. Used by the picker.
 * Does not match `@…`, `user@host`, or `src/lib`.
 * Keep in sync with web/src/lib/slash.ts.
 */
export function activeSlash(
  text: string,
  cursor: number = text.length,
): { start: number; query: string } | null {
  const slice = text.slice(0, cursor);
  const start = slice.lastIndexOf("/");
  if (start < 0) return null;
  if (start > 0 && !/\s/.test(slice[start - 1]!)) return null;
  const rest = slice.slice(start + 1);
  if (/\n/.test(rest)) return null;
  return { start, query: rest };
}

/**
 * Active `@` token at the cursor (same rules as attach-files `activeMention`).
 * Duplicated here so slash vs mention exclusion no importa de un sibling.
 */
export function activeMentionToken(
  text: string,
  cursor: number = text.length,
): { start: number; query: string } | null {
  const slice = text.slice(0, cursor);
  const at = slice.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0 && /[A-Za-z0-9_]/.test(slice[at - 1]!)) return null;
  const rest = slice.slice(at + 1);
  if (/\s/.test(rest)) return null;
  return { start: at, query: rest };
}

export type ComposerTrigger =
  | { kind: "slash"; start: number; query: string }
  | { kind: "mention"; start: number; query: string };

/**
 * Mutually exclusive trigger. If both tokens exist, the one closer to the
 * cursor wins; `/` never opens the file picker.
 */
export function composerTrigger(
  text: string,
  cursor: number = text.length,
): ComposerTrigger | null {
  const slash = activeSlash(text, cursor);
  const mention = activeMentionToken(text, cursor);
  if (slash && mention) {
    return slash.start >= mention.start
      ? { kind: "slash", ...slash }
      : { kind: "mention", ...mention };
  }
  if (slash) return { kind: "slash", ...slash };
  if (mention) return { kind: "mention", ...mention };
  return null;
}

export type ParsedSlash =
  | { ok: true; command: SlashCommandId; args: string[]; raw: string }
  | { ok: false; error: "not_slash"; raw: string }
  | { ok: false; error: "unknown"; raw: string; name: string };

function tokenize(body: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    out.push(m[1] ?? m[2] ?? m[3] ?? "");
  }
  return out.filter((t) => t.length > 0);
}

export function parseSlash(text: string): ParsedSlash {
  const raw = text.trim();
  if (!raw.startsWith("/")) return { ok: false, error: "not_slash", raw };
  const body = raw.slice(1);
  const tokens = tokenize(body);
  const name = (tokens[0] ?? "").toLowerCase();
  if (!name) {
    return { ok: true, command: "help", args: [], raw };
  }
  if (!isSlashCommandId(name)) {
    return { ok: false, error: "unknown", raw, name };
  }
  return { ok: true, command: name, args: tokens.slice(1), raw };
}

export type SlashPickItem = {
  id: string;
  label: string;
  insert: string;
  executeOnPick: boolean;
};

function prefixScore(id: string, prefix: string): number {
  const p = prefix.toLowerCase();
  const s = id.toLowerCase();
  if (!p) return 0;
  if (s === p) return 0;
  if (s.startsWith(p)) return 1;
  if (s.includes(p)) return 2;
  return 99;
}

function rankIds(ids: string[], prefix: string, limit: number): string[] {
  const p = prefix.toLowerCase();
  const scored = ids
    .map((id) => ({ id, score: prefixScore(id, p) }))
    .filter((x) => x.score < 99)
    .sort((a, b) => a.score - b.score || a.id.localeCompare(b.id));
  return scored.slice(0, limit).map((x) => x.id);
}

const MODE_ARGS = ["ask", "auto", "plan"] as const;
const PROVIDER_ARGS = ["claude", "cursor"] as const;

export function slashPickerItems(
  query: string,
  opts: { modelIds?: string[] } = {},
): SlashPickItem[] {
  const q = query.replace(/^\s+/, "");
  const space = q.indexOf(" ");
  const cmdToken = (space < 0 ? q : q.slice(0, space)).toLowerCase();
  const rest = space < 0 ? "" : q.slice(space + 1);
  const completingArgs = space >= 0;

  if (!completingArgs) {
    const ids = rankIds([...SLASH_COMMAND_IDS], cmdToken, SLASH_PICKER_LIMIT);
    return ids.map((id) => {
      const entry = SLASH_CATALOG.find((e) => e.id === id)!;
      const needsArgs = id === "mode" || id === "provider" || id === "model";
      return {
        id,
        label: `${entry.usage}  — ${entry.summary}`,
        insert: needsArgs ? `/${id} ` : `/${id}`,
        executeOnPick: !needsArgs,
      };
    });
  }

  if (cmdToken === "mode") {
    const args = rankIds([...MODE_ARGS], rest.trim(), SLASH_PICKER_LIMIT);
    return args.map((a) => ({
      id: `mode:${a}`,
      label: `/mode ${a}`,
      insert: `/mode ${a}`,
      executeOnPick: true,
    }));
  }
  if (cmdToken === "provider") {
    const args = rankIds([...PROVIDER_ARGS], rest.trim(), SLASH_PICKER_LIMIT);
    return args.map((a) => ({
      id: `provider:${a}`,
      label: `/provider ${a}`,
      insert: `/provider ${a}`,
      executeOnPick: true,
    }));
  }
  if (cmdToken === "model") {
    const ids = rankIds(opts.modelIds ?? [], rest.trim(), SLASH_PICKER_LIMIT);
    return ids.map((a) => ({
      id: `model:${a}`,
      label: `/model ${a}`,
      insert: `/model ${a}`,
      executeOnPick: true,
    }));
  }
  return [];
}

export function formatHelp(): string {
  const lines = [
    HELP_HEADER,
    ...SLASH_CATALOG.map((e) => `  ${e.usage}  — ${e.summary}`),
    HELP_MODES,
  ];
  return lines.join("\n");
}

export function isSlashResultMeta(meta: unknown): boolean {
  if (!meta || typeof meta !== "object") return false;
  return (meta as { kind?: unknown }).kind === SLASH_RESULT_KIND;
}
```

- [ ] Crear `cli/src/llm/slash.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  SLASH_PICKER_LIMIT,
  UNKNOWN_SLASH,
  activeSlash,
  composerTrigger,
  formatHelp,
  HELP_MODES,
  isSlashInput,
  parseSlash,
  slashPickerItems,
} from "./slash";

describe("isSlashInput / parseSlash", () => {
  test("plain prompt is not slash", () => {
    expect(isSlashInput("arregla el test")).toBe(false);
    expect(parseSlash("arregla el test").ok).toBe(false);
    if (!parseSlash("arregla el test").ok) {
      expect(parseSlash("arregla el test").error).toBe("not_slash");
    }
  });

  test("src/lib is not slash", () => {
    expect(isSlashInput("src/lib")).toBe(false);
    expect(parseSlash("cd src/lib").ok).toBe(false);
  });

  test("/mode auto", () => {
    const p = parseSlash("  /mode auto  ");
    expect(p).toEqual({
      ok: true,
      command: "mode",
      args: ["auto"],
      raw: "/mode auto",
    });
  });

  test("/plan is alias command, not mode arg", () => {
    const p = parseSlash("/plan");
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.command).toBe("plan");
  });

  test("unknown explains /help", () => {
    const p = parseSlash("/foo");
    expect(p.ok).toBe(false);
    if (!p.ok && p.error === "unknown") {
      expect(p.name).toBe("foo");
    }
    expect(UNKNOWN_SLASH).toContain("/help");
  });

  test("lone slash is help", () => {
    const p = parseSlash("/");
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.command).toBe("help");
  });
});

describe("composerTrigger: / vs @", () => {
  test("typing / is slash, not mention", () => {
    const t = composerTrigger("/");
    expect(t?.kind).toBe("slash");
    expect(t && t.kind === "slash" ? t.query : null).toBe("");
  });

  test("@src does not open slash", () => {
    const t = composerTrigger("@src");
    expect(t?.kind).toBe("mention");
  });

  test("slash wins over an earlier @", () => {
    const text = "@src/auth.ts /mod";
    const t = composerTrigger(text);
    expect(t?.kind).toBe("slash");
    expect(t && t.kind === "slash" ? t.query : null).toBe("mod");
  });

  test("mention wins over an earlier / in another token", () => {
    const text = "/mode @src";
    const t = composerTrigger(text);
    expect(t?.kind).toBe("mention");
  });

  test("user@host is not mention nor slash", () => {
    expect(composerTrigger("user@host")).toBeNull();
    expect(activeSlash("user@host")).toBeNull();
  });
});

describe("slashPickerItems", () => {
  test("/ lists commands, not files, max 10", () => {
    const items = slashPickerItems("");
    expect(items.length).toBeGreaterThan(0);
    expect(items.length).toBeLessThanOrEqual(SLASH_PICKER_LIMIT);
    expect(items.every((i) => i.insert.startsWith("/"))).toBe(true);
    expect(items.some((i) => i.insert.includes("src/"))).toBe(false);
  });

  test("prefix /c refines to compact/clear/cost", () => {
    const ids = slashPickerItems("c").map((i) => i.id).sort();
    expect(ids).toEqual(["clear", "compact", "cost"]);
  });

  test("/mode args", () => {
    const ids = slashPickerItems("mode a").map((i) => i.id);
    expect(ids).toContain("mode:ask");
    expect(ids).toContain("mode:auto");
    expect(ids).not.toContain("mode:plan");
  });

  test("/model caps at 10 and refines", () => {
    const modelIds = Array.from({ length: 20 }, (_, i) => `m${i}`);
    const items = slashPickerItems("model m1", { modelIds });
    expect(items.length).toBeLessThanOrEqual(10);
    expect(items.every((i) => i.insert.startsWith("/model m1"))).toBe(true);
  });

  test("picking /help executes; /mode inserts trailing space", () => {
    const help = slashPickerItems("hel").find((i) => i.id === "help");
    expect(help?.executeOnPick).toBe(true);
    expect(help?.insert).toBe("/help");
    const mode = slashPickerItems("mod").find((i) => i.id === "mode");
    expect(mode?.executeOnPick).toBe(false);
    expect(mode?.insert).toBe("/mode ");
  });
});

describe("formatHelp", () => {
  test("lists commands and modes", () => {
    const h = formatHelp();
    expect(h).toContain("/mode");
    expect(h).toContain("/compact");
    expect(h).toContain("/undo");
    expect(h).toContain("/cost");
    expect(h).toContain("/help");
    expect(h).toContain(HELP_MODES);
  });
});
```

- [ ] Correr:

```bash
cd cli && bun test src/llm/slash.test.ts
```

Esperado: todos pasan.

- [ ] Commit:

```bash
git add cli/src/llm/slash.ts cli/src/llm/slash.test.ts cli/package.json
git commit -m "feat(slash): parse / commands without confusing them with @"
```

---

## Task 2: Usage `/cost` y `slash_result` fuera del historial LLM

**Files:**

- Create: `cli/src/llm/slash-cost.ts`
- Test: `cli/src/llm/slash-cost.test.ts`
- Modify: `cli/src/llm/history.ts`
- Test: `cli/src/llm/history.test.ts` (crear si no existe; si existe, **añadir** casos)

`/cost` no llama al provider. Lee metadata ya persistida. Si plan 15 aún no guardó usage, el resultado es `sin datos` — no error.

- [ ] Crear `cli/src/llm/slash-cost.ts`:

```ts
import { NO_USAGE_TEXT } from "./slash";

export type CostRow = {
  role?: string | null;
  content?: string | null;
  metadata?: unknown;
};

function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) {
    return Number(v);
  }
  return null;
}

/** Pull native usage (Claude or Cursor) without flattening to one schema. */
export function extractUsageBlob(meta: unknown): Record<string, unknown> | null {
  const m = rec(meta);
  if (!m) return null;
  for (const key of ["usage", "tokenUsage", "cost", "cursorUsage"]) {
    const blob = rec(m[key]);
    if (blob && Object.keys(blob).length) return blob;
  }
  const input =
    num(m.inputTokens) ?? num(m.input_tokens) ?? num(m.prompt_tokens);
  const output =
    num(m.outputTokens) ?? num(m.output_tokens) ?? num(m.completion_tokens);
  if (input != null || output != null) {
    return {
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens:
        num(m.cacheReadTokens) ?? num(m.cache_read_input_tokens),
    };
  }
  return null;
}

function lineFromBlob(blob: Record<string, unknown>, label: string): string | null {
  const input =
    num(blob.inputTokens) ??
    num(blob.input_tokens) ??
    num(blob.prompt_tokens) ??
    num(blob.input);
  const output =
    num(blob.outputTokens) ??
    num(blob.output_tokens) ??
    num(blob.completion_tokens) ??
    num(blob.output);
  const cache =
    num(blob.cacheReadTokens) ??
    num(blob.cache_read_input_tokens) ??
    num(blob.cache_read);
  if (input == null && output == null && cache == null) return null;
  const parts: string[] = [];
  if (input != null) parts.push(`in ${input}`);
  if (output != null) parts.push(`out ${output}`);
  if (cache != null) parts.push(`cache ${cache}`);
  return `${label}: ${parts.join(" · ")}`;
}

/**
 * Chat aggregate if present, else last turn with usage, else "sin datos".
 * Cursor Router/cost is printed as native keys — never as Claude "effort".
 */
export function formatChatCost(
  messages: CostRow[],
  chatMeta?: unknown,
): string {
  const chatBlob = extractUsageBlob(chatMeta);
  const chatLine = chatBlob ? lineFromBlob(chatBlob, "chat") : null;

  let turnLine: string | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const blob = extractUsageBlob(messages[i]?.metadata);
    if (!blob) continue;
    const line = lineFromBlob(blob, "turn");
    if (line) {
      turnLine = line;
      break;
    }
    const keys = Object.keys(blob).filter((k) => k !== "effort");
    if (keys.length) {
      turnLine = `turn: ${keys.map((k) => `${k}=${String(blob[k])}`).join(" · ")}`;
      break;
    }
  }

  if (!chatLine && !turnLine) return NO_USAGE_TEXT;
  return [chatLine, turnLine].filter(Boolean).join("\n");
}
```

- [ ] Crear `cli/src/llm/slash-cost.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { NO_USAGE_TEXT } from "./slash";
import { formatChatCost } from "./slash-cost";

describe("formatChatCost", () => {
  test("sin datos when provider reported nothing", () => {
    expect(formatChatCost([{ role: "assistant", content: "hi", metadata: {} }])).toBe(
      NO_USAGE_TEXT,
    );
    expect(formatChatCost([])).toBe(NO_USAGE_TEXT);
  });

  test("Claude-shaped usage", () => {
    const text = formatChatCost([
      {
        role: "assistant",
        content: "ok",
        metadata: { usage: { input_tokens: 12, output_tokens: 4 } },
      },
    ]);
    expect(text).toContain("in 12");
    expect(text).toContain("out 4");
    expect(text).not.toBe(NO_USAGE_TEXT);
  });

  test("Cursor native keys are not labeled effort", () => {
    const text = formatChatCost([
      {
        role: "assistant",
        content: "ok",
        metadata: {
          cursorUsage: { inputTokens: 3, outputTokens: 1, optimize_for: "cost" },
        },
      },
    ]);
    expect(text).toContain("in 3");
    expect(text.toLowerCase()).not.toContain("effort");
  });
});
```

- [ ] En `cli/src/llm/history.ts`, ampliar `DbMessage`:

```ts
type DbMessage = {
  role?: string | null;
  content?: string | null;
  metadata?: unknown;
};
```

Importar `isSlashResultMeta` desde `./slash`. Dentro del loop de `historyFromChatMessages`, **antes** de aceptar un `system`:

```ts
if (isSlashResultMeta(m.metadata)) continue;
```

Los compact markers (`kind: "compact_marker"`) **no** se filtran aquí (plan 10 los usa). Solo `slash_result`.

- [ ] Tests en `cli/src/llm/history.test.ts`. Si el archivo no existe, crearlo con este caso más un caso de regresión (user+assistant se conservan). Si existe, **añadir**:

```ts
import { historyFromChatMessages } from "./history";
import { SLASH_RESULT_KIND } from "./slash";

test("drops slash_result system rows so the LLM does not see /help", () => {
  const history = historyFromChatMessages(
    [
      { role: "user", content: "hola" },
      {
        role: "system",
        content: "Unknown command. Try /help",
        metadata: { kind: SLASH_RESULT_KIND, command: "unknown", ok: false },
      },
      { role: "assistant", content: "hola!" },
    ],
    "next",
  );
  expect(history.map((m) => m.content).join(" ")).not.toContain("/help");
  expect(history.some((m) => m.content === "hola")).toBe(true);
});
```

- [ ] Correr:

```bash
cd cli && bun test src/llm/slash-cost.test.ts src/llm/history.test.ts src/llm/slash.test.ts
```

Esperado: todos pasan.

- [ ] Commit:

```bash
git add cli/src/llm/slash-cost.ts cli/src/llm/slash-cost.test.ts \
  cli/src/llm/history.ts cli/src/llm/history.test.ts
git commit -m "feat(slash): format /cost as sin datos and keep slash_result out of LLM history"
```

---

## Task 3: Dispatcher — un solo `runSlash` con I/O inyectado

**Files:**

- Create: `cli/src/llm/slash-run.ts`
- Test: `cli/src/llm/slash-run.test.ts`

El dispatcher **no** habla HTTP/WS directo: recibe `SlashIo`. CLI, TUI y (en Web, una copia delgadas) implementan el IO. Así se testea `/mode auto`, rechazo de modelo, `/clear` no-git y unknown **sin** API.

- [ ] Crear `cli/src/llm/slash-run.ts`. Si `cli/src/llm/execution-mode.ts` exporta `isExecutionMode` / `parseExecutionMode` / `INVALID_MODE_ERROR`, importarlos. Si **no** existe, definir en este archivo:

```ts
const EXECUTION_MODES = ["plan", "auto", "ask"] as const;
type ExecutionMode = (typeof EXECUTION_MODES)[number];
const INVALID_MODE_ERROR = "executionMode must be plan, auto, or ask";
function isExecutionMode(v: unknown): v is ExecutionMode {
  return v === "plan" || v === "auto" || v === "ask";
}
```

No duplicar si el módulo del plan 3 ya está.

```ts
import {
  CLEAR_OK,
  formatHelp,
  invalidProviderModel,
  isSlashCommandId,
  modeSetText,
  modelSetText,
  NO_CHAT_ERROR,
  NO_SESSION_ERROR,
  parseSlash,
  PROVIDER_MUST,
  providerSetText,
  SLASH_RESULT_KIND,
  SLASH_USAGE_MODE,
  SLASH_USAGE_MODEL,
  SLASH_USAGE_PROVIDER,
  UNKNOWN_SLASH,
  type SlashCommandId,
} from "./slash";
import { formatChatCost, type CostRow } from "./slash-cost";

export type PrefsSnapshot = {
  activeProvider: string | null;
  activeModel: string | null;
  activeEffort?: string | null;
  activeExecutionMode?: string | null;
  catalogs?: Array<{ id: string; models: Array<{ id: string }> }>;
  providers?: Record<string, { models?: Array<{ id: string }> }>;
};

export type SlashIo = {
  getPrefs: () => Promise<PrefsSnapshot>;
  putPrefs: (patch: {
    activeProvider?: string | null;
    activeModel?: string | null;
    activeExecutionMode?: string | null;
  }) => Promise<PrefsSnapshot>;
  compact?: (chatId: string) => Promise<{ text: string }>;
  undo?: (chatId: string) => Promise<{ text: string }>;
  createChat: (
    sessionId: string,
    title: string,
  ) => Promise<{ id: string }>;
  getChat: (chatId: string) => Promise<{
    messages: CostRow[];
    usage?: unknown;
  }>;
  appendResult: (
    chatId: string,
    content: string,
    meta: { kind: typeof SLASH_RESULT_KIND; command: string; ok: boolean },
  ) => Promise<void>;
};

export type SlashContext = {
  chatId: string | null;
  sessionId: string | null;
};

export type SlashRunResult = {
  ok: boolean;
  command: string;
  text: string;
  persist: boolean;
  navigatedChatId?: string;
};

function modelIdsFor(prefs: PrefsSnapshot, provider: string): string[] {
  const fromProv = prefs.providers?.[provider]?.models?.map((m) => m.id) ?? [];
  if (fromProv.length) return fromProv;
  return (
    prefs.catalogs?.find((c) => c.id === provider)?.models.map((m) => m.id) ?? []
  );
}

function belongsToProvider(
  prefs: PrefsSnapshot,
  provider: string,
  modelId: string,
): boolean {
  return modelIdsFor(prefs, provider).includes(modelId);
}

async function persist(
  io: SlashIo,
  ctx: SlashContext,
  command: string,
  ok: boolean,
  text: string,
): Promise<SlashRunResult> {
  if (ctx.chatId) {
    await io.appendResult(ctx.chatId, text, {
      kind: SLASH_RESULT_KIND,
      command,
      ok,
    });
  }
  return { ok, command, text, persist: Boolean(ctx.chatId) };
}

export async function runSlash(
  raw: string,
  io: SlashIo,
  ctx: SlashContext,
): Promise<SlashRunResult> {
  const parsed = parseSlash(raw);
  if (!parsed.ok && parsed.error === "not_slash") {
    return {
      ok: false,
      command: "not_slash",
      text: UNKNOWN_SLASH,
      persist: false,
    };
  }
  if (!parsed.ok) {
    return persist(io, ctx, "unknown", false, UNKNOWN_SLASH);
  }

  const { command, args } = parsed;

  if (command === "help") {
    return persist(io, ctx, "help", true, formatHelp());
  }

  if (command === "plan") {
    if (args.length) {
      return persist(io, ctx, "plan", false, SLASH_USAGE_MODE);
    }
    const prefs = await io.putPrefs({ activeExecutionMode: "plan" });
    const mode = prefs.activeExecutionMode || "plan";
    return persist(io, ctx, "plan", true, modeSetText(mode));
  }

  if (command === "mode") {
    if (args.length !== 1) {
      return persist(io, ctx, "mode", false, SLASH_USAGE_MODE);
    }
    const mode = args[0]!.toLowerCase();
    if (!isExecutionMode(mode)) {
      return persist(io, ctx, "mode", false, INVALID_MODE_ERROR);
    }
    const prefs = await io.putPrefs({ activeExecutionMode: mode });
    return persist(
      io,
      ctx,
      "mode",
      true,
      modeSetText(prefs.activeExecutionMode || mode),
    );
  }

  if (command === "provider") {
    if (args.length !== 1) {
      return persist(io, ctx, "provider", false, SLASH_USAGE_PROVIDER);
    }
    const provider = args[0]!.toLowerCase();
    if (provider !== "claude" && provider !== "cursor") {
      return persist(io, ctx, "provider", false, PROVIDER_MUST);
    }
    const current = await io.getPrefs();
    const ids = modelIdsFor(current, provider);
    const nextModel =
      current.activeModel && belongsToProvider(current, provider, current.activeModel)
        ? current.activeModel
        : (ids[0] ?? null);
    const prefs = await io.putPrefs({
      activeProvider: provider,
      activeModel: nextModel,
    });
    return persist(
      io,
      ctx,
      "provider",
      true,
      providerSetText(prefs.activeProvider || provider),
    );
  }

  if (command === "model") {
    if (args.length !== 1) {
      return persist(io, ctx, "model", false, SLASH_USAGE_MODEL);
    }
    const modelId = args[0]!;
    const current = await io.getPrefs();
    const provider = current.activeProvider || "claude";
    if (!belongsToProvider(current, provider, modelId)) {
      return persist(
        io,
        ctx,
        "model",
        false,
        invalidProviderModel(modelId, provider),
      );
    }
    const prefs = await io.putPrefs({ activeModel: modelId });
    return persist(
      io,
      ctx,
      "model",
      true,
      modelSetText(prefs.activeModel || modelId),
    );
  }

  if (command === "compact") {
    if (!ctx.chatId) return persist(io, ctx, "compact", false, NO_CHAT_ERROR);
    if (!io.compact) {
      return persist(
        io,
        ctx,
        "compact",
        false,
        "Compact no está disponible (plan 10).",
      );
    }
    try {
      const res = await io.compact(ctx.chatId);
      // plan 10 already appends compact_marker — do not double-append
      return { ok: true, command: "compact", text: res.text, persist: false };
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      return persist(io, ctx, "compact", false, text);
    }
  }

  if (command === "undo") {
    if (!ctx.chatId) return persist(io, ctx, "undo", false, NO_CHAT_ERROR);
    if (!io.undo) {
      return persist(
        io,
        ctx,
        "undo",
        false,
        "Undo no está disponible (plan 12).",
      );
    }
    try {
      const res = await io.undo(ctx.chatId);
      return { ok: true, command: "undo", text: res.text, persist: false };
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      return persist(io, ctx, "undo", false, text);
    }
  }

  if (command === "cost") {
    if (!ctx.chatId) return persist(io, ctx, "cost", false, NO_CHAT_ERROR);
    const chat = await io.getChat(ctx.chatId);
    const text = formatChatCost(chat.messages, chat.usage);
    return persist(io, ctx, "cost", true, text);
  }

  if (command === "clear") {
    if (!ctx.sessionId) {
      return persist(io, ctx, "clear", false, NO_SESSION_ERROR);
    }
    const chat = await io.createChat(ctx.sessionId, "Chat");
    if (ctx.chatId) {
      await io.appendResult(ctx.chatId, CLEAR_OK, {
        kind: SLASH_RESULT_KIND,
        command: "clear",
        ok: true,
      });
    }
    return {
      ok: true,
      command: "clear",
      text: CLEAR_OK,
      persist: true,
      navigatedChatId: chat.id,
    };
  }

  if (isSlashCommandId(command as SlashCommandId)) {
    return persist(io, ctx, command, false, UNKNOWN_SLASH);
  }
  return persist(io, ctx, "unknown", false, UNKNOWN_SLASH);
}

export function makeMemoryIo(init?: {
  prefs?: PrefsSnapshot;
  messages?: CostRow[];
  compact?: SlashIo["compact"];
  undo?: SlashIo["undo"];
}): { io: SlashIo; state: { prefs: PrefsSnapshot; results: string[]; chats: string[] } } {
  const state = {
    prefs: init?.prefs ?? {
      activeProvider: "claude",
      activeModel: "claude-sonnet-4-6",
      activeExecutionMode: "ask",
      providers: {
        claude: { models: [{ id: "claude-sonnet-4-6" }, { id: "claude-opus-4-6" }] },
        cursor: { models: [{ id: "composer-2.5" }] },
      },
    },
    results: [] as string[],
    chats: [] as string[],
    messages: init?.messages ?? ([] as CostRow[]),
  };
  const io: SlashIo = {
    getPrefs: async () => state.prefs,
    putPrefs: async (patch) => {
      state.prefs = { ...state.prefs, ...patch };
      return state.prefs;
    },
    compact: init?.compact,
    undo: init?.undo,
    createChat: async () => {
      const id = `chat-${state.chats.length + 1}`;
      state.chats.push(id);
      return { id };
    },
    getChat: async () => ({ messages: state.messages }),
    appendResult: async (_chatId, content) => {
      state.results.push(content);
    },
  };
  return { io, state };
}
```

Si `isExecutionMode` se importa del plan 3, **borrar** el fallback local. `INVALID_MODE_ERROR` debe ser el mismo string.

- [ ] Crear `cli/src/llm/slash-run.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { CLEAR_OK, HELP_MODES, NO_USAGE_TEXT, UNKNOWN_SLASH } from "./slash";
import { makeMemoryIo, runSlash } from "./slash-run";

const ctx = { chatId: "c1", sessionId: "s1" };

describe("runSlash", () => {
  test("/mode auto persists and does not throw", async () => {
    const { io, state } = makeMemoryIo();
    const res = await runSlash("/mode auto", io, ctx);
    expect(res.ok).toBe(true);
    expect(state.prefs.activeExecutionMode).toBe("auto");
    expect(res.text).toBe("Mode → auto");
    expect(state.results[0]).toBe("Mode → auto");
  });

  test("/plan is shortcut to mode plan", async () => {
    const { io, state } = makeMemoryIo();
    const res = await runSlash("/plan", io, ctx);
    expect(state.prefs.activeExecutionMode).toBe("plan");
    expect(res.text).toBe("Mode → plan");
  });

  test("/mode yolo rejected, prefs unchanged", async () => {
    const { io, state } = makeMemoryIo();
    const before = state.prefs.activeExecutionMode;
    const res = await runSlash("/mode yolo", io, ctx);
    expect(res.ok).toBe(false);
    expect(res.text).toBe("executionMode must be plan, auto, or ask");
    expect(state.prefs.activeExecutionMode).toBe(before);
  });

  test("Claude model with provider cursor is rejected", async () => {
    const { io, state } = makeMemoryIo();
    await runSlash("/provider cursor", io, ctx);
    expect(state.prefs.activeProvider).toBe("cursor");
    const res = await runSlash("/model claude-sonnet-4-6", io, ctx);
    expect(res.ok).toBe(false);
    expect(res.text).toContain("claude-sonnet-4-6");
    expect(res.text).toContain("cursor");
    expect(state.prefs.activeModel).not.toBe("claude-sonnet-4-6");
  });

  test("/provider cursor clamps model off Claude ids", async () => {
    const { io, state } = makeMemoryIo();
    await runSlash("/provider cursor", io, ctx);
    expect(state.prefs.activeModel).toBe("composer-2.5");
  });

  test("unknown command explains /help", async () => {
    const { io, state } = makeMemoryIo();
    const res = await runSlash("/wat", io, ctx);
    expect(res.ok).toBe(false);
    expect(res.text).toBe(UNKNOWN_SLASH);
    expect(state.results[0]).toBe(UNKNOWN_SLASH);
  });

  test("/help lists commands and modes", async () => {
    const { io } = makeMemoryIo();
    const res = await runSlash("/help", io, ctx);
    expect(res.text).toContain("/compact");
    expect(res.text).toContain(HELP_MODES);
  });

  test("/cost sin datos", async () => {
    const { io } = makeMemoryIo();
    const res = await runSlash("/cost", io, ctx);
    expect(res.text).toBe(NO_USAGE_TEXT);
  });

  test("/clear creates a chat and does not call git", async () => {
    const { io, state } = makeMemoryIo();
    const res = await runSlash("/clear", io, ctx);
    expect(res.ok).toBe(true);
    expect(res.navigatedChatId).toBe("chat-1");
    expect(res.text).toBe(CLEAR_OK);
    expect(state.chats).toEqual(["chat-1"]);
  });

  test("/compact and /undo call injected RPCs", async () => {
    const { io } = makeMemoryIo({
      compact: async () => ({ text: "contexto compactado" }),
      undo: async () => ({ text: "undone" }),
    });
    expect((await runSlash("/compact", io, ctx)).text).toBe("contexto compactado");
    expect((await runSlash("/undo", io, ctx)).text).toBe("undone");
  });

  test("/compact without RPC still feedbacks", async () => {
    const { io } = makeMemoryIo();
    const res = await runSlash("/compact", io, ctx);
    expect(res.ok).toBe(false);
    expect(res.text.toLowerCase()).toContain("compact");
  });
});
```

- [ ] Correr:

```bash
cd cli && bun test src/llm/slash-run.test.ts src/llm/slash.test.ts src/llm/slash-cost.test.ts
```

Esperado: todos pasan.

- [ ] Commit:

```bash
git add cli/src/llm/slash-run.ts cli/src/llm/slash-run.test.ts
git commit -m "feat(slash): dispatch /mode /model /provider /help without hitting the LLM"
```

---

## Task 4: CLI headless — flags y subcomandos sin TTY

**Files:**

- Create: `cli/src/llm/slash-io-live.ts`
- Create: `cli/src/commands/model.ts`
- Modify: `cli/src/commands/mode.ts` (crear si execution-modes **no** lo creó)
- Modify: `cli/src/index.ts`
- Modify: `cli/src/commands/headless.ts`
- Modify: `cli/src/commands/provider.ts`
- Test: `cli/src/commands/headless-slash.test.ts`

No hay `prompt()` ni `readline` en estos paths. `chavez model` y `chavez mode` son HTTP. `chat compact|undo|cost|clear` y `ask` con prompt `/…` usan WS.

- [ ] Crear `cli/src/llm/slash-io-live.ts`:

```ts
import { apiFetch } from "../api-client";
import type { ChavezWsClient } from "../ws/client";
import { SLASH_RESULT_KIND } from "./slash";
import type { PrefsSnapshot, SlashIo } from "./slash-run";

export function liveSlashIo(opts: {
  client: ChavezWsClient;
  token?: string;
}): SlashIo {
  const { client, token } = opts;
  return {
    getPrefs: () => apiFetch<PrefsSnapshot>("/providers", {}, token),
    putPrefs: (patch) =>
      apiFetch<PrefsSnapshot>(
        "/providers/preferences",
        { method: "PUT", body: JSON.stringify(patch) },
        token,
      ),
    compact: async (chatId) => {
      const res = await client.request({ type: "chat.compact", chatId }, 90_000);
      if (!res.ok) throw new Error(res.error || "compact failed");
      const data = (res.data || {}) as { message?: { content?: string } };
      return { text: data.message?.content || "contexto compactado" };
    },
    undo: async (chatId) => {
      const res = await client.request(
        { type: "agent.turn.undo", chatId },
        30_000,
      );
      if (!res.ok) throw new Error(res.error || "undo failed");
      const data = (res.data || {}) as {
        noop?: boolean;
        message?: string;
      };
      return { text: data.message || (data.noop ? "Nothing to undo: the last turn made no applied changes" : "undone") };
    },
    createChat: async (sessionId, title) => {
      const res = await client.request({
        type: "chat.create",
        sessionId,
        title,
      });
      if (!res.ok) throw new Error(res.error || "chat.create failed");
      const chat = (res.data as { chat?: { id: string } })?.chat;
      if (!chat?.id) throw new Error("chat.create returned no id");
      return { id: chat.id };
    },
    getChat: async (chatId) => {
      const res = await client.request({ type: "chat.get", chatId });
      if (!res.ok) throw new Error(res.error || "chat.get failed");
      const data = (res.data || {}) as {
        messages?: Array<{ role?: string; content?: string; metadata?: unknown }>;
        chat?: { metadata?: unknown };
        context?: unknown;
        usage?: unknown;
      };
      return {
        messages: data.messages ?? [],
        usage: data.usage ?? data.context ?? data.chat?.metadata,
      };
    },
    appendResult: async (chatId, content, meta) => {
      const res = await client.request({
        type: "chat.append",
        chatId,
        role: "system",
        content,
        metadata: meta,
      });
      if (!res.ok) throw new Error(res.error || "chat.append failed");
    },
  };
}

export { SLASH_RESULT_KIND };
```

Si `chat.compact` / `agent.turn.undo` no existen aún, `client.request` devolverá el `fail` del hub (`Unknown type` o similar): `runSlash` lo persiste como error visible. **No** implementar compact/undo aquí.

- [ ] Crear `cli/src/commands/model.ts`:

```ts
import { apiFetch } from "../api-client";
import { loadConfig } from "../config";
import { invalidProviderModel, modelSetText, SLASH_USAGE_MODEL } from "../llm/slash";
import type { PrefsSnapshot } from "../llm/slash-run";

function requireAuth(): void {
  if (!loadConfig().accessToken) {
    throw new Error("No hay sesión. Ejecuta: chavez login");
  }
}

export async function modelCommand(args: string[]): Promise<void> {
  requireAuth();
  const data = await apiFetch<PrefsSnapshot>("/providers");
  const provider = data.activeProvider || "claude";
  const ids =
    data.providers?.[provider]?.models?.map((m) => m.id) ??
    data.catalogs?.find((c) => c.id === provider)?.models.map((m) => m.id) ??
    [];
  const raw = args[0];
  if (!raw || raw === "-h" || raw === "--help") {
    console.log(`Provider: ${provider}`);
    console.log(`Model: ${data.activeModel ?? "(none)"}`);
    for (const id of ids) console.log(`- ${id}`);
    if (!raw) return;
    console.log(SLASH_USAGE_MODEL.replace("/model", "chavez model"));
    return;
  }
  if (!ids.includes(raw)) {
    throw new Error(invalidProviderModel(raw, provider));
  }
  const next = await apiFetch<PrefsSnapshot>("/providers/preferences", {
    method: "PUT",
    body: JSON.stringify({ activeModel: raw }),
  });
  console.log(modelSetText(next.activeModel || raw));
}
```

- [ ] `cli/src/commands/mode.ts`: si el archivo **ya existe** (plan 3), no reescribirlo. Si **no** existe, crearlo idéntico al plan 3 (GET sin args, PUT con `plan|auto|ask`, throw `INVALID_MODE_ERROR`). Registrar `case "mode"` en `cli/src/index.ts` solo si falta.

- [ ] En `cli/src/index.ts`:

  1. Importar `modelCommand`. Importar `modeCommand` si se creó aquí.
  2. `case "model": await modelCommand(rest); break;`
  3. Ampliar `usage()`:

```
  chavez mode [plan|auto|ask]
  chavez model [id]
  chavez provider set <claude|cursor>
  chavez headless chat create|list|append|get|ask|watch|compact|undo|cost|clear
  chavez headless chat ask [--mode plan|auto|ask] [--provider claude|cursor] [--model <id>] <chatId> <prompt…>
```

- [ ] En `cli/src/commands/provider.ts`, `list`/`status` ya imprime `Active:`. Añadir modelo activo si no está:

```ts
console.log(`Active: ${data.activeProvider ?? "(none)"}`);
console.log(`Model: ${data.activeModel ?? "(none)"}`);
```

Ampliar `ProvidersResponse` con `activeModel`. No imprimir secrets.

- [ ] En `cli/src/commands/headless.ts`:

  1. Imports:

```ts
import { isSlashInput } from "../llm/slash";
import { liveSlashIo } from "../llm/slash-io-live";
import { runSlash } from "../llm/slash-run";
```

  2. Helper de flags (arriba del archivo, junto a `ensureClient`):

```ts
function takeFlag(args: string[], name: string): { value?: string; rest: string[] } {
  const rest: string[] = [];
  let value: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) {
      value = args[++i];
      continue;
    }
    rest.push(args[i]!);
  }
  return { value, rest };
}
```

  3. Reemplazar `action === "ask"`: parsear `--mode`, `--provider`, `--model` **antes** del prompt. PUT prefs si vienen. Si el prompt recortado `isSlashInput`, `runSlash` y `console.log(res.text)` — **no** `agent.turn.request`. Si no, el request actual.

```ts
if (action === "ask") {
  let filtered = rest;
  const mode = takeFlag(filtered, "--mode");
  filtered = mode.rest;
  const provider = takeFlag(filtered, "--provider");
  filtered = provider.rest;
  const model = takeFlag(filtered, "--model");
  filtered = model.rest;
  const chatId = filtered[0];
  const prompt = filtered.slice(1).join(" ");
  if (!chatId || !prompt) {
    throw new Error(
      "Uso: … chat ask [--mode plan|auto|ask] [--provider claude|cursor] [--model <id>] <chatId> <prompt…>",
    );
  }
  const patch: Record<string, string> = {};
  if (mode.value) patch.activeExecutionMode = mode.value;
  if (provider.value) patch.activeProvider = provider.value;
  if (model.value) patch.activeModel = model.value;
  if (Object.keys(patch).length) {
    await apiFetch("/providers/preferences", {
      method: "PUT",
      body: JSON.stringify(patch),
    });
  }
  if (isSlashInput(prompt)) {
    const getRes = await client.request({ type: "chat.get", chatId });
    if (!getRes.ok) throw new Error(getRes.error);
    const sessionId =
      (getRes.data as { chat?: { sessionId?: string } })?.chat?.sessionId ?? null;
    const io = liveSlashIo({ client });
    const result = await runSlash(prompt, io, { chatId, sessionId });
    console.log(result.text);
    if (result.navigatedChatId) {
      console.log(`chatId: ${result.navigatedChatId}`);
    }
    if (!result.ok) process.exitCode = 1;
    return;
  }
  const res = await client.request(
    { type: "agent.turn.request", chatId, prompt },
    30_000,
  );
  if (!res.ok) throw new Error(res.error);
  console.log(JSON.stringify(res.data, null, 2));
  console.log(
    "Turn aceptado por el daemon. Usa `chat watch` o el hub web para ver el stream.",
  );
  return;
}
```

  4. Acciones nuevas. Si `compact`/`undo` ya existen (planes 10/12), **no** duplicarlas. Añadir `cost` y `clear`:

```ts
if (action === "cost") {
  const chatId = rest[0];
  if (!chatId) throw new Error("Uso: chavez headless chat cost <chatId>");
  const io = liveSlashIo({ client });
  const result = await runSlash("/cost", io, { chatId, sessionId: null });
  console.log(result.text);
  if (!result.ok) process.exitCode = 1;
  return;
}

if (action === "clear") {
  const sessionId = rest[0];
  if (!sessionId) throw new Error("Uso: chavez headless chat clear <sessionId>");
  const io = liveSlashIo({ client });
  const result = await runSlash("/clear", io, { chatId: null, sessionId });
  console.log(result.text);
  if (result.navigatedChatId) console.log(`chatId: ${result.navigatedChatId}`);
  if (!result.ok) process.exitCode = 1;
  return;
}
```

Si `compact` **no** existe:

```ts
if (action === "compact") {
  const chatId = rest[0];
  if (!chatId) throw new Error("Uso: chavez headless chat compact <chatId>");
  const io = liveSlashIo({ client });
  const getRes = await client.request({ type: "chat.get", chatId });
  const sessionId =
    (getRes.data as { chat?: { sessionId?: string } } | undefined)?.chat
      ?.sessionId ?? null;
  const result = await runSlash("/compact", io, { chatId, sessionId });
  console.log(result.text);
  if (!result.ok) process.exitCode = 1;
  return;
}
```

Misma forma para `undo` si falta.

  5. Actualizar el `throw` de uso del grupo chat para incluir `compact|undo|cost|clear`.

- [ ] Crear `cli/src/commands/headless-slash.test.ts` — **sin** red: testea el parse de flags con una función extraída. Mover `takeFlag` a `cli/src/llm/slash-flags.ts` para poder testearlo:

```ts
export function takeFlag(
  args: string[],
  name: string,
): { value?: string; rest: string[] } {
  const rest: string[] = [];
  let value: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) {
      value = args[++i];
      continue;
    }
    rest.push(args[i]!);
  }
  return { value, rest };
}

export function parseAskArgs(rest: string[]): {
  mode?: string;
  provider?: string;
  model?: string;
  chatId?: string;
  prompt: string;
} {
  let filtered = rest;
  const mode = takeFlag(filtered, "--mode");
  filtered = mode.rest;
  const provider = takeFlag(filtered, "--provider");
  filtered = provider.rest;
  const model = takeFlag(filtered, "--model");
  filtered = model.rest;
  return {
    mode: mode.value,
    provider: provider.value,
    model: model.value,
    chatId: filtered[0],
    prompt: filtered.slice(1).join(" "),
  };
}
```

`headless.ts` importa `parseAskArgs` desde `slash-flags.ts` en lugar de redefinir `takeFlag`.

```ts
import { describe, expect, test } from "bun:test";
import { isSlashInput } from "../llm/slash";
import { parseAskArgs } from "../llm/slash-flags";

test("flags do not require a TTY", () => {
  const p = parseAskArgs([
    "--mode",
    "auto",
    "--provider",
    "cursor",
    "--model",
    "composer-2.5",
    "chat-1",
    "/compact",
  ]);
  expect(p.mode).toBe("auto");
  expect(p.provider).toBe("cursor");
  expect(p.model).toBe("composer-2.5");
  expect(p.chatId).toBe("chat-1");
  expect(isSlashInput(p.prompt)).toBe(true);
});

test("plain ask is not slash", () => {
  const p = parseAskArgs(["chat-1", "refactor", "auth"]);
  expect(p.prompt).toBe("refactor auth");
  expect(isSlashInput(p.prompt)).toBe(false);
});
```

- [ ] Correr:

```bash
cd cli && bun test src/llm/slash-run.test.ts src/commands/headless-slash.test.ts src/llm/slash-flags.ts
```

El último path solo corre si exportas tests; preferir `src/commands/headless-slash.test.ts`.

- [ ] Commit:

```bash
git add cli/src/llm/slash-io-live.ts cli/src/llm/slash-flags.ts \
  cli/src/commands/model.ts cli/src/commands/mode.ts cli/src/index.ts \
  cli/src/commands/headless.ts cli/src/commands/provider.ts \
  cli/src/commands/headless-slash.test.ts
git commit -m "feat(slash): headless mode/provider/model/compact without a TTY"
```

Si `mode.ts` ya existía y no se tocó, no lo listes en `git add`.

---

## Task 5: TUI — picker `/`, exclusión de `@`, execute on Enter

**Files:**

- Modify: `tui/src/App.tsx`

Hoy `mode === "compose"` concatena y Enter llama `sendWithLlm`. Escape en command mode mata la TUI (attach-files lo mueve). Esta fase: picker de comandos, `/` no abre archivos, Enter con slash **no** dispara el LLM.

- [ ] Imports (junto a los de `cli/src/llm/catalog`):

```ts
import {
  composerTrigger,
  isSlashInput,
  slashPickerItems,
  type SlashPickItem,
} from "../../cli/src/llm/slash";
import { liveSlashIo } from "../../cli/src/llm/slash-io-live";
import { runSlash } from "../../cli/src/llm/slash-run";
```

Si attach-files ya importó `completeWorkspace` / `activeMention`, **no** borrar esos imports. `composerTrigger` sustituye la decisión de qué picker abrir.

- [ ] State, junto a `input` / `mode` / `pickerOpen` (este último si attach-files lo creó):

```ts
const [slashOpen, setSlashOpen] = useState(false);
const [slashItems, setSlashItems] = useState<SlashPickItem[]>([]);
const [slashIndex, setSlashIndex] = useState(0);
```

Ampliar `Message` con `metadata?: Record<string, unknown> | null` si aún es `{ id, role, content }`.

- [ ] `runSlashCommand` con `useCallback`:

```ts
const runSlashCommand = useCallback(
  async (text: string) => {
    if (!client) return;
    const io = liveSlashIo({ client, token });
    const result = await runSlash(text, io, {
      chatId: activeChatId,
      sessionId: activeSessionId,
    });
    setLog(result.text.split("\n")[0] || result.text);
    if (result.navigatedChatId) {
      setActiveChatId(result.navigatedChatId);
      setMessages([]);
      await refreshChats(activeSessionId!);
      const created = await client.request({
        type: "chat.get",
        chatId: result.navigatedChatId,
      });
      if (created.ok) {
        setMessages(
          (created.data as { messages?: Message[] })?.messages ?? [],
        );
      }
    } else if (activeChatId) {
      await loadChat(activeChatId);
    }
    if (result.command === "mode" && result.ok) {
      const next = result.text.replace(/^Mode → /, "");
      if (next === "plan" || next === "auto" || next === "ask") {
        setExecutionMode?.(next); // si plan 3 añadió el state; si no, omitir
      }
    }
  },
  [client, token, activeChatId, activeSessionId, loadChat, refreshChats],
);
```

Si `executionMode` / `setExecutionMode` / `refreshChats` no existen, usar solo `setLog` + `loadChat`. No inventar el gate de modos aquí.

Tras `/provider` o `/model` con `ok`, recargar `/providers` (el `useEffect` inicial no se re-ejecuta): llamar el mismo `apiFetch<ProvidersResponse>("/providers")` y `setProvider` / `setModelId` como en el load inicial. Extraer ese bloque a `reloadPrefs` si aún no está.

- [ ] En el callback de texto (si attach-files creó `applyComposeText`, **extenderlo**; si no, crear `applyComposeText` y usarlo desde compose):

```ts
function applyComposeText(next: string) {
  setInput(next);
  const trigger = composerTrigger(next);
  if (trigger?.kind === "slash") {
    const models = (providersInfo?.providers?.[provider]?.models ?? []).map(
      (m) => m.id,
    );
    const items = slashPickerItems(trigger.query, { modelIds: models });
    setSlashOpen(true);
    setSlashItems(items);
    setSlashIndex((i) => (items.length ? Math.min(i, items.length - 1) : 0));
    setPickerOpen?.(false);
    setPickerItems?.([]);
    return;
  }
  setSlashOpen(false);
  setSlashItems([]);
  // existing @ picker from attach-files, if present:
  //   const mention = activeMention(next); …
  // if attach-files is absent, just:
  //   setPickerOpen?.(false);
}
```

`setPickerOpen` / `setPickerItems` solo si attach-files los añadió; si no, no los references. TypeScript: declara los setters siempre o ramifica.

- [ ] Branch `mode === "compose"` — insertar **antes** del Enter que llama `sendWithLlm`. Orden:

  1. Escape: si `slashOpen`, cerrar slash picker (no matar TUI). Si picker `@` abierto, cerrarlo (plan 1). Si no, cancelar compose.
  2. Flechas: si `slashOpen`, mueven `slashIndex` (no el cursor de listas).
  3. Tab/Enter con `slashOpen` e ítem: insertar `item.insert`; si `item.executeOnPick`, `setInput("")`, `setMode("command")`, `setSlashOpen(false)`, `await runSlashCommand(item.insert)`. Si no, `applyComposeText(item.insert)` y dejar compose abierto.
  4. Enter **sin** picker: `const text = input.trim()`; si `isSlashInput(text)`, `setInput("")`, `setMode("command")`, `await runSlashCommand(text)`, **return** (no `sendWithLlm`).
  5. Enter prompt normal: `sendWithLlm` como hoy.
  6. Backspace / char: `applyComposeText`.

Si context-compact ya intercepta `text === "/compact"`, **eliminar** ese `if` especial: `runSlashCommand("/compact")` lo cubre.

Garantía: con `slashOpen === true` **no** se llama `completeWorkspace`.

- [ ] Render, debajo de `compose> {input}` y **antes** del picker `@` si existe:

```tsx
{mode === "compose" && slashOpen ? (
  <Box flexDirection="column">
    <Text dimColor>/ commands · máx 10 · no archivos</Text>
    {slashItems.length === 0 ? (
      <Text color="yellow">Sin coincidencias — /help</Text>
    ) : (
      slashItems.map((c, i) => (
        <Text
          key={c.id}
          color={i === slashIndex ? "cyan" : undefined}
          bold={i === slashIndex}
        >
          {i === slashIndex ? ">" : " "} {c.label}
        </Text>
      ))
    )}
    <Text dimColor>Tab/Enter insertan · Esc cierra</Text>
  </Box>
) : null}
```

Pintar `slash_result` en la timeline: si `m.metadata?.kind === "slash_result"`, prefijo `slash:` en yellow, no `system:`. Compact marker sigue cyan (plan 10).

Ayuda de teclas: añadir ` / cmds` en la línea dim.

- [ ] `prefs.updated` en `onPush` (si plan 3 no lo hizo):

```ts
if (msg.type === "prefs.updated") {
  const data = (msg.data || {}) as {
    activeProvider?: string | null;
    activeModel?: string | null;
    activeExecutionMode?: string | null;
  };
  if (data.activeProvider === "claude" || data.activeProvider === "cursor") {
    setProvider(data.activeProvider);
  }
  if (data.activeModel) setModelId(data.activeModel);
  return;
}
```

Así `/mode auto` en Web se refleja en TUI.

- [ ] Commit:

```bash
git add tui/src/App.tsx
git commit -m "feat(slash): TUI / picker lists commands not files and never hits the LLM"
```

---

## Task 6: Web — picker `/` en el compositor, sync de prefs, `/clear` navega

**Files:**

- Create: `web/src/lib/slash.ts`
- Test: `web/src/lib/slash.test.ts`
- Create: `web/src/lib/slash-cost.ts`
- Create: `web/src/lib/slash-run.ts`
- Modify: `web/src/lib/hooks.ts`
- Modify: `web/src/lib/ws-hooks.ts`
- Modify: `web/src/components/MentionComposer.tsx` (si existe) **o** Create: `web/src/components/ChatComposer.tsx`
- Modify: `web/src/components/ChatDetailPanel.tsx`
- Modify: `web/src/styles/global.css`
- Modify: `web/package.json`

Web no importa CLI. Copiar parser y dispatcher. El IO usa `apiJson` + hooks WS.

- [ ] Copiar `cli/src/llm/slash.ts` → `web/src/lib/slash.ts` **idéntico** (mismo source). Primera línea de comentario:

```ts
/** Keep in sync with cli/src/llm/slash.ts */
```

Copiar `cli/src/llm/slash-cost.ts` → `web/src/lib/slash-cost.ts` (imports desde `./slash`).

Copiar `cli/src/llm/slash-run.ts` → `web/src/lib/slash-run.ts` ajustando imports a `./slash` y `./slash-cost`. Incluir `makeMemoryIo` para el test.

- [ ] Copiar `cli/src/llm/slash.test.ts` → `web/src/lib/slash.test.ts` (imports `./slash`). Crear `web/src/lib/slash-run.test.ts` copiando los casos de Task 3 (al menos: `/mode auto`, modelo Claude + provider cursor, unknown → `/help`, `/cost` sin datos, `/clear` no-git).

- [ ] Añadir `"test": "bun test"` en `web/package.json` `scripts` si falta.

- [ ] En `web/src/lib/hooks.ts`:

  1. Ampliar `ProvidersResponse` con `activeExecutionMode?: string | null` si aún no está.
  2. Ampliar `useProviderPreferences` body con `activeExecutionMode?: string | null`.
  3. Ampliar `ChatMessage.metadata` (ya es opcional). Nada más.

- [ ] En `web/src/lib/ws-hooks.ts`, añadir (no reemplazar los existentes):

```ts
export function useWsChatGet() {
  const ws = useWs();
  return useMutation({
    mutationFn: (chatId: string) => ws.request({ type: "chat.get", chatId }),
  });
}
```

`useWsChatCreate` y `useWsChatAppend` ya existen. `useWsAgentTurn` se queda para prompts **no** slash.

- [ ] Composer. **Si** `web/src/components/MentionComposer.tsx` existe (attach-files):

  1. Importar `composerTrigger`, `slashPickerItems`, type `SlashPickItem` desde `../lib/slash`.
  2. Props nuevas opcionales:

```ts
modelIds?: string[];
onSlashExecute?: (insert: string) => void;
```

  3. Calcular `const trigger = composerTrigger(value, cursor)`.
  4. El `useEffect` de `fs.complete` **solo** corre si `trigger?.kind === "mention"`. Si `kind === "slash"`, `setItems([])` y no llamar al daemon.
  5. Estado `slashItems` / `slashHi`. Cuando `trigger?.kind === "slash"`, `setSlashItems(slashPickerItems(trigger.query, { modelIds }))`.
  6. `onKeyDown`: si slash picker abierto, flechas / Enter / Tab actúan sobre comandos (`preventDefault`). Enter con `executeOnPick` llama `onSlashExecute(item.insert)` y **no** inserta `@`. Escape cierra el slash picker.
  7. Render: panel `slash-picker` **o** `mention-picker`, nunca ambos. Header del slash: `comandos · máx 10` — **sin** hostname (hostname es solo `@`, decisión 6).

  **Si** `MentionComposer` **no** existe: crear `web/src/components/ChatComposer.tsx` con el textarea controlado + slash picker (misma semántica). `ChatDetailPanel` lo usa en el form del agente. No añadir `<input type="file">`.

Referencia mínima del picker (usar en ChatComposer o dentro de MentionComposer):

```tsx
{slashOpen ? (
  <div className="slash-picker" role="listbox" aria-label="Slash commands">
    <div className="muted">comandos · máx 10</div>
    {slashItems.length === 0 ? (
      <div className="muted">Sin coincidencias — /help</div>
    ) : (
      slashItems.map((c, i) => (
        <button
          key={c.id}
          type="button"
          className={i === slashHi ? "slash-item active" : "slash-item"}
          onMouseDown={(e) => {
            e.preventDefault();
            if (c.executeOnPick && onSlashExecute) onSlashExecute(c.insert);
            else onChange(c.insert);
          }}
        >
          {c.label}
        </button>
      ))
    )}
  </div>
) : null}
```

- [ ] En `web/src/components/ChatDetailPanel.tsx`:

  1. Imports: `isSlashInput` desde `../lib/slash`; `runSlash` + types desde `../lib/slash-run`; `useProviders`, `useProviderPreferences`, `useWsChatCreate`, `useWsChatAppend`, `useWsChatGet`, `useWs`.
  2. Helper `webSlashIo` en el mismo archivo (o `web/src/lib/slash-io.ts`):

```ts
function useWebSlashIo() {
  const prefs = useProviderPreferences();
  const providers = useProviders();
  const createChat = useWsChatCreate();
  const append = useWsChatAppend();
  const getChat = useWsChatGet();
  const ws = useWs();
  return {
    io: {
      getPrefs: async () => {
        const data = providers.data;
        if (!data) throw new Error("providers not loaded");
        return data;
      },
      putPrefs: async (patch: {
        activeProvider?: string | null;
        activeModel?: string | null;
        activeExecutionMode?: string | null;
      }) => prefs.mutateAsync(patch),
      compact: async (chatId: string) => {
        const res = await ws.request({ type: "chat.compact", chatId });
        if (!res.ok) throw new Error(res.error || "compact failed");
        const data = (res.data || {}) as { message?: { content?: string } };
        return { text: data.message?.content || "contexto compactado" };
      },
      undo: async (chatId: string) => {
        const res = await ws.request({ type: "agent.turn.undo", chatId });
        if (!res.ok) throw new Error(res.error || "undo failed");
        const data = (res.data || {}) as { message?: string; noop?: boolean };
        return {
          text:
            data.message ||
            (data.noop
              ? "Nothing to undo: the last turn made no applied changes"
              : "undone"),
        };
      },
      createChat: async (sessionId: string, title: string) => {
        const res = await createChat.mutateAsync({ sessionId, title });
        const chat = (res.data as { chat?: { id: string } })?.chat;
        if (!chat?.id) throw new Error("chat.create returned no id");
        return { id: chat.id };
      },
      getChat: async (chatId: string) => {
        const res = await getChat.mutateAsync(chatId);
        const data = (res.data || {}) as {
          messages?: Array<{ role?: string; content?: string; metadata?: unknown }>;
          usage?: unknown;
          context?: unknown;
        };
        return { messages: data.messages ?? [], usage: data.usage ?? data.context };
      },
      appendResult: async (
        chatId: string,
        content: string,
        meta: { kind: "slash_result"; command: string; ok: boolean },
      ) => {
        await append.mutateAsync({
          chatId,
          content,
          role: "system",
          metadata: meta,
        });
      },
    },
    providers,
  };
}
```

  `useWsChatAppend` hoy no pasa `metadata`. **Extenderlo**:

```ts
mutationFn: (input: {
  chatId: string;
  content: string;
  role?: string;
  metadata?: Record<string, unknown>;
}) =>
  ws.request({
    type: "chat.append",
    chatId: input.chatId,
    content: input.content,
    role: input.role || "user",
    metadata: input.metadata,
  }),
```

  `WsRequest` en `web/src/lib/ws-client.ts` ya tiene `metadata`.

  3. `onAgent`: **primera** línea tras `preventDefault`:

```ts
const text = prompt.trim();
if (isSlashInput(text)) {
  setMsg(null);
  try {
    const sessionId = chat.data?.chat?.sessionId ?? null;
    const result = await runSlash(text, io, { chatId, sessionId });
    setPrompt("");
    setMsg({ kind: result.ok ? "ok" : "error", text: result.text });
    if (result.navigatedChatId) {
      window.location.assign(`/chats/${result.navigatedChatId}`);
      return;
    }
    void qc.invalidateQueries({ queryKey: queryKeys.chat(chatId) });
    void qc.invalidateQueries({ queryKey: queryKeys.providers() });
  } catch (err) {
    setMsg({ kind: "error", text: formatQueryError(err) });
  }
  return;
}
await agent.mutateAsync({ chatId, prompt: text });
```

  Si context-compact interceptaba `prompt.trim().toLowerCase() === "/compact"`, **eliminar** ese branch.

  4. Timeline: `m.metadata?.kind === "slash_result"` → badge `slash` + `<pre>` del content. No usar `ToolCard`.

  5. Form del agente: `required` en el textarea **impide** enviar vacío; no impide `/help`. Quitar `required` del textarea del agente (el submit ya valida `trim()`). Placeholder: `Mensaje o /help`.

  6. `onPush`: si `prefs.updated`, `qc.invalidateQueries({ queryKey: queryKeys.providers() })` (si plan 3 no lo hizo).

- [ ] CSS en `web/src/styles/global.css`:

```css
.slash-picker {
  margin-top: 0.35rem;
  border: 1px solid var(--border);
  background: var(--panel);
  border-radius: 6px;
  padding: 0.35rem 0.5rem;
  max-height: 16rem;
  overflow: auto;
}
.slash-item {
  display: block;
  width: 100%;
  text-align: left;
  background: transparent;
  color: var(--fg);
  border: 0;
  padding: 0.25rem 0.35rem;
  font: inherit;
  cursor: pointer;
}
.slash-item.active,
.slash-item:hover {
  background: var(--accent-dim);
}
```

No reutilizar clases del picker `@` de forma que un test visual los confunda: el header dice `comandos`, no `hostname`.

- [ ] Correr:

```bash
cd web && bun test src/lib/slash.test.ts src/lib/slash-run.test.ts
cd cli && bun test src/llm/slash.test.ts src/llm/slash-run.test.ts
```

Esperado: todos pasan. Parser CLI y Web coinciden (mismos casos).

- [ ] Commit:

```bash
git add web/src/lib/slash.ts web/src/lib/slash.test.ts \
  web/src/lib/slash-cost.ts web/src/lib/slash-run.ts web/src/lib/slash-run.test.ts \
  web/src/lib/hooks.ts web/src/lib/ws-hooks.ts \
  web/src/components/MentionComposer.tsx web/src/components/ChatComposer.tsx \
  web/src/components/ChatDetailPanel.tsx web/src/styles/global.css web/package.json
git commit -m "feat(slash): Web / picker and prefs persist across TUI and CLI"
```

Si `ChatComposer.tsx` o `MentionComposer.tsx` no se creó/tocó, no lo listes.

---

## Task 7: API — `prefs.updated` en PUT preferences (si falta) y OpenAPI

**Files:**

- Modify: `api/src/routes/providers.ts`
- Modify: `api/openapi/openapi.yaml`
- Modify: `api/src/ws/handlers.ts` (solo si hay que documentar; no hay case `slash`)

Sin tabla nueva. Sin event `slash.*`. El append `system` + `metadata.kind=slash_result` ya lo acepta `chat.append`.

- [ ] En `api/src/routes/providers.ts`, PUT `/preferences`:

  1. Tras un upsert **exitoso**, si **aún no** se hace broadcast:

```ts
import { hub } from "../ws/hub";

hub.broadcastToUser(
  session.user.id,
  hub.pushEvent("prefs.updated", {
    activeProvider: prefs[0]?.activeProvider ?? null,
    activeModel: prefs[0]?.activeModel ?? null,
    activeEffort: prefs[0]?.activeEffort ?? null,
    activeExecutionMode: prefs[0]?.activeExecutionMode ?? null,
  }),
);
```

  `activeExecutionMode` solo si la columna existe. Si plan 3 ya broadcast, **no** duplicar el `broadcastToUser`.

  2. Validación de par provider/model: si `api/src/llm/prefs-validate.ts` existe, usarlo (plan 4). Si no, tras leer el body, si vienen `activeProvider` y `activeModel` (o se combinan con la fila actual):

```ts
const provider = body.activeProvider ?? prefsNow?.activeProvider;
const model = body.activeModel ?? prefsNow?.activeModel;
if (provider && model) {
  const catalog = PROVIDER_CATALOGS.find((p) => p.id === provider);
  const ok = catalog?.models.some((m) => m.id === model);
  if (!ok) {
    return c.json(
      {
        error: `modelId "${model}" does not belong to provider ${provider}`,
      },
      400,
    );
  }
}
```

  Un 400 **no** hace upsert ni broadcast. String **exacto** `INVALID_PROVIDER_MODEL`.

  3. PUT `/active`: al cambiar de provider, recortar `activeModel` al primer id del catálogo destino si el actual no pertenece (plan 4 ya lo hace). Si no está, añadirlo aquí para que `/provider cursor` desde slash no deje un modelo Claude.

- [ ] En `api/openapi/openapi.yaml`, description de `/ws`:

```
Composer slash commands (/mode, /model, /provider, /compact, /clear, /undo, /cost, /help, /plan) are client-side. They never arrive as agent.turn.request. Feedback is chat.append role=system metadata.kind=slash_result. prefs.updated is broadcast after PUT /providers/preferences.
```

Añadir `prefs.updated` a la lista de push si falta.

- [ ] `chat.append` ya permite `role=system` y `metadata`. No cambiar el handler salvo que hoy tire `metadata`: en `api/src/ws/handlers.ts` el insert ya usa `metadata: msg.metadata ?? null`. Dejarlo.

- [ ] Commit:

```bash
git add api/src/routes/providers.ts api/openapi/openapi.yaml
git commit -m "feat(slash): broadcast prefs.updated and reject mismatched /model"
```

---

## Task 8: Smoke — Gherkin sin LLM vivo

**Files:**

- Create: `cli/scripts/slash-smoke.ts`

No dispara un modelo real. Cubre picker vs `@`, persistencia de modo, rechazo de modelo, unknown → `/help`, `/clear` sin git, `/cost` sin datos, y que un prompt slash **no** genera `agent.turn.dispatch`.

- [ ] Crear `cli/scripts/slash-smoke.ts`:

```ts
/**
 * Smoke: slash parse, prefs via /mode, mismatched model, no turn on /help.
 * Needs: chavez login, API up. Daemon bound only for compact/undo paths
 * (those are skipped if chat.compact is unknown).
 */
import { loadConfig } from "../src/config";
import { apiFetch, ApiError } from "../src/api-client";
import { ChavezWsClient } from "../src/ws/client";
import { cwdPath } from "../src/workspace";
import {
  composerTrigger,
  isSlashInput,
  parseSlash,
  slashPickerItems,
  UNKNOWN_SLASH,
} from "../src/llm/slash";
import { liveSlashIo } from "../src/llm/slash-io-live";
import { runSlash } from "../src/llm/slash-run";

const config = loadConfig();
const token = process.env.CHAVEZ_ACCESS_TOKEN || config.accessToken;
if (!token) {
  console.error("Need login");
  process.exit(1);
}

if (composerTrigger("/")?.kind !== "slash") {
  throw new Error("typing / must open slash, not files");
}
if (composerTrigger("@src")?.kind !== "mention") {
  throw new Error("@ must stay a mention trigger");
}
if (slashPickerItems("").some((i) => i.insert.includes("src/"))) {
  throw new Error("slash picker listed a file path");
}
if (!isSlashInput("/mode auto") || parseSlash("cd src/lib").ok) {
  throw new Error("parseSlash confusion");
}

type Prefs = {
  activeProvider?: string | null;
  activeModel?: string | null;
  activeExecutionMode?: string | null;
};

const before = await apiFetch<Prefs>("/providers", {}, token);
console.log("before", before);

const client = new ChavezWsClient(token);
await client.connect();
const bound = await client.bind(cwdPath(), "client");
if (!bound.ok) throw new Error(bound.error || "bind failed");

const sessionRes = await client.request({
  type: "session.create",
  title: `slash-smoke ${Date.now()}`,
});
if (!sessionRes.ok) throw new Error(sessionRes.error);
const sessionId = (sessionRes.data as { session: { id: string } }).session.id;
const chatRes = await client.request({
  type: "chat.create",
  sessionId,
  title: "slash-smoke",
});
if (!chatRes.ok) throw new Error(chatRes.error);
const chatId = (chatRes.data as { chat: { id: string } }).chat.id;

const io = liveSlashIo({ client, token });
const ctx = { chatId, sessionId };

const modeRes = await runSlash("/mode auto", io, ctx);
if (!modeRes.ok || !modeRes.text.includes("auto")) {
  throw new Error(` /mode auto failed: ${modeRes.text}`);
}
const afterMode = await apiFetch<Prefs>("/providers", {}, token);
if (afterMode.activeExecutionMode && afterMode.activeExecutionMode !== "auto") {
  throw new Error(`prefs mode=${afterMode.activeExecutionMode}`);
}

const helpRes = await runSlash("/not-a-cmd", io, ctx);
if (helpRes.text !== UNKNOWN_SLASH) {
  throw new Error(`unknown: ${helpRes.text}`);
}

let dispatched = false;
const off = client.onPush((msg) => {
  if (msg.type === "agent.turn.dispatch") dispatched = true;
});
await runSlash("/help", io, ctx);
await Bun.sleep(400);
off();
if (dispatched) throw new Error("/help dispatched a turn");

await runSlash("/provider cursor", io, ctx);
const bad = await runSlash("/model claude-sonnet-4-6", io, ctx);
if (bad.ok) throw new Error("claude model on cursor should fail");
if (!bad.text.includes("claude-sonnet-4-6") || !bad.text.includes("cursor")) {
  throw new Error(`mismatch message: ${bad.text}`);
}

const cost = await runSlash("/cost", io, ctx);
if (!cost.text) throw new Error("cost empty");
console.log("cost", cost.text);

const clear = await runSlash("/clear", io, ctx);
if (!clear.navigatedChatId) throw new Error("clear did not create a chat");
console.log("clear", clear.navigatedChatId);

try {
  await apiFetch(
    "/providers/preferences",
    {
      method: "PUT",
      body: JSON.stringify({
        activeExecutionMode: before.activeExecutionMode ?? "ask",
        activeProvider: before.activeProvider ?? "claude",
        activeModel: before.activeModel ?? null,
      }),
    },
    token,
  );
} catch (e) {
  if (e instanceof ApiError) console.warn("restore prefs", e.message);
}

client.close();
console.log("SMOKE PASS");
```

Si `ApiError` no se exporta de `cli/src/api-client.ts`, catch `Error` y listo.

- [ ] Correr unitarios de las tres superficies:

```bash
cd cli && bun test src/llm/slash.test.ts src/llm/slash-cost.test.ts \
  src/llm/slash-run.test.ts src/llm/history.test.ts src/commands/headless-slash.test.ts
cd web && bun test src/lib/slash.test.ts src/lib/slash-run.test.ts
```

Esperado: todos pasan.

- [ ] Smoke (API + login + WS):

```bash
cd cli && bun run scripts/slash-smoke.ts
```

Esperado: `SMOKE PASS`. Compact/undo reales se verifican cuando los planes 10/12 están mergeados; este smoke no falla si esos RPC no existen (no los llama).

- [ ] Commit:

```bash
git add cli/scripts/slash-smoke.ts
git commit -m "test(slash): picker vs @, prefs, unknown /help, no turn on slash"
```

---

## Orden de ejecución

1. Task 1 (parser + picker puro) — no depende de API.
2. Task 2 (cost + history) — depende de Task 1.
3. Task 3 (dispatcher) — depende de 1–2.
4. Task 4 (CLI headless) — depende de 3.
5. Task 5 (TUI) — depende de 3; picker `@` de attach-files se extiende si ya está.
6. Task 6 (Web) — depende de 3; paralelizable con 4 y 5.
7. Task 7 (API broadcast + mismatch) — puede ir en paralelo con 4 una vez 3 está mergeada; Web/TUI lo notan vía `prefs.updated`.
8. Task 8 (smoke) — al final.

Tasks 4, 5 y 6 son paralelizables entre sí una vez 3 está mergeada.

## Verificación Gherkin → task

| Escenario | Dónde se cubre |
|---|---|
| Autocomplete de `/` lista comandos, no archivos; `@` no se abre | Task 1 `composerTrigger` + `slashPickerItems`; Task 5 TUI `slashOpen` cierra `@`; Task 6 Web `fs.complete` no corre si slash; Task 8 smoke |
| `/mode ask\|auto\|plan` persiste; siguiente turn usa el modo; Web/TUI coinciden | Task 3 `putPrefs`; Task 4 `chavez mode` / `--mode`; Task 5/6 execute + `prefs.updated`; el gate del turn es plan 3 (no se reimplementa) |
| `/provider` y `/model` persisten; modelo Claude + provider cursor se rechaza | Task 3 `belongsToProvider`; Task 4 `chavez model`; Task 7 PUT 400; Task 8 smoke |
| `/compact` y `/undo` disparan planes 10 y 12 con feedback en el chat | Task 3 `io.compact` / `io.undo`; Task 4/5/6 live IO; marker existente, sin segundo algoritmo |
| `/clear` nuevo chat o compositor vacío; no borra el repo | Task 3 `createChat` + `CLEAR_OK`; Task 5 cambia `activeChatId`; Task 6 `window.location.assign`; ningún `git` / `rm` |
| `/cost` usage o `sin datos` | Task 2 `formatChatCost`; Task 3 `/cost`; Task 4 `chat cost` |
| `/help` lista comandos y modos; desconocido explica `/help` | Task 1 `formatHelp` / `UNKNOWN_SLASH`; Task 3 unknown; Task 5/6 persist `slash_result` |
| CLI headless sin TTY para mode/provider/compact | Task 4 flags + subcomandos + prompt `/…` en `chat ask`; Task 8 no usa `prompt()` |

## Fuera de este plan (no implementar)

- Algoritmo de compact → [context-compact](../context-compact/plan.md). Aquí solo se llama `chat.compact`.
- Snapshot git / restore → [checkpoints-undo](../checkpoints-undo/plan.md). Aquí solo se llama `agent.turn.undo`.
- Gate `plan`/`auto`/`ask` en `canUseTool` → [execution-modes](../execution-modes/plan.md). Aquí solo se persiste el modo.
- Cursor ejecutable + catálogo crudo → [cursor-provider](../cursor-provider/plan.md). Aquí se elige provider/model y se rechaza el par imposible.
- Panel de usage nativo por provider → [usage-cost](../usage-cost/plan.md). Aquí se **lee** lo que haya o se imprime `sin datos`.
- Picker `@` / hidratación → [attach-files](../attach-files/plan.md). Aquí solo se garantiza que `/` no lo abre.
- `/git` → [git-workspace](../git-workspace/plan.md).
- `/rules` → [project-rules](../project-rules/plan.md).
- Artefacto editable de plan → [plan-artifact](../plan-artifact/plan.md). `/plan` es **solo** atajo de modo.
- Cola de turns, worktrees paralelos, Cursor cloud, voz, extensión IDE, upload desde el navegador, notificaciones OS/email.
