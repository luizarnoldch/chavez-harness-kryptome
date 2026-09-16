# Prompt library Implementation Plan

> **For agentic workers:** Execute task-by-task. Do not skip tests. Do not implement Cursor cloud, voz, extensión IDE, upload desde el navegador, notificaciones OS/email, skills/MCP (plan 19), slash `/prompt` (plan 11 no lo lista), memoria (plan 31), cola de turns (plan 29), ni worktrees paralelos (plan 28). Spec: [`plan.md`](./plan.md). Distinta de skills ([`mcp-skills-subagents`](../mcp-skills-subagents/implementation.md): procedimiento de agente / `SKILL.md`) y de reglas ([`project-rules`](../project-rules/implementation.md): instrucciones en capas). Un prompt **se pega** en el compositor; no se inyecta al system prompt y no dispara un turn al guardar. Si un sibling (`attach-files`, `slash-commands`) ya creó un archivo citado, **extiéndelo**; no lo reescribas.

**Goal:** El usuario guarda briefs en **su cuenta** y los reutiliza sin reescribirlos. Guardar desde el compositor persiste el texto en Postgres (`saved_prompts`) y el ítem aparece en **Web y TUI** (mismo GET + `prompt.changed`). Elegir uno **inserta el body en el compositor**; se puede mezclar con `@`. Guardar **no** dispara `agent.turn.request`. CLI lista por nombre y `chavez headless chat ask --prompt <name>` expande el body (más texto extra / `@`) y recién ahí pide el turn.

**Architecture:** La fuente de verdad es la API (cuenta del usuario), no el filesystem del daemon y no `chat_messages`. El daemon **no** lee ni escribe `PROMPTS.md` ni `.chavez/prompts`. CRUD HTTP funciona **sin** daemon. Insertar/guardar es local al compositor; el turn sigue el camino existente (`agent.turn.request` → daemon bound). Web no importa CLI (duplicar el módulo puro). TUI importa `cli/src/llm/prompt-library.ts`.

```
Composer (Web | TUI)
  [Guardar] / Ctrl+s     POST /prompts     →  prompt.changed  →  Web + TUI refrescan
  tecla "#"              picker ≤10        →  inserta body en el compositor
  tecla "@"              picker archivos   (plan 1; NUNCA a la vez que #)
  Enter / submit         agent.turn.request (solo si el usuario envía)
        |
        v
  daemon hidrata @  (plan 1)  →  LLM
        |
        v
  chat.stream.* / message.appended  →  Web + TUI + CLI watch

CLI
  chavez prompt list|save|get|rm     HTTP, sin daemon, sin turn
  chavez headless chat ask <id> --prompt <name> [extra…] [@path]
        GET /prompts/:name  →  expand body + extra  →  agent.turn.request
```

Estado actual que este plan extiende (no reescribir):

- `api/src/db/schema.ts` tiene `user`, `user_preferences`, `workspaces`, `chats`, `chat_messages`. **No** hay tabla `saved_prompts`. `user_skills` (plan 19) y `memories` (plan 31) son **otras** tablas: no reutilizarlas para briefs.
- `api/src/index.ts` monta `/providers`, `/workspaces`, sessions/chats. **No** hay `/prompts`. CORS cubre esas rutas; hay que añadir `/prompts`.
- `api/src/ws/handlers.ts` despacha `agent.turn.request` → daemon. Guardar un prompt **no** entra al switch WS.
- `cli/src/index.ts`: `login|logout|whoami|provider|tui|headless`. **No** hay `chavez prompt`.
- `cli/src/commands/headless.ts` `chat ask <chatId> <prompt…>` manda el texto crudo. **No** hay `--prompt`.
- Web `ChatDetailPanel.tsx`: `<textarea id="prompt">` + submit `onAgent` → `agent.turn.request`. Si attach-files aterrizó, `MentionComposer`; si slash aterrizó, picker `/`. **No** hay guardar ni picker `#`.
- TUI `tui/src/App.tsx`: compose concatena; Enter llama `sendWithLlm`. Teclas command: `p` `[` `]` `{` `}` `s` `c` `m` `q` (+ siblings `o`/`r`/`g`/`y`/`k`/`C` si existen). **No** hay `l`. Escape en compose hoy cancela o (si attach-files) cierra el picker `@`.
- Slash (plan 11): catálogo cerrado **sin** `/prompt`. El picker `/` no lista briefs. Esta fase usa `#`, no añade un slash.
- Skills (plan 19): `user_skills` / `SKILL.md` son procedimientos del agente. Un prompt de esta fase **nunca** se registra como skill ni se ofrece al modelo como tool.
- Cursor `runnable: false` hasta el plan 4. `--prompt` no simula un turn Cursor; el dispatch es el mismo `agent.turn.request`.
- `chat_messages.metadata` jsonb **ya existe**. Esta fase **no** guarda el brief ahí al hacer save (solo al enviar el turn, como cualquier prompt de usuario).

**Tech Stack:** Bun, Hono + Drizzle (tabla `saved_prompts` nueva), WebSocket hub (`prompt.changed`; **sin** RPC nuevo), Ink TUI, Astro/React web + TanStack Query. Tests: `bun test`. Web **no** importa CLI: duplicar `web/src/lib/prompt-library.ts` (comentario keep-in-sync). Zod ya está en `api` y `cli`. Sin archivos en cwd. Sin MCP. Sin tokenizer.

**Global Constraints:**

1. El filesystem real vive en el daemon. **La biblioteca no lo toca.** CRUD habla con la API. Cero `writeFile` de `PROMPTS.md`, `.chavez/prompts`, `SKILL.md`, `AGENTS.md`. API y browser no leen el cwd para “hidratar” un brief.
2. Un turn solo corre si hay daemon bound. `agent.turn.request` (incluido `ask --prompt`) sin daemon falla con exactamente `"No daemon bound for this workspace. Run: chavez headless workspace open"`. El CRUD HTTP `/prompts` **sí** funciona sin daemon.
3. Web, CLI `watch` y TUI ven el **mismo** chat en vivo cuando hay un turn. Guardar/insertar **no** emite `chat.stream.*`. La lista de prompts se sincroniza con `prompt.changed` + GET `/prompts` entre Web y TUI.
4. Preferencias de provider/modelo/esfuerzo/modo **no** se tocan.
5. Claude es el provider ejecutable. Cursor vinculado no ejecuta aquí; `--prompt` no inventa un runner Cursor.
6. Tools por defecto siguen. Un prompt insertado es texto de usuario, no una tool. Lecturas no piden confirmación. Guardar un brief **no** es write/edit/bash del workspace.
7. Un usuario = su vault. `saved_prompts` filtra `eq(userId)`. Sin org ni roles. El link de solo lectura (plan 23) **no** lista ni inserta prompts ajenos.
8. 1 turn por daemon. Guardar o insertar **no** abre un turn. `ask --prompt` es **un** turn (el mismo lock `turnBusy`).
9. `@` sigue siendo archivos del workspace. El picker `#` no llama `fs.complete`. Varios prompts se eligen **de uno en uno** (se puede repetir `#`). Tras insertar, el usuario puede añadir `@`.
10. `/` y `@` y `#` son triggers **mutuamente excluyentes**. Con `#` activo no se abre el picker de archivos ni el de slash. Un markdown `# Título` (espacio tras `#`) **no** es picker. `user@host` no es prompt.
11. Distinta de skills: no se pega un procedimiento, no hay `SKILL.md`, no hay `chavez-skills` MCP, no hay `kind: "skill"` en la timeline. El body se inserta en el compositor / se expande en `ask`.
12. Picker: máximo **10** candidatos; se afina con el prefijo; selección de uno en uno.
13. Fuera de alcance: Cursor cloud, voz, extensión IDE, upload desde el navegador, notificaciones OS/email, slash `/prompt`, marketplace, “siempre permitir”, lote, CI JSON schema, prompts de org, snippets inyectados al system prompt.

**Constantes (congeladas, no inventar otras):**

| Nombre | Valor |
|---|---|
| `PROMPT_PICKER_LIMIT` | `10` |
| `PROMPT_NAME_MAX` | `63` |
| `PROMPT_TITLE_MAX` | `120` |
| `PROMPT_BODY_MAX` | `20_000` |
| `PROMPTS_MAX` | `50` |
| `PROMPT_NAME_RE` | `/^[a-z][a-z0-9_-]{0,62}$/` |
| `NO_DAEMON_ERROR` | `"No daemon bound for this workspace. Run: chavez headless workspace open"` |
| `PROMPT_NAME_ERROR` | `"name must match [a-z][a-z0-9_-]{0,62}"` |
| `PROMPT_TITLE_ERROR` | `"title must be 1–120 characters"` |
| `PROMPT_BODY_ERROR` | `"body must be 1–20000 characters"` |
| `PROMPTS_CAP_ERROR` | `"Maximum 50 saved prompts"` |
| `PROMPT_NOT_FOUND` | `` `Prompt not found: ${name}` `` |
| `PROMPT_NAME_TAKEN` | `` `Prompt name already exists: ${name}` `` |
| `PROMPT_SAVED` | `"Prompt guardado"` |
| `PROMPT_DELETED` | `"Prompt borrado"` |
| `PROMPT_ASK_USAGE` | `"Uso: chavez headless chat ask <chatId> [--prompt <name>] [texto…]"` |
| `PROMPT_SAVE_USAGE` | `"Uso: chavez prompt save <name> [body…]"` |
| `PROMPT_GET_USAGE` | `"Uso: chavez prompt get <name>"` |
| `PROMPT_RM_USAGE` | `"Uso: chavez prompt rm <name>"` |
| `PROMPT_LIST_USAGE` | `"Uso: chavez prompt list [--json]"` |
| `PROMPT_EMPTY` | `"0 prompts"` |
| `PROMPT_PICKER_HEADER` | `"prompts · máx 10"` |
| `PROMPT_ACCOUNT_LABEL` | `"Biblioteca · cuenta"` |
| `PROMPT_CHANGED_EVENT` | `"prompt.changed"` |
| `TURN_BUSY_ERROR` | `"Turn already running on this daemon"` (reusar; no cambiar) |

