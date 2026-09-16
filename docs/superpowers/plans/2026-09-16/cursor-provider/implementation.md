# Cursor provider Implementation Plan

> **For agentic workers:** Execute task-by-task. Do not skip tests. Do not implement Cursor cloud, voz, extensión IDE, upload desde el navegador, MCP/skills/subagentes (plan 19), slash `/model` (plan 11), ni cola de turns (plan 29). Spec: [`plan.md`](./plan.md). Depende de Claude ya ejecutable en `cli/src/llm/claude-runner.ts` + `cli/src/llm/publish-turn.ts`. Si [`agent-tools`](../agent-tools/implementation.md) / [`execution-modes`](../execution-modes/implementation.md) ya añadieron `tool-names.ts` o `execution-gate.ts`, **extiéndelos**; no los reescribas.

**Goal:** Cursor se comporta como Claude en el harness: se vincula, se elige modelo y params nativos, se ejecuta un **agente local** sobre el cwd del daemon, se streamean texto y tools con el mismo contrato visual, y se persiste el chat. Los catálogos de Claude y Cursor se recolectan **completos**: se guarda el JSON crudo y se deserializa con los types de ese provider (esfuerzo Claude vs `optimize_for` / `fast` / variants de Cursor). No se aplana a un único schema que pierda campos. Sin daemon bound no corre ningún turn. Sin key de Cursor, un turn con provider activo `cursor` falla con el mismo error de fondo en CLI, TUI y Web.

**Architecture:** El filesystem y el runtime de Cursor viven en el proceso daemon (`cli/src/ws/daemon.ts` o TUI con `clientKind: "daemon"`). La API guarda el vault, el JSON crudo de cada catálogo y las preferencias; hace fan-out WebSocket. El SDK `@cursor/sdk` corre **solo** con `local: { cwd }` — jamás `cloud`. Discovery de modelos de Cursor (`Cursor.models.list`) es una lectura de cuenta: la hace la API con la key del vault para que Web/TUI/CLI vean el catálogo sin daemon. El turn lo ejecuta el daemon.

```
PUT /providers/cursor/credentials { authKind: "api_key", secret }
        |
        v
  vault AES-GCM  +  refresh Cursor.models.list({ apiKey })
        |             success → provider_catalogs.raw_json
        |             fail    → last cache + catalogError; key intacta
        v
GET /providers  (sesión requerida)
        |  linked, authKind, runnable, catalogs[].raw + models nativos,
        |  activeProvider, activeModel, activeEffort, activeParams, activeMode?
        v
PUT /providers/preferences | PUT /providers/active
        |  rechaza par provider/model imposible (400 explícito)
        |  al set de provider, recorta model+params al catálogo de ese provider
        v
Composer (Web | TUI | CLI ask)
        |
        v
  agent.turn.request  --WS-->  API hub.findDaemon
        |                         | no daemon → "No daemon bound…"
        |                         | daemon.turnBusy → "Turn already running…"
        v                         v
  agent.turn.dispatch  ------>  daemon / TUI
        |
        v
  publishAgentTurn
        |  chat.append user
        |  GET /providers → activeProvider
        |  claude → runClaudeTurn (sin gastar key Cursor)
        |  cursor → runCursorTurn
        |            Agent.create({ apiKey, model: { id, params }, local: { cwd } })
        |            historyFromChatMessages → promptWithHistory
        |            run.stream() / onDelta → chat.stream.delta
        |            tool_call  → chat.tool.start / chat.tool.result (nombres canónicos)
        |            cancel     → run.cancel() → cancelled
        |            auth fail  → CURSOR_AUTH_ERROR (sugerir re-link)
        |            bad model  → CURSOR_MODEL_UNAVAILABLE (nombra el id)
        v
  API persist + broadcast  →  Web ToolCard | TUI messages | CLI watch
```

Estado actual que este plan extiende (no reescribir):

- Vault Cursor **ya existe**: `PUT/GET/DELETE /providers/:provider/credentials` en `api/src/routes/providers.ts`. CLI `chavez provider link cursor` y `--web` en `cli/src/commands/provider.ts`. Web `ProvidersPanel.tsx` guarda la key. `api/src/index.ts` redirige `/providers/link?provider=cursor&token=` a `web/src/pages/providers.astro`.
- Catálogo Cursor es **stub**: `api/src/llm/catalog.ts` y `cli/src/llm/catalog.ts` tienen `CURSOR_MODELS = [{ id: "composer-2.5", label: "Composer 2.5 (stub)", … }]` y `runnable: false`. GET `/providers` copia ese stub a `providers.cursor.models`.
- Un solo type `ModelInfo` (id/label/precios/`effortLevels`) se aplica a ambos providers. Eso **aplana** y se elimina para Cursor.
- `user_preferences` tiene `activeProvider` / `activeModel` / `activeEffort`. **No** hay `activeParams`. PUT `/preferences` **no** valida que el modelId pertenezca al provider.
- `cli/src/llm/publish-turn.ts` lanza si `activeProvider !== "claude"`: ``Provider activo "${id}" no ejecuta agente en daemon (solo claude)``. Solo pide credenciales de Claude.
- TUI `tui/src/App.tsx` `sendWithLlm`: si `provider !== "claude"` hace `chat.append` y log `"Cursor LLM aún no implementado — solo se guardó el mensaje user"`. Header: `LLM: stub` cuando `runnable === false`.
- `cli/src/commands/whoami.ts` no muestra provider/modelo/runnable. `provider list` no muestra runnable ni modelo activo.
- No hay `agent.turn.cancel`. Escape en TUI cierra la TUI.
- Claude Agent SDK ya corre en el daemon. Cursor SDK **no** está en `cli/package.json` ni `api/package.json`.
- Tools visuales: si el plan 2 ya emitió `chat.tool.start`/`result` con nombres canónicos, Cursor **reutiliza** ese contrato. Si no, este plan emite el mismo envelope (`toolName` canónico, `id`, `input`, `output`, `status`).

**Tech Stack:** Bun, Hono + Drizzle (`user_preferences`, nueva `provider_catalogs`), WebSocket hub, `@cursor/sdk` (`Cursor.models.list`, `Agent.create` local, `Run.stream`/`cancel`/`wait`, `JsonlLocalAgentStore`), Claude Agent SDK (sin cambios de runtime), Ink TUI, Astro/React web.

**Global Constraints:**

1. El filesystem y el loop del agente Cursor corren **solo** en el daemon (cwd del workspace). API y browser no ejecutan `Agent.create`. La API **sí** llama `Cursor.models.list` (lectura de cuenta, sin cwd).
2. Sin daemon bound, `agent.turn.request` falla con el string existente: `"No daemon bound for this workspace. Run: chavez headless workspace open"`.
3. Cursor es **solo runtime local**. `Agent.create` recibe `local: { cwd }` y **nunca** `cloud`, `repos`, `autoCreatePR` ni UI de “cloud VM”. Fuera de alcance: cloud agents, voz, extensión IDE, upload desde el navegador.
4. Catálogos **completos y nativos**. Se persiste `raw_json` (el array/objeto que devolvió la fuente). Se deserializa con types de ese provider. Un campo desconocido no se descarta del crudo. No se fuerza el shape de Cursor sobre Claude ni al revés.
5. Claude catálogo = **estático** (`CLAUDE_MODELS` actual: id, label, precios, `effortLevels`). Se “recolecta” serializando ese objeto a JSON crudo y persistiendo. Cursor catálogo = **descubierto** con `Cursor.models.list({ apiKey })` (id, `displayName`, `parameters`, `variants`, `optimize_for`, `fast`, …). Router (`auto-smart` + `optimize_for` cost/balanced/intelligence) **solo** si aparece en el JSON de esa cuenta. Si no está, no se ofrece.
6. Fallback de discovery: si Cursor está linked y `models.list` falla, se sirve el último `raw_json` cacheado **o** un error visible. La key **no** se borra. `runnable` es true solo si hay al menos un modelo **real** en el cache. Nunca se marca runnable con `composer-2.5 (stub)` inventado.
7. Preferencias: una sola fuente (`user_preferences`). `activeProvider` + `activeModel` incompatibles → **400** con mensaje que nombra ambos. Al `provider set`, se recorta modelo/params al catálogo del nuevo provider (corrección explícita). No se dispara un turn con un par imposible: `publishAgentTurn` revalida.
8. Historial: `historyFromChatMessages` + `promptWithHistory` (ya en `cli/src/llm/history.ts`) se inyectan igual a Cursor. Un chat que empezó en Claude y sigue en Cursor conserva los mensajes en DB y el modelo los recibe. No se usa `Agent.resume` como fuente de verdad (perdería turns de Claude).
9. Tools: mismas 6 por defecto (read/write/edit/grep/glob/bash-shell). Visualización idéntica a Claude: `chat.tool.start` / `chat.tool.result` con nombre canónico, id, input, output, status. Lecturas no piden confirmación. Write/edit/bash siguen el modo si el plan 3 ya está; si no, se ejecutan (paridad con Claude hoy).
10. 1 turn por daemon (`turnBusy` / `turnBusyRef` existentes). Cancelar un run Cursor llama `run.cancel()`; el stream termina; el chat acepta un turn nuevo. Cancelar **no** desvincula ni cambia preferencias.
11. Claude activo **no** gasta la key de Cursor: `publishAgentTurn` solo llama `runClaudeTurn` y GET `/providers/claude/credentials`.
12. Secretos: listados, whoami, logs del daemon y `console.log` **nunca** imprimen la API key. Reveal es GET autenticado (ya existe).
13. Un usuario = su vault. Unlink de Cursor no toca la fila de Claude.
14. Modo de ejecución (`plan`/`auto`/`ask`): si `activeExecutionMode` ya existe (plan 3), se lee y se respeta; **no** se mapea al `mode: "plan"|"agent"` del SDK de Cursor (semántica distinta). Si el plan 3 no aterrizó, no se añade la columna aquí.

**Constantes (congeladas, no inventar otras):**

