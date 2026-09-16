# Plan artifact Implementation Plan

> **For agentic workers:** Execute task-by-task. Do not skip tests. Do not implement Cursor cloud, voz, extensión IDE, upload desde el navegador, slash picker genérico (plan 11: `/plan` sigue siendo atajo a `/mode plan`; esta fase añade `/apply` exacto si el dispatcher ya existe), cola de turns (plan 29), git commit/push/PR (plan 7: el turn de aplicación **puede** invocar esas tools; `chat.plan.apply` **no** corre git), undo (plan 12), ni notificaciones OS/email. Spec: [`plan.md`](./plan.md). Depende de modos ([`execution-modes`](../execution-modes/implementation.md)): el gate `plan`/`auto`/`ask` ya existe o se asume. Si un sibling ya creó un archivo citado, **extiéndelo**; no lo reescribas.

**Goal:** Un turn en modo `plan` deja un **documento de plan editable** asociado al chat, distinto de un assistant suelto. El usuario lo edita en Web (markdown persistido; TUI y `watch` ven la versión nueva), marca cuál es el **actual** si hay varios, y al **aplicar** el modo pasa a `ask` o `auto` (el último modo ejecutable que el usuario tenía) y el **siguiente** turn inyecta el artefacto como brief — sin copiar-pegar. Aplicar **no** commitea. El agente puede proponer commit en el turn de aplicación.

**Architecture:** El filesystem real vive en el daemon (`cli/src/ws/daemon.ts` o TUI con `clientKind: "daemon"`). El artefacto **no** es un archivo del workspace: vive en `chat_messages` (`metadata.kind === "plan_artifact"`) y se hidrata al LLM **en el daemon** en el siguiente turn. La API persiste, promociona el actual, hace fan-out WS y cambia preferencias. No escribe en disco ni corre `git`.

```
Turn executionMode=plan
        |
        v
  publishAgentTurn → chat.stream.end
        metadata.kind = "plan_artifact"
        |
        v
  API  persist assistant + promoteCurrentPlan
        previous current → status "history"
        new               → status "current"
        broadcast message.appended + chat.plan.created
        |
        v
  Web PlanCard | TUI [plan · current] | CLI watch

Edit (Web / CLI)
  chat.plan.update { artifactId, markdown }
        revision++
        broadcast chat.plan.updated  → TUI loadChat / watch

Apply
  chat.plan.apply { artifactId? }     — default: el current
        setCurrent si hace falta
        PUT activeExecutionMode = lastRunnableExecutionMode (ask|auto)
        pendingApply = true
        NO git, NO agent.turn.request
        broadcast chat.plan.applied + prefs.updated
        |
        v
  siguiente agent.turn.request
        dispatch.planBrief = markdown actual (editado)
        publishAgentTurn prepends APPLY_PLAN_PREAMBLE + <plan>
        chat.plan.consume  (pendingApply = false)
        modo ask|auto → el agente PUEDE proponer git_commit (plan 7)
```

Estado actual que este plan extiende (no reescribir):

- `api/src/db/schema.ts` `chat_messages.metadata` jsonb **ya existe**. `chats` no tiene columna de plan. **No** hay tabla `plan_artifacts`. Esta fase **no** crea tabla nueva: el documento es una fila `role=assistant` con `metadata.kind="plan_artifact"`.
- `user_preferences` hoy: `activeProvider` / `activeModel` / `activeEffort`. El [plan 3](../execution-modes/implementation.md) añade `activeExecutionMode`. Esta fase añade `lastRunnableExecutionMode` (`ask`|`auto`) y, si `activeExecutionMode` **aún no existe**, lo añade en la misma migración (no implementa el gate `canUseTool`).
- `api/src/ws/handlers.ts` `chat.stream.end` inserta assistant con `metadata: { streamId, ...msg.metadata }`. No promociona planes. `agent.turn.request` despacha `{ chatId, prompt, ... }` **sin** `planBrief`.
- `cli/src/llm/publish-turn.ts` manda `chat.stream.end` con `content: result` y **sin** metadata de modo. No inyecta brief.
- `cli/src/llm/history.ts` mete `assistant` al LLM. Un `plan_artifact` **es** assistant: entra al historial. El brief de apply se prepende igual para que el markdown **editado** sea la spec, no un recorte viejo.
- Compact (plan 10) ya pinnea `metadata.kind === "plan_artifact"` si existe. Si `cli/src/llm/compact.ts` `extractLastPlan` ya está, **preferir** `status === "current"` (extender, no reescribir el compact).
- TUI `Message` es `{ id, role, content }` — **sin** metadata. Timeline pinta `role: content` truncado. Tecla `p` es provider; `a` queda libre para apply.
- Web `ChatDetailPanel.tsx` pinta assistant en un `.panel` genérico. No hay editor de plan ni botón Aplicar.
- CLI `chavez headless chat`: `create|list|append|get|ask|watch`. No hay `plan`.
- Slash `/plan` (plan 11) es **solo** atajo a modo `plan`. No crea artefacto. Esta fase no lo cambia. Si `cli/src/llm/slash.ts` existe, añadir comando `apply` que llama `chat.plan.apply`; si no, interceptar el string exacto `/apply` en TUI/Web/CLI ask.
- Cursor `runnable: false` hoy. El artefacto se crea igual cuando el provider ejecutable (Claude; Cursor tras plan 4) termina un turn `plan`. No simular un plan Cursor.
- Git (plan 7) **no** se implementa. `chat.plan.apply` no importa `git-exec` / `git-constants`. El preamble de apply dice explícitamente que apply no commiteó.

**Tech Stack:** Bun, Hono WebSocket hub, Drizzle `chat_messages.metadata` jsonb + columna `user_preferences.last_runnable_execution_mode` (y `active_execution_mode` si falta), Claude Agent SDK solo vía `publishAgentTurn` ya existente, Ink TUI, Astro/React web. Tests: `bun test`. Web **no** importa `cli/`: duplicar helpers de kind/status (comentario keep-in-sync).

**Global Constraints:**

1. El filesystem se lee y escribe **solo** en el daemon. El artefacto **no** se materializa como `PLAN.md` ni `.chavez/plan.md`. API y browser no hidratan, no grepean, no commitean.
2. Sin daemon bound, `agent.turn.request` falla con el string existente `"No daemon bound for this workspace. Run: chavez headless workspace open"`. `chat.plan.update` / `apply` / `setCurrent` **no** requieren daemon (son persistencia + prefs).
3. Un turn de agente solo corre con daemon bound. Apply **no** dispara el turn; prepara el siguiente.
4. Modos: apply pone `activeExecutionMode` en `lastRunnableExecutionMode` (`ask` o `auto`, default `ask`). Nunca deja el modo en `plan`. Nunca inventa un cuarto modo.
5. Varios planes: exactamente **uno** `status: "current"` por chat. Los demás `history`. Apply usa el current (o el `artifactId` pedido, que pasa a current). Los viejos siguen en la timeline.
6. Lecturas no piden confirmación. Apply no es una tool del modelo y no entra en `canUseTool`.
7. Aprobaciones una a una: no aplica (apply no pide permiso de tool). El turn de aplicación posterior sigue el modo `ask`/`auto` del plan 3.
8. 1 turn por daemon. Crear/editar/aplicar un plan **no** cancela un turn en curso. El brief se consume en el **siguiente** `agent.turn.request` que se acepte.
9. Claude es el provider ejecutable hoy. Cursor vinculado no ejecuta turns aquí; cuando el plan 4 lo haga, el mismo `chat.stream.end` + `kind=plan_artifact` aplica.
10. Web, TUI y CLI `watch` ven el mismo contrato: `chat.plan.created` / `updated` / `applied` / `current` + el mensaje con `kind=plan_artifact`. Un reload de `chat.get` reconstruye current/history.
11. Apply **no** corre `git commit` / `git push` / PR. Cero side-effects en el repo. El preamble del turn de aplicación autoriza al modelo a **proponer** commit (tools del plan 7, si existen).
12. Fuera de alcance: Cursor cloud, voz, extensión IDE, upload desde el navegador, notificaciones OS/email, escribir el plan a disco, lote, “siempre permitir”, cola, worktrees.

**Constantes (congeladas, no inventar otras):**

| Nombre | Valor |
|---|---|
| `PLAN_ARTIFACT_KIND` | `"plan_artifact"` |
| `PLAN_STATUS_CURRENT` | `"current"` |
| `PLAN_STATUS_HISTORY` | `"history"` |
| `PLAN_MARKDOWN_MAX_CHARS` | `200_000` |
| `DEFAULT_APPLY_MODE` | `"ask"` |
| `RUNNABLE_MODES` | `"ask"` \| `"auto"` |
| `NO_CURRENT_PLAN` | `"No current plan artifact in this chat"` |
| `PLAN_NOT_FOUND` | `"Plan artifact not found"` |
| `PLAN_EMPTY_ERROR` | `"Plan markdown cannot be empty"` |
| `PLAN_TOO_LARGE` | `"Plan markdown exceeds 200000 characters"` |
| `PLAN_NOT_IN_CHAT` | `"Plan artifact does not belong to this chat"` |
| `APPLY_USER_PROMPT` | `"Aplica el plan actual."` |
| `APPLY_PLAN_PREAMBLE` | `"You are applying the user's reviewed plan below. Follow it as the spec. Do not ask the user to paste it. Applying the plan did not commit anything; you may propose a git commit at the end of this turn if the workspace is a git repo and the user wants it."` |
| `PLAN_CREATED_EVENT` | `"chat.plan.created"` |
| `PLAN_UPDATED_EVENT` | `"chat.plan.updated"` |
| `PLAN_APPLIED_EVENT` | `"chat.plan.applied"` |
| `PLAN_CURRENT_EVENT` | `"chat.plan.current"` |