Reusar `NO_DAEMON_ERROR` / `TURN_BUSY_ERROR` si ya viven en `cli/src/llm/tool-names.ts` o `api/src/ws/errors.ts`. **No** duplicar otro wording.

Nombres de events WS:

| Tipo | Dirección | Quién lo emite |
|---|---|---|
| `prompt.changed` | API → broadcast | POST/PUT/DELETE `/prompts` |
| `agent.turn.request` | cliente → API | **solo** al enviar (Web submit, TUI Enter, CLI `ask`). Nunca al guardar. |
| `agent.turn.dispatch` | API → daemon | existente; el prompt ya va expandido (CLI) o tal cual el compositor (Web/TUI) |
| `chat.stream.*` / `message.appended` | existente | el turn, no el save |

HTTP:

| Método | Ruta | Notas |
|---|---|---|
| `GET` | `/prompts` | `{ prompts: SavedPrompt[] }` del `userId`. 401 sin sesión. Orden `name` ASC. |
| `GET` | `/prompts/:nameOrId` | Lookup por `name` (lowercase) o `id`. 404 `PROMPT_NOT_FOUND`. |
| `POST` | `/prompts` | `{ name, title?, body }`. 201 `{ prompt }`. 400 validación/cap. 409 nombre tomado. |
| `PUT` | `/prompts/:nameOrId` | `{ title?, body?, name? }`. 200 `{ prompt }`. 404 / 409. |
| `DELETE` | `/prompts/:nameOrId` | 200 `{ ok: true, name }`. 404. |

Tras POST/PUT/DELETE: `hub.broadcastToUser` `prompt.changed` con `{ prompts: SavedPrompt[] }` (lista completa del usuario). GET no.

Tipos (congelados):

```ts
export type SavedPrompt = {
  id: string;
  name: string;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
};

export type SavePromptInput = {
  name: string;
  title: string;
  body: string;
};

export type PromptTrigger = {
  start: number;
  query: string;
};
```

`name` se guarda **lowercase**. `title` default = `name` si el cliente omite title. El body se persiste tal cual (trim de extremos; no se colapsa whitespace interno — es un brief).

Alcance (Gherkin):

| Acción | ¿Turn? | ¿Daemon? | Superficies que ven el ítem |
|---|---|---|---|
| Guardar desde compositor | **no** | no | Web + TUI (cuenta) |
| Insertar en compositor | **no** | no | el compositor local; `@` se puede añadir después |
| `chavez prompt list` | **no** | no | stdout |
| `chat ask --prompt <name>` | **sí** | sí | Web + TUI + `watch` (el chat) |

---

## Task 1: Módulo puro — constantes, validate, picker, insert, ask args

**Files:**

- Create: `cli/src/llm/prompt-library.ts`
- Test: `cli/src/llm/prompt-library.test.ts`
- Modify: `cli/package.json`

Sin I/O de red ni filesystem. TUI importa desde aquí. Web **no** importa CLI: Task 5 copia el archivo. API duplica validate/errors en Task 2.

- [ ] Añadir `"test": "bun test"` en `cli/package.json` `scripts` si aún no existe (dejar `start`/`dev`/`bin` intactos):

```json
"scripts": {
  "start": "bun run src/index.ts",
  "dev": "bun run src/index.ts",
  "test": "bun test"
}
```

- [ ] Crear `cli/src/llm/prompt-library.ts`:

```ts
export const PROMPT_PICKER_LIMIT = 10;
export const PROMPT_NAME_MAX = 63;
export const PROMPT_TITLE_MAX = 120;
export const PROMPT_BODY_MAX = 20_000;
export const PROMPTS_MAX = 50;

export const PROMPT_NAME_RE = /^[a-z][a-z0-9_-]{0,62}$/;

export const NO_DAEMON_ERROR =
  "No daemon bound for this workspace. Run: chavez headless workspace open";

export const PROMPT_NAME_ERROR =
  "name must match [a-z][a-z0-9_-]{0,62}";
export const PROMPT_TITLE_ERROR = "title must be 1–120 characters";
export const PROMPT_BODY_ERROR = "body must be 1–20000 characters";
export const PROMPTS_CAP_ERROR = "Maximum 50 saved prompts";
export const PROMPT_SAVED = "Prompt guardado";
export const PROMPT_DELETED = "Prompt borrado";
export const PROMPT_EMPTY = "0 prompts";
export const PROMPT_PICKER_HEADER = "prompts · máx 10";
export const PROMPT_ACCOUNT_LABEL = "Biblioteca · cuenta";
export const PROMPT_CHANGED_EVENT = "prompt.changed";

export const PROMPT_ASK_USAGE =
  "Uso: chavez headless chat ask <chatId> [--prompt <name>] [texto…]";
export const PROMPT_SAVE_USAGE = "Uso: chavez prompt save <name> [body…]";
export const PROMPT_GET_USAGE = "Uso: chavez prompt get <name>";
export const PROMPT_RM_USAGE = "Uso: chavez prompt rm <name>";
export const PROMPT_LIST_USAGE = "Uso: chavez prompt list [--json]";

export function promptNotFound(name: string): string {
  return `Prompt not found: ${name}`;
}

export function promptNameTaken(name: string): string {
  return `Prompt name already exists: ${name}`;
}

export type SavedPrompt = {
  id: string;
  name: string;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
};

export type SavePromptInput = {
  name: string;
  title: string;
  body: string;
};

export type PromptTrigger = {
  start: number;
  query: string;
};

export function normalizePromptName(raw: unknown): string {
  return String(raw ?? "").trim().toLowerCase();
}

export function parseSavePromptInput(raw: {
  name?: unknown;
  title?: unknown;
  body?: unknown;
}): SavePromptInput {
  const name = normalizePromptName(raw.name);
  if (!PROMPT_NAME_RE.test(name)) {
    throw new Error(PROMPT_NAME_ERROR);
  }
  const body = String(raw.body ?? "").trim();
  if (body.length < 1 || body.length > PROMPT_BODY_MAX) {
    throw new Error(PROMPT_BODY_ERROR);
  }
  const titleRaw =
    raw.title == null || String(raw.title).trim() === ""
      ? name
      : String(raw.title).trim();
  if (titleRaw.length < 1 || titleRaw.length > PROMPT_TITLE_MAX) {
    throw new Error(PROMPT_TITLE_ERROR);
  }
  return { name, title: titleRaw, body };
}

/**
 * Active `#` token at the cursor.
 * `# Título` (space after hash) is markdown, not a picker.
 * `foo#bar` is not a trigger. Keep in sync with web/src/lib/prompt-library.ts.
 */
export function activePrompt(
  text: string,
  cursor: number = text.length,
): PromptTrigger | null {
  const slice = text.slice(0, cursor);
  const start = slice.lastIndexOf("#");
  if (start < 0) return null;
  if (start > 0 && !/\s/.test(slice[start - 1]!)) return null;
  const rest = slice.slice(start + 1);
  if (/\s/.test(rest)) return null;
  if (/^\S/.test(text.slice(cursor))) return null;
  return { start, query: rest };
}

function activeAt(
  text: string,
  cursor: number,
  token: "#" | "@" | "/",
): PromptTrigger | null {
  const slice = text.slice(0, cursor);
  const start = slice.lastIndexOf(token);
  if (start < 0) return null;
  if (token === "@") {
    if (start > 0 && /[A-Za-z0-9_]/.test(slice[start - 1]!)) return null;
    const rest = slice.slice(start + 1);
    if (/\s/.test(rest)) return null;
    return { start, query: rest };
  }
  if (token === "/") {
    if (start > 0 && !/\s/.test(slice[start - 1]!)) return null;
    const rest = slice.slice(start + 1);
    if (/\n/.test(rest)) return null;
    return { start, query: rest };
  }
  return activePrompt(text, cursor);
}

export type PromptComposerTrigger =
  | { kind: "slash"; start: number; query: string }
  | { kind: "mention"; start: number; query: string }
  | { kind: "prompt"; start: number; query: string };

/**
 * Mutually exclusive trigger. The token closest to the cursor wins.
 * `#` never opens the file picker; `@` never opens the prompt picker.
 */
export function resolveComposerTrigger(
  text: string,
  cursor: number = text.length,
): PromptComposerTrigger | null {
  const candidates: PromptComposerTrigger[] = [];
  const prompt = activePrompt(text, cursor);
  if (prompt) candidates.push({ kind: "prompt", ...prompt });
  const mention = activeAt(text, cursor, "@");
  if (mention) candidates.push({ kind: "mention", ...mention });
  const slash = activeAt(text, cursor, "/");
  if (slash) candidates.push({ kind: "slash", ...slash });
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.start - a.start);
  return candidates[0]!;
}