| Nombre | Valor |
|---|---|
| `CURSOR_SDK_PKG` | `"@cursor/sdk"` |
| `CLAUDE_UNLINKED` | `"Claude no está vinculado — chavez provider link claude"` |
| `CURSOR_UNLINKED` | `"Cursor no está vinculado — chavez provider link cursor (o Web /providers)"` |
| `CURSOR_AUTH_ERROR` | `"Cursor authentication failed — re-link: chavez provider link cursor (o Web /providers)"` |
| `CURSOR_MODEL_UNAVAILABLE` | `` `Model "${id}" is not available for this Cursor account. Choose another from the discovered catalog.` `` |
| `CURSOR_NOT_RUNNABLE` | `"Cursor no es ejecutable (catálogo no disponible). Reintenta o re-vincula."` |
| `INVALID_PROVIDER_MODEL` | `` `modelId "${model}" does not belong to provider ${provider}` `` |
| `INVALID_PROVIDER_PARAM` | `` `param "${id}=${value}" is not valid for model ${model}` `` |
| `NO_DAEMON_ERROR` | `"No daemon bound for this workspace. Run: chavez headless workspace open"` |
| `TURN_BUSY_ERROR` | `"Turn already running on this daemon"` |
| `CATALOG_TTL_MS` | `300_000` |
| `ROUTER_MODEL_ID` | `"auto-smart"` |
| `OPTIMIZE_FOR_ID` | `"optimize_for"` |
| `OPTIMIZE_FOR_VALUES` | `"cost"` \| `"balanced"` \| `"intelligence"` (solo si el catálogo los lista) |
| `DEFAULT_CURSOR_TOOLS` | `["read", "edit", "write", "grep", "glob", "ls", "shell"]` |

Nombres canónicos de tools (timeline; Cursor usa minúsculas / `shell`, Claude PascalCase):

| SDK name (Claude / Cursor) | Canónico |
|---|---|
| `Read` / `read` | `read` |
| `Write` / `write` | `write` |
| `Edit`, `NotebookEdit` / `edit` | `edit` |
| `Grep` / `grep` | `grep` |
| `Glob`, `LS` / `glob`, `ls` | `glob` |
| `Bash` / `shell` | `bash` |
| cualquier otra | `toolName.toLowerCase()` |

Si `cli/src/llm/tool-names.ts` ya existe con `canonicalToolName`, **añadir** los alias de Cursor ahí. Si no, crear el mapper en Task 4 y usarlo en `publish-turn`.

---

## Task 1: Types nativos — Claude y Cursor, codec sin aplanar

**Files:**

- Create: `api/src/llm/claude-types.ts`
- Create: `api/src/llm/cursor-types.ts`
- Create: `api/src/llm/catalog-codec.ts`
- Test: `api/src/llm/catalog-codec.test.ts`
- Create: `cli/src/llm/claude-types.ts`
- Create: `cli/src/llm/cursor-types.ts`
- Create: `cli/src/llm/catalog-codec.ts`
- Test: `cli/src/llm/catalog-codec.test.ts`
- Modify: `api/src/llm/catalog.ts`
- Modify: `cli/src/llm/catalog.ts`
- Modify: `api/package.json`
- Modify: `cli/package.json`

API y CLI **duplican** los types (mismo patrón que execution-mode). Web no importa CLI: Task 9 declara los types en `web/src/lib/hooks.ts`. TUI importa desde `cli/src/llm/…`.

- [ ] Añadir `"test": "bun test"` en `api/package.json` y `cli/package.json` `scripts` si aún no existe (dejar `start`/`dev`/`bin` intactos).

- [ ] Crear `api/src/llm/claude-types.ts` (copiar idéntico a `cli/src/llm/claude-types.ts`):

```ts
export type EffortLevel = "none" | "low" | "medium" | "high" | "xhigh" | "max";

export type ClaudeModelInfo = {
  id: string;
  label: string;
  inputPricePerMTok: number;
  outputPricePerMTok: number;
  effortLevels: EffortLevel[];
};

export type ClaudeCatalog = {
  id: "claude";
  label: string;
  models: ClaudeModelInfo[];
};

export const EFFORT_FULL: EffortLevel[] = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
```

- [ ] Crear `api/src/llm/cursor-types.ts` (copiar idéntico a `cli/src/llm/cursor-types.ts`). Shape = `ModelListItem` de `@cursor/sdk` (`Cursor.models.list`), **sin** `effortLevels` ni precios Claude:

```ts
export type CursorParamValue = {
  value: string;
  displayName?: string;
};

export type CursorParameterDefinition = {
  id: string;
  displayName?: string;
  values: CursorParamValue[];
};

export type CursorParamSelection = {
  id: string;
  value: string;
};

export type CursorVariant = {
  params: CursorParamSelection[];
  displayName: string;
  description?: string;
  isDefault?: boolean;
};

export type CursorModelInfo = {
  id: string;
  displayName: string;
  description?: string;
  aliases?: string[];
  parameters?: CursorParameterDefinition[];
  variants?: CursorVariant[];
};

export type CursorCatalog = {
  id: "cursor";
  label: string;
  models: CursorModelInfo[];
};

export const ROUTER_MODEL_ID = "auto-smart";
export const OPTIMIZE_FOR_ID = "optimize_for";
```

- [ ] Crear `api/src/llm/catalog-codec.ts` (copiar la lógica a `cli/src/llm/catalog-codec.ts`):

```ts
import type { ClaudeCatalog, ClaudeModelInfo, EffortLevel } from "./claude-types";
import type { CursorCatalog, CursorModelInfo, CursorParamSelection } from "./cursor-types";
import { OPTIMIZE_FOR_ID, ROUTER_MODEL_ID } from "./cursor-types";

export const INVALID_PROVIDER_MODEL = (model: string, provider: string) =>
  `modelId "${model}" does not belong to provider ${provider}`;

export const INVALID_PROVIDER_PARAM = (
  id: string,
  value: string,
  model: string,
) => `param "${id}=${value}" is not valid for model ${model}`;

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function parseClaudeModels(raw: unknown): ClaudeModelInfo[] {
  const root = asRecord(raw);
  const list = Array.isArray(raw) ? raw : asArray(root?.models);
  const out: ClaudeModelInfo[] = [];
  for (const item of list) {
    const m = asRecord(item);
    if (!m || typeof m.id !== "string" || !m.id) continue;
    const effortLevels = asArray(m.effortLevels).filter(
      (e): e is EffortLevel =>
        e === "none" ||
        e === "low" ||
        e === "medium" ||
        e === "high" ||
        e === "xhigh" ||
        e === "max",
    );
    out.push({
      id: m.id,
      label: typeof m.label === "string" ? m.label : m.id,
      inputPricePerMTok: Number(m.inputPricePerMTok) || 0,
      outputPricePerMTok: Number(m.outputPricePerMTok) || 0,
      effortLevels,
    });
  }
  return out;
}

export function parseCursorModels(raw: unknown): CursorModelInfo[] {
  const root = asRecord(raw);
  const list = Array.isArray(raw) ? raw : asArray(root?.models);
  const out: CursorModelInfo[] = [];
  for (const item of list) {
    const m = asRecord(item);
    if (!m || typeof m.id !== "string" || !m.id) continue;
    const parameters = asArray(m.parameters).flatMap((p) => {
      const pr = asRecord(p);
      if (!pr || typeof pr.id !== "string") return [];
      return [
        {
          id: pr.id,
          displayName:
            typeof pr.displayName === "string" ? pr.displayName : undefined,
          values: asArray(pr.values).flatMap((v) => {
            const vr = asRecord(v);
            if (!vr || typeof vr.value !== "string") return [];
            return [
              {
                value: vr.value,
                displayName:
                  typeof vr.displayName === "string"
                    ? vr.displayName
                    : undefined,
              },
            ];
          }),
        },
      ];
    });
    const variants = asArray(m.variants).flatMap((v) => {
      const vr = asRecord(v);
      if (!vr || typeof vr.displayName !== "string") return [];
      const params: CursorParamSelection[] = asArray(vr.params).flatMap((p) => {
        const pr = asRecord(p);
        if (!pr || typeof pr.id !== "string" || typeof pr.value !== "string") {
          return [];
        }
        return [{ id: pr.id, value: pr.value }];
      });
      return [
        {
          params,
          displayName: vr.displayName,
          description:
            typeof vr.description === "string" ? vr.description : undefined,
          isDefault: vr.isDefault === true,
        },
      ];
    });
    out.push({
      id: m.id,
      displayName:
        typeof m.displayName === "string"
          ? m.displayName
          : typeof m.label === "string"
            ? m.label
            : m.id,
      description: typeof m.description === "string" ? m.description : undefined,
      aliases: asArray(m.aliases).filter((a): a is string => typeof a === "string"),
      parameters: parameters.length ? parameters : undefined,
      variants: variants.length ? variants : undefined,
    });
  }
  return out;
}

export function wrapClaudeRaw(models: ClaudeModelInfo[]): unknown {
  return { provider: "claude", models };
}

export function wrapCursorRaw(models: unknown): unknown {
  return { provider: "cursor", models };
}

export function findClaudeModel(
  catalog: ClaudeCatalog,
  modelId: string,
): ClaudeModelInfo | undefined {
  return catalog.models.find((m) => m.id === modelId);
}

export function findCursorModel(
  catalog: CursorCatalog,
  modelId: string,
): CursorModelInfo | undefined {
  return catalog.models.find(
    (m) => m.id === modelId || m.aliases?.includes(modelId),
  );
}

export function hasCursorRouter(catalog: CursorCatalog): boolean {
  const m = findCursorModel(catalog, ROUTER_MODEL_ID);
  return Boolean(
    m?.parameters?.some(
      (p) => p.id === OPTIMIZE_FOR_ID && p.values.length > 0,
    ),
  );
}

export function defaultCursorParams(
  model: CursorModelInfo,
): CursorParamSelection[] {
  const defVariant = model.variants?.find((v) => v.isDefault);
  if (defVariant?.params?.length) return defVariant.params.map((p) => ({ ...p }));
  const params: CursorParamSelection[] = [];
  for (const p of model.parameters ?? []) {
    if (p.id === OPTIMIZE_FOR_ID) {
      const balanced = p.values.find((v) => v.value === "balanced");
      params.push({
        id: p.id,
        value: balanced?.value ?? p.values[0]!.value,
      });
      continue;
    }
    if (p.values[0]) params.push({ id: p.id, value: p.values[0].value });
  }
  return params;
}

export function paramAllowed(
  model: CursorModelInfo,
  sel: CursorParamSelection,
): boolean {
  const def = model.parameters?.find((p) => p.id === sel.id);
  if (!def) return false;
  return def.values.some((v) => v.value === sel.value);
}

export function clampCursorParams(
  model: CursorModelInfo,
  params: CursorParamSelection[] | null | undefined,
): CursorParamSelection[] {
  const next = (params ?? []).filter((p) => paramAllowed(model, p));
  const have = new Set(next.map((p) => p.id));
  for (const d of defaultCursorParams(model)) {
    if (!have.has(d.id)) next.push(d);
  }
  return next;
}
```