Metadata congelada del mensaje artefacto:

```ts
{
  kind: "plan_artifact",          // PLAN_ARTIFACT_KIND
  status: "current" | "history",
  revision: number,               // 1 al crear; ++ en cada update
  streamId: string,               // del chat.stream.end origen
  executionMode: "plan",
  pendingApply: boolean,          // true tras apply, false tras consume / demote
  appliedAt?: string,             // ISO, si se aplicó al menos una vez
}
```

`chat.get` (WS y `GET /chats/:chatId`) añade `currentPlanArtifactId: string | null` derivado (no columna).

---

## Task 1: Módulos puros — kind, promote, brief, apply-mode

**Files:**

- Create: `cli/src/llm/plan-artifact.ts`
- Test: `cli/src/llm/plan-artifact.test.ts`
- Create: `api/src/llm/plan-artifact.ts`
- Test: `api/src/llm/plan-artifact.test.ts`
- Create: `web/src/lib/plan-artifact.ts`
- Test: `web/src/lib/plan-artifact.test.ts`
- Modify: `cli/package.json`
- Modify: `api/package.json`
- Modify: `web/package.json`

Módulos sin I/O de red ni git. TUI importa desde `cli/src/llm/plan-artifact.ts`. API y Web **no** importan CLI: copiar las exportaciones listadas (comentario `keep-in-sync: plan-artifact`).

- [ ] Añadir `"test": "bun test"` en `cli/package.json`, `api/package.json` y `web/package.json` `scripts` si aún no existe. Dejar `start`/`dev`/`bin`/`db:*` intactos.

- [ ] Crear `cli/src/llm/plan-artifact.ts` con **exactamente**:

```ts
export const PLAN_ARTIFACT_KIND = "plan_artifact";
export const PLAN_STATUS_CURRENT = "current";
export const PLAN_STATUS_HISTORY = "history";
export const PLAN_MARKDOWN_MAX_CHARS = 200_000;
export const DEFAULT_APPLY_MODE = "ask" as const;
export const RUNNABLE_MODES = ["ask", "auto"] as const;

export type PlanStatus = typeof PLAN_STATUS_CURRENT | typeof PLAN_STATUS_HISTORY;
export type RunnableMode = (typeof RUNNABLE_MODES)[number];

export const NO_CURRENT_PLAN = "No current plan artifact in this chat";
export const PLAN_NOT_FOUND = "Plan artifact not found";
export const PLAN_EMPTY_ERROR = "Plan markdown cannot be empty";
export const PLAN_TOO_LARGE = "Plan markdown exceeds 200000 characters";
export const PLAN_NOT_IN_CHAT = "Plan artifact does not belong to this chat";
export const APPLY_USER_PROMPT = "Aplica el plan actual.";

export const APPLY_PLAN_PREAMBLE =
  "You are applying the user's reviewed plan below. Follow it as the spec. Do not ask the user to paste it. Applying the plan did not commit anything; you may propose a git commit at the end of this turn if the workspace is a git repo and the user wants it.";

export const PLAN_CREATED_EVENT = "chat.plan.created";
export const PLAN_UPDATED_EVENT = "chat.plan.updated";
export const PLAN_APPLIED_EVENT = "chat.plan.applied";
export const PLAN_CURRENT_EVENT = "chat.plan.current";

export type PlanArtifactMeta = {
  kind: typeof PLAN_ARTIFACT_KIND;
  status: PlanStatus;
  revision: number;
  streamId: string;
  executionMode: "plan";
  pendingApply: boolean;
  appliedAt?: string;
};

export type PlanRow = {
  id: string;
  chatId?: string;
  role?: string;
  content?: string | null;
  metadata?: Record<string, unknown> | null;
};

export function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

export function isRunnableMode(v: unknown): v is RunnableMode {
  return v === "ask" || v === "auto";
}

export function resolveApplyMode(lastRunnable: unknown): RunnableMode {
  return isRunnableMode(lastRunnable) ? lastRunnable : DEFAULT_APPLY_MODE;
}

export function isPlanArtifact(meta: unknown): boolean {
  const m = rec(meta);
  return Boolean(m && m.kind === PLAN_ARTIFACT_KIND);
}

export function asPlanMeta(meta: unknown): PlanArtifactMeta | null {
  const m = rec(meta);
  if (!m || m.kind !== PLAN_ARTIFACT_KIND) return null;
  const status =
    m.status === PLAN_STATUS_HISTORY
      ? PLAN_STATUS_HISTORY
      : PLAN_STATUS_CURRENT;
  return {
    kind: PLAN_ARTIFACT_KIND,
    status,
    revision: Number.isFinite(Number(m.revision)) ? Number(m.revision) : 1,
    streamId: typeof m.streamId === "string" ? m.streamId : "",
    executionMode: "plan",
    pendingApply: m.pendingApply === true,
    appliedAt: typeof m.appliedAt === "string" ? m.appliedAt : undefined,
  };
}

export function currentPlanId(messages: PlanRow[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const meta = asPlanMeta(messages[i]!.metadata);
    if (meta?.status === PLAN_STATUS_CURRENT) return messages[i]!.id;
  }
  return null;
}

export function findPlan(
  messages: PlanRow[],
  artifactId: string,
): PlanRow | null {
  return messages.find((m) => m.id === artifactId && isPlanArtifact(m.metadata)) ?? null;
}

/**
 * Body of the plan document. Prefer a single fenced ```markdown|md|plan block
 * when it is the majority of the text; otherwise the full assistant result.
 */
export function extractPlanMarkdown(assistantText: string): string {
  const text = assistantText.trim();
  if (!text) return "";
  const re = /```(?:markdown|md|plan)\s*\n([\s\S]*?)```/gi;
  const blocks: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const body = (m[1] || "").trim();
    if (body) blocks.push(body);
  }
  if (blocks.length === 1 && blocks[0]!.length >= text.length * 0.5) {
    return blocks[0]!;
  }
  return text;
}

export function validatePlanMarkdown(markdown: string): string {
  const trimmed = markdown.trim();
  if (!trimmed) throw new Error(PLAN_EMPTY_ERROR);
  if (trimmed.length > PLAN_MARKDOWN_MAX_CHARS) throw new Error(PLAN_TOO_LARGE);
  return trimmed;
}

export function newPlanMeta(streamId: string): PlanArtifactMeta {
  return {
    kind: PLAN_ARTIFACT_KIND,
    status: PLAN_STATUS_CURRENT,
    revision: 1,
    streamId,
    executionMode: "plan",
    pendingApply: false,
  };
}

/**
 * Exactly one current. `newCurrentId` becomes current; every other
 * plan_artifact becomes history and loses pendingApply.
 */
export function promoteCurrent(
  messages: PlanRow[],
  newCurrentId: string,
): PlanRow[] {
  return messages.map((row) => {
    const meta = asPlanMeta(row.metadata);
    if (!meta) return row;
    if (row.id === newCurrentId) {
      return {
        ...row,
        metadata: { ...meta, status: PLAN_STATUS_CURRENT },
      };
    }
    return {
      ...row,
      metadata: { ...meta, status: PLAN_STATUS_HISTORY, pendingApply: false },
    };
  });
}

export function markPendingApply(
  meta: PlanArtifactMeta,
  at: string,
): PlanArtifactMeta {
  return { ...meta, pendingApply: true, appliedAt: at };
}

export function consumePending(meta: PlanArtifactMeta): PlanArtifactMeta {
  return { ...meta, pendingApply: false };
}

export function bumpRevision(
  meta: PlanArtifactMeta,
  extra?: Partial<PlanArtifactMeta>,
): PlanArtifactMeta {
  return { ...meta, ...extra, revision: meta.revision + 1 };
}

export function buildApplyPrompt(
  userPrompt: string,
  planMarkdown: string,
): string {
  const instruction = userPrompt.trim() || APPLY_USER_PROMPT;
  return [
    APPLY_PLAN_PREAMBLE,
    "",
    "<plan>",
    planMarkdown.trim(),
    "</plan>",
    "",
    "User instruction:",
    instruction,
  ].join("\n");
}

export function pendingApplyPlan(messages: PlanRow[]): PlanRow | null {
  const id = currentPlanId(messages);
  if (!id) return null;
  const row = findPlan(messages, id);
  if (!row) return null;
  const meta = asPlanMeta(row.metadata);
  if (!meta?.pendingApply) return null;
  if (!String(row.content || "").trim()) return null;
  return row;
}
```

- [ ] Copiar el mismo archivo a `api/src/llm/plan-artifact.ts` y a `web/src/lib/plan-artifact.ts`. Primera línea de cada copia:

```ts
/** keep-in-sync: cli/src/llm/plan-artifact.ts */
```

Web puede omitir `buildApplyPrompt` / `pendingApplyPlan` si no los usa; **debe** exportar `PLAN_ARTIFACT_KIND`, `isPlanArtifact`, `asPlanMeta`, `currentPlanId`, `PLAN_STATUS_CURRENT`, `PLAN_STATUS_HISTORY`.

- [ ] Crear `cli/src/llm/plan-artifact.test.ts` (la API y Web copian los mismos asserts sobre las funciones que exportan):

```ts
import { describe, expect, test } from "bun:test";
import {
  APPLY_PLAN_PREAMBLE,
  APPLY_USER_PROMPT,
  DEFAULT_APPLY_MODE,
  NO_CURRENT_PLAN,
  PLAN_ARTIFACT_KIND,
  PLAN_EMPTY_ERROR,
  PLAN_STATUS_CURRENT,
  PLAN_STATUS_HISTORY,
  PLAN_TOO_LARGE,
  PLAN_MARKDOWN_MAX_CHARS,
  asPlanMeta,
  buildApplyPrompt,
  bumpRevision,
  consumePending,
  currentPlanId,
  extractPlanMarkdown,
  isPlanArtifact,
  isRunnableMode,
  markPendingApply,
  newPlanMeta,
  pendingApplyPlan,
  promoteCurrent,
  resolveApplyMode,
  validatePlanMarkdown,
} from "./plan-artifact";