export function filterPrompts(
  prompts: SavedPrompt[],
  query: string,
  limit = PROMPT_PICKER_LIMIT,
): SavedPrompt[] {
  const q = query.trim().toLowerCase();
  const matched = q
    ? prompts.filter(
        (p) =>
          p.name.includes(q) ||
          p.title.toLowerCase().includes(q) ||
          p.body.toLowerCase().includes(q),
      )
    : [...prompts];
  matched.sort((a, b) => a.name.localeCompare(b.name));
  return matched.slice(0, limit);
}

export function insertPromptAt(
  text: string,
  trigger: { start: number },
  cursor: number,
  body: string,
): string {
  const after = text.slice(cursor);
  const spacer = body.endsWith("\n") || after.startsWith(" ") || after.length === 0
    ? ""
    : " ";
  return `${text.slice(0, trigger.start)}${body}${spacer}${after}`;
}

export function expandAskPrompt(opts: {
  libraryBody?: string | null;
  extra: string;
}): string {
  const extra = opts.extra.trim();
  const body = (opts.libraryBody ?? "").trim();
  if (body && extra) return `${body}\n\n${extra}`;
  return body || extra;
}

export function parseAskArgs(args: string[]): {
  chatId: string;
  promptName: string | null;
  extra: string;
} {
  const chatId = args[0] ?? "";
  if (!chatId || chatId.startsWith("-")) {
    throw new Error(PROMPT_ASK_USAGE);
  }
  let promptName: string | null = null;
  const extraParts: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--prompt") {
      const n = args[++i];
      if (!n || n.startsWith("-")) throw new Error(PROMPT_ASK_USAGE);
      promptName = n;
      continue;
    }
    extraParts.push(a);
  }
  return { chatId, promptName, extra: extraParts.join(" ") };
}
```

Si `NO_DAEMON_ERROR` ya está exportado en `cli/src/llm/tool-names.ts` o `cli/src/ws/errors.ts`, reexportar el mismo literal (no un segundo string).

- [ ] Si `cli/src/llm/slash.ts` **ya** existe y exporta `composerTrigger` / `ComposerTrigger`, **extenderlo** (no reescribir el archivo):

  1. Ampliar el union con `{ kind: "prompt"; start: number; query: string }`.
  2. Importar `activePrompt` desde `./prompt-library`.
  3. En `composerTrigger`, incluir el prompt en la misma regla “el `start` más cercano al cursor gana”.

  Si slash **no** existe, TUI/Web usan `resolveComposerTrigger` de este archivo. No crear `slash.ts` aquí.

- [ ] Crear `cli/src/llm/prompt-library.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  PROMPT_ASK_USAGE,
  PROMPT_BODY_ERROR,
  PROMPT_NAME_ERROR,
  PROMPT_PICKER_LIMIT,
  activePrompt,
  expandAskPrompt,
  filterPrompts,
  insertPromptAt,
  parseAskArgs,
  parseSavePromptInput,
  promptNameTaken,
  promptNotFound,
  resolveComposerTrigger,
  type SavedPrompt,
} from "./prompt-library";

function p(name: string, title = name, body = `${name} body`): SavedPrompt {
  return {
    id: name,
    name,
    title,
    body,
    createdAt: "2026-09-16T00:00:00.000Z",
    updatedAt: "2026-09-16T00:00:00.000Z",
  };
}

describe("parseSavePromptInput", () => {
  test("lowercases name and defaults title to name", () => {
    const ok = parseSavePromptInput({
      name: "Review-PR",
      body: "Review this diff",
    });
    expect(ok.name).toBe("review-pr");
    expect(ok.title).toBe("review-pr");
    expect(ok.body).toBe("Review this diff");
  });

  test("rejects bad name, empty body, oversize", () => {
    expect(() =>
      parseSavePromptInput({ name: "1bad", body: "x" }),
    ).toThrow(PROMPT_NAME_ERROR);
    expect(() =>
      parseSavePromptInput({ name: "ok", body: "  " }),
    ).toThrow(PROMPT_BODY_ERROR);
    expect(() =>
      parseSavePromptInput({ name: "Has Space", body: "x" }),
    ).toThrow(PROMPT_NAME_ERROR);
  });
});

describe("activePrompt + resolveComposerTrigger", () => {
  test("#query at end is a prompt trigger", () => {
    expect(activePrompt("please #rev")).toEqual({ start: 7, query: "rev" });
    expect(resolveComposerTrigger("please #rev")?.kind).toBe("prompt");
  });

  test("markdown header is not a trigger", () => {
    expect(activePrompt("# Título")).toBeNull();
    expect(activePrompt("# ")).toBeNull();
  });

  test("@ wins over an earlier #", () => {
    const t = resolveComposerTrigger("#rev look @src/a");
    expect(t?.kind).toBe("mention");
  });

  test("# after @ is prompt, not files", () => {
    const t = resolveComposerTrigger("@src/a.ts #rev");
    expect(t?.kind).toBe("prompt");
    expect(t?.query).toBe("rev");
  });

  test("slash at start wins over later # when cursor is on slash token", () => {
    const t = resolveComposerTrigger("/mode", 5);
    expect(t?.kind).toBe("slash");
  });
});

describe("filterPrompts", () => {
  const rows = [
    p("review", "Review PR", "look at the diff"),
    p("review-pr", "PR extra"),
    p("fix-tests", "Fix tests", "reproduce the failure"),
    ...Array.from({ length: 12 }, (_, i) => p(`other-${i}`)),
  ];

  test("refines by prefix and caps at 10", () => {
    const found = filterPrompts(rows, "rev");
    expect(found.every((x) => x.name.startsWith("review") || x.title.toLowerCase().includes("rev") || x.body.includes("rev") || x.name.includes("rev"))).toBe(true);
    expect(found.length).toBeLessThanOrEqual(PROMPT_PICKER_LIMIT);
    expect(found.map((x) => x.name)).toContain("review");
    expect(filterPrompts(rows, "").length).toBe(PROMPT_PICKER_LIMIT);
  });
});

describe("insertPromptAt mixes with @", () => {
  test("replaces #query with body and leaves room for @", () => {
    const text = "please #rev";
    const trigger = activePrompt(text)!;
    const next = insertPromptAt(text, trigger, text.length, "Review the diff");
    expect(next).toBe("please Review the diff");
    const mixed = `${next} @src/auth.ts`;
    expect(mixed).toContain("Review the diff");
    expect(mixed).toContain("@src/auth.ts");
    expect(resolveComposerTrigger(mixed)?.kind).toBe("mention");
  });
});

describe("parseAskArgs + expandAskPrompt", () => {
  test("raw ask unchanged", () => {
    expect(parseAskArgs(["chat1", "hello", "world"])).toEqual({
      chatId: "chat1",
      promptName: null,
      extra: "hello world",
    });
  });

  test("ask --prompt name plus extra @", () => {
    expect(
      parseAskArgs(["chat1", "--prompt", "review", "also", "@src/a.ts"]),
    ).toEqual({
      chatId: "chat1",
      promptName: "review",
      extra: "also @src/a.ts",
    });
    expect(
      expandAskPrompt({
        libraryBody: "Review the diff",
        extra: "also @src/a.ts",
      }),
    ).toBe("Review the diff\n\nalso @src/a.ts");
  });

  test("ask --prompt alone uses body", () => {
    expect(parseAskArgs(["chat1", "--prompt", "review"])).toEqual({
      chatId: "chat1",
      promptName: "review",
      extra: "",
    });
    expect(
      expandAskPrompt({ libraryBody: "Review the diff", extra: "" }),
    ).toBe("Review the diff");
  });

  test("missing chatId or --prompt value", () => {
    expect(() => parseAskArgs(["--prompt", "review"])).toThrow(PROMPT_ASK_USAGE);
    expect(() => parseAskArgs(["chat1", "--prompt"])).toThrow(PROMPT_ASK_USAGE);
  });
});

describe("error strings", () => {
  test("not found and taken include the name", () => {
    expect(promptNotFound("review")).toBe("Prompt not found: review");
    expect(promptNameTaken("review")).toBe("Prompt name already exists: review");
  });
});
```

- [ ] Correr:

```bash
cd cli && bun test src/llm/prompt-library.test.ts
```

Esperado: pass.

- [ ] Commit:

```bash
git add cli/src/llm/prompt-library.ts cli/src/llm/prompt-library.test.ts \
  cli/package.json cli/src/llm/slash.ts