El crudo se guarda **tal cual** llegó (Task 2). El codec **extrae** campos conocidos; no borra el crudo.

- [ ] Tests en `api/src/llm/catalog-codec.test.ts` **y** `cli/src/llm/catalog-codec.test.ts` (mismos casos):

  1. Claude fixture `{ models: [{ id: "claude-sonnet-4-6", label: "Sonnet 4.6", inputPricePerMTok: 3, outputPricePerMTok: 15, effortLevels: ["none","low","medium","high","xhigh","max"] }] }` → `parseClaudeModels` conserva `effortLevels` y precios.
  2. Cursor fixture con `auto-smart` + `parameters: [{ id: "optimize_for", values: [{value:"cost"},{value:"balanced"},{value:"intelligence"}] }]` → `hasCursorRouter === true`.
  3. Cursor fixture **sin** `auto-smart` → `hasCursorRouter === false` (no inventar Router).
  4. Cursor fixture `composer-2.5` + `parameters: [{ id: "fast", values: [{value:"false"},{value:"true", displayName:"Fast"}] }]` → `defaultCursorParams` incluye `fast`.
  5. Campo extra en el item (`"mystery": true`) **no** aparece en el type parseado, pero el test de persistencia (Task 2) comprueba que el crudo lo conserva. Aquí: `parseCursorModels` no tira el modelo por el extra.
  6. `clampCursorParams` tira `optimize_for=default` (valor legacy no listado) y deja `balanced` si existe.
  7. `INVALID_PROVIDER_MODEL("claude-sonnet-4-6", "cursor")` contiene ambos tokens.

```bash
cd api && bun test src/llm/catalog-codec.test.ts
cd cli && bun test src/llm/catalog-codec.test.ts
```

- [ ] En `api/src/llm/catalog.ts` y `cli/src/llm/catalog.ts`:

  1. Mover `CLAUDE_MODELS` / `EffortLevel` a importar desde `./claude-types` (reexportar `EffortLevel` para no romper TUI/scripts).
  2. **Eliminar** `CURSOR_MODELS` stub (`"Composer 2.5 (stub)"`) y el entry `runnable: false` de `PROVIDER_CATALOGS`.
  3. Dejar `PROVIDER_CATALOGS` solo como labels estáticos **sin** models Cursor inventados:

```ts
export const PROVIDER_LABELS: Record<"claude" | "cursor", string> = {
  claude: "Claude (Anthropic)",
  cursor: "Cursor",
};
```

  4. `getCatalog` / `getModel` / `defaultModelId` / `defaultEffort` de Claude **siguen** usando `CLAUDE_MODELS`. Añadir `defaultClaudeModelId()` = primer id de `CLAUDE_MODELS`. **No** devolver un modelId Cursor hardcodeado.

- [ ] Commit:

```bash
git add api/src/llm/claude-types.ts api/src/llm/cursor-types.ts api/src/llm/catalog-codec.ts api/src/llm/catalog-codec.test.ts api/src/llm/catalog.ts api/package.json cli/src/llm/claude-types.ts cli/src/llm/cursor-types.ts cli/src/llm/catalog-codec.ts cli/src/llm/catalog-codec.test.ts cli/src/llm/catalog.ts cli/package.json
git commit -m "feat(cursor): native catalog types for Claude and Cursor"
```

---

## Task 2: Persistencia del JSON crudo + discovery Cursor

**Files:**

- Modify: `api/src/db/schema.ts`
- Create: `api/drizzle/0002_cursor_provider_catalogs.sql`
- Create: `api/src/llm/cursor-discover.ts`
- Test: `api/src/llm/cursor-discover.test.ts`
- Modify: `api/src/routes/providers.ts`
- Modify: `api/package.json`
- Modify: `api/scripts/e2e-phase1.ts`

La API es la fuente de verdad del catálogo. GET `/providers` (con sesión) refresca si el cache tiene más de `CATALOG_TTL_MS` o no existe.

- [ ] En `api/src/db/schema.ts`, añadir tabla y columna:

```ts
export const userPreferences = pgTable("user_preferences", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  activeProvider: text("active_provider"),
  activeModel: text("active_model"),
  activeEffort: text("active_effort"),
  activeParams: jsonb("active_params").$type<
    Array<{ id: string; value: string }>
  >(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const providerCatalogs = pgTable(
  "provider_catalogs",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(), // claude | cursor
    rawJson: jsonb("raw_json").notNull().$type<unknown>(),
    fetchedAt: timestamp("fetched_at").notNull().defaultNow(),
    lastError: text("last_error"),
  },
  (table) => [
    uniqueIndex("provider_catalogs_user_provider_uidx").on(
      table.userId,
      table.provider,
    ),
  ],
);
```

Si el plan 3 ya añadió `activeExecutionMode` a `userPreferences`, **dejarlo**. Añadir `activeParams` al lado. No borrar columnas.

- [ ] Crear `api/drizzle/0002_cursor_provider_catalogs.sql`:

```sql
ALTER TABLE "user_preferences"
  ADD COLUMN IF NOT EXISTS "active_params" jsonb;

CREATE TABLE IF NOT EXISTS "provider_catalogs" (
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "provider" text NOT NULL,
  "raw_json" jsonb NOT NULL,
  "fetched_at" timestamp NOT NULL DEFAULT now(),
  "last_error" text,
  CONSTRAINT "provider_catalogs_user_provider_uidx" UNIQUE ("user_id", "provider")
);
```

- [ ] Aplicar:

```bash
cd api && bun run db:push
```

Si `DATABASE_URL` no está, fallar con el error de drizzle. No editar `docker-compose.yml`.

- [ ] Añadir dependencia en `api/package.json`:

```bash
cd api && bun add @cursor/sdk
```

No pinnear una versión inventada: la que resuelva bun. El API **solo** importa `Cursor` (catalog). No importar `Agent` en `api/` (el runner es del daemon).

- [ ] Crear `api/src/llm/cursor-discover.ts`:

```ts
import { Cursor } from "@cursor/sdk";
import { wrapCursorRaw } from "./catalog-codec";

export const CATALOG_TTL_MS = 300_000;

export async function fetchCursorModelsRaw(apiKey: string): Promise<unknown> {
  const models = await Cursor.models.list({ apiKey });
  return wrapCursorRaw(models);
}

export function catalogIsFresh(fetchedAt: Date, now = new Date()): boolean {
  return now.getTime() - fetchedAt.getTime() < CATALOG_TTL_MS;
}
```

- [ ] Test `api/src/llm/cursor-discover.test.ts`:

  1. Mockear `Cursor.models.list` para devolver `[{ id: "composer-2.5", displayName: "Composer 2.5", mystery: true, parameters: [{ id: "fast", values: [{ value: "false" }, { value: "true" }] }] }]`. `fetchCursorModelsRaw` envuelve `{ provider: "cursor", models }` y el item **conserva** `mystery` (crudo = lo que devolvió el SDK, no el parseado).
  2. Mock que tira `new Error("Invalid API key")` → la función **propaga**; el caller (ruta) no debe borrar credenciales.
  3. `catalogIsFresh(new Date(now - 1000)) === true`; `catalogIsFresh(new Date(now - 301_000)) === false`.

Para el mock, no pegarse a internals del paquete. Patrón:

```ts
import { mock } from "bun:test";

mock.module("@cursor/sdk", () => ({
  Cursor: {
    models: {
      list: async () => [
        { id: "composer-2.5", displayName: "Composer 2.5", mystery: true },
      ],
    },
  },
}));
```

Si `mock.module` no intercepta el import ya evaluado, extraer el call a `listCursorModels(apiKey)` inyectable:

```ts
export type CursorListFn = (apiKey: string) => Promise<unknown[]>;

export async function fetchCursorModelsRaw(
  apiKey: string,
  listFn: CursorListFn = defaultList,
): Promise<unknown> {
  const models = await listFn(apiKey);
  return wrapCursorRaw(models);
}

async function defaultList(apiKey: string): Promise<unknown[]> {
  const { Cursor } = await import("@cursor/sdk");
  return Cursor.models.list({ apiKey }) as Promise<unknown[]>;
}
```

Los tests inyectan `listFn`. Production usa el default.

- [ ] En `api/src/routes/providers.ts`:

  1. Importar `providerCatalogs`, `decryptSecret`, `CLAUDE_MODELS` (desde catalog), `wrapClaudeRaw`, `parseClaudeModels`, `parseCursorModels`, `fetchCursorModelsRaw`, `catalogIsFresh`, `PROVIDER_LABELS`.
  2. Helper `upsertCatalog(userId, provider, rawJson, lastError: string | null)`.
  3. Helper `loadCatalogRow(userId, provider)`.
  4. `async function refreshClaudeCatalog(userId: string)`: `raw = wrapClaudeRaw(CLAUDE_MODELS)`; upsert con `lastError: null`. Claude es estático: siempre se puede recolectar. Aun así se **persiste** el JSON crudo.
  5. `async function refreshCursorCatalog(userId: string, apiKey: string, force: boolean)`:
     - Si hay fila fresh y `!force`, no llamar a Cursor.
     - Try `fetchCursorModelsRaw(apiKey)`. Success → upsert raw, `lastError: null`.
     - Catch → si hay fila previa, `update lastError = message` **sin** tocar `raw_json`. Si no hay fila, upsert **no**: no hay raw que guardar; devolver `{ raw: null, lastError }`. **No** borrar `provider_credentials`.
  6. GET `/` (lista):
     - 401 si no hay sesión (ya).
     - Para cada provider en `["claude","cursor"]`:
       - `linked` = hay fila de credenciales.
       - Si `claude` linked → `refreshClaudeCatalog`.
       - Si `cursor` linked → decrypt secret, `refreshCursorCatalog` (no loguear secret; no incluirlo en el JSON de respuesta).
       - Parsear `raw_json` con el codec de **ese** provider.
       - `runnable`:
         - claude: `linked && parseClaudeModels(raw).length > 0`
         - cursor: `linked && parseCursorModels(raw).length > 0`
         - Si cursor linked, discovery falló y **no** hay raw → `runnable: false`, `catalogError: lastError`. **No** inyectar stub.
     - Respuesta:

```ts
return c.json({
  activeProvider: prefs[0]?.activeProvider ?? null,
  activeModel: prefs[0]?.activeModel ?? null,
  activeEffort: prefs[0]?.activeEffort ?? null,
  activeParams: prefs[0]?.activeParams ?? null,
  catalogs: [
    {
      id: "claude",
      label: PROVIDER_LABELS.claude,
      runnable: claudeRunnable,
      raw: claudeRaw,
      models: parseClaudeModels(claudeRaw),
      catalogError: claudeErr,
    },
    {
      id: "cursor",
      label: PROVIDER_LABELS.cursor,
      runnable: cursorRunnable,
      raw: cursorRaw,
      models: parseCursorModels(cursorRaw),
      catalogError: cursorErr,
    },
  ],
  providers: {
    claude: {
      linked: claudeLinked,
      authKind: claudeRow?.authKind,
      updatedAt: claudeRow?.updatedAt,
      label: PROVIDER_LABELS.claude,
      runnable: claudeRunnable,
      models: parseClaudeModels(claudeRaw),
      catalogError: claudeErr,
    },
    cursor: { /* análogo; models = parseCursorModels */ },
  },
});
```

     `models` de cada provider es el array **nativo**. Claude items tienen `effortLevels`; Cursor items tienen `parameters` / `variants` / `displayName`. No convertir Cursor a `effortLevels`.
  7. Tras `PUT /:provider/credentials` exitoso, si `providerParam === "cursor"`, llamar `refreshCursorCatalog(userId, secret, true)` **después** de guardar. Si falla, la respuesta del PUT sigue `{ ok: true, provider, authKind }` — la key ya está. GET posterior muestra `catalogError`.
  8. `DELETE /:provider/credentials` **no** borra la fila de Claude ni sus catalogs. Puede dejar `provider_catalogs` de Cursor (no es secreto). `runnable` pasará a false porque `linked` es false.
  9. GET `/` y GET `/:provider/credentials` **nunca** meten `secret` en logs (`console.log`, `console.error`). El decrypt de GET credentials sigue existiendo (reveal explícito).

- [ ] Query `?refresh=1` en GET `/providers` fuerza `refreshCursorCatalog(..., true)`.

- [ ] En `api/scripts/e2e-phase1.ts`, tras PUT `cursor-test-key` y GET `/providers`:

```ts
if (!listJson.providers.cursor.linked) throw new Error("cursor should be linked");
if (listJson.providers.cursor.runnable === true && !(listJson.providers.cursor.models?.length > 0)) {
  throw new Error("runnable without real models");
}
if (JSON.stringify(listJson).includes("cursor-test-key")) {
  throw new Error("secret leaked in GET /providers");
}
```

La key de test **no** es válida: `runnable` debe ser `false` (discovery falla, sin cache real). El PUT no debe haberse revertido.

```bash
cd api && bun test src/llm/cursor-discover.test.ts
```

- [ ] Commit:

```bash
git add api/src/db/schema.ts api/drizzle/0002_cursor_provider_catalogs.sql api/src/llm/cursor-discover.ts api/src/llm/cursor-discover.test.ts api/src/routes/providers.ts api/package.json api/scripts/e2e-phase1.ts bun.lock
git commit -m "feat(cursor): persist raw catalogs and discover Cursor models"
```

---

## Task 3: Preferencias — rechazo de pares imposibles + params Cursor

**Files:**

- Create: `api/src/llm/prefs-validate.ts`
- Test: `api/src/llm/prefs-validate.test.ts`
- Modify: `api/src/routes/providers.ts`
- Modify: `api/openapi/openapi.yaml`

- [ ] Crear `api/src/llm/prefs-validate.ts`:

```ts
import {
  INVALID_PROVIDER_MODEL,
  INVALID_PROVIDER_PARAM,
  clampCursorParams,
  findClaudeModel,
  findCursorModel,
} from "./catalog-codec";
import type { ClaudeCatalog, EffortLevel } from "./claude-types";
import type { CursorCatalog, CursorParamSelection } from "./cursor-types";

export type PrefsPatch = {
  activeProvider?: string | null;
  activeModel?: string | null;
  activeEffort?: string | null;
  activeParams?: CursorParamSelection[] | null;
};

export type ValidatedPrefs = {
  activeProvider: "claude" | "cursor" | null;
  activeModel: string | null;
  activeEffort: string | null;
  activeParams: CursorParamSelection[] | null;
};

const EFFORTS = new Set<EffortLevel>([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export function validatePreferences(
  patch: PrefsPatch,
  current: ValidatedPrefs,
  catalogs: { claude: ClaudeCatalog; cursor: CursorCatalog },
): ValidatedPrefs {
  const provider = (patch.activeProvider !== undefined
    ? patch.activeProvider
    : current.activeProvider) as ValidatedPrefs["activeProvider"];

  if (provider !== null && provider !== "claude" && provider !== "cursor") {
    throw new Error("provider must be claude or cursor");
  }

  let model =
    patch.activeModel !== undefined ? patch.activeModel : current.activeModel;
  let effort =
    patch.activeEffort !== undefined ? patch.activeEffort : current.activeEffort;
  let params =
    patch.activeParams !== undefined ? patch.activeParams : current.activeParams;

  if (provider === "claude") {
    if (model) {
      const m = findClaudeModel(catalogs.claude, model);
      if (!m) throw new Error(INVALID_PROVIDER_MODEL(model, "claude"));
      if (effort && !m.effortLevels.includes(effort as EffortLevel)) {
        effort = m.effortLevels.includes("medium")
          ? "medium"
          : (m.effortLevels[0] ?? "none");
      }
    }
    params = null;
  }

  if (provider === "cursor") {
    if (model) {
      const m = findCursorModel(catalogs.cursor, model);
      if (!m) throw new Error(INVALID_PROVIDER_MODEL(model, "cursor"));
      const clamped = clampCursorParams(m, params ?? []);
      for (const p of params ?? []) {
        if (!m.parameters?.some((d) => d.id === p.id && d.values.some((v) => v.value === p.value))) {
          throw new Error(INVALID_PROVIDER_PARAM(p.id, p.value, model));
        }
      }
      params = clamped;
    }
    if (effort && !EFFORTS.has(effort as EffortLevel)) {
      effort = null;
    }
  }

  return {
    activeProvider: provider,
    activeModel: model,
    activeEffort: effort,
    activeParams: params,
  };
}

export function defaultsForProvider(
  provider: "claude" | "cursor",
  catalogs: { claude: ClaudeCatalog; cursor: CursorCatalog },
): Pick<ValidatedPrefs, "activeModel" | "activeEffort" | "activeParams"> {
  if (provider === "claude") {
    const m = catalogs.claude.models[0];
    return {
      activeModel: m?.id ?? null,
      activeEffort: m?.effortLevels.includes("medium")
        ? "medium"
        : (m?.effortLevels[0] ?? "none"),
      activeParams: null,
    };
  }
  const m = catalogs.cursor.models[0];
  return {
    activeModel: m?.id ?? null,
    activeEffort: null,
    activeParams: m ? clampCursorParams(m, []) : null,
  };
}
```

Ajuste: `validatePreferences` para Cursor **rechaza** params no listados (400), no los traga en silencio. `clampCursorParams` se usa en `defaultsForProvider` y en `PUT /active` (corrección **explícita** al cambiar de provider). PUT `/preferences` con param inválido → throw `INVALID_PROVIDER_PARAM`.

- [ ] Tests `api/src/llm/prefs-validate.test.ts`:

  1. `activeProvider=cursor` + `activeModel=claude-sonnet-4-6` → throw que incluye `claude-sonnet-4-6` y `cursor`.
  2. `activeProvider=claude` + `activeModel=composer-2.5` → throw que incluye ambos.
  3. Cursor + `auto-smart` + `{ id: "optimize_for", value: "balanced" }` con Router en catálogo → ok.
  4. Cursor + `auto-smart` + `optimize_for=default` cuando el catálogo solo tiene cost/balanced/intelligence → throw `INVALID_PROVIDER_PARAM`.
  5. Cursor **sin** `auto-smart` en catálogo + modelId `auto-smart` → throw `INVALID_PROVIDER_MODEL`.
  6. `defaultsForProvider("cursor")` no devuelve un id Claude.

```bash
cd api && bun test src/llm/prefs-validate.test.ts
```

- [ ] En `api/src/routes/providers.ts`:

  1. Ampliar `upsertPrefs` con `activeParams`.
  2. Helper `loadCatalogsForUser(userId)` que lee `provider_catalogs` (sin forzar refresh; GET ya refresca) y arma `{ claude, cursor }`. Si Cursor no tiene raw, `models: []`.
  3. PUT `/preferences`:
     - Body acepta `activeProvider`, `activeModel`, `activeEffort`, `activeParams`.
     - Cargar current + catalogs.
     - `try { validated = validatePreferences(body, current, catalogs) } catch (e) { return c.json({ error: message }, 400); }`
     - Persistir los cuatro campos validados.
     - Responder los cuatro (más `activeExecutionMode` si la columna existe).
  4. PUT `/active`:
     - Si `provider` es `claude` o `cursor`, `defaults = defaultsForProvider(provider, catalogs)`.
     - `upsertPrefs({ activeProvider: provider, ...defaults })`.
     - Responder `{ activeProvider, activeModel, activeEffort, activeParams }`.
     - Esto **corrige de forma explícita** un modelId huérfano al cambiar de provider (el cliente pidió “set cursor”, no “set cursor + modelo Claude”).
  5. Si `activeParams` no es array ni null → 400 `"activeParams must be an array of {id,value}"`.

- [ ] OpenAPI `api/openapi/openapi.yaml`:

  1. Schema `CursorParamSelection`: `{ id: string, value: string }`.
  2. Schema `CursorModelInfo`: `id`, `displayName`, `description`, `aliases`, `parameters`, `variants` (additionalProperties: true en el item para no mentir sobre extras; el crudo vive en `raw`).
  3. `ProviderCatalog.models` no puede ser un único `ModelInfo`. Usar:

```yaml
models:
  type: array
  items: {}
raw: {}
catalogError:
  type: string
  nullable: true
```

     Documentar en `description` que Claude deserializa a `ModelInfo` (effortLevels) y Cursor a `CursorModelInfo`.
  4. `ProvidersListResponse` + `ProviderPreferences` + `ProviderPreferencesBody`: añadir `activeParams` (array nullable) y `catalogError` en `ProviderStatus`.
  5. Si `activeExecutionMode` ya está en el yaml (plan 3), no quitarlo.