describe("kind / meta", () => {
  test("assistant suelto no es artefacto", () => {
    expect(isPlanArtifact({ streamId: "s" })).toBe(false);
    expect(isPlanArtifact(null)).toBe(false);
    expect(asPlanMeta({ kind: "slash_result" })).toBeNull();
  });

  test("newPlanMeta is current, not pending", () => {
    const m = newPlanMeta("sid");
    expect(m.kind).toBe(PLAN_ARTIFACT_KIND);
    expect(m.status).toBe(PLAN_STATUS_CURRENT);
    expect(m.pendingApply).toBe(false);
    expect(m.revision).toBe(1);
    expect(m.executionMode).toBe("plan");
  });
});

describe("extractPlanMarkdown", () => {
  test("full text when no fence", () => {
    expect(extractPlanMarkdown("  ## Auth refactor\n\n1. Split routes  ")).toBe(
      "## Auth refactor\n\n1. Split routes",
    );
  });

  test("single majority markdown fence", () => {
    const body = "a".repeat(80);
    const text = `Intro\n\n\`\`\`markdown\n${body}\n\`\`\`\n`;
    expect(extractPlanMarkdown(text)).toBe(body);
  });

  test("empty", () => {
    expect(extractPlanMarkdown("   ")).toBe("");
  });
});

describe("validatePlanMarkdown", () => {
  test("empty throws PLAN_EMPTY_ERROR", () => {
    expect(() => validatePlanMarkdown("  \n")).toThrow(PLAN_EMPTY_ERROR);
  });

  test("too large throws PLAN_TOO_LARGE", () => {
    expect(() =>
      validatePlanMarkdown("x".repeat(PLAN_MARKDOWN_MAX_CHARS + 1)),
    ).toThrow(PLAN_TOO_LARGE);
  });
});

describe("promoteCurrent", () => {
  test("exactly one current; old become history", () => {
    const a = {
      id: "p1",
      metadata: newPlanMeta("s1"),
      content: "old",
    };
    const b = {
      id: "p2",
      metadata: newPlanMeta("s2"),
      content: "new",
    };
    const out = promoteCurrent([a, b], "p2");
    expect(asPlanMeta(out[0]!.metadata)?.status).toBe(PLAN_STATUS_HISTORY);
    expect(asPlanMeta(out[0]!.metadata)?.pendingApply).toBe(false);
    expect(asPlanMeta(out[1]!.metadata)?.status).toBe(PLAN_STATUS_CURRENT);
    expect(currentPlanId(out)).toBe("p2");
  });

  test("non-plan rows untouched", () => {
    const rows = [
      { id: "u", role: "user", content: "hi", metadata: null },
      { id: "p", metadata: newPlanMeta("s"), content: "plan" },
    ];
    const out = promoteCurrent(rows, "p");
    expect(out[0]).toEqual(rows[0]);
  });
});

describe("apply mode + brief", () => {
  test("null lastRunnable → ask", () => {
    expect(resolveApplyMode(null)).toBe(DEFAULT_APPLY_MODE);
    expect(resolveApplyMode("plan")).toBe("ask");
    expect(resolveApplyMode("auto")).toBe("auto");
    expect(isRunnableMode("plan")).toBe(false);
  });

  test("buildApplyPrompt wraps markdown and does not mention a commit happened", () => {
    const p = buildApplyPrompt("go", "## Steps\n- a");
    expect(p.startsWith(APPLY_PLAN_PREAMBLE)).toBe(true);
    expect(p).toContain("<plan>\n## Steps\n- a\n</plan>");
    expect(p).toContain("User instruction:\ngo");
    expect(p.toLowerCase()).toContain("did not commit");
    expect(p).not.toContain("git commit -m");
  });

  test("empty user prompt uses APPLY_USER_PROMPT", () => {
    expect(buildApplyPrompt("  ", "X")).toContain(APPLY_USER_PROMPT);
  });
});

describe("pendingApply", () => {
  test("pendingApplyPlan reads current+pending only", () => {
    const current = {
      id: "p2",
      content: "NEW",
      metadata: markPendingApply(newPlanMeta("s2"), "2026-09-16T00:00:00.000Z"),
    };
    const old = {
      id: "p1",
      content: "OLD",
      metadata: {
        ...newPlanMeta("s1"),
        status: PLAN_STATUS_HISTORY,
        pendingApply: true,
      },
    };
    const rows = promoteCurrent([old, current], "p2");
    const pending = pendingApplyPlan(
      rows.map((r) =>
        r.id === "p2"
          ? { ...r, metadata: markPendingApply(asPlanMeta(r.metadata)!, "t") }
          : r,
      ),
    );
    expect(pending?.id).toBe("p2");
    expect(pending?.content).toBe("NEW");
  });

  test("consumePending clears flag", () => {
    const m = consumePending(
      markPendingApply(newPlanMeta("s"), "t"),
    );
    expect(m.pendingApply).toBe(false);
    expect(m.appliedAt).toBe("t");
  });

  test("bumpRevision", () => {
    expect(bumpRevision(newPlanMeta("s")).revision).toBe(2);
  });
});

test("frozen error strings", () => {
  expect(NO_CURRENT_PLAN).toBe("No current plan artifact in this chat");
});
```

Copiar el test a `api/src/llm/plan-artifact.test.ts` (mismo import relativo) y a `web/src/lib/plan-artifact.test.ts` importando `../lib/plan-artifact` — si Web no exporta `buildApplyPrompt`, limitar el archivo web a kind/status/currentPlanId/extract/validate.

- [ ] Correr:

```bash
cd cli && bun test src/llm/plan-artifact.test.ts
cd api && bun test src/llm/plan-artifact.test.ts
cd web && bun test src/lib/plan-artifact.test.ts
```

Esperado: todos pasan. Cero I/O git.

- [ ] Commit:

```bash
git add cli/src/llm/plan-artifact.ts cli/src/llm/plan-artifact.test.ts \
  api/src/llm/plan-artifact.ts api/src/llm/plan-artifact.test.ts \
  web/src/lib/plan-artifact.ts web/src/lib/plan-artifact.test.ts \
  cli/package.json api/package.json web/package.json