git commit -m "feat(prompts): pure validate, # picker, insert, and ask --prompt args"
```

Solo añadir a `git add` los archivos que existan en el working tree.

---

## Task 2: API — tabla `saved_prompts`, HTTP CRUD, `prompt.changed`

**Files:**

- Create: `api/src/llm/prompt-library.ts`
- Test: `api/src/llm/prompt-library.test.ts`
- Create: `api/src/routes/prompts.ts`
- Test: `api/src/routes/prompts-validate.test.ts`
- Create: `api/drizzle/0032_prompt_library.sql`
- Modify: `api/src/db/schema.ts`
- Modify: `api/src/index.ts`
- Modify: `api/package.json`

La API es la fuente de verdad. El daemon no tiene copia en disco. **No** tocar `api/src/ws/handlers.ts` `agent.turn.request`: guardar no es un RPC.

- [ ] Añadir `"test": "bun test"` en `api/package.json` `scripts` si falta (dejar `dev`/`start`/`db:*`/`test:e2e` intactos).

- [ ] Crear `api/src/llm/prompt-library.ts` copiando `PROMPT_NAME_RE`, caps, `PROMPT_*_ERROR`, `PROMPTS_CAP_ERROR`, `promptNotFound`, `promptNameTaken`, `normalizePromptName`, `parseSavePromptInput` **idénticos** a CLI (comentario `keep-in-sync with cli/src/llm/prompt-library.ts`). No importar `cli/`. No copiar picker/insert/ask (eso es cliente).

- [ ] Test `api/src/llm/prompt-library.test.ts`: `Review-PR` → `review-pr`; `1bad` → `PROMPT_NAME_ERROR`; body vacío → `PROMPT_BODY_ERROR`; title omitido = name; title de 121 chars → `PROMPT_TITLE_ERROR`.

- [ ] En `api/src/db/schema.ts` añadir **después** de `chatMessages` (no reordenar tablas Better Auth; no tocar `workspaces_user_path_uidx`):

```ts
export const savedPrompts = pgTable(
  "saved_prompts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("saved_prompts_user_name_uidx").on(table.userId, table.name),
  ],
);
```

No hay `workspaceId`: el Gherkin dice “queda en mi cuenta”. Un prompt sigue al usuario entre workspaces. Skills de usuario (plan 19) son otra tabla.

- [ ] Crear `api/drizzle/0032_prompt_library.sql`. Si `0032_` ya existe por otro plan, usar el siguiente entero libre; el SQL es idempotente:

```sql
CREATE TABLE IF NOT EXISTS "saved_prompts" (
  "id" text PRIMARY KEY,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "title" text NOT NULL,
  "body" text NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "saved_prompts_user_name_uidx"
  ON "saved_prompts" ("user_id", "name");
```

- [ ] Crear `api/src/routes/prompts.ts`:

```ts
import { Hono } from "hono";
import { and, asc, eq, or, sql } from "drizzle-orm";
import { db } from "../db";
import { savedPrompts } from "../db/schema";
import type { Session } from "../auth";
import { hub } from "../ws/hub";
import {
  PROMPTS_CAP_ERROR,
  PROMPTS_MAX,
  parseSavePromptInput,
  promptNameTaken,
  promptNotFound,
  normalizePromptName,
  PROMPT_NAME_ERROR,
  PROMPT_BODY_ERROR,
  PROMPT_TITLE_ERROR,
  PROMPT_TITLE_MAX,
  PROMPT_BODY_MAX,
} from "../llm/prompt-library";

type RequireSession = (c: {
  req: { raw: Request };
}) => Promise<Session | null>;

function toPublic(row: typeof savedPrompts.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    title: row.title,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function listForUser(userId: string) {
  const rows = await db
    .select()
    .from(savedPrompts)
    .where(eq(savedPrompts.userId, userId))
    .orderBy(asc(savedPrompts.name));
  return rows.map(toPublic);
}

async function broadcastPrompts(userId: string) {
  const prompts = await listForUser(userId);
  hub.broadcastToUser(userId, hub.pushEvent("prompt.changed", { prompts }));
}

async function findOwned(userId: string, nameOrId: string) {
  const name = normalizePromptName(nameOrId);
  const rows = await db
    .select()
    .from(savedPrompts)
    .where(
      and(
        eq(savedPrompts.userId, userId),
        or(eq(savedPrompts.id, nameOrId), eq(savedPrompts.name, name)),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export function createPromptRoutes(requireSession: RequireSession) {
  const app = new Hono();

  app.get("/", async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    return c.json({ prompts: await listForUser(session.user.id) });
  });

  app.get("/:nameOrId", async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    const nameOrId = c.req.param("nameOrId");
    const row = await findOwned(session.user.id, nameOrId);
    if (!row) {
      return c.json({ error: promptNotFound(nameOrId) }, 404);
    }
    return c.json({ prompt: toPublic(row) });
  });

  app.post("/", async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    const body = await c.req.json().catch(() => ({}));
    let input;
    try {
      input = parseSavePromptInput(body as {
        name?: unknown;
        title?: unknown;
        body?: unknown;
      });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Invalid prompt" },
        400,
      );
    }
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(savedPrompts)
      .where(eq(savedPrompts.userId, session.user.id));
    if (Number(n) >= PROMPTS_MAX) {
      return c.json({ error: PROMPTS_CAP_ERROR }, 400);
    }
    const now = new Date();
    try {
      const inserted = await db
        .insert(savedPrompts)
        .values({
          id: crypto.randomUUID(),
          userId: session.user.id,
          name: input.name,
          title: input.title,
          body: input.body,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      const prompt = toPublic(inserted[0]!);
      await broadcastPrompts(session.user.id);
      return c.json({ prompt }, 201);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (/saved_prompts_user_name_uidx|unique/i.test(msg)) {
        return c.json({ error: promptNameTaken(input.name) }, 409);
      }
      throw err;
    }
  });

  app.put("/:nameOrId", async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    const existing = await findOwned(session.user.id, c.req.param("nameOrId"));
    if (!existing) {
      return c.json({ error: promptNotFound(c.req.param("nameOrId")) }, 404);
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      name?: unknown;
      title?: unknown;
      body?: unknown;
    };
    let name = existing.name;
    let title = existing.title;
    let promptBody = existing.body;
    try {
      if (body.name != null) {
        const parsed = parseSavePromptInput({
          name: body.name,
          title: body.title ?? existing.title,
          body: body.body ?? existing.body,
        });
        name = parsed.name;
        title = parsed.title;
        promptBody = parsed.body;
      } else {
        if (body.title != null) {
          title = String(body.title).trim();
          if (title.length < 1 || title.length > PROMPT_TITLE_MAX) {
            throw new Error(PROMPT_TITLE_ERROR);
          }
        }
        if (body.body != null) {
          promptBody = String(body.body).trim();
          if (promptBody.length < 1 || promptBody.length > PROMPT_BODY_MAX) {
            throw new Error(PROMPT_BODY_ERROR);
          }
        }
      }
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Invalid prompt" },
        400,
      );
    }
    try {
      const updated = await db
        .update(savedPrompts)
        .set({ name, title, body: promptBody, updatedAt: new Date() })
        .where(
          and(
            eq(savedPrompts.id, existing.id),
            eq(savedPrompts.userId, session.user.id),
          ),
        )
        .returning();
      await broadcastPrompts(session.user.id);
      return c.json({ prompt: toPublic(updated[0]!) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (/saved_prompts_user_name_uidx|unique/i.test(msg)) {
        return c.json({ error: promptNameTaken(name) }, 409);
      }
      throw err;
    }
  });

  app.delete("/:nameOrId", async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    const existing = await findOwned(session.user.id, c.req.param("nameOrId"));
    if (!existing) {
      return c.json({ error: promptNotFound(c.req.param("nameOrId")) }, 404);
    }
    await db
      .delete(savedPrompts)
      .where(
        and(
          eq(savedPrompts.id, existing.id),
          eq(savedPrompts.userId, session.user.id),
        ),
      );
    await broadcastPrompts(session.user.id);
    return c.json({ ok: true, name: existing.name });
  });

  return app;
}
```

`PROMPT_NAME_ERROR` se usa vía `parseSavePromptInput`. No exportar un 500 en unique: siempre 409 con `promptNameTaken`.

Garantía: este archivo **no** importa `handleWsMessage` ni llama `agent.turn.request` / `agent.turn.dispatch`. Un test de grep mental: cero `turn`.

- [ ] Crear `api/src/routes/prompts-validate.test.ts` (sin Postgres): reexportar y reassert `parseSavePromptInput` + strings de error. Añadir:

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PROMPTS_CAP_ERROR,
  parseSavePromptInput,
  promptNameTaken,
} from "../llm/prompt-library";

test("route source never fires a turn", () => {
  const src = readFileSync(join(import.meta.dir, "prompts.ts"), "utf8");
  expect(src).not.toContain("agent.turn");
  expect(src).toContain("prompt.changed");
  expect(src).toContain("PROMPTS_MAX");
});

test("cap and taken strings frozen", () => {
  expect(PROMPTS_CAP_ERROR).toBe("Maximum 50 saved prompts");
  expect(promptNameTaken("x")).toBe("Prompt name already exists: x");
  expect(() => parseSavePromptInput({ name: "x", body: "" })).toThrow();
});
```

- [ ] En `api/src/index.ts`:

  1. Importar `createPromptRoutes` desde `./routes/prompts`.
  2. Añadir CORS **junto a los demás** `app.use`:

```ts
app.use("/prompts", corsMiddleware);
app.use("/prompts/*", corsMiddleware);
```

  3. Montar **después** de workspaces/sessions:

```ts
app.route("/prompts", createPromptRoutes(requireSession));
```

No montar bajo `/workspaces`. No exigir `workspaceId` query.

- [ ] Correr:

```bash
cd api && bun test src/llm/prompt-library.test.ts src/routes/prompts-validate.test.ts
```

Esperado: pass. La migración se aplica en Task 7 / `bun run db:migrate` cuando haya `DATABASE_URL`.

- [ ] Commit:

```bash
git add api/src/llm/prompt-library.ts api/src/llm/prompt-library.test.ts \
  api/src/routes/prompts.ts api/src/routes/prompts-validate.test.ts \
  api/src/db/schema.ts api/drizzle/0032_prompt_library.sql \
  api/src/index.ts api/package.json
git commit -m "feat(prompts): account-scoped saved_prompts HTTP CRUD and prompt.changed"
```

---

## Task 3: CLI — `chavez prompt` y `chat ask --prompt <name>`

**Files:**

- Create: `cli/src/commands/prompt.ts`
- Test: `cli/src/commands/prompt-ask.test.ts`
- Modify: `cli/src/index.ts`
- Modify: `cli/src/commands/headless.ts`

CRUD **no** necesita daemon. `ask --prompt` sí (el turn existente). Guardar por CLI **no** llama WS.

- [ ] Crear `cli/src/commands/prompt.ts`:

```ts
import { apiFetch } from "../api-client";
import { loadConfig } from "../config";
import {
  PROMPT_GET_USAGE,
  PROMPT_LIST_USAGE,
  PROMPT_RM_USAGE,
  PROMPT_SAVE_USAGE,
  parseSavePromptInput,
  type SavedPrompt,
} from "../llm/prompt-library";

function token(): string {
  const t = loadConfig().accessToken;
  if (!t) throw new Error("No hay sesión. Ejecuta: chavez login");
  return t;
}

export async function promptCommand(args: string[]): Promise<void> {
  const [action, ...rest] = args;
  if (!action || action === "list") {
    const json = rest.includes("--json");
    const data = await apiFetch<{ prompts: SavedPrompt[] }>(
      "/prompts",
      {},
      token(),
    );
    const prompts = data.prompts ?? [];
    if (json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    if (!prompts.length) {
      console.log("0 prompts");
      return;
    }
    for (const p of prompts) {
      console.log(`${p.name}\t${p.title}`);
    }
    return;
  }
  if (action === "save") {
    const name = rest[0];
    const bodyArg = rest.slice(1).join(" ").trim();
    if (!name) throw new Error(PROMPT_SAVE_USAGE);
    const body = bodyArg || (await Bun.stdin.text()).trim();
    const input = parseSavePromptInput({ name, body });
    const data = await apiFetch(
      "/prompts",
      { method: "POST", body: JSON.stringify(input) },
      token(),
    );
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (action === "get") {
    const name = rest[0];
    if (!name) throw new Error(PROMPT_GET_USAGE);
    const data = await apiFetch<{ prompt: SavedPrompt }>(
      `/prompts/${encodeURIComponent(name)}`,
      {},
      token(),
    );
    console.log(data.prompt.body);
    return;
  }
  if (action === "rm") {
    const name = rest[0];
    if (!name) throw new Error(PROMPT_RM_USAGE);
    const data = await apiFetch(
      `/prompts/${encodeURIComponent(name)}`,
      { method: "DELETE" },
      token(),
    );
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  throw new Error(
    `${PROMPT_LIST_USAGE}\n${PROMPT_SAVE_USAGE}\n${PROMPT_GET_USAGE}\n${PROMPT_RM_USAGE}`,
  );
}
```

`save` **solo** hace POST. Cero `ChavezWsClient`. Cero `agent.turn.request`.

- [ ] Crear `cli/src/commands/prompt-ask.test.ts` (puro, sin red): cubre que `parseAskArgs` + `expandAskPrompt` producen el prompt que `ask` mandará, y que `promptCommand` source no contiene `agent.turn`:

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  expandAskPrompt,
  parseAskArgs,
} from "../llm/prompt-library";

test("prompt.ts CRUD never requests a turn", () => {
  const src = readFileSync(join(import.meta.dir, "prompt.ts"), "utf8");
  expect(src).not.toContain("agent.turn");
  expect(src).toContain('"/prompts"');
});

test("ask --prompt expansion is body then extra including @", () => {
  const parsed = parseAskArgs([
    "chat-1",
    "--prompt",
    "review",
    "focus",
    "@src/auth.ts",
  ]);
  expect(parsed.promptName).toBe("review");
  const prompt = expandAskPrompt({
    libraryBody: "Review the PR",
    extra: parsed.extra,
  });
  expect(prompt).toBe("Review the PR\n\nfocus @src/auth.ts");
  expect(prompt).toContain("@src/auth.ts");
});
```

- [ ] En `cli/src/index.ts`:

  1. `import { promptCommand } from "./commands/prompt";`
  2. `case "prompt": await promptCommand(rest); break;`
  3. En `usage()` añadir (junto a headless):

```
  chavez prompt list [--json]
  chavez prompt save <name> [body…]
  chavez prompt get <name>
  chavez prompt rm <name>
  chavez headless chat ask <chatId> [--prompt <name>] [texto…]
```

- [ ] En `cli/src/commands/headless.ts`:

  1. Importar `promptCommand` y `parseAskArgs`, `expandAskPrompt`, `promptNotFound`, `PROMPT_ASK_USAGE` desde `../llm/prompt-library` / `./prompt`.
  2. **Antes** del `throw Grupo desconocido`, grupo HTTP (como `connections`):

```ts
if (group === "prompt") {
  await promptCommand([action ?? "list", ...rest]);
  return;
}
```

  Actualizar el error de grupo: `Uso: chavez headless <workspace|session|chat|connections|prompt> …`.

  3. Reemplazar el bloque `action === "ask"` (hoy `rest[0]` chatId + `rest.slice(1).join(" ")`) por:

```ts
if (action === "ask") {
  let parsed;
  try {
    parsed = parseAskArgs(rest);
  } catch (err) {
    throw new Error(
      err instanceof Error ? err.message : PROMPT_ASK_USAGE,
    );
  }
  const { chatId, promptName, extra } = parsed;
  let libraryBody: string | null = null;
  if (promptName) {
    const data = await apiFetch<{ prompt: { body: string } }>(
      `/prompts/${encodeURIComponent(promptName)}`,
    );
    libraryBody = data.prompt.body;
  }
  const prompt = expandAskPrompt({ libraryBody, extra });
  if (!prompt) {
    throw new Error(PROMPT_ASK_USAGE);
  }
  const res = await client.request(
    {
      type: "agent.turn.request",
      chatId,
      prompt,
    },
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

Si `apiFetch` 404, `ApiError.message` ya es `Prompt not found: …` (el JSON `error` de la API). No envolver en otro string.

`ask` **sin** `--prompt` y con texto sigue igual (regression). `ask` **con** `--prompt` y extra `@src/foo.ts` manda body + extra; el daemon (plan 1) hidrata `@` si aterrizó. Esta fase no reimplementa hidratación.

Si `apiFetch` GET 404 y el helper no expone el body, el `throw` de `ApiError` basta. No inventar un prompt vacío.

- [ ] Correr:

```bash
cd cli && bun test src/llm/prompt-library.test.ts src/commands/prompt-ask.test.ts
```

Esperado: pass.

- [ ] Commit:

```bash
git add cli/src/commands/prompt.ts cli/src/commands/prompt-ask.test.ts \
  cli/src/index.ts cli/src/commands/headless.ts
git commit -m "feat(prompts): CLI list/save/get/rm and headless ask --prompt"
```

---

## Task 4: TUI — `#` picker, Ctrl+s guarda, tecla `l`, no dispara turn

**Files:**

- Modify: `tui/src/App.tsx`

TUI **es** daemon para turns; el CRUD de prompts es HTTP (`apiFetch`). Guardar **no** llama `sendWithLlm`. Insertar **no** llama `sendWithLlm`. Enter con texto normal sigue enviando el turn.

- [ ] Imports (junto a `apiFetch` / `cli/src/llm/catalog`):

```ts
import {
  PROMPT_ACCOUNT_LABEL,
  PROMPT_BODY_ERROR,
  PROMPT_CHANGED_EVENT,
  PROMPT_DELETED,
  PROMPT_EMPTY,
  PROMPT_PICKER_HEADER,
  PROMPT_SAVED,
  activePrompt,
  filterPrompts,
  insertPromptAt,
  parseSavePromptInput,
  resolveComposerTrigger,
  type SavedPrompt,
} from "../../cli/src/llm/prompt-library";
```

Si slash-commands ya importó `composerTrigger` desde `cli/src/llm/slash`, **sustituir** la decisión del picker por `resolveComposerTrigger` **o** por el `composerTrigger` extendido en Task 1 (si slash ya incluye `kind: "prompt"`). No abrir `@` y `#` a la vez.

- [ ] State nuevo, junto a `input` / `mode`:

```ts
const [prompts, setPrompts] = useState<SavedPrompt[]>([]);
const [promptOverlay, setPromptOverlay] = useState(false);
const [promptCursor, setPromptCursor] = useState(0);
const [promptFilter, setPromptFilter] = useState("");
const [promptPickerOpen, setPromptPickerOpen] = useState(false);
const [promptPickerItems, setPromptPickerItems] = useState<SavedPrompt[]>([]);
const [promptPickerIndex, setPromptPickerIndex] = useState(0);
const [promptSaveMode, setPromptSaveMode] = useState(false);
const [promptSaveName, setPromptSaveName] = useState("");
```

- [ ] `refreshPrompts`:

```ts
async function refreshPrompts() {
  if (!token) return;
  try {
    const data = await apiFetch<{ prompts: SavedPrompt[] }>(
      "/prompts",
      {},
      token,
    );
    setPrompts(data.prompts ?? []);
    setPromptCursor((c) =>
      clampIndex(c, data.prompts?.length ?? 0),
    );
  } catch {
    // overlay shows empty; compose still works
  }
}
```

Llamar al bind (junto al GET `/providers`). En `onPush`, si `msg.type === PROMPT_CHANGED_EVENT` (`"prompt.changed"`), `refreshPrompts()`.

- [ ] `saveComposerPrompt(name: string, body: string)`:

```ts
async function saveComposerPrompt(name: string, body: string) {
  const input = parseSavePromptInput({ name, body });
  await apiFetch(
    "/prompts",
    { method: "POST", body: JSON.stringify(input) },
    token,
  );
  setLog(PROMPT_SAVED);
  await refreshPrompts();
}
```

Esta función **no** recibe `client` y **no** llama `sendWithLlm`.

- [ ] `applyComposeText` (si attach-files/slash ya lo creó, **extenderlo**; si no, crearlo y usarlo desde compose):

```ts
function applyComposeText(next: string) {
  setInput(next);
  const trigger = resolveComposerTrigger(next);
  if (trigger?.kind === "prompt") {
    const items = filterPrompts(prompts, trigger.query);
    setPromptPickerOpen(true);
    setPromptPickerItems(items);
    setPromptPickerIndex((i) =>
      items.length ? Math.min(i, items.length - 1) : 0,
    );
    setSlashOpen?.(false);
    setPickerOpen?.(false);
    return;
  }
  setPromptPickerOpen(false);
  setPromptPickerItems([]);
  // existing slash / @ branches if those setters exist
}
```

`setSlashOpen` / `setPickerOpen` solo si los siblings los añadieron.

- [ ] Branch `mode === "compose"` — insertar **antes** del Enter que llama `sendWithLlm`. Orden:

  1. Si `promptSaveMode`: Escape cancela save (vuelve a compose, **input intacto**). Backspace edita `promptSaveName`. Enter llama `saveComposerPrompt(promptSaveName, input)` dentro de try/catch (`setLog` el error), `setPromptSaveMode(false)`, `setPromptSaveName("")`, **return** (no `sendWithLlm`, no `setInput("")`). Chars van a `promptSaveName`.
  2. Escape: si `promptPickerOpen`, cerrar picker `#` (no matar TUI). Si picker `@` o `/` abierto, el sibling ya lo cierra. Si no, cancelar compose.
  3. `key.ctrl && ch === "s"`: si `input.trim()` vacío, `setLog(PROMPT_BODY_ERROR)` y return. Si no, `setPromptSaveMode(true)`, `setPromptSaveName("")`, `setLog("nombre del prompt + Enter")`, return. **No** `sendWithLlm`.
  4. Flechas: si `promptPickerOpen`, mueven `promptPickerIndex` (no el cursor de listas).
  5. Tab/Enter con `promptPickerOpen` e ítem: `const t = activePrompt(input)!`; `applyComposeText(insertPromptAt(input, t, input.length, promptPickerItems[promptPickerIndex]!.body))`; `setPromptPickerOpen(false)`; **return** (sigue en compose; no turn).
  6. Enter **sin** picker: `sendWithLlm` como hoy (slash intercepta antes si el sibling aterrizó).
  7. Backspace / char: `applyComposeText`.

Garantía: con `promptPickerOpen === true` **no** se llama `completeWorkspace` ni `sendWithLlm`. Con `promptSaveMode === true` **no** se llama `sendWithLlm`.

- [ ] Command mode, **no** interceptar `l` en compose. Antes de `q` (y sin pisar `y`/`k`/`o` de siblings):

  - Si `promptOverlay` y Escape: cerrar overlay, no exit. Limpiar `promptFilter`.
  - Si `promptOverlay` y flechas: mueven `promptCursor` sobre `filterPrompts(prompts, promptFilter)`.
  - Si `promptOverlay` y Enter: tomar el ítem, `setPromptOverlay(false)`, `setMode("compose")`, `setInput` al `body` (o `insertPromptAt` si ya había input; si `input` está vacío, `setInput(body + " ")` para poder teclear `@`). `setLog("insertado · @ adjunta archivos")`.
  - Si `promptOverlay` y `ch === "d"`: DELETE `/prompts/${name}` (name del ítem), `setLog(PROMPT_DELETED)`, `refreshPrompts`. Bloquear delete si `busy`.
  - Si `promptOverlay` y char (no ctrl): acumular `promptFilter` (afinar). Backspace recorta el filtro.
  - Si no overlay y `ch === "l"`: abrir overlay, `refreshPrompts()`, `setPromptFilter("")`. Abrir **sí** se permite durante busy (solo lectura).

- [ ] Render:

  Debajo de `compose> {input}` y **antes** del picker `@` / `/` si existen:

```tsx
{mode === "compose" && promptSaveMode ? (
  <Text color="yellow">save as&gt; {promptSaveName}</Text>
) : null}
{mode === "compose" && promptPickerOpen ? (
  <Box flexDirection="column">
    <Text dimColor>
      {PROMPT_PICKER_HEADER} · {PROMPT_ACCOUNT_LABEL}
    </Text>
    {promptPickerItems.length === 0 ? (
      <Text color="yellow">{PROMPT_EMPTY}</Text>
    ) : (
      promptPickerItems.map((c, i) => (
        <Text
          key={c.id}
          color={i === promptPickerIndex ? "cyan" : undefined}
          bold={i === promptPickerIndex}
        >
          {i === promptPickerIndex ? ">" : " "} {c.name}  {c.title}
        </Text>
      ))
    )}
    <Text dimColor>Tab/Enter insertan · Esc cierra · no ejecuta</Text>
  </Box>
) : null}
```

Overlay command (`promptOverlay`):

```
Prompts  cuenta  n=N
[Enter] insertar  [d] borrar  [esc] cerrar
> review  Review PR
  fix-tests  Reproduce and fix
```

Si lista vacía: `0 prompts`. Body recortado **no** se vuelca entero (solo `name` + `title`). Filtro en la línea `filter: {promptFilter}`.

Footer de ayuda: añadir `[l] prompts` y en compose ` # prompts  C-s guardar`. No reordenar el resto de teclas de siblings.

- [ ] Commit:

```bash
git add tui/src/App.tsx
git commit -m "feat(prompts): TUI # picker, Ctrl+s save, l overlay — save does not run a turn"
```

---

## Task 5: Web — guardar desde el compositor, picker `#`, `/prompts`, sync

**Files:**

- Create: `web/src/lib/prompt-library.ts`
- Test: `web/src/lib/prompt-library.test.ts`
- Create: `web/src/components/PromptPicker.tsx`
- Create: `web/src/components/PromptLibraryPanel.tsx`
- Create: `web/src/pages/prompts.astro`
- Modify: `web/src/components/ChatDetailPanel.tsx`
- Modify: `web/src/components/MentionComposer.tsx` (solo si el archivo **ya** existe; si no, el picker vive en `ChatDetailPanel`)
- Modify: `web/src/lib/hooks.ts`
- Modify: `web/src/lib/query-keys.ts`
- Modify: `web/src/lib/ws-context.tsx`
- Modify: `web/src/layouts/BaseLayout.astro`
- Modify: `web/src/components/HubPanel.tsx`
- Modify: `web/src/styles/global.css`
- Modify: `web/package.json`

Web **no** importa `cli/`. Keep-in-sync del módulo puro.

- [ ] Copiar `cli/src/llm/prompt-library.ts` → `web/src/lib/prompt-library.ts` **idéntico** (mismo source). Primera línea:

```ts
/** Keep in sync with cli/src/llm/prompt-library.ts */
```

Copiar el test a `web/src/lib/prompt-library.test.ts` ajustando el import a `./prompt-library`. Añadir `"test": "bun test"` en `web/package.json` `scripts` si falta (dejar `dev`/`build`/`preview`/`start`).

- [ ] `queryKeys.prompts = ["prompts"] as const` en `web/src/lib/query-keys.ts`.

- [ ] Tipos + hooks en `web/src/lib/hooks.ts`:

```ts
export type SavedPrompt = {
  id: string;
  name: string;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
};

export function usePrompts(enabled = true) {
  return useQuery({
    queryKey: queryKeys.prompts,
    enabled,
    queryFn: async () => {
      const data = await apiJson<{ prompts: SavedPrompt[] }>("/prompts");
      return data.prompts ?? [];
    },
  });
}

export function useSavePrompt() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; title?: string; body: string }) =>
      apiJson<{ prompt: SavedPrompt }>("/prompts", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.prompts });
    },
  });
}

export function useDeletePrompt() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (nameOrId: string) =>
      apiJson<{ ok: true; name: string }>(
        `/prompts/${encodeURIComponent(nameOrId)}`,
        { method: "DELETE" },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.prompts });
    },
  });
}
```

`useSavePrompt` **no** llama `useWsAgentTurn`. Cero `agent.turn.request` en estos hooks.

- [ ] En `web/src/lib/ws-context.tsx`, dentro del `onPush` global, **añadir** (no reemplazar los `chat.*`):

```ts
if (msg.type === "prompt.changed") {
  void qc.invalidateQueries({ queryKey: queryKeys.prompts });
}
```

Importar `queryKeys` si el archivo aún no lo usa para prompts (ya importa `queryKeys` para chats).

- [ ] Crear `web/src/components/PromptPicker.tsx`:

```tsx
import { filterPrompts, type SavedPrompt } from "../lib/prompt-library";
import { PROMPT_ACCOUNT_LABEL, PROMPT_EMPTY, PROMPT_PICKER_HEADER } from "../lib/prompt-library";

export function PromptPicker({
  prompts,
  query,
  activeIndex,
  onHover,
  onPick,
}: {
  prompts: SavedPrompt[];
  query: string;
  activeIndex: number;
  onHover: (i: number) => void;
  onPick: (p: SavedPrompt) => void;
}) {
  const items = filterPrompts(prompts, query);
  return (
    <div className="prompt-picker" role="listbox" aria-label="Saved prompts">
      <header>
        {PROMPT_PICKER_HEADER} · {PROMPT_ACCOUNT_LABEL}
      </header>
      {items.length === 0 ? (
        <p className="muted">{PROMPT_EMPTY}</p>
      ) : (
        items.map((p, i) => (
          <button
            type="button"
            key={p.id}
            className={`pick${i === activeIndex ? " active" : ""}`}
            onMouseEnter={() => onHover(i)}
            onClick={() => onPick(p)}
          >
            <code>{p.name}</code> {p.title}
          </button>
        ))
      )}
    </div>
  );
}
```

Todos los botones son `type="button"`. Click **no** submit del form del agente.

- [ ] Compositor en `ChatDetailPanel.tsx` (y `MentionComposer.tsx` si existe):

  **Si `web/src/components/MentionComposer.tsx` existe:** extenderlo con props `prompts: SavedPrompt[]`. En el mismo sitio donde calcula `activeMention`:

  1. `const trigger = resolveComposerTrigger(value, cursor)`.
  2. Si `trigger.kind === "prompt"`: **no** llamar `fs.complete`; render `PromptPicker`; Enter/click llama `onChange(insertPromptAt(value, trigger, cursor, body))` y `preventDefault`.
  3. Si `kind === "mention"`: comportamiento actual `@` (hostname + path del daemon — decisión 6 **solo** para `@`).
  4. Si `kind === "slash"`: el picker `/` del plan 11 si existe; si no, ignorar.

  **Si MentionComposer no existe:** en `ChatDetailInner`, el `<textarea id="prompt">` se envuelve:

  - `onChange` / `onKeyUp` / `onSelect` guardan `cursor` y `value`.
  - Si `resolveComposerTrigger(prompt, cursor)?.kind === "prompt"`, mostrar `PromptPicker` debajo del textarea.
  - Flechas con picker abierto: `preventDefault`, mueven índice.
  - Enter con picker abierto: `preventDefault`, inserta, **no** `onAgent`.

  En el form `onAgent` (submit):

```tsx
<div className="composer-actions">
  <button
    type="submit"
    disabled={agent.isPending || ws.status !== "open"}
  >
    {agent.isPending ? "Enviando…" : "agent.turn.request"}
  </button>
  <button
    type="button"
    className="secondary"
    id="save-prompt-btn"
    disabled={savePrompt.isPending || !prompt.trim()}
    onClick={() => {
      setSaveOpen(true);
      setSaveName("");
      setSaveMsg(null);
    }}
  >
    Guardar prompt
  </button>
</div>
{saveOpen && (
  <div className="prompt-save">
    <label htmlFor="prompt-name">Nombre</label>
    <input
      id="prompt-name"
      value={saveName}
      onChange={(e) => setSaveName(e.target.value)}
      placeholder="review-pr"
      autoComplete="off"
    />
    <button
      type="button"
      onClick={async () => {
        setSaveMsg(null);
        try {
          await savePrompt.mutateAsync({
            name: saveName,
            body: prompt,
          });
          setSaveOpen(false);
          setSaveMsg({ kind: "ok", text: "Prompt guardado" });
        } catch (err) {
          setSaveMsg({ kind: "error", text: formatQueryError(err) });
        }
      }}
    >
      Guardar
    </button>
    <button
      type="button"
      className="secondary"
      onClick={() => setSaveOpen(false)}
    >
      Cancelar
    </button>
  </div>
)}
```

Reglas de este bloque (Gherkin: **No se ejecuta solo**):

1. `Guardar prompt` es `type="button"`, **nunca** `submit`.
2. El `onClick` de Guardar llama **solo** `useSavePrompt().mutateAsync`. **No** `agent.mutateAsync`. **No** `setPrompt("")`.
3. Tras 201, el textarea conserva el texto (el usuario puede insertar `@` o enviar después).
4. `saveOpen` no monta un segundo form que haga submit al padre.

State extra en `ChatDetailInner`: `saveOpen`, `saveName`, `saveMsg`, `savePrompt = useSavePrompt()`, `prompts = usePrompts(signedIn)`.

- [ ] Crear `web/src/components/PromptLibraryPanel.tsx` (página de cuenta, no workspace):

  - `useMe` + `usePrompts` + `useSavePrompt` + `useDeletePrompt`.
  - Lista `name` + `title` + preview de body (120 chars).
  - Form crear: name, title opcional, body. Submit del form de crear es POST, **no** WS turn.
  - Botón borrar `type="button"` → DELETE.
  - Vacío: `0 prompts`.
  - 401: link a `/sign-in?redirect=/prompts`.

- [ ] Crear `web/src/pages/prompts.astro`:

```astro
---
export const prerender = false;
import BaseLayout from "../layouts/BaseLayout.astro";
import { PromptLibraryPanel } from "../components/PromptLibraryPanel";
---

<BaseLayout title="Prompts">
  <PromptLibraryPanel client:only="react" />
</BaseLayout>
```

- [ ] `BaseLayout.astro`: en `<nav>`, junto a Workspaces:

```html
<a href="/prompts">Prompts</a>
```

- [ ] `HubPanel.tsx`: si `signedIn`, añadir ` · <a href="/prompts">Biblioteca de prompts</a>` en el párrafo muted de providers/workspaces.

- [ ] CSS en `web/src/styles/global.css` (si `.mention-picker` / `.slash-picker` ya existen, copiar medidas; si no, añadir):

```css
.prompt-picker {
  margin-top: 0.5rem;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: #12181f;
  padding: 0.5rem;
}
.prompt-picker header {
  font-size: 0.8rem;
  color: var(--muted);
  margin-bottom: 0.35rem;
}
.prompt-picker button.pick {
  display: block;
  width: 100%;
  text-align: left;
  margin-top: 0.15rem;
  background: transparent;
  color: var(--fg);
  font-weight: 400;
  padding: 0.35rem 0.5rem;
}
.prompt-picker button.pick.active,
.prompt-picker button.pick:hover {
  background: #2a3542;
}
.composer-actions {
  display: flex;
  gap: 0.75rem;
  flex-wrap: wrap;
  align-items: center;
}
.composer-actions button {
  margin-top: 1rem;
}
.prompt-save {
  margin-top: 0.75rem;
  padding: 0.75rem;
  border: 1px solid var(--border);
  border-radius: 8px;
}
```

- [ ] Correr:

```bash
cd web && bun test src/lib/prompt-library.test.ts
cd cli && bun test src/llm/prompt-library.test.ts
```

Esperado: pass (mismo módulo).

- [ ] Commit:

```bash
git add web/src/lib/prompt-library.ts web/src/lib/prompt-library.test.ts \
  web/src/components/PromptPicker.tsx web/src/components/PromptLibraryPanel.tsx \
  web/src/pages/prompts.astro web/src/components/ChatDetailPanel.tsx \
  web/src/components/MentionComposer.tsx web/src/lib/hooks.ts \
  web/src/lib/query-keys.ts web/src/lib/ws-context.tsx \
  web/src/layouts/BaseLayout.astro web/src/components/HubPanel.tsx \
  web/src/styles/global.css web/package.json
git commit -m "feat(prompts): Web composer save/insert, # picker, /prompts library"
```

Solo `git add` los archivos que existan (MentionComposer puede no existir).

---

## Task 6: OpenAPI + contrato WS documentado

**Files:**

- Modify: `api/openapi/openapi.yaml`

- [ ] Tag `Prompts` en `tags:` (después de `Chats`):

```yaml
  - name: Prompts
    description: |
      Biblioteca de briefs de la cuenta (no skills, no AGENTS.md).
      CRUD HTTP sin daemon. Guardar no dispara un turn.
      Insertar ocurre en el compositor del cliente.
```

- [ ] Paths (mismo estilo que `/me` / `/workspaces` — cookie + bearer):

```yaml
  /prompts:
    get:
      tags: [Prompts]
      summary: Listar prompts de la cuenta
      operationId: listPrompts
      security:
        - bearerAuth: []
        - cookieAuth: []
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/PromptsResponse"
        "401":
          $ref: "#/components/responses/Unauthorized"
    post:
      tags: [Prompts]
      summary: Guardar un prompt. No dispara agent.turn.request.
      operationId: createPrompt
      security:
        - bearerAuth: []
        - cookieAuth: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/CreatePromptRequest"
      responses:
        "201":
          description: Created
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/PromptResponse"
        "400":
          description: Validación o cap 50
        "401":
          $ref: "#/components/responses/Unauthorized"
        "409":
          description: Prompt name already exists
  /prompts/{nameOrId}:
    get:
      tags: [Prompts]
      summary: Obtener un prompt por name o id
      operationId: getPrompt
      security:
        - bearerAuth: []
        - cookieAuth: []
      parameters:
        - in: path
          name: nameOrId
          required: true
          schema: { type: string }
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/PromptResponse"
        "401":
          $ref: "#/components/responses/Unauthorized"
        "404":
          description: Prompt not found
    put:
      tags: [Prompts]
      summary: Actualizar title/body/name
      operationId: updatePrompt
      security:
        - bearerAuth: []
        - cookieAuth: []
      parameters:
        - in: path
          name: nameOrId
          required: true
          schema: { type: string }
      requestBody:
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/UpdatePromptRequest"
      responses:
        "200":
          description: OK
        "400":
          description: Validación
        "404":
          description: Prompt not found
        "409":
          description: Prompt name already exists
    delete:
      tags: [Prompts]
      summary: Borrar un prompt propio
      operationId: deletePrompt
      security:
        - bearerAuth: []
        - cookieAuth: []
      parameters:
        - in: path
          name: nameOrId
          required: true
          schema: { type: string }
      responses:
        "200":
          description: Deleted
        "404":
          description: Prompt not found
```

Schemas en `components.schemas`:

```yaml
    SavedPrompt:
      type: object
      required: [id, name, title, body, createdAt, updatedAt]
      properties:
        id: { type: string }
        name: { type: string, pattern: "^[a-z][a-z0-9_-]{0,62}$" }
        title: { type: string, maxLength: 120 }
        body: { type: string, maxLength: 20000 }
        createdAt: { type: string, format: date-time }
        updatedAt: { type: string, format: date-time }
    PromptsResponse:
      type: object
      required: [prompts]
      properties:
        prompts:
          type: array
          items: { $ref: "#/components/schemas/SavedPrompt" }
    PromptResponse:
      type: object
      required: [prompt]
      properties:
        prompt: { $ref: "#/components/schemas/SavedPrompt" }
    CreatePromptRequest:
      type: object
      required: [name, body]
      properties:
        name: { type: string }
        title: { type: string }
        body: { type: string }
    UpdatePromptRequest:
      type: object
      properties:
        name: { type: string }
        title: { type: string }
        body: { type: string }
```

En la descripción del tag WebSocket, documentar push `prompt.changed` con `{ prompts: SavedPrompt[] }` tras POST/PUT/DELETE. **No** documentar un RPC `prompt.save`. **No** documentar slash `/prompt`.

- [ ] Commit:

```bash
git add api/openapi/openapi.yaml
git commit -m "docs(prompts): OpenAPI for /prompts and prompt.changed"
```

---

## Task 7: Smoke Gherkin — los cuatro escenarios

**Files:**

- Create: `cli/scripts/prompt-library-smoke.ts`
- Create: `api/scripts/e2e-prompts.ts`
- Modify: `cli/package.json` (script opcional `"test:prompts": "bun run scripts/prompt-library-smoke.ts"`)
- Modify: `api/package.json` (script opcional `"test:e2e:prompts": "bun run scripts/e2e-prompts.ts"`)

Cubre las cuatro cláusulas con asserts concretos. El turn live (Claude) se salta con exit 0 y un log si no hay token/daemon; HTTP + insert + “save no es turn” **siempre** corren.

- [ ] Crear `cli/scripts/prompt-library-smoke.ts`:

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  activePrompt,
  expandAskPrompt,
  filterPrompts,
  insertPromptAt,
  parseAskArgs,
  parseSavePromptInput,
  resolveComposerTrigger,
  type SavedPrompt,
} from "../src/llm/prompt-library";

const brief = "Review this PR for auth regressions";

function rec(name: string, body = brief): SavedPrompt {
  return {
    id: name,
    name,
    title: name,
    body,
    createdAt: "2026-09-16T00:00:00.000Z",
    updatedAt: "2026-09-16T00:00:00.000Z",
  };
}

// 1. Guardar desde el compositor → cuenta (validate + no turn in CLI save)
{
  const saved = parseSavePromptInput({ name: "review", body: brief });
  assert.equal(saved.name, "review");
  assert.equal(saved.body, brief);
  const promptTs = readFileSync(
    join(import.meta.dir, "../src/commands/prompt.ts"),
    "utf8",
  );
  assert.equal(promptTs.includes("agent.turn"), false);
  assert.ok(promptTs.includes('"/prompts"'));
}

// 2. Insertar + mezclar con @
{
  const composer = "please #rev";
  const trigger = activePrompt(composer);
  assert.ok(trigger);
  const inserted = insertPromptAt(composer, trigger, composer.length, brief);
  assert.equal(inserted.includes("#rev"), false);
  assert.ok(inserted.includes(brief));
  const mixed = `${inserted}@src/auth.ts`;
  assert.ok(mixed.includes("@src/auth.ts"));
  assert.equal(resolveComposerTrigger(mixed)?.kind, "mention");
  const items = filterPrompts(
    [rec("review"), rec("fix-tests", "reproduce")],
    "rev",
  );
  assert.equal(items[0]?.name, "review");
  assert.ok(items.length <= 10);
}

// 3. Guardar no dispara un turn (API route + TUI/Web source)
{
  const apiRoute = readFileSync(
    join(import.meta.dir, "../../api/src/routes/prompts.ts"),
    "utf8",
  );
  assert.equal(apiRoute.includes("agent.turn"), false);
  assert.ok(apiRoute.includes("prompt.changed"));
  const webPanel = readFileSync(
    join(import.meta.dir, "../../web/src/components/ChatDetailPanel.tsx"),
    "utf8",
  );
  assert.ok(webPanel.includes('id="save-prompt-btn"') || webPanel.includes("Guardar prompt"));
  assert.ok(webPanel.includes('type="button"'));
}

// 4. CLI list + ask --prompt <name>
{
  const parsed = parseAskArgs([
    "chat-1",
    "--prompt",
    "review",
    "also",
    "@src/auth.ts",
  ]);
  assert.equal(parsed.promptName, "review");
  const expanded = expandAskPrompt({
    libraryBody: brief,
    extra: parsed.extra,
  });
  assert.equal(expanded, `${brief}\n\nalso @src/auth.ts`);
  const headless = readFileSync(
    join(import.meta.dir, "../src/commands/headless.ts"),
    "utf8",
  );
  assert.ok(headless.includes("parseAskArgs"));
  assert.ok(headless.includes("--prompt") || headless.includes("promptName"));
}

console.log("prompt-library smoke ok");
```

- [ ] Crear `api/scripts/e2e-prompts.ts`. Corre contra API viva (`CHAVEZ_API_URL`, default `http://localhost:25001`). Si `/health` falla, `console.log("skip e2e-prompts: API down")` y `process.exit(0)`. Si está up:

  1. Sign-up email (mismo patrón que `api/scripts/e2e-phase1.ts`: `PASSWORD_EMAIL`, cookie).
  2. `GET /prompts` 401 sin cookie.
  3. `GET /prompts` 200 `{ prompts: [] }` con cookie.
  4. `POST /prompts` `{ name: "review", body: "Review this PR" }` → 201, `prompt.name === "review"`.
  5. **No hay** side-effect de turn: `GET /workspaces` sigue igual; no hay chats nuevos requeridos. Assert 201 no incluye `chatId` ni `streamId`.
  6. `GET /prompts` incluye `review`. Segundo usuario (otro sign-up) `GET /prompts` **no** ve `review` (cuenta, no org).
  7. `POST` el mismo name → 409 `Prompt name already exists: review`.
  8. `GET /prompts/review` 200 body.
  9. `DELETE /prompts/review` 200; GET 404 `Prompt not found: review`.
  10. `POST` 51 veces → el 51º es 400 `Maximum 50 saved prompts` (crear 50 en loop y assert; borrar al final). Si el test quiere ir más rápido: insertar 50 y assert el 51. No dejar sucio: delete all names `cap-*`.

  11. CORS: el test usa `Origin` igual que e2e-phase1.

Esqueleto (rellenar con los helpers `cookieFromResponse` copiados de `e2e-phase1.ts`):

```ts
const API = process.env.CHAVEZ_API_URL || "http://localhost:25001";

const health = await fetch(`${API}/health`);
if (!health.ok) {
  console.log("skip e2e-prompts: API down");
  process.exit(0);
}

// sign-up → cookie (copy e2e-phase1 helpers)
// POST /prompts → 201
// GET /prompts → contains review
// POST duplicate → 409
// other user GET → empty
// DELETE → 404 on GET
console.log("e2e-prompts ok");
```

Copiar `cookieFromResponse` y el `sign-up/email` de `api/scripts/e2e-phase1.ts` (no extraer a un paquete nuevo). No llamar `/ws`. No enviar `agent.turn.request`.

- [ ] Scripts en package.json:

`cli/package.json`:

```json
"test:prompts": "bun run scripts/prompt-library-smoke.ts"
```

`api/package.json`:

```json
"test:e2e:prompts": "bun run scripts/e2e-prompts.ts"
```

- [ ] Correr (en este orden):

```bash
cd cli && bun test src/llm/prompt-library.test.ts src/commands/prompt-ask.test.ts
cd cli && bun run scripts/prompt-library-smoke.ts
cd api && bun test src/llm/prompt-library.test.ts src/routes/prompts-validate.test.ts
cd web && bun test src/lib/prompt-library.test.ts
# si API + Postgres up:
cd api && bunx drizzle-kit migrate && bun run scripts/e2e-prompts.ts
```

Esperado: unit + smoke pass. e2e pass o skip limpio si API down.

- [ ] Commit:

```bash
git add cli/scripts/prompt-library-smoke.ts api/scripts/e2e-prompts.ts \
  cli/package.json api/package.json
git commit -m "test(prompts): Gherkin smoke for save, insert+@, no-turn, CLI ask --prompt"
```

---

## Orden de ejecución

1. Task 1 (puro) — desbloquea TUI/Web/CLI.
2. Task 2 (API) — desbloquea CLI HTTP y Web.
3. Task 3 (CLI) — list + ask `--prompt`.
4. Task 4 (TUI) y Task 5 (Web) — en paralelo una vez 1–2 existen; Web no espera a TUI.
5. Task 6 (OpenAPI) — puede ir junto a Task 2; no bloquear UI.
6. Task 7 (smoke) — al final, con los archivos de 1–5 en disco.

No implementar skills, slash `/prompt`, memoria, ni Cursor cloud en esta fase.