- [ ] Commit:

```bash
git add api/src/llm/prefs-validate.ts api/src/llm/prefs-validate.test.ts api/src/routes/providers.ts api/openapi/openapi.yaml
git commit -m "feat(cursor): reject mismatched provider/model prefs"
```

---

## Task 4: Runner local Cursor (`@cursor/sdk`)

**Files:**

- Modify: `cli/package.json`
- Create: `cli/src/llm/cursor-errors.ts`
- Create: `cli/src/llm/cursor-tools.ts`
- Test: `cli/src/llm/cursor-tools.test.ts`
- Create: `cli/src/llm/cursor-runner.ts`
- Test: `cli/src/llm/cursor-runner.test.ts`

El runner **nunca** pasa `cloud`. History entra por `promptWithHistory`. Store JSONL en tmp para no contaminar el repo del usuario y para que Bun no exija `node:sqlite`.

- [ ] Instalar SDK en CLI:

```bash
cd cli && bun add @cursor/sdk
```

- [ ] Crear `cli/src/llm/cursor-errors.ts`:

```ts
export const CURSOR_UNLINKED =
  "Cursor no está vinculado — chavez provider link cursor (o Web /providers)";
export const CURSOR_AUTH_ERROR =
  "Cursor authentication failed — re-link: chavez provider link cursor (o Web /providers)";
export const CURSOR_NOT_RUNNABLE =
  "Cursor no es ejecutable (catálogo no disponible). Reintenta o re-vincula.";

export function cursorModelUnavailable(id: string): string {
  return `Model "${id}" is not available for this Cursor account. Choose another from the discovered catalog.`;
}

export function classifyCursorError(err: unknown, modelId: string): Error {
  const msg = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : "";
  const code =
    err && typeof err === "object" && "code" in err
      ? String((err as { code?: string }).code || "")
      : "";
  const lower = msg.toLowerCase();
  if (
    name === "AuthenticationError" ||
    code === "unauthenticated" ||
    lower.includes("invalid api key") ||
    lower.includes("unauthorized") ||
    lower.includes("authentication")
  ) {
    return new Error(CURSOR_AUTH_ERROR);
  }
  if (
    name === "ConfigurationError" ||
    lower.includes("bad model") ||
    lower.includes("unknown model") ||
    lower.includes("model") && (lower.includes("not available") || lower.includes("not found"))
  ) {
    return new Error(cursorModelUnavailable(modelId));
  }
  return err instanceof Error ? err : new Error(msg);
}
```

- [ ] Crear `cli/src/llm/cursor-tools.ts`. Si `cli/src/llm/tool-names.ts` existe y exporta `canonicalToolName`, importarlo y **añadir** ahí:

```ts
const CURSOR_ALIASES: Record<string, string> = {
  read: "read",
  write: "write",
  edit: "edit",
  grep: "grep",
  glob: "glob",
  ls: "glob",
  shell: "bash",
  bash: "bash",
};
```

Si `tool-names.ts` no existe, `canonicalCursorToolName(name: string)` en este archivo con la tabla de constantes (Read/read → read, shell → bash, etc.).

```ts
export const DEFAULT_CURSOR_TOOLS = [
  "read",
  "edit",
  "write",
  "grep",
  "glob",
  "ls",
  "shell",
] as const;

export function canonicalCursorToolName(name: string): string {
  const lower = name.toLowerCase();
  if (lower === "ls") return "glob";
  if (lower === "shell" || lower === "bash") return "bash";
  if (lower === "notebookedit") return "edit";
  return lower;
}

export function stringifyToolPayload(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
```

- [ ] Test `cli/src/llm/cursor-tools.test.ts`: `shell` → `bash`, `ls` → `glob`, `Read` → `read`, `edit` → `edit`.

- [ ] Crear `cli/src/llm/cursor-runner.ts`:

```ts
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, JsonlLocalAgentStore } from "@cursor/sdk";
import type { AgentTurnEvent } from "./claude-runner";
import { promptWithHistory, type HistoryMessage } from "./history";
import { classifyCursorError } from "./cursor-errors";
import {
  DEFAULT_CURSOR_TOOLS,
  canonicalCursorToolName,
  stringifyToolPayload,
} from "./cursor-tools";
import type { CursorParamSelection } from "./cursor-types";

export type CursorAuth = { authKind: "api_key"; secret: string };

export type RunCursorTurnInput = {
  prompt: string;
  history?: HistoryMessage[];
  model: string;
  params?: CursorParamSelection[] | null;
  auth: CursorAuth;
  cwd: string;
  onEvent?: (event: AgentTurnEvent) => void | Promise<void>;
  signal?: AbortSignal;
};

export type CursorRunHandle = {
  cancel: () => Promise<void>;
};

function storeDir(cwd: string): string {
  const slug = Buffer.from(cwd).toString("hex").slice(0, 24);
  const dir = join(tmpdir(), "chavez-cursor", slug);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function assistantText(event: {
  message?: { content?: Array<{ type?: string; text?: string }> };
}): string {
  const blocks = event.message?.content ?? [];
  let out = "";
  for (const b of blocks) {
    if (b.type === "text" && b.text) out += b.text;
  }
  return out;
}

export async function runCursorTurn(
  input: RunCursorTurnInput,
): Promise<string> {
  const prompt = promptWithHistory(input.prompt, input.history ?? []);
  const store = new JsonlLocalAgentStore(storeDir(input.cwd));

  const modelSel = {
    id: input.model,
    params: (input.params ?? []).map((p) => ({ id: p.id, value: p.value })),
  };

  let agent: Awaited<ReturnType<typeof Agent.create>> | null = null;
  let run: Awaited<ReturnType<NonNullable<typeof agent>["send"]>> | null = null;

  const onAbort = () => {
    void run?.cancel();
  };
  input.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    agent = await Agent.create({
      apiKey: input.auth.secret,
      model: modelSel,
      tools: [...DEFAULT_CURSOR_TOOLS],
      local: { cwd: input.cwd, store },
    });
    // Nunca pasar `cloud`. Nunca `repos` / `autoCreatePR`.

    run = await agent.send(prompt, {
      model: modelSel,
      onDelta: async ({ update }) => {
        if (update.type === "text-delta" && update.text) {
          await input.onEvent?.({ kind: "stream_delta", text: update.text });
        }
      },
    });

    if (input.signal?.aborted) {
      await run.cancel();
    }

    for await (const event of run.stream()) {
      if (input.signal?.aborted) {
        await run.cancel();
        break;
      }
      if (event.type === "assistant") {
        const text = assistantText(event);
        if (text) await input.onEvent?.({ kind: "stream_delta", text });
      }
      if (event.type === "tool_call") {
        const toolName = canonicalCursorToolName(String(event.name || "tool"));
        const toolCallId = String(event.call_id || crypto.randomUUID());
        if (event.status === "running") {
          await input.onEvent?.({
            kind: "tool_start",
            toolCallId,
            toolName,
            input: event.args,
          });
        } else {
          await input.onEvent?.({
            kind: "tool_result",
            toolCallId,
            toolName,
            output: stringifyToolPayload(event.result),
            status: event.status === "error" ? "error" : "done",
          });
        }
      }
    }

    const result = await run.wait();
    if (result.status === "cancelled") {
      throw new Error("Turn cancelled");
    }
    if (result.status === "error") {
      throw classifyCursorError(
        new Error(result.error?.message || "Cursor run error"),
        input.model,
      );
    }
    const text = result.result ?? "";
    await input.onEvent?.({ kind: "result", text });
    return text;
  } catch (err) {
    if (input.signal?.aborted) throw new Error("Turn cancelled");
    throw classifyCursorError(err, input.model);
  } finally {
    input.signal?.removeEventListener("abort", onAbort);
    try {
      await agent?.[Symbol.asyncDispose]();
    } catch {
      agent?.close();
    }
  }
}
```

Si `AgentTurnEvent` no está exportado de `claude-runner.ts`, exportarlo (hoy ya lo está). No duplicar el union.

Si `execution-gate.ts` **existe**, registrar hooks del SDK (`preToolUse` / `beforeShellExecution`) que llamen `gateMutation` + `denyIfEscapes` **antes** de que el SDK toque el disco. Mapear `shell` → clase write, `read`/`grep`/`glob`/`ls` → read, `edit`/`write` → write. Si el gate no existe, no inventarlo: el default del SDK local ejecuta tools (paridad con Claude `bypassPermissions` pre-plan-3).

- [ ] Tests `cli/src/llm/cursor-runner.test.ts` con un fake Agent inyectable. Para no pelear con el paquete real, extraer la función pura `emitCursorEvent(event, onEvent)` a `cli/src/llm/cursor-events.ts` y testearla:

  1. `tool_call` `{ name: "shell", status: "running", call_id: "t1", args: { command: "ls" } }` → `tool_start` canónico `bash`.
  2. `tool_call` `{ name: "shell", status: "completed", call_id: "t1", result: { exitCode: 0 } }` → `tool_result` status `done`.
  3. `assistant` con text block → `stream_delta`.
  4. `classifyCursorError(Object.assign(new Error("Invalid API key"), { name: "AuthenticationError" }), "composer-2.5").message === CURSOR_AUTH_ERROR` y el mensaje **no** contiene la key.
  5. `classifyCursorError(Object.assign(new Error("Bad model name"), { name: "ConfigurationError" }), "nope-model")` incluye `nope-model` y “discovered catalog”.

Añadir un test de contrato del **input** de `Agent.create` con un mock:

```ts
const creates: unknown[] = [];
// inyectar factory
await runCursorTurn({ ..., createAgent: async (opts) => { creates.push(opts); return fakeAgent; }});
expect(creates[0]).not.toHaveProperty("cloud");
expect(creates[0].local.cwd).toBe("/tmp/ws");
```

Refactor mínimo: `runCursorTurn` acepta `createAgent?: typeof Agent.create` (default `Agent.create`). Los tests pasan fake. Production no pasa el arg.

El fake `send` devuelve `{ stream: async function* () {}, wait: async () => ({ status: "finished", result: "ok" }), cancel: async () => {} }`. `asyncDispose` no-op.

```bash
cd cli && bun test src/llm/cursor-tools.test.ts src/llm/cursor-runner.test.ts
```