git commit -m "feat(plan-artifact): pure promote/current/brief helpers"
```

---

## Task 2: Preferencias — `lastRunnableExecutionMode` (ask|auto)

**Files:**

- Modify: `api/src/db/schema.ts`
- Create: `api/drizzle/0002_last_runnable_execution_mode.sql`
- Modify: `api/src/routes/providers.ts`
- Modify: `api/src/llm/execution-mode.ts` (si existe; si no, no crearlo — `resolveApplyMode` ya está en `plan-artifact.ts`)
- Test: `api/src/routes/providers.last-runnable.test.ts`

Apply necesita “el modo que yo tenga para ejecutar”. Cada PUT `ask`/`auto` snapshotéa `lastRunnableExecutionMode`. Un PUT `plan` **no** lo pisa.

- [ ] En `api/src/db/schema.ts`, ampliar `userPreferences` **sin quitar columnas**. Queda:

```ts
export const userPreferences = pgTable("user_preferences", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  activeProvider: text("active_provider"),
  activeModel: text("active_model"),
  activeEffort: text("active_effort"),
  activeExecutionMode: text("active_execution_mode"),
  lastRunnableExecutionMode: text("last_runnable_execution_mode"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
```

Si `activeExecutionMode` **ya** está (plan 3), solo añadir `lastRunnableExecutionMode`. Si **no** está, añadir las dos (esta fase no implementa `canUseTool`).

- [ ] Crear `api/drizzle/0002_last_runnable_execution_mode.sql`:

```sql
ALTER TABLE "user_preferences"
  ADD COLUMN IF NOT EXISTS "active_execution_mode" text;
ALTER TABLE "user_preferences"
  ADD COLUMN IF NOT EXISTS "last_runnable_execution_mode" text;
```

- [ ] Aplicar:

```bash
cd api && bun run db:push
```

Si `DATABASE_URL` no está, fallar con el error de drizzle. No editar `docker-compose.yml`.

- [ ] En `api/src/routes/providers.ts`:

  1. Importar `isRunnableMode`, `resolveApplyMode`, `DEFAULT_APPLY_MODE` desde `../llm/plan-artifact`. Si `isExecutionMode` existe en `../llm/execution-mode`, usarlo; si no:

```ts
function isExecutionMode(v: unknown): v is "plan" | "auto" | "ask" {
  return v === "plan" || v === "auto" || v === "ask";
}
```

  2. Ampliar el patch de `upsertPrefs` con `activeExecutionMode?: string | null` y `lastRunnableExecutionMode?: string | null`. En `insert`/`update`, el mismo patrón `!== undefined` que `activeEffort`.

  3. En PUT `/preferences`, **después** de validar `activeExecutionMode` (si viene; inválido → 400 `"executionMode must be plan, auto, or ask"` — el string del plan 3 si ya existe):

```ts
if (body.activeExecutionMode !== undefined) {
  if (!isExecutionMode(body.activeExecutionMode)) {
    return c.json(
      { error: "executionMode must be plan, auto, or ask" },
      400,
    );
  }
  if (isRunnableMode(body.activeExecutionMode)) {
    body.lastRunnableExecutionMode = body.activeExecutionMode;
  }
}
```

No aceptar `lastRunnableExecutionMode` crudo del cliente para ponerlo en `plan`. Si el body trae `lastRunnableExecutionMode` solo (sin cambiar modo), validar `isRunnableMode` o 400.

  4. GET `/` y la respuesta de PUT `/preferences` incluyen:

```ts
activeExecutionMode: prefs[0]?.activeExecutionMode ?? null,
lastRunnableExecutionMode: resolveApplyMode(
  prefs[0]?.lastRunnableExecutionMode,
),
```

GET coalescing de lastRunnable: `null` → `"ask"`. **No** coalescer `activeExecutionMode` aquí si el plan 3 ya lo hace; si esta fase acaba de crear la columna, coalescer active a `"ask"` igual que plan 3.

  5. Si el PUT de preferences ya hace `hub.broadcastToUser(..., prefs.updated)`, no duplicar. Si **no** hay broadcast, añadirlo ahora (mismo event `prefs.updated` del plan 3, payload las prefs públicas). Apply (Task 3) depende de que Web/TUI vean el modo nuevo.

- [ ] Crear `api/src/routes/providers.last-runnable.test.ts` como test **unitario del helper de patch**, no del server HTTP. Extraer (en `providers.ts` o en `api/src/llm/plan-artifact.ts` si cabe mejor):

```ts
export function patchLastRunnable(
  body: {
    activeExecutionMode?: string | null;
    lastRunnableExecutionMode?: string | null;
  },
): { activeExecutionMode?: string | null; lastRunnableExecutionMode?: string | null } {
  const next = { ...body };
  if (next.activeExecutionMode !== undefined) {
    if (isRunnableMode(next.activeExecutionMode)) {
      next.lastRunnableExecutionMode = next.activeExecutionMode;
    }
  }
  return next;
}
```

Tests:

```ts
test("ask snapshots lastRunnable", () => {
  expect(patchLastRunnable({ activeExecutionMode: "ask" }).lastRunnableExecutionMode).toBe("ask");
});
test("auto snapshots lastRunnable", () => {
  expect(patchLastRunnable({ activeExecutionMode: "auto" }).lastRunnableExecutionMode).toBe("auto");
});
test("plan does not overwrite lastRunnable", () => {
  const p = patchLastRunnable({ activeExecutionMode: "plan" });
  expect(p.lastRunnableExecutionMode).toBeUndefined();
  expect(p.activeExecutionMode).toBe("plan");
});
```

Exportar `patchLastRunnable` desde `providers.ts` **o** moverlo a `api/src/llm/plan-artifact.ts` y usarlo en el PUT. Preferir `plan-artifact.ts` para no pelear con el árbol de Hono.

- [ ] Correr:

```bash
cd api && bun test src/llm/plan-artifact.test.ts src/routes/providers.last-runnable.test.ts
```

- [ ] Commit:

```bash
git add api/src/db/schema.ts api/drizzle/0002_last_runnable_execution_mode.sql \
  api/src/routes/providers.ts api/src/llm/plan-artifact.ts \
  api/src/routes/providers.last-runnable.test.ts
git commit -m "feat(plan-artifact): persist last runnable ask/auto for apply"
```

---

## Task 3: API WS — crear, editar, current, apply, consume

**Files:**

- Modify: `api/src/ws/protocol.ts`
- Modify: `api/src/ws/handlers.ts`
- Modify: `api/src/routes/workspaces.ts`
- Modify: `api/openapi/openapi.yaml`
- Test: `api/src/llm/plan-artifact.test.ts` (casos extra de promote ya cubiertos; añadir `applyFlow` puro si hace falta)
- Test: `api/src/ws/plan-handlers.test.ts`

La API es la fuente de verdad del documento. Cero `git`, cero `child_process`.

- [ ] En `api/src/ws/protocol.ts`, ampliar `ClientMessage`:

```ts
export type ClientMessage = {
  type: string;
  id: string;
  path?: string;
  title?: string;
  sessionId?: string;
  chatId?: string;
  role?: string;
  content?: string;
  clientKind?: "client" | "daemon";
  metadata?: Record<string, unknown>;
  streamId?: string;
  toolCallId?: string;
  toolName?: string;
  prompt?: string;
  delta?: string;
  status?: string;
  artifactId?: string;
  markdown?: string;
};
```

- [ ] En `api/src/ws/handlers.ts`, importar helpers de `../llm/plan-artifact` y `userPreferences` + `eq` (ya hay `eq`). Añadir helpers locales **encima** de `handleWsMessage`:

```ts
async function loadMessages(chatId: string) {
  return db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.chatId, chatId))
    .orderBy(asc(chatMessages.createdAt));
}

async function writePlanMeta(
  row: { id: string; content: string; metadata: unknown },
  meta: Record<string, unknown>,
  content?: string,
) {
  const nextContent = content !== undefined ? content : row.content;
  await db
    .update(chatMessages)
    .set({ content: nextContent, metadata: meta })
    .where(eq(chatMessages.id, row.id));
  return { ...row, content: nextContent, metadata: meta };
}

async function persistPromote(chatId: string, newId: string) {
  const rows = await loadMessages(chatId);
  const promoted = promoteCurrent(
    rows.map((r) => ({
      id: r.id,
      chatId: r.chatId,
      role: r.role,
      content: r.content,
      metadata: (r.metadata as Record<string, unknown> | null) ?? null,
    })),
    newId,
  );
  for (const row of promoted) {
    const prev = rows.find((r) => r.id === row.id);
    if (!prev) continue;
    const prevMeta = JSON.stringify(prev.metadata ?? null);
    const nextMeta = JSON.stringify(row.metadata ?? null);
    if (prevMeta !== nextMeta) {
      await db
        .update(chatMessages)
        .set({ metadata: row.metadata as Record<string, unknown> })
        .where(eq(chatMessages.id, row.id));
    }
  }
}

function publicPlan(row: {
  id: string;
  chatId: string;
  role: string;
  content: string;
  metadata: unknown;
  createdAt: Date;
}) {
  return {
    ...row,
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
  };
}
```

- [ ] En el case `chat.stream.end`, tras insertar el assistant (el bloque `if (content) { ... }`), **si** el metadata resultante tiene `kind === PLAN_ARTIFACT_KIND` **o** `executionMode === "plan"` **o** el último user del chat tiene `metadata.executionMode === "plan"`:

  1. `extractPlanMarkdown(content)` — si queda vacío, no promocionar (el assistant suelto se queda).
  2. Si el content extraído ≠ `content`, `update` content al extraído.
  3. Set metadata = `{ ...newPlanMeta(msg.streamId), ...existing }` con `kind: PLAN_ARTIFACT_KIND`, `status: current`, `revision: 1`, `pendingApply: false`, `executionMode: "plan"`, `streamId`.
  4. `await persistPromote(msg.chatId, message.id)`.
  5. Recargar la fila y usar esa como `message` del broadcast `message.appended`.
  6. `broadcast(userId, PLAN_CREATED_EVENT, { chatId, message, currentPlanArtifactId: message.id })`.

El daemon (Task 4) mandará `metadata.kind`. El fallback por `executionMode` del user cubre un daemon viejo.

No crear una **segunda** fila: el assistant del stream.end **es** el artefacto. Así no hay un assistant suelto duplicado más un documento.

- [ ] Añadir cases **antes** del `default`:

```ts
case "chat.plan.list": {
  if (!msg.chatId) return fail(type, id, "chatId is required");
  const chat = await loadChatForUser(msg.chatId, userId);
  if (!chat) return fail(type, id, "Chat not found");
  const messages = await loadMessages(msg.chatId);
  const plans = messages.filter((m) => isPlanArtifact(m.metadata));
  return ok(type, id, {
    chatId: msg.chatId,
    currentPlanArtifactId: currentPlanId(
      plans.map((p) => ({ id: p.id, metadata: p.metadata as Record<string, unknown> })),
    ),
    plans: plans.map(publicPlan),
  });
}

case "chat.plan.update": {
  if (!msg.chatId || !msg.artifactId) {
    return fail(type, id, "chatId and artifactId are required");
  }
  const chat = await loadChatForUser(msg.chatId, userId);
  if (!chat) return fail(type, id, "Chat not found");
  let markdown: string;
  try {
    markdown = validatePlanMarkdown(msg.markdown ?? msg.content ?? "");
  } catch (e) {
    return fail(type, id, e instanceof Error ? e.message : PLAN_EMPTY_ERROR);
  }
  const rows = await loadMessages(msg.chatId);
  const row = rows.find((m) => m.id === msg.artifactId);
  if (!row || !isPlanArtifact(row.metadata)) {
    return fail(type, id, PLAN_NOT_FOUND);
  }
  if (row.chatId !== msg.chatId) return fail(type, id, PLAN_NOT_IN_CHAT);
  const meta = bumpRevision(asPlanMeta(row.metadata)!);
  const message = await writePlanMeta(row, meta, markdown);
  await db.update(chats).set({ updatedAt: new Date() }).where(eq(chats.id, msg.chatId));
  const payload = { chatId: msg.chatId, message: publicPlan(message) };
  broadcast(userId, PLAN_UPDATED_EVENT, payload);
  broadcast(userId, "message.appended", { ...payload, updated: true });
  return ok(type, id, payload);
}