- [ ] Commit:

```bash
git add cli/package.json cli/src/llm/cursor-errors.ts cli/src/llm/cursor-tools.ts cli/src/llm/cursor-tools.test.ts cli/src/llm/cursor-events.ts cli/src/llm/cursor-runner.ts cli/src/llm/cursor-runner.test.ts cli/src/llm/tool-names.ts bun.lock
git commit -m "feat(cursor): local Agent SDK runner with tool mapping"
```

(Incluir `tool-names.ts` solo si se modificó.)

---

## Task 5: `publishAgentTurn` despacha por provider activo

**Files:**

- Modify: `cli/src/llm/publish-turn.ts`
- Test: `cli/src/llm/publish-turn.test.ts`
- Modify: `tui/src/App.tsx`
- Modify: `cli/src/ws/daemon.ts`

- [ ] En `cli/src/llm/publish-turn.ts`:

  1. Ampliar `ProvidersResponse`:

```ts
type ProvidersResponse = {
  activeProvider: string | null;
  activeModel: string | null;
  activeEffort: string | null;
  activeParams?: Array<{ id: string; value: string }> | null;
  providers: Record<
    string,
    {
      linked?: boolean;
      runnable?: boolean;
      models?: unknown[];
      catalogError?: string | null;
    }
  >;
};
```

  2. Tras GET `/providers`, ramificar. **Eliminar** el throw `"solo claude"`.

```ts
import { runClaudeTurn } from "./claude-runner";
import { runCursorTurn } from "./cursor-runner";
import { CURSOR_UNLINKED, CURSOR_NOT_RUNNABLE } from "./cursor-errors";
import { defaultEffort, defaultModelId } from "./catalog";

const active = providers.activeProvider || "claude";

if (active === "claude") {
  if (!providers.providers?.claude?.linked) {
    throw new Error("Claude no está vinculado — chavez provider link claude");
  }
  const creds = await apiFetch<{ authKind: "oauth_token" | "api_key"; secret: string }>(
    "/providers/claude/credentials",
    {},
    token,
  );
  // model/effort como hoy; historyFromChatMessages como hoy
  // runClaudeTurn({ ... })  — NO fetch cursor credentials
} else if (active === "cursor") {
  if (!providers.providers?.cursor?.linked) {
    throw new Error(CURSOR_UNLINKED);
  }
  if (!providers.providers.cursor.runnable) {
    throw new Error(
      providers.providers.cursor.catalogError
        ? `${CURSOR_NOT_RUNNABLE} (${providers.providers.cursor.catalogError})`
        : CURSOR_NOT_RUNNABLE,
    );
  }
  const creds = await apiFetch<{ authKind: "api_key" | "oauth_token"; secret: string }>(
    "/providers/cursor/credentials",
    {},
    token,
  );
  const model = providers.activeModel;
  if (!model) {
    throw new Error(CURSOR_NOT_RUNNABLE);
  }
  await runCursorTurn({
    prompt,
    history,
    model,
    params: providers.activeParams ?? [],
    auth: { authKind: "api_key", secret: creds.secret },
    cwd,
    signal: input.signal,
    onEvent: /* mismos chat.stream.delta / chat.tool.start / chat.tool.result */,
  });
} else {
  throw new Error(
    `Provider activo "${active}" no ejecuta agente en daemon (claude|cursor)`,
  );
}
```

  3. Ampliar input con `signal?: AbortSignal` (Task 6 lo usa).
  4. `chat.append` del user **antes** de ramificar (como hoy). Metadata opcional `{ provider: active, model }` para la timeline; no romper clientes que ignoran metadata.
  5. El `onEvent` de tools debe publicar `toolName` **canónico** (Cursor ya sale canónico del runner; Claude: si `canonicalToolName` existe, usarlo; si no, `toLowerCase()`).
  6. No loguear `creds.secret`. No meterlo en `chat.append` metadata.

- [ ] Test `cli/src/llm/publish-turn.test.ts`: extraer `selectRunner(providers)` a `cli/src/llm/select-runner.ts` (puro) y testear:

```ts
export type RunnerKind = "claude" | "cursor";

export function selectRunner(p: {
  activeProvider: string | null;
  providers: Record<string, { linked?: boolean; runnable?: boolean; catalogError?: string | null }>;
}): { kind: RunnerKind } {
  const active = p.activeProvider || "claude";
  if (active === "claude") {
    if (!p.providers.claude?.linked) throw new Error("Claude no está vinculado — chavez provider link claude");
    return { kind: "claude" };
  }
  if (active === "cursor") {
    if (!p.providers.cursor?.linked) {
      throw new Error(
        "Cursor no está vinculado — chavez provider link cursor (o Web /providers)",
      );
    }
    if (!p.providers.cursor.runnable) {
      throw new Error("Cursor no es ejecutable (catálogo no disponible). Reintenta o re-vincula.");
    }
    return { kind: "cursor" };
  }
  throw new Error(`Provider activo "${active}" no ejecuta agente en daemon (claude|cursor)`);
}
```

Casos:

  1. `activeProvider: "claude"` + cursor linked → `kind: "claude"` (no “gasta” Cursor: el test solo afirma kind).
  2. `activeProvider: "cursor"` + no linked → mensaje `CURSOR_UNLINKED` (incluye `chavez provider link cursor` y `Web`).
  3. `activeProvider: "cursor"` + linked + `runnable: false` → `CURSOR_NOT_RUNNABLE`.
  4. `activeProvider: "cursor"` + linked + runnable → `kind: "cursor"`.

`publish-turn.ts` llama `selectRunner(providers)` **antes** de GET credentials.

- [ ] En `tui/src/App.tsx` `sendWithLlm`: **borrar** el branch

```ts
if (provider !== "claude") {
  // chat.append + "Cursor LLM aún no implementado"
}
```

Siempre `publishAgentTurn({ client, chatId, prompt: text, cwd, token })`. El log de thinking: `` `${provider} thinking (${modelId})…` ``.

El onPush de `agent.turn.dispatch` ya llama `publishAgentTurn` — con Task 5 el dispatch Web también corre Cursor.

- [ ] `cli/src/ws/daemon.ts` no cambia la firma salvo pasar `signal` en Task 6. En esta task, solo verificar que sigue llamando `publishAgentTurn` sin hardcodear claude.

```bash
cd cli && bun test src/llm/publish-turn.test.ts
```

- [ ] Commit:

```bash
git add cli/src/llm/publish-turn.ts cli/src/llm/select-runner.ts cli/src/llm/publish-turn.test.ts tui/src/App.tsx
git commit -m "feat(cursor): dispatch turns by active provider"
```

---

## Task 6: Cancelación de un turn Cursor en curso

**Files:**

- Create: `cli/src/llm/turn-control.ts`
- Test: `cli/src/llm/turn-control.test.ts`
- Modify: `cli/src/llm/publish-turn.ts`
- Modify: `cli/src/ws/daemon.ts`
- Modify: `cli/src/ws/client.ts`
- Modify: `api/src/ws/protocol.ts`
- Modify: `api/src/ws/handlers.ts`
- Modify: `api/src/ws/hub.ts`
- Modify: `tui/src/App.tsx`
- Modify: `cli/src/commands/headless.ts`
- Modify: `web/src/lib/ws-hooks.ts`
- Modify: `web/src/components/ChatDetailPanel.tsx`

Contrato:

```
client → agent.turn.cancel { chatId }
API   → si no hay daemon: fail NO_DAEMON_ERROR
      → si el daemon no tiene ese turn: ok { cancelled: false, reason: "No turn in progress" }
      → push agent.turn.cancel al daemon
daemon → abort() → run.cancel() → chat.stream.error o chat.stream.end con cancelled
       → turnBusy = false
```

- [ ] Crear `cli/src/llm/turn-control.ts`:

```ts
export type TurnController = {
  chatId: string;
  abort: AbortController;
};

let current: TurnController | null = null;

export function beginTurn(chatId: string): AbortSignal {
  current?.abort.abort();
  current = { chatId, abort: new AbortController() };
  return current.abort.signal;
}

export function endTurn(chatId: string): void {
  if (current?.chatId === chatId) current = null;
}

export function cancelTurn(chatId?: string): boolean {
  if (!current) return false;
  if (chatId && current.chatId !== chatId) return false;
  current.abort.abort();
  return true;
}

export function isTurnActive(chatId?: string): boolean {
  if (!current) return false;
  if (chatId) return current.chatId === chatId;
  return true;
}
```

- [ ] Test: `beginTurn("a")`; `cancelTurn("a") === true`; `cancelTurn("b") === false` si current es a; `endTurn` limpia.

- [ ] `publishAgentTurn`: `const signal = input.signal ?? beginTurn(chatId);` try/finally `endTurn(chatId)`. Pasar `signal` a `runCursorTurn`. Para Claude, si `query()` no acepta abort, al abortar se deja de publicar deltas y se manda `chat.stream.error` con `"Turn cancelled"`; no se cuelga `turnBusy` (el finally corre). Documentar en comentario que cancel de Claude es best-effort; Cursor es `run.cancel()`.

- [ ] `api/src/ws/protocol.ts` — `ClientMessage` ya es `{ type: string, chatId?: string, ... }`. No hace falta campo nuevo. Añadir el case.

- [ ] `api/src/ws/handlers.ts` case `"agent.turn.cancel"`:

```ts
case "agent.turn.cancel": {
  if (!msg.chatId) return fail(type, id, "chatId is required");
  const ctx = await workspaceIdForChat(msg.chatId, userId);
  if (!ctx) return fail(type, id, "Chat not found");
  const daemon = hub.findDaemon(userId, ctx.workspaceId);
  if (!daemon) {
    return fail(
      type,
      id,
      "No daemon bound for this workspace. Run: chavez headless workspace open",
    );
  }
  hub.sendTo(
    daemon.connectionId,
    hub.pushEvent("agent.turn.cancel", {
      chatId: msg.chatId,
      requestId: id,
    }),
  );
  return ok(type, id, { accepted: true });
}
```

- [ ] `cli/src/ws/daemon.ts` en el mismo `onPush`:

```ts
if (msg.type === "agent.turn.cancel") {
  const data = (msg.data || {}) as { chatId?: string };
  const okCancel = cancelTurn(data.chatId);
  log(`cancel chat=${data.chatId} ok=${okCancel}`);
  return;
}
```

Importar `cancelTurn` desde `../llm/turn-control`. En el branch `agent.turn.dispatch`, `publishAgentTurn` ya llama `beginTurn`.

Si `turnBusy` es true y llega otro dispatch, el fail de busy del plan 2 (si existe) se mantiene; si aún se ignora en silencio, **no** es el foco de esta task (plan 2/29). Cancel **sí** debe funcionar aunque el segundo dispatch se ignore.

- [ ] TUI `tui/src/App.tsx`:

  1. Importar `cancelTurn`.
  2. En onPush, si `msg.type === "agent.turn.cancel"` → `cancelTurn(data.chatId)`.
  3. Input: si `busy` y `key.escape` → `cancelTurn(activeChatId ?? undefined)` y `setLog("Cancelando turn…")`. **No** `exit()`. Si no busy, Escape sigue cerrando (comportamiento actual).
  4. `sendWithLlm` / dispatch: el `finally` ya baja `busy`.

- [ ] CLI `cli/src/commands/headless.ts` acción `chat cancel`:

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

Actualizar el usage string de `chat` para incluir `cancel`.

- [ ] Web `web/src/lib/ws-hooks.ts`:

```ts
export function useWsAgentCancel() {
  const ws = useWs();
  return useMutation({
    mutationFn: (chatId: string) =>
      ws.request({ type: "agent.turn.cancel", chatId }),
  });
}
```

- [ ] `web/src/components/ChatDetailPanel.tsx`: con `streaming === true`, botón “Cancelar turn” que llama `useWsAgentCancel`. Deshabilitado si no hay stream. No añadir UI de cloud.

- [ ] Tras cancel, el catch de `publishAgentTurn` ya hace `chat.stream.error` con el mensaje. Usar contenido `"Turn cancelled"` para que Web/TUI no muestren un 500. El chat acepta un turn nuevo porque `finally` limpia `turnBusy`.

```bash
cd cli && bun test src/llm/turn-control.test.ts
```

- [ ] Commit:

```bash
git add cli/src/llm/turn-control.ts cli/src/llm/turn-control.test.ts cli/src/llm/publish-turn.ts cli/src/ws/daemon.ts cli/src/ws/client.ts cli/src/commands/headless.ts api/src/ws/protocol.ts api/src/ws/handlers.ts tui/src/App.tsx web/src/lib/ws-hooks.ts web/src/components/ChatDetailPanel.tsx
git commit -m "feat(cursor): cancel in-flight Cursor runs"
```

---

## Task 7: CLI — list/status/whoami sin filtrar la key

**Files:**

- Modify: `cli/src/commands/provider.ts`
- Modify: `cli/src/commands/whoami.ts`
- Modify: `cli/src/index.ts`
- Test: `cli/src/commands/provider-format.test.ts`

El link/unlink/web **ya existen**. Esta task los deja de redactar secretos y muestra runnable + activo.

- [ ] Extraer el printer a `cli/src/commands/provider-format.ts` (testeable, sin I/O):

```ts
export function formatProviderList(data: {
  activeProvider: string | null;
  activeModel?: string | null;
  activeEffort?: string | null;
  activeParams?: Array<{ id: string; value: string }> | null;
  providers: Record<
    string,
    {
      linked: boolean;
      authKind?: string;
      runnable?: boolean;
      catalogError?: string | null;
      models?: unknown[];
    }
  >;
}): string {
  const params =
    data.activeParams?.map((p) => `${p.id}=${p.value}`).join(",") || "—";
  const lines = [
    `Active: ${data.activeProvider ?? "(none)"} / ${data.activeModel ?? "—"} / effort=${data.activeEffort ?? "—"} / params=${params}`,
  ];
  for (const [name, info] of Object.entries(data.providers)) {
    if (info.linked) {
      const run = info.runnable ? "runnable" : "not-runnable";
      const err = info.catalogError ? ` catalogError=${info.catalogError}` : "";
      const n = Array.isArray(info.models) ? info.models.length : 0;
      lines.push(
        `- ${name}: linked (${info.authKind}) ${run} models=${n}${err}`,
      );
    } else {
      lines.push(`- ${name}: not linked`);
    }
  }
  return lines.join("\n");
}

export function assertNoSecret(haystack: string, secret: string): void {
  if (secret && haystack.includes(secret)) {
    throw new Error("secret leaked");
  }
}
```

`provider list` y `provider status` imprimen `formatProviderList(data)`. **Nunca** piden GET credentials.

- [ ] Tests: fixture con `secret` que no debe aparecer; cursor linked + runnable + 2 models; cursor linked + `catalogError` + runnable false; active params `optimize_for=balanced`.

- [ ] `linkCursor` / `saveCredentials`: no `console.log` del secret. El prompt de `promptSecret` es stdin; no reimprimir. Tras link, `provider list` (opcional) o el mensaje actual `Vinculado cursor (api_key) en el vault de Chavez.`

- [ ] `unlink`: mensaje `Unlinked cursor`. Un turn posterior con activo cursor falla en el daemon con `CURSOR_UNLINKED` (Task 5). No tocar credenciales Claude.

- [ ] `whoami.ts` además de user/cwd/API:

```ts
const providers = await apiFetch<{
  activeProvider: string | null;
  activeModel: string | null;
  activeEffort: string | null;
  activeParams?: Array<{ id: string; value: string }> | null;
  providers: Record<string, { linked: boolean; runnable?: boolean; authKind?: string }>;
}>("/providers");
console.log(
  formatProviderList(providers),
);
```

Importar `formatProviderList`. Si GET `/providers` es 401, whoami ya falló antes por `/me` o lanza el mismo `ApiError`.

- [ ] `cli/src/index.ts` usage: no cambia flags. Añadir línea:

```
  chavez provider list|status          # linked, runnable, activo (sin secrets)
```

```bash
cd cli && bun test src/commands/provider-format.test.ts
```

- [ ] Commit:

```bash
git add cli/src/commands/provider.ts cli/src/commands/provider-format.ts cli/src/commands/provider-format.test.ts cli/src/commands/whoami.ts cli/src/index.ts
git commit -m "feat(cursor): CLI list/status/whoami show runnable without leaking keys"
```

---

## Task 8: TUI — runnable, params nativos, compose dispara Cursor

**Files:**

- Modify: `tui/src/App.tsx`

- [ ] Types locales: dejar de asumir `ModelInfo` Claude para Cursor. El GET ya trae models nativos:

```ts
type CursorParam = { id: string; value: string };
type AnyModel = {
  id: string;
  label?: string;
  displayName?: string;
  effortLevels?: string[];
  parameters?: Array<{
    id: string;
    displayName?: string;
    values: Array<{ value: string; displayName?: string }>;
  }>;
};
```

`providerMeta.models` se castea a `AnyModel[]`. Label: `m.displayName ?? m.label ?? m.id`.

- [ ] Al cargar `/providers`:
  - Si `activeProvider === "cursor"` y el `activeModel` **no** está en `providers.cursor.models`, recortar al primer modelo Cursor y `persistPrefs` (defensa; la API de Task 3 ya rechaza el par).
  - No caer al default `claude-sonnet-4-6` cuando el provider es cursor (hoy `defaultModelId(nextProvider) || … || "claude-sonnet-4-6"`). Usar solo models del provider activo.

- [ ] Tecla `p`: igual, cicla linked. Al pasar a cursor, `activeModel` = primer modelo Cursor; `activeParams` = `clamp` local (primer valor de cada parameter; `optimize_for` → `balanced` si existe). `persistPrefs({ activeProvider, activeModel, activeEffort: null, activeParams })`.

- [ ] Teclas `[` / `]`: ciclan `models` del provider activo (ya). Tras cambiar, recortar params/effort a lo que el modelo soporta y persistir.

- [ ] Teclas `{` / `}`:
  - Claude: ciclan `effortLevels` (igual que hoy).
  - Cursor: ciclan el param primario: `optimize_for` si el modelo lo tiene; si no, el primer `parameters[0]`. Persist `activeParams`. **No** escribir un effort Claude en un modelo Cursor.

- [ ] Header:

```
provider: cursor (api_key) · model: Composer 2.5 · params: fast=true
```

Quitar `{providerMeta?.runnable === false ? " · LLM: stub" : ""}`. Si no runnable: ` · LLM: not runnable` + `catalogError` recortado. Nunca la palabra `stub`.

- [ ] `sendWithLlm` (Task 5 ya unifica). Si Cursor not linked: el error de `publishAgentTurn` se pinta en `setLog` (incluye cómo vincular).

- [ ] Precio: si el modelo Cursor no trae `inputPricePerMTok`, mostrar `precios: —` (usage/cost es plan 15). No inventar 0/0 del stub.

- [ ] Commit:

```bash
git add tui/src/App.tsx
git commit -m "feat(cursor): TUI runs Cursor and cycles native params"
```

---

## Task 9: Web — catálogos nativos, sin stub, params, turns

**Files:**

- Modify: `web/src/lib/hooks.ts`
- Modify: `web/src/components/ProvidersPanel.tsx`
- Modify: `web/src/components/ChatDetailPanel.tsx`
- Modify: `web/src/components/HubPanel.tsx`

- [ ] En `web/src/lib/hooks.ts` reemplazar el `ModelInfo` único. Dejar Claude como está y añadir Cursor:

```ts
export type CursorParamSelection = { id: string; value: string };

export type CursorModelInfo = {
  id: string;
  displayName?: string;
  label?: string;
  description?: string;
  parameters?: Array<{
    id: string;
    displayName?: string;
    values: Array<{ value: string; displayName?: string }>;
  }>;
  variants?: Array<{
    params: CursorParamSelection[];
    displayName: string;
    isDefault?: boolean;
  }>;
};

export type ProvidersResponse = {
  activeProvider: string | null;
  activeModel: string | null;
  activeEffort: string | null;
  activeParams?: CursorParamSelection[] | null;
  catalogs?: Array<{
    id: string;
    label: string;
    runnable?: boolean;
    raw?: unknown;
    models?: unknown[];
    catalogError?: string | null;
  }>;
  providers: Record<
    string,
    {
      linked: boolean;
      authKind?: string;
      label?: string;
      runnable?: boolean;
      models?: unknown[];
      catalogError?: string | null;
      updatedAt?: string;
    }
  >;
};
```

`useProviderPreferences` body incluye `activeParams`.