case "chat.plan.setCurrent": {
  if (!msg.chatId || !msg.artifactId) {
    return fail(type, id, "chatId and artifactId are required");
  }
  const chat = await loadChatForUser(msg.chatId, userId);
  if (!chat) return fail(type, id, "Chat not found");
  const rows = await loadMessages(msg.chatId);
  const row = rows.find((m) => m.id === msg.artifactId);
  if (!row || !isPlanArtifact(row.metadata)) {
    return fail(type, id, PLAN_NOT_FOUND);
  }
  await persistPromote(msg.chatId, msg.artifactId);
  const fresh = await loadMessages(msg.chatId);
  const message = fresh.find((m) => m.id === msg.artifactId)!;
  const payload = {
    chatId: msg.chatId,
    message: publicPlan(message),
    currentPlanArtifactId: msg.artifactId,
  };
  broadcast(userId, PLAN_CURRENT_EVENT, payload);
  broadcast(userId, "message.appended", { ...payload, updated: true });
  return ok(type, id, payload);
}

case "chat.plan.apply": {
  if (!msg.chatId) return fail(type, id, "chatId is required");
  const chat = await loadChatForUser(msg.chatId, userId);
  if (!chat) return fail(type, id, "Chat not found");
  const rows = await loadMessages(msg.chatId);
  const targetId = msg.artifactId || currentPlanId(
    rows.map((r) => ({ id: r.id, metadata: r.metadata as Record<string, unknown> })),
  );
  if (!targetId) return fail(type, id, NO_CURRENT_PLAN);
  const row = rows.find((m) => m.id === targetId);
  if (!row || !isPlanArtifact(row.metadata)) {
    return fail(type, id, PLAN_NOT_FOUND);
  }
  await persistPromote(msg.chatId, targetId);
  const prefsRows = await db
    .select()
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1);
  const applyMode = resolveApplyMode(prefsRows[0]?.lastRunnableExecutionMode);
  const now = new Date();
  if (prefsRows[0]) {
    await db
      .update(userPreferences)
      .set({ activeExecutionMode: applyMode, updatedAt: now })
      .where(eq(userPreferences.userId, userId));
  } else {
    await db.insert(userPreferences).values({
      userId,
      activeExecutionMode: applyMode,
      lastRunnableExecutionMode: applyMode,
      updatedAt: now,
    });
  }
  const meta = markPendingApply(asPlanMeta(row.metadata)!, now.toISOString());
  meta.status = PLAN_STATUS_CURRENT;
  const message = await writePlanMeta(row, meta);
  const payload = {
    chatId: msg.chatId,
    message: publicPlan(message),
    currentPlanArtifactId: targetId,
    executionMode: applyMode,
    gitCommit: false,
  };
  broadcast(userId, PLAN_APPLIED_EVENT, payload);
  broadcast(userId, "message.appended", { ...payload, updated: true });
  broadcast(userId, "prefs.updated", {
    activeExecutionMode: applyMode,
    lastRunnableExecutionMode: applyMode,
  });
  return ok(type, id, payload);
}

case "chat.plan.consume": {
  if (!msg.chatId) return fail(type, id, "chatId is required");
  const chat = await loadChatForUser(msg.chatId, userId);
  if (!chat) return fail(type, id, "Chat not found");
  const rows = await loadMessages(msg.chatId);
  const pending = pendingApplyPlan(
    rows.map((r) => ({
      id: r.id,
      content: r.content,
      metadata: r.metadata as Record<string, unknown>,
    })),
  );
  if (!pending) return ok(type, id, { consumed: false });
  const dbRow = rows.find((r) => r.id === pending.id)!;
  const message = await writePlanMeta(
    dbRow,
    consumePending(asPlanMeta(dbRow.metadata)!),
  );
  const payload = { chatId: msg.chatId, message: publicPlan(message), consumed: true };
  broadcast(userId, "message.appended", { ...payload, updated: true });
  return ok(type, id, payload);
}
```

`chat.plan.apply` **no** importa git, **no** llama `agent.turn.request`, **no** toca el cwd. El payload incluye `gitCommit: false` congelado.

- [ ] En `agent.turn.request`, después de resolver daemon y **antes** de `hub.sendTo`, cargar mensajes, `pendingApplyPlan`, y si hay:

```ts
const planBrief = String(pending.content || "");
```

Añadir al dispatch:

```ts
planBrief: planBrief || undefined,
planArtifactId: pending?.id,
executionMode: /* el de prefs si plan 3 ya lo estampa; no pisar */,
```

No consumir aquí: si el daemon no llega a correr, el brief debe sobrevivir. Consume lo hace `publishAgentTurn` (Task 4) tras append del user.

- [ ] En `chat.get` (handlers **y** `GET /chats/:chatId` en `api/src/routes/workspaces.ts`), añadir al JSON:

```ts
currentPlanArtifactId: currentPlanId(
  messages.map((m) => ({
    id: m.id,
    metadata: (m.metadata as Record<string, unknown> | null) ?? null,
  })),
),
```

- [ ] En `api/openapi/openapi.yaml`:

  1. Descripción de `/ws`: añadir `chat.plan.list|update|setCurrent|apply|consume` y push `chat.plan.created|updated|applied|current`.
  2. `GET /chats/{chatId}` schema: `currentPlanArtifactId` nullable string.
  3. `GET /providers` / PUT preferences: `lastRunnableExecutionMode`.

- [ ] Crear `api/src/ws/plan-handlers.test.ts` **sin** Postgres: testear que el source de `handlers.ts` no contiene `git commit`, `git-exec`, `runGit(` ni `child_process`. Test de texto:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

const src = readFileSync(new URL("./handlers.ts", import.meta.url), "utf8");

test("apply does not commit", () => {
  expect(src).toContain("chat.plan.apply");
  expect(src).toContain("gitCommit: false");
  expect(src).not.toContain("runGit");
  expect(src).not.toContain("git commit");
  expect(src).not.toContain("git-exec");
});

test("stream.end promotes plan_artifact", () => {
  expect(src).toContain("PLAN_CREATED_EVENT");
  expect(src).toContain("persistPromote");
});
```

(Ajustar a los identificadores reales que quedaron: si se inlinó el string `"chat.plan.created"` en vez de la constante, assert ese string.)

- [ ] Correr:

```bash
cd api && bun test src/llm/plan-artifact.test.ts src/ws/plan-handlers.test.ts src/routes/providers.last-runnable.test.ts
```

- [ ] Commit:

```bash
git add api/src/ws/protocol.ts api/src/ws/handlers.ts \
  api/src/routes/workspaces.ts api/openapi/openapi.yaml \
  api/src/ws/plan-handlers.test.ts
git commit -m "feat(plan-artifact): WS create/edit/apply without git"
```

---

## Task 4: Daemon — tag del turn plan + brief en el siguiente turn

**Files:**

- Modify: `cli/src/llm/publish-turn.ts`
- Modify: `cli/src/ws/client.ts`
- Modify: `cli/src/ws/daemon.ts`
- Modify: `tui/src/App.tsx` (solo el `onPush` de `agent.turn.dispatch` / `publishAgentTurn` — el render es Task 6)
- Test: `cli/src/llm/publish-turn.plan.test.ts`

El filesystem sigue solo en el daemon. El brief es texto ya persistido.

- [ ] En `cli/src/ws/client.ts`, ampliar `WsRequest` con `artifactId?: string` y `markdown?: string` (igual que protocol).

- [ ] En `cli/src/llm/publish-turn.ts`:

  1. Ampliar `ProvidersResponse` con `activeExecutionMode?: string | null` y `lastRunnableExecutionMode?: string | null`.
  2. Ampliar input:

```ts
export async function publishAgentTurn(input: {
  client: ChavezWsClient;
  chatId: string;
  prompt: string;
  cwd: string;
  token?: string;
  skipUserAppend?: boolean;
  executionMode?: string;
  planBrief?: string;
}): Promise<string> {
```

  3. Tras `chat.get` (ya existe), **antes** de append user:

```ts
import {
  buildApplyPrompt,
  extractPlanMarkdown,
  pendingApplyPlan,
  PLAN_ARTIFACT_KIND,
} from "./plan-artifact";
import { parseExecutionMode } from "./execution-mode";
```

Si `./execution-mode` **no** existe, inlinar:

```ts
function parseExecutionMode(v: unknown): "plan" | "auto" | "ask" {
  return v === "plan" || v === "auto" || v === "ask" ? v : "ask";
}
```

  4. Resolver modo:

```ts
const mode = parseExecutionMode(
  input.executionMode ?? providers.activeExecutionMode,
);
```

  5. Brief: `input.planBrief` gana; si no, `pendingApplyPlan` sobre `dbMessages`. Si hay markdown:

```ts
prompt = buildApplyPrompt(prompt, String(planRow?.content || input.planBrief));
```

usar esa `prompt` tanto en `chat.append` user como en `runClaudeTurn`. El user message que se persiste es el **prompt original del usuario** (sin el wrapper), y el wrapper va **solo** al LLM:

```ts
const userVisible = input.prompt;
const llmPrompt = planMarkdown
  ? buildApplyPrompt(userVisible, planMarkdown)
  : userVisible;
```

Así la timeline no duplica el plan entero en el user bubble. Metadata del user append:

```ts
metadata: {
  executionMode: mode,
  ...(planMarkdown
    ? { appliedPlanArtifactId: planRow?.id || true, kind: "plan_apply" }
    : {}),
},
```

  6. Tras un append user que usó brief, `client.request({ type: "chat.plan.consume", chatId })`. Si falla, log y seguir: un brief doble es peor que perder el flag, pero el consume es best-effort **después** de append (si append falla, no consumir).

  7. `chat.stream.end`:

```ts
await client.request(
  {
    type: "chat.stream.end",
    chatId,
    streamId,
    content:
      mode === "plan" ? extractPlanMarkdown(result) || result : result,
    metadata:
      mode === "plan"
        ? { kind: PLAN_ARTIFACT_KIND, executionMode: "plan" }
        : { executionMode: mode },
  },
  60_000,
);
```

Si `result` recortado queda vacío en modo plan, mandar `result` crudo: Task 3 no promociona si extract queda vacío **y** kind no viaja… aquí kind **sí** viaja, así que un plan de una línea sigue siendo artefacto.

- [ ] Extraer la resolución brief+mode a `cli/src/llm/plan-turn.ts` para testearla sin SDK:

```ts
export function resolveTurnPrompt(input: {
  userPrompt: string;
  executionMode: string;
  planBrief?: string | null;
  pendingMarkdown?: string | null;
}): { llmPrompt: string; userVisible: string; usedPlan: boolean } {
  const pending = input.planBrief || input.pendingMarkdown || "";
  const usedPlan = Boolean(pending.trim());
  return {
    userVisible: input.userPrompt,
    usedPlan,
    llmPrompt: usedPlan
      ? buildApplyPrompt(input.userPrompt, pending)
      : input.userPrompt,
  };
}

export function streamEndMetadata(mode: string): Record<string, unknown> {
  return mode === "plan"
    ? { kind: PLAN_ARTIFACT_KIND, executionMode: "plan" }
    : { executionMode: mode };
}
```

`publish-turn.ts` llama estas dos. Cero git.

- [ ] Test `cli/src/llm/publish-turn.plan.test.ts` (importa `resolveTurnPrompt` / `streamEndMetadata`):

```ts
test("plan turn tags artifact kind", () => {
  expect(streamEndMetadata("plan").kind).toBe("plan_artifact");
  expect(streamEndMetadata("ask").kind).toBeUndefined();
});

test("apply brief prepends markdown without copy-paste from user", () => {
  const r = resolveTurnPrompt({
    userPrompt: "go",
    executionMode: "ask",
    pendingMarkdown: "## Do the thing",
  });
  expect(r.usedPlan).toBe(true);
  expect(r.userVisible).toBe("go");
  expect(r.llmPrompt).toContain("## Do the thing");
  expect(r.llmPrompt).toContain("did not commit");
});

test("no pending → prompt intact", () => {
  const r = resolveTurnPrompt({
    userPrompt: "hello",
    executionMode: "plan",
  });
  expect(r.llmPrompt).toBe("hello");
  expect(r.usedPlan).toBe(false);
});
```

- [ ] En `cli/src/ws/daemon.ts`, el `onPush` de `agent.turn.dispatch` ya pasa `prompt`. Ampliar el destructuring:

```ts
const data = (msg.data || {}) as {
  chatId?: string;
  prompt?: string;
  path?: string;
  planBrief?: string;
  executionMode?: string;
};
```

y pasar `planBrief` / `executionMode` a `publishAgentTurn`.

- [ ] En `tui/src/App.tsx`, el handler `agent.turn.dispatch` igual: leer `planBrief` / `executionMode` y pasarlos a `publishAgentTurn`. **No** cambies el render de messages todavía.

- [ ] Correr:

```bash
cd cli && bun test src/llm/plan-artifact.test.ts src/llm/publish-turn.plan.test.ts
```

- [ ] Commit:

```bash
git add cli/src/llm/publish-turn.ts cli/src/llm/plan-turn.ts \
  cli/src/llm/publish-turn.plan.test.ts cli/src/ws/client.ts \
  cli/src/ws/daemon.ts tui/src/App.tsx
git commit -m "feat(plan-artifact): tag plan turns and inject apply brief"
```

---

## Task 5: CLI headless — list/get/update/current/apply + watch

**Files:**

- Modify: `cli/src/commands/headless.ts`
- Modify: `cli/src/index.ts`
- Modify: `cli/src/llm/watch-format.ts` (si existe; si no, el `onPush` de watch ya dumpa JSON — añadir un `console.error` humano para `chat.plan.*`)
- Test: `cli/src/commands/headless-plan.test.ts`

- [ ] En `cli/src/commands/headless.ts`, dentro de `group === "chat"`, **antes** del `throw` de uso, añadir `action === "plan"`:

```ts
if (action === "plan") {
  const sub = rest[0];
  const chatId = rest[1];
  if (!sub || !chatId) {
    throw new Error(
      "Uso: chavez headless chat plan <list|get|update|current|apply> <chatId> …",
    );
  }
  if (sub === "list") {
    const res = await client.request({ type: "chat.plan.list", chatId });
    if (!res.ok) throw new Error(res.error);
    console.log(JSON.stringify(res.data, null, 2));
    return;
  }
  if (sub === "get") {
    const artifactId = rest[2];
    const res = await client.request({ type: "chat.plan.list", chatId });
    if (!res.ok) throw new Error(res.error);
    const data = res.data as {
      currentPlanArtifactId?: string | null;
      plans?: Array<{ id: string; content: string; metadata?: unknown }>;
    };
    const id = artifactId || data.currentPlanArtifactId;
    const plan = data.plans?.find((p) => p.id === id);
    if (!plan) throw new Error(NO_CURRENT_PLAN);
    process.stdout.write(plan.content.endsWith("\n") ? plan.content : `${plan.content}\n`);
    return;
  }
  if (sub === "update") {
    const artifactId = rest[2];
    if (!artifactId) {
      throw new Error("Uso: … chat plan update <chatId> <artifactId> [--stdin]");
    }
    const markdown = rest.includes("--stdin")
      ? await Bun.stdin.text()
      : rest.filter((a) => a !== "--stdin").slice(3).join(" ");
    const res = await client.request({
      type: "chat.plan.update",
      chatId,
      artifactId,
      markdown,
    });
    if (!res.ok) throw new Error(res.error);
    console.log(JSON.stringify(res.data, null, 2));
    return;
  }
  if (sub === "current") {
    const artifactId = rest[2];
    if (!artifactId) {
      throw new Error("Uso: … chat plan current <chatId> <artifactId>");
    }
    const res = await client.request({
      type: "chat.plan.setCurrent",
      chatId,
      artifactId,
    });
    if (!res.ok) throw new Error(res.error);
    console.log(JSON.stringify(res.data, null, 2));
    return;
  }
  if (sub === "apply") {
    const artifactId = rest[2];
    const res = await client.request({
      type: "chat.plan.apply",
      chatId,
      artifactId,
    });
    if (!res.ok) throw new Error(res.error);
    const data = res.data as { executionMode?: string; gitCommit?: boolean };
    if (data.gitCommit) {
      throw new Error("apply must not commit");
    }
    console.log(JSON.stringify(res.data, null, 2));
    console.log(
      `Mode → ${data.executionMode}. Next chat ask will use the current plan as brief. No git commit.`,
    );
    return;
  }
  throw new Error(
    "Uso: chavez headless chat plan <list|get|update|current|apply> <chatId> …",
  );
}
```

Importar `NO_CURRENT_PLAN` desde `../llm/plan-artifact`.

Actualizar el `throw` de uso de `chat` a `create|list|append|get|ask|watch|plan`.

- [ ] En `cli/src/index.ts` `usage()` añadir:

```
  chavez headless chat plan list|get|update|current|apply <chatId> …
```

- [ ] Si el compositor slash existe (`cli/src/llm/slash.ts`), añadir id `"apply"`:

  - parse `/apply` → `{ id: "apply" }`
  - `runSlash` llama `io.request({ type: "chat.plan.apply", chatId })` y append `slash_result` `"Plan aplicado. Modo {executionMode}. El siguiente turn usará el brief."`
  - **No** cambiar `/plan` (sigue siendo mode plan).

  Si no existe slash.ts, en `headless.ts` `chat ask`: si `prompt.trim() === "/apply"`, despachar `chat.plan.apply` y **no** `agent.turn.request`.

- [ ] Watch: en el `onPush` de `chat watch`, si `msg.type.startsWith("chat.plan.")`:

```ts
console.error(`[plan] ${msg.type}`);
```

El JSON completo ya se imprime.

- [ ] Test `cli/src/commands/headless-plan.test.ts` — no spawn. Extraer el parser de subcomando a `cli/src/commands/plan-argv.ts`:

```ts
export function parsePlanArgv(rest: string[]): {
  sub: "list" | "get" | "update" | "current" | "apply";
  chatId: string;
  artifactId?: string;
  stdin: boolean;
} {
  const sub = rest[0];
  const chatId = rest[1];
  const allowed = ["list", "get", "update", "current", "apply"] as const;
  if (!allowed.includes(sub as (typeof allowed)[number]) || !chatId) {
    throw new Error(
      "Uso: chavez headless chat plan <list|get|update|current|apply> <chatId> …",
    );
  }
  return {
    sub: sub as (typeof allowed)[number],
    chatId,
    artifactId: rest[2] && rest[2] !== "--stdin" ? rest[2] : undefined,
    stdin: rest.includes("--stdin"),
  };
}
```

Tests: list requiere chatId; apply acepta artifactId opcional (`rest[2]` ausente → undefined); string de uso congelado.

- [ ] Correr:

```bash
cd cli && bun test src/llm/plan-artifact.test.ts src/commands/headless-plan.test.ts
```

- [ ] Commit:

```bash
git add cli/src/commands/headless.ts cli/src/commands/plan-argv.ts \
  cli/src/commands/headless-plan.test.ts cli/src/index.ts \
  cli/src/llm/watch-format.ts cli/src/llm/slash.ts
git commit -m "feat(plan-artifact): headless plan list/get/update/apply"
```

(`watch-format.ts` / `slash.ts` solo si se modificaron.)

---

## Task 6: TUI — card distinta + apply + live edit

**Files:**

- Modify: `tui/src/App.tsx`

Gherkin: se ve distinto de un assistant suelto; TUI ve la versión nueva tras editar en Web; apply usa el current.

- [ ] Ampliar el type:

```ts
type Message = {
  id: string;
  role: string;
  content: string;
  metadata?: Record<string, unknown> | null;
};
```

`loadChat` ya asigna `messages` del `chat.get`; no filtrar metadata.

- [ ] Importar `isPlanArtifact`, `asPlanMeta`, `PLAN_STATUS_CURRENT`, `PLAN_APPLIED_EVENT`, `PLAN_UPDATED_EVENT`, `PLAN_CREATED_EVENT`, `PLAN_CURRENT_EVENT` desde `../../cli/src/llm/plan-artifact`.

- [ ] En el `onPush` existente, añadir `msg.type.startsWith("chat.plan.")` y `prefs.updated` al mismo branch que recarga `loadChat`. Si `prefs.updated` trae `activeExecutionMode` y el state `executionMode` del plan 3 existe, setearlo; si el state **no** existe aún, mostrar el modo en `log`:

```ts
if (msg.type === "prefs.updated") {
  const mode = (msg.data as { activeExecutionMode?: string })?.activeExecutionMode;
  if (mode) setLog(`Mode → ${mode}`);
}
if (msg.type.startsWith("chat.plan.") && data.chatId === activeChatIdRef.current) {
  void loadChat(data.chatId);
  if (msg.type === PLAN_UPDATED_EVENT) setLog("Plan actualizado (Web)");
  if (msg.type === PLAN_APPLIED_EVENT) {
    const em = (msg.data as { executionMode?: string })?.executionMode;
    setLog(`Plan aplicado → modo ${em}. Siguiente turn usará el brief.`);
  }
}
```

- [ ] Reemplazar el map de Messages (hoy `messages.slice(-8)` con `role: content`) por:

```tsx
{messages.slice(-10).map((m) => {
  if (isPlanArtifact(m.metadata)) {
    const meta = asPlanMeta(m.metadata)!;
    const current = meta.status === PLAN_STATUS_CURRENT;
    const title = (m.content || "").split("\n").find((l) => l.trim()) || "(plan)";
    return (
      <Text key={m.id} wrap="truncate-end">
        <Text color={current ? "cyan" : "blue"} bold={current}>
          {current ? "plan · current" : "plan · history"}
          {meta.pendingApply ? " · apply-next" : ""}
          {` r${meta.revision}`}:{" "}
        </Text>
        {title.replace(/\s+/g, " ").slice(0, 90)}
      </Text>
    );
  }
  return (
    <Text key={m.id} wrap="truncate-end">
      <Text color={m.role === "assistant" ? "green" : "magenta"}>
        {m.role}:{" "}
      </Text>
      {m.content.replace(/\s+/g, " ").slice(0, 100)}
    </Text>
  );
})}
```

Un assistant **sin** `kind=plan_artifact` sigue verde `assistant:`. El plan es cyan/blue con badge. Eso cumple “distinto de un assistant suelto”.

- [ ] Tecla `a` en command mode (junto a `m`/`s`/`c`, **bloqueada** si `busy`):

```ts
if (ch === "a" && client && activeChatId) {
  const res = await client.request({
    type: "chat.plan.apply",
    chatId: activeChatId,
  });
  if (!res.ok) setLog(res.error || "chat.plan.apply failed");
  else {
    const data = res.data as { executionMode?: string; gitCommit?: boolean };
    if (data.gitCommit) setLog("BUG: apply committed");
    else {
      setLog(
        `Plan aplicado → ${data.executionMode}. Enter en compose dispara el turn con brief.`,
      );
    }
  }
  return;
}
```

TUI **no** edita markdown (Gherkin: editar en Web). Apply sí.

- [ ] Interceptar compose Enter: si `input.trim() === "/apply"`, llamar el mismo `chat.plan.apply` y **no** `sendWithLlm`.

- [ ] Footer de ayuda: añadir `[a] apply plan` a la línea dimColor.

- [ ] Commit:

```bash
git add tui/src/App.tsx
git commit -m "feat(plan-artifact): TUI plan cards, apply key, live updates"
```

---

## Task 7: Web — PlanCard editable, aplicar, historial

**Files:**

- Create: `web/src/components/PlanCard.tsx`
- Modify: `web/src/components/ChatDetailPanel.tsx`
- Modify: `web/src/components/WorkspaceDetailPanel.tsx`
- Modify: `web/src/lib/ws-hooks.ts`
- Modify: `web/src/lib/ws-client.ts`
- Modify: `web/src/lib/ws-context.tsx`
- Modify: `web/src/lib/hooks.ts`
- Modify: `web/src/styles/global.css`
- Test: `web/src/lib/plan-artifact.test.ts` (ya en Task 1)

Verificar en desktop **y** mentalmente el CSS de `.plan-card` (no hay browser tools en este plan de docs; el implementador **sí** debe abrir `/chats/:id`).

- [ ] En `web/src/lib/ws-client.ts` y el `request` de `web/src/lib/ws-context.tsx`, añadir `artifactId?: string` y `markdown?: string` al payload parcial.

- [ ] En `web/src/lib/hooks.ts`, ampliar `Chat` (opcional) no es necesario: `useChat` ya devuelve `{ chat, messages }`. El GET ahora trae `currentPlanArtifactId`. Ampliar el type de `useChat` data:

```ts
export type ChatDetail = {
  chat: Chat;
  messages: ChatMessage[];
  currentPlanArtifactId?: string | null;
};
```

Si `useChat` está tipado en línea, ajustar ahí.

- [ ] En `web/src/lib/ws-hooks.ts`:

```ts
export function useWsPlanUpdate() {
  const ws = useWs();
  return useMutation({
    mutationFn: (input: {
      chatId: string;
      artifactId: string;
      markdown: string;
    }) =>
      ws.request({
        type: "chat.plan.update",
        chatId: input.chatId,
        artifactId: input.artifactId,
        markdown: input.markdown,
      }),
  });
}

export function useWsPlanApply() {
  const ws = useWs();
  return useMutation({
    mutationFn: (input: { chatId: string; artifactId?: string }) =>
      ws.request({
        type: "chat.plan.apply",
        chatId: input.chatId,
        artifactId: input.artifactId,
      }),
  });
}

export function useWsPlanSetCurrent() {
  const ws = useWs();
  return useMutation({
    mutationFn: (input: { chatId: string; artifactId: string }) =>
      ws.request({
        type: "chat.plan.setCurrent",
        chatId: input.chatId,
        artifactId: input.artifactId,
      }),
  });
}
```

- [ ] Crear `web/src/components/PlanCard.tsx`:

```tsx
import { useState } from "react";
import type { ChatMessage } from "../lib/hooks";
import {
  asPlanMeta,
  PLAN_STATUS_CURRENT,
} from "../lib/plan-artifact";

export function PlanCard({
  m,
  onSave,
  onApply,
  onSetCurrent,
  busy,
}: {
  m: ChatMessage;
  onSave: (markdown: string) => Promise<void>;
  onApply: () => Promise<void>;
  onSetCurrent: () => Promise<void>;
  busy?: boolean;
}) {
  const meta = asPlanMeta(m.metadata)!;
  const current = meta.status === PLAN_STATUS_CURRENT;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(m.content);
  const [err, setErr] = useState<string | null>(null);

  return (
    <div className={`panel plan-card ${current ? "plan-current" : "plan-history"}`}>
      <div className="plan-card-head">
        <span className={`badge ${current ? "ok" : ""}`}>
          plan · {meta.status}
          {meta.pendingApply ? " · apply-next" : ""}
          {` · r${meta.revision}`}
        </span>
        {meta.appliedAt && (
          <span className="muted"> aplicado {meta.appliedAt}</span>
        )}
      </div>
      {editing ? (
        <textarea
          className="plan-editor"
          rows={16}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
      ) : (
        <pre className="plan-body">{m.content}</pre>
      )}
      {err && <p className="error">{err}</p>}
      <div className="plan-actions">
        {editing ? (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                setErr(null);
                try {
                  await onSave(draft);
                  setEditing(false);
                } catch (e) {
                  setErr(e instanceof Error ? e.message : String(e));
                }
              }}
            >
              Guardar
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setDraft(m.content);
                setEditing(false);
                setErr(null);
              }}
            >
              Cancelar
            </button>
          </>
        ) : (
          <button type="button" className="secondary" onClick={() => setEditing(true)}>
            Editar
          </button>
        )}
        {current ? (
          <button type="button" disabled={busy} onClick={() => void onApply().catch((e) => setErr(e instanceof Error ? e.message : String(e)))}>
            Aplicar
          </button>
        ) : (
          <button type="button" className="secondary" disabled={busy} onClick={() => void onSetCurrent()}>
            Marcar actual
          </button>
        )}
      </div>
    </div>
  );
}
```

- [ ] En `ChatDetailPanel.tsx`:

  1. Importar `PlanCard`, `isPlanArtifact`, hooks de plan, `formatQueryError`.
  2. En el `onPush`, invalidar `queryKeys.chat(chatId)` también para `chat.plan.*` y `prefs.updated`.
  3. En el map de messages: `isPlanArtifact(m.metadata) ? <PlanCard .../> : tool ? ToolCard : panel role`.
  4. `onSave` → `planUpdate.mutateAsync({ chatId, artifactId: m.id, markdown })` + invalidate.
  5. `onApply` → `planApply.mutateAsync({ chatId, artifactId: m.id })`. Si `data.gitCommit` es true, mostrar error. Banner bajo el compositor:

```tsx
{messages.some((m) => asPlanMeta(m.metadata)?.pendingApply) && (
  <p className="ok">
    Plan listo. El próximo envío al agente lo usa como brief (modo{" "}
    {asPlanMeta(messages.find((m) => asPlanMeta(m.metadata)?.pendingApply)?.metadata)?.status
      ? "ask/auto"
      : "ask/auto"}
    ). No se ha hecho git commit.
  </p>
)}
```

  Simplificar el banner: guardar `applyMode` del payload `chat.plan.applied` en state `appliedMode: string | null`.

  6. Interceptar `onAgent`: si `prompt.trim() === "/apply"`, llamar apply y return (no `agent.turn.request`).
  7. `onSetCurrent` → `planSetCurrent.mutateAsync`.

- [ ] En `WorkspaceDetailPanel.tsx` `previewLabel`: si `isPlanArtifact(m.metadata)`, devolver `plan · {status}` en vez del truncate de assistant.

- [ ] En `web/src/styles/global.css`:

```css
.plan-card {
  border-color: color-mix(in srgb, var(--accent) 55%, var(--border));
  box-shadow: inset 4px 0 0 var(--accent);
}
.plan-card.plan-history {
  opacity: 0.78;
  box-shadow: inset 4px 0 0 var(--muted);
}
.plan-card-head {
  display: flex;
  gap: 0.5rem;
  align-items: baseline;
  flex-wrap: wrap;
}
.plan-body {
  white-space: pre-wrap;
  margin: 0.75rem 0 0;
  font-family: var(--mono);
  font-size: 0.85rem;
}
.plan-editor {
  width: 100%;
  min-height: 16rem;
  font-family: var(--mono);
  font-size: 0.85rem;
  margin-top: 0.75rem;
}
.plan-actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
  margin-top: 0.75rem;
}
```

- [ ] Si `ProvidersPanel.tsx` ya tiene el select de modo (plan 3), no tocarlo. Apply hace PUT vía WS handler (Task 3) y `prefs.updated` refresca el select.

- [ ] Commit:

```bash
git add web/src/components/PlanCard.tsx web/src/components/ChatDetailPanel.tsx \
  web/src/components/WorkspaceDetailPanel.tsx web/src/lib/ws-hooks.ts \
  web/src/lib/ws-client.ts web/src/lib/ws-context.tsx web/src/lib/hooks.ts \
  web/src/styles/global.css
git commit -m "feat(plan-artifact): Web PlanCard edit/apply and live sync"
```

---

## Task 8: Compact pin, smoke E2E, git no-commit

**Files:**

- Modify: `cli/src/llm/compact.ts` (solo si existe `extractLastPlan`)
- Create: `cli/scripts/plan-artifact-smoke.ts`
- Modify: `cli/src/llm/history.ts` (no filtrar plan_artifact; documentar)

- [ ] Si `cli/src/llm/compact.ts` exporta `extractLastPlan`, cambiar el loop para **preferir** `status === "current"`:

```ts
export function extractLastPlan(messages: ChatRow[]): string | null {
  let fallback: string | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    const meta = rec(m.metadata);
    if (!meta) continue;
    const text =
      typeof m.content === "string" && m.content.trim() ? m.content : null;
    if (!text) continue;
    if (meta.kind === "plan_artifact") {
      if (meta.status === "current") return clip(text, PINNED_PLAN_MAX_CHARS);
      if (!fallback) fallback = clip(text, PINNED_PLAN_MAX_CHARS);
      continue;
    }
    if (m.role === "assistant" && meta.executionMode === "plan" && !fallback) {
      fallback = clip(text, PINNED_PLAN_MAX_CHARS);
    }
  }
  return fallback;
}
```

Añadir un caso en `cli/src/llm/compact.test.ts` (si existe) o `cli/src/llm/plan-artifact.test.ts`: current gana sobre un history más nuevo no puede pasar (history es más viejo); current gana sobre un history posterior si el usuario re-marcó uno viejo.

- [ ] En `cli/src/llm/history.ts`, no hace falta filtrar: `plan_artifact` es `assistant`. Añadir un comentario de una línea sobre el user `metadata.kind === "plan_apply"`: el content del user es la instrucción corta; el brief lo prepende `publishAgentTurn` al LLM, no `historyFromChatMessages`. **No** meter el wrapper dos veces: `historyFromChatMessages` usa el content persistido (sin wrapper).

- [ ] Crear `cli/scripts/plan-artifact-smoke.ts`. Mismo patrón de login/token que `cli/scripts/ws-sync-smoke.ts` / `cli/scripts/tui-sync-smoke.ts` (leer esos files e igualar `loadConfig` + dos clientes). Flujo:

  1. Bind daemon (`clientKind: "daemon"`) + bind web (`clientKind: "client"`) al mismo cwd.
  2. `session.create` + `chat.create`.
  3. PUT `/providers/preferences` `{ activeExecutionMode: "auto" }` — snapshot lastRunnable=auto. Luego PUT `{ activeExecutionMode: "plan" }`.
  4. Escuchar en web `chat.plan.created` **y** `message.appended`.
  5. `agent.turn.request` prompt `"Escribe un plan corto con un heading y dos bullets para añadir un README de smoke."` Timeout 180s. Si no hay Claude vinculado, imprimir `"SKIP: claude not linked"` y `process.exit(0)`.
  6. Assert: el mensaje creado tiene `metadata.kind === "plan_artifact"` y `status === "current"`. El cliente web recibió `chat.plan.created`.
  7. `chat.plan.update` con markdown `"# Edited plan\n\n- step one\n"`. Assert web recibe `chat.plan.updated` y `chat.get` devuelve el texto nuevo.
  8. Segundo turn plan (`"Otro plan distinto"`). Assert: el nuevo es `current`, el editado quedó `history`. `chat.plan.list` tiene 2.
  9. `chat.plan.setCurrent` al primero. Assert current id = primero.
  10. `git rev-parse HEAD` en cwd **antes** de apply (si no es repo, `headBefore = "NOT_A_REPO"`).
  11. `chat.plan.apply`. Assert `data.executionMode === "auto"` (lastRunnable), `data.gitCommit === false`. GET `/providers` `activeExecutionMode === "auto"`.
  12. `git rev-parse HEAD` después === antes. Si no era repo, sigue sin `.git`.
  13. `agent.turn.request` prompt `"go"`. El daemon debe haber usado brief: no hay assert de tokens, pero `chat.plan.consume` deja `pendingApply === false` en `chat.get`.
  14. Print `SMOKE PASS`.

Si el daemon está busy: `process.exit(1)` con el error. No reintentar en bucle.

Cabecera del script:

```ts
/**
 * Smoke: plan artifact create / edit / current / apply (no git commit).
 * Requires: logged in CLI, Claude linked, API up, empty-enough daemon.
 * Usage: bun run cli/scripts/plan-artifact-smoke.ts
 */
```

- [ ] Correr unitarios:

```bash
cd cli && bun test src/llm/plan-artifact.test.ts src/llm/publish-turn.plan.test.ts src/commands/headless-plan.test.ts
cd api && bun test src/llm/plan-artifact.test.ts src/ws/plan-handlers.test.ts src/routes/providers.last-runnable.test.ts
cd web && bun test src/lib/plan-artifact.test.ts
```

Esperado: todos pasan.

- [ ] Smoke (si API + login + Claude):

```bash
bun run cli/scripts/plan-artifact-smoke.ts
```

Si no hay entorno, el implementador deja constancia en el commit message body; **no** borra el script.

- [ ] Commit:

```bash
git add cli/src/llm/compact.ts cli/src/llm/history.ts \
  cli/scripts/plan-artifact-smoke.ts cli/src/llm/compact.test.ts
git commit -m "test(plan-artifact): smoke create/edit/apply without git commit"
```

---

## Verificación Gherkin → tasks

| Escenario | Tasks |
|---|---|
| Turn en modo plan crea artefacto; Web/TUI distinto de assistant suelto | 3, 4, 6, 7 |
| Editar markdown en Web → persiste → TUI ve la versión nueva | 3, 6, 7 |
| Aplicar → modo ask o auto (lastRunnable) → siguiente turn usa brief, sin copy-paste | 2, 3, 4, 5, 6, 7 |
| Varios planes: se aplica el current; viejos en historial | 1, 3, 6, 7 |
| Apply no commitea; el agente puede proponer commit en el turn de aplicación | 3, 4, 8 |

## Fuera de alcance (no implementar)

- Cursor cloud / agentes cloud.
- Escribir `PLAN.md` al cwd.
- Auto-dispatch del turn al pulsar Aplicar (el siguiente `ask` / Enter / `chat ask` hidrata el brief).
- `/plan` como creación de artefacto (sigue siendo atajo de modo).
- Lote, “siempre permitir”, notificaciones OS/email.
- Git commit/push/PR (plan 7) — solo el preamble autoriza a **proponerlos** en el turn de aplicación.
- Cola de turns, worktrees, voz, extensión IDE, upload desde el navegador.