- [ ] `ProvidersPanel.tsx`:

  1. Badge por provider: `linked (api_key)` / `not linked` + `runnable` / `not runnable`. **Cero** copys “stub”.
  2. Si `catalogError`, banner `<p className="error">` con el error. La key sigue linked (Reveal sigue funcionando).
  3. Bloque “Modelo y effort” pasa a “Modelo y params”:
     - Si `activeId === "claude"`: select de modelos (`label`) + select de `effortLevels` (como hoy).
     - Si `activeId === "cursor"`: select de modelos (`displayName ?? label ?? id`). Por cada `parameters[]` del modelo seleccionado, un `<select name={`param-${id}`}>` con `values`. Si el modelo es `auto-smart`, el select `optimize_for` usa labels Cost / Balance / Intelligence mapeados desde `displayName` o, si falta, `cost`→Cost, `balanced`→Balance, `intelligence`→Intelligence. **No** renderizar Router si el modelo no está en `models`.
     - Submit: Claude → `{ activeModel, activeEffort }`. Cursor → `{ activeModel, activeParams: [{id,value}, ...] }`.
  4. Activar Cursor llama `PUT /providers/active` (ya); invalidar query. El 400 de par imposible se muestra con `formatQueryError`.
  5. Vincular: para Cursor, default `authKind=api_key` (ocultar `oauth_token` si `linkProvider==="cursor"` — Cursor en esta fase es API key). Placeholder `key_…` / Cursor dashboard.
  6. **No** hay checkbox ni copy de cloud VM / repos remotos.

- [ ] `HubPanel.tsx`: si se lista providers, no decir stub. Opcional: `linkedCount` ya existe; se puede añadir `runnableCount`. No requerido por Gherkin.

- [ ] `ChatDetailPanel.tsx`: el composer ya dispara `agent.turn.request`. Si el daemon responde error de credencial, el push `chat.stream.error` ya se pinta. Asegurar que `data.error` **o** `data.content` del error se muestran (hoy lee `data.error`; el handler de API en `chat.stream.error` usa `content` — alinear:

```ts
const errText =
  (data as { error?: string; content?: string; message?: string }).error ||
  (data as { content?: string }).content;
```

en el branch `chat.stream.error`. Así CLI/TUI/Web ven el mismo `CURSOR_UNLINKED` / `CURSOR_AUTH_ERROR`.

Botón cancelar: Task 6.

- [ ] Commit:

```bash
git add web/src/lib/hooks.ts web/src/components/ProvidersPanel.tsx web/src/components/ChatDetailPanel.tsx web/src/components/HubPanel.tsx
git commit -m "feat(cursor): Web native catalogs and params, no stub"
```

---

## Task 10: OpenAPI, smokes y regresiones Claude

**Files:**

- Modify: `api/openapi/openapi.yaml` (cerrar huecos de Task 3)
- Create: `cli/scripts/cursor-provider-smoke.ts`
- Modify: `scripts/llm-smoke.ts`
- Modify: `api/scripts/e2e-phase1.ts`
- Test: `api/src/routes/providers.test.ts`

- [ ] Tests HTTP de `api/src/routes/providers.test.ts` con Hono `app.request` **si** el resto de rutas se testean así. Si no hay harness de DB en unit tests, testear helpers ya cubiertos y un smoke script. Mínimo unitario **sin** DB:

  Reexportar de `prefs-validate` + `catalog-codec` (ya testeados). Añadir test de “GET response shape” con una función `publicProviderPayload(...)` extraída de la ruta (refactor mínimo en `providers.ts`) que, dados rows + catalogs, arma `{ linked, runnable, models, catalogError }` **sin** `secret`.

Casos:

  1. Cursor linked + raw con `mystery: true` en un modelo → `payload.raw` conserva `mystery`; `models[]` parseado no explota.
  2. Cursor linked + raw null + lastError `"Invalid API key"` → `runnable: false`, `catalogError` set, `models: []`. No hay `composer-2.5 (stub)`.
  3. Claude linked → models tienen `effortLevels`, no `parameters`.
  4. Payload stringificado no contiene un secret pasado al helper (el helper no lo recibe).

- [ ] `cli/scripts/cursor-provider-smoke.ts` (solo se corre con env; no en CI obligatorio):

```ts
/**
 * Optional live smoke:
 *   CURSOR_API_KEY=... bun run cli/scripts/cursor-provider-smoke.ts
 * Exits 2 if no key (skip). Never prints the key.
 */
```

Pasos: `Cursor.models.list` → log `models=N router=${hasRouter}`; `Agent.create({ local: { cwd: process.cwd() }, model: { id: first } })` → `send("say hi in one word")` → `wait`. Si `cloud` se cuela en el objeto, `process.exit(1)`.

- [ ] `scripts/llm-smoke.ts`: si `activeProvider === "cursor"`, no llamar `runClaudeTurn`. Branch a `runCursorTurn` o skip con mensaje `"active provider is cursor; use cli/scripts/cursor-provider-smoke.ts"`. No romper el smoke Claude.

- [ ] `api/scripts/e2e-phase1.ts` (además de Task 2): GET `/providers` sin `Authorization` → 401. GET con bearer no incluye `secret`. PUT preferences `{ activeProvider: "cursor", activeModel: "claude-sonnet-4-6" }` → 400 cuyo body contiene `does not belong`.

- [ ] OpenAPI: `GET /providers` 401 documentado (ya). Descripción: “models son nativos por provider; raw es el JSON recolectado”.

```bash
cd api && bun test src/llm/catalog-codec.test.ts src/llm/prefs-validate.test.ts src/llm/cursor-discover.test.ts
cd cli && bun test src/llm/catalog-codec.test.ts src/llm/cursor-tools.test.ts src/llm/cursor-runner.test.ts src/llm/publish-turn.test.ts src/llm/turn-control.test.ts src/commands/provider-format.test.ts
```

Si `DATABASE_URL` está:

```bash
cd api && bun run scripts/e2e-phase1.ts
```

- [ ] Commit:

```bash
git add api/openapi/openapi.yaml api/src/routes/providers.ts api/src/routes/providers.test.ts api/scripts/e2e-phase1.ts cli/scripts/cursor-provider-smoke.ts scripts/llm-smoke.ts
git commit -m "test(cursor): catalogs, prefs, runner errors, unlink isolation"
```

---

## Verificación manual (Gherkin → comando)

Tras las 10 tasks, cada escenario se demuestra así. No es una task de código; es la checklist del implementador.

| Escenario | Cómo |
|---|---|
| Vincular Cursor CLI | `chavez login` → `chavez provider link cursor` (pega key) → `chavez provider list` muestra `cursor: linked (api_key) runnable` (o `not-runnable` + catalogError si la key es mala). `whoami` no imprime la key. |
| Vincular Web | `/providers` → guardar key → `chavez provider list` refleja linked. |
| Vincular CLI `--web` | `chavez provider link cursor --web` abre `/providers?provider=cursor&token=…` → guardar → CLI `list` linked. |
| Desvincular | `chavez provider unlink cursor` → turn con activo cursor falla `CURSOR_UNLINKED`. Claude linked sigue ejecutando. |
| Reveal | GET `/providers/cursor/credentials` con sesión → secret. Sin sesión → 401. `list` no trae secret. |
| Catálogo deja de ser stub | GET `/providers` con key válida → `runnable: true`, models de la cuenta, **cero** `"Composer 2.5 (stub)"`. |
| Catálogo Cursor completo | `catalogs[cursor].raw` es el JSON de `models.list`. Models tienen `parameters`/`variants`. `auto-smart` solo si viene en raw. |
| Catálogo Claude completo | `catalogs[claude].raw` persiste `CLAUDE_MODELS`. Models tienen `effortLevels` y precios. |
| JSON distintos conviven | Web: Claude muestra effort; Cursor muestra params. Un campo extra en raw sobrevive un GET. |
| Fallback discovery | Key válida + `Cursor.models.list` mock fail → UI `catalogError` o cache previo; linked true; no runnable con modelo inventado. |
| No cloud | Grep `cloud:` en `cli/src/llm/cursor-runner.ts` = solo comentarios de prohibición. UI sin VM/repos. |
| Set provider CLI | `chavez provider set cursor` → TUI/Web leen el mismo `activeProvider`. Modelo recortado al catálogo Cursor. |
| Elegir modelo/params Web | Select + guardar → GET prefs → siguiente turn usa `model.params`. |
| Ciclo TUI | `p` `[` `]` `{` `}` no dejan un id Claude con provider Cursor. |
| Prefs inválidas | PUT `{ activeProvider:"cursor", activeModel:"claude-sonnet-4-6" }` → 400 `does not belong`. |
| Claude sigue igual | `provider set claude` + turn → `runClaudeTurn`; no GET `/providers/cursor/credentials`. |
| Primer turn Cursor | Daemon bound, chat vacío, prompt → deltas + assistant persistido. |
| Historial reinyectado | Chat con turns Claude → follow-up Cursor incluye el texto previo en el prompt (no “hello, how can I help” de sesión vacía). |
| Tools visuales | `tool_call` shell → timeline `tool · bash · running|done` en Web, TUI y `chat watch`. |
| Cancel | Web botón / TUI Escape-si-busy / `headless chat cancel` → run cancelled, stream termina, se puede enviar otro turn. |
| Auth error | Key revocada → `CURSOR_AUTH_ERROR`, daemon no se queda en `turnBusy`. |
| Modelo no disponible | `activeModel` fuera del catálogo vivo → error que **nombra** el id y pide elegir otro. |
| Switch mid-chat | Mensajes Claude permanecen; el nuevo turn es Cursor; tools nuevas en la misma timeline. |
| Cursor inactivo | Activo Claude → no se llama `Agent.create`. |
| API 401 | GET `/providers` sin cookie/bearer → 401. |
| Web no stub | Consola permite Activar Cursor y disparar turn si runnable. |
| TUI no stub | Header sin `LLM: stub`; compose dispara runner Cursor. |
| whoami / status | Activo, modelo, linked/runnable. |
| Turn sin key | Mismo `CURSOR_UNLINKED` desde Web, TUI y `chat ask`. |

Grep de seguridad antes de merge:

```bash
rg -n "Composer 2.5 \\(stub\\)|LLM: stub|solo claude|Cursor LLM aún no implementado" api cli tui web
rg -n "cloud:" cli/src/llm/cursor-runner.ts
```

El primer grep debe quedar vacío (salvo este `implementation.md` y `plan.md`). El segundo, solo comentarios que prohíben cloud.
