# Onboarding Implementation Plan

> **For agentic workers:** Execute task-by-task. Do not skip tests. Do not implement Cursor cloud, voz, extensión IDE, upload desde el navegador, org/roles, notificaciones OS/email, cola de turns (plan 29), reconnect/heartbeat (plan 17), ni Cursor ejecutable (plan 4). Spec: [`plan.md`](./plan.md). Si un sibling (`execution-modes`, `daemon-reconnect`, `invariants`, `cursor-provider`) ya creó un archivo citado, **extiéndelo**; no lo reescribas. El wizard es UI: **nunca** 401/403/409 en `/providers`, `/workspaces`, `workspace.bind` ni `agent.turn.request` porque el onboarding esté `pending`.

**Goal:** Un usuario nuevo llega al primer turn sin leer el README. Tras sign-up, el hub Web muestra tres pasos (vincular provider, cómo abrir un workspace con el daemon, ir a un chat) y **no** pinta un workspace vacío como si ya hubiera runner. Tras `chavez login`, `whoami` (o el propio login) explica `provider link` → `tui` / `workspace open` → `chat ask`. Un `ask` sin provider o sin daemon falla con **el siguiente paso concreto**. Con provider runnable vinculado y daemon bound, el primer prompt corre; Web y TUI muestran stream o un error accionable; el wizard se marca completo. Saltar el wizard no bloquea API ni headless.

**Architecture:** El filesystem y el runner viven en el proceso daemon (`cli/src/ws/daemon.ts` o TUI con `clientKind: "daemon"`). La API **no** abre workspaces ni ejecuta turns: persiste `onboardingStatus` en `user_preferences`, deriva los tres pasos (vault + hub + status) y hace fan-out de `onboarding.updated`. Web/CLI/TUI leen el mismo GET. Skip y complete son PUT; el primer `agent.turn.request` **aceptado** (dispatch al daemon) también completa. Un bind de la Web es `clientKind: "client"` y **nunca** cuenta como daemon.

```
Sign-up Web / chavez login
        |
        v
GET /me/onboarding
  derive(status, runnableLinked, daemonBound)
    1. provider  → vault con provider runnable linked (Claude hoy)
    2. daemon    → hub.findAnyDaemon(userId)
    3. chat      → status === completed (primer turn aceptado)
  wizardVisible ⇔ status === "pending"
        |
        +-- Web Hub  OnboardingWizard (3 pasos + Saltar)
        |    Workspaces vacío → EMPTY_WORKSPACE_COPY (no fake runner)
        +-- CLI login/whoami  printOnboardingHint si pending
        |    chat ask  preflight → NO_PROVIDER_ASK | NO_DAEMON_ERROR
        +-- TUI banner pending; compose no bloquea
        |
Skip  PUT { action: "skip" }     → wizard hidden; API/headless iguales
Turn  agent.turn.request ok      → mark completed + onboarding.updated
        |
Web/TUI: stream o error accionable (mismo string que CLI)
```

Estado actual que este plan extiende (no reescribir):

- Tras sign-up, `web/src/components/SignInForm.tsx` redirige a `/`. `HubPanel.tsx` muestra “Providers vinculados: 0 · Workspaces: 0” y un grid de API/CLI/Workspaces — **no** hay wizard ni pasos.
- `WorkspacesPanel.tsx` ofrece `workspace.bind` de un path absoluto desde el **navegador** (`clientKind` default `"client"`). Crea fila en `workspaces` y cuenta `openConnections` (incluye el socket web). Eso se ve como un workspace listo. `agent.turn.request` luego falla con `NO_DAEMON_ERROR`.
- `WorkspaceDetailPanel.tsx` pinta `openConnections` y sessions/chats vacíos. No distingue daemon vs client. No dice “sin runner”.
- CLI `login.ts` termina en `"Login correcto. Sesión guardada en ~/.chavez/config.json"` y sale. `whoami.ts` imprime cwd/API/email/name. **No** hay siguiente paso.
- `headless chat ask` manda `agent.turn.request` a ciegas. Sin daemon, la API ya responde `NO_DAEMON_ERROR`. Sin provider, el request **se acepta** si hay daemon y el fallo aparece después en `publish-turn.ts` (`"Claude no está vinculado — chavez provider link claude"`). El preflight de esta fase adelanta ese error **antes** del dispatch.
- `user_preferences` tiene `activeProvider` / `activeModel` / `activeEffort` (y `activeExecutionMode` si plan 3 aterrizó). **No** hay `onboardingStatus`.
- TUI se bindea como daemon al arrancar. Si Claude no está linked, `sendWithLlm` loguea `"Claude no está vinculado — chavez provider link claude"` y no hay banner de primer uso.
- Cursor `runnable: false`. Vincular Cursor **no** completa el paso 1. El primer turn necesita un provider **runnable** (Claude hoy).
- `hub.findDaemon(userId, workspaceId)` ya existe. **No** hay `findAnyDaemon(userId)`. `countForWorkspace` cuenta **todas** las conexiones.
- No hay GET `/me/onboarding`. CORS de `/me/*` ya está en `api/src/index.ts`.

**Tech Stack:** Bun, Hono + Drizzle `user_preferences`, WebSocket hub in-memory, Better Auth (cookie Web + Bearer CLI), Ink TUI, Astro/React web. Tests: `bun test`. Web **no** importa CLI: duplicar `status.ts` en `web/src/lib/onboarding.ts` (comentario keep-in-sync). TUI importa `cli/src/onboarding/status.ts`.

**Global Constraints:**

1. El filesystem real vive en el daemon (cwd del workspace). El wizard **explica** cómo abrir el daemon; no lista ni hidrata disco desde API ni browser. Cero `readdir` / `readFile` en `api/` y `web/` por esta fase.
2. Un turn solo corre si hay daemon bound. Sin daemon, el error de `agent.turn.request` y de `chat ask` es **exactamente** `NO_DAEMON_ERROR`. No inventar un segundo string para el mismo caso.
3. Sin provider runnable vinculado, `chat ask` (CLI) y el compositor Web/TUI fallan **antes** de despachar, con `NO_PROVIDER_ASK`. No se queda un turn busy.
4. Wizard **no** es un gate. `pending` / `skipped` / `completed` no cambian 401/404/400 de auth, vault, workspaces, bind, sessions, chats ni headless. Skip = ocultar UI.
5. Pasos 1–2 se **derivan** (vault + hub). El paso 3 y skip se **persisten** en `user_preferences.onboardingStatus`. No hay tabla nueva. Un usuario = su vault; el snapshot es solo de ese `userId`.
6. Paso 1 = al menos un provider **runnable y linked**. Cursor vinculado solo no basta (plan 4 lo hará runnable). No simular un turn Cursor.
7. Paso 2 = al menos un socket `clientKind: "daemon"` del usuario. Un bind Web (`"client"`) **no** cuenta. `openConnections` crudo no se usa como “hay runner”.
8. El primer `agent.turn.request` que hace `ok` + dispatch al daemon marca `completed` y emite `onboarding.updated`. Un fail (no daemon, no chat) **no** completa. Un `chat.stream.error` posterior **sí** deja el wizard completo: el camino se recorrió; el error es accionable en la timeline.
9. Web, TUI y CLI `watch` ven el mismo stream/error del turn. El wizard es Web+CLI+TUI; `watch` no pinta pasos.
10. Preferencias de provider/modelo/esfuerzo/modo no se tocan. Completar onboarding no cambia el provider activo.
11. 1 turn por daemon. El wizard no introduce cola ni worktrees.
12. Fuera de alcance: Cursor cloud, voz, extensión IDE, upload desde el navegador, notificaciones OS/email, org, README in-app largo, tours de 10 pantallas.

**Constantes (congeladas, no inventar otras):**

| Nombre | Valor |
|---|---|
| `ONBOARDING_STATUSES` | `"pending"` \| `"skipped"` \| `"completed"` |
| `DEFAULT_ONBOARDING_STATUS` | `"pending"` |
| `ONBOARDING_STEPS` | `"provider"` \| `"daemon"` \| `"chat"` |
| `NO_DAEMON_ERROR` | `"No daemon bound for this workspace. Run: chavez headless workspace open"` |
| `NO_PROVIDER_ASK` | `"No hay provider vinculado. Siguiente paso: chavez provider link claude"` |
| `NEXT_PROVIDER` | `"Siguiente paso: chavez provider link claude"` |
| `NEXT_DAEMON` | `"Siguiente paso: chavez tui   (o: chavez headless workspace open)"` |
| `NEXT_CHAT` | `"Siguiente paso: abre un chat en TUI/Web o: chavez headless chat ask <chatId> <prompt>"` |
| `HINT_LOGIN_HEADER` | `"Primer uso — tres pasos:"` |
| `STEP_PROVIDER_LABEL` | `"Vincular provider (Claude)"` |
| `STEP_DAEMON_LABEL` | `"Abrir un workspace con el daemon"` |
| `STEP_CHAT_LABEL` | `"Ir a un chat y enviar el primer prompt"` |
| `SKIP_LABEL` | `"Saltar"` |
| `WIZARD_TITLE` | `"Primer uso"` |
| `EMPTY_WORKSPACE_COPY` | `"El filesystem vive en la máquina del daemon, no en el navegador. En el cwd del proyecto corre: chavez tui   o   chavez headless workspace open"` |
| `NO_RUNNER_LABEL` | `"sin runner"` |
| `CLIENT_BIND_HINT` | `"El navegador no es el filesystem. Bind de cliente solo crea sessions/chats; los turns necesitan el daemon."` |
| `CURSOR_NOT_RUNNABLE_HINT` | `"Cursor está vinculado pero no ejecuta turns. Para el primer turn: chavez provider link claude"` |
| `INVALID_ONBOARDING_ACTION` | `"action must be skip or complete"` |
| `ONBOARDING_EVENT` | `"onboarding.updated"` |
| `CLAUDE_NOT_LINKED_TUI` | `"Claude no está vinculado — chavez provider link claude"` (string **existente** en TUI; el preflight Web/CLI usa `NO_PROVIDER_ASK`. TUI Task 4 **unifica** el log de send al mismo `NO_PROVIDER_ASK`) |

Reusar `NO_DAEMON_ERROR` / `NO_RUNNER_LABEL` si `api/src/ws/errors.ts` o `cli/src/ws/presence-constants.ts` ya existen (invariants / daemon-reconnect). **No** cambiar esos strings. Si no existen, definir `NO_DAEMON_ERROR` en `api/src/onboarding/status.ts` y `cli/src/onboarding/status.ts` (mismo literal) y que handlers importen desde ahí **o** desde `errors.ts` si ya está.

`wizardVisible(status)` = `status == null || status === "" || status === "pending"`.

---

## Task 1: Módulo puro — snapshot, next step, visibilidad

**Files:**

- Create: `cli/src/onboarding/status.ts`
- Test: `cli/src/onboarding/status.test.ts`
- Create: `api/src/onboarding/status.ts`
- Test: `api/src/onboarding/status.test.ts`
- Create: `web/src/lib/onboarding.ts`
- Test: `web/src/lib/onboarding.test.ts`
- Modify: `cli/package.json`
- Modify: `api/package.json`
- Modify: `web/package.json`

Sin I/O de red. TUI importa CLI. API y Web **duplican** el módulo (keep-in-sync en la primera línea). Tres copias, misma semántica.

- [ ] Añadir `"test": "bun test"` en `cli/package.json`, `api/package.json` y `web/package.json` `scripts` si aún no existe (dejar `start`/`dev`/`bin`/`db:*`/`test:e2e` intactos).

- [ ] Crear `cli/src/onboarding/status.ts`:

```ts
/** keep-in-sync: api/src/onboarding/status.ts, web/src/lib/onboarding.ts */

export const ONBOARDING_STATUSES = ["pending", "skipped", "completed"] as const;
export type OnboardingStatus = (typeof ONBOARDING_STATUSES)[number];
export const DEFAULT_ONBOARDING_STATUS: OnboardingStatus = "pending";

export const ONBOARDING_STEPS = ["provider", "daemon", "chat"] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export const NO_DAEMON_ERROR =
  "No daemon bound for this workspace. Run: chavez headless workspace open";
export const NO_PROVIDER_ASK =
  "No hay provider vinculado. Siguiente paso: chavez provider link claude";
export const NEXT_PROVIDER = "Siguiente paso: chavez provider link claude";
export const NEXT_DAEMON =
  "Siguiente paso: chavez tui   (o: chavez headless workspace open)";
export const NEXT_CHAT =
  "Siguiente paso: abre un chat en TUI/Web o: chavez headless chat ask <chatId> <prompt>";
export const HINT_LOGIN_HEADER = "Primer uso — tres pasos:";
export const STEP_PROVIDER_LABEL = "Vincular provider (Claude)";
export const STEP_DAEMON_LABEL = "Abrir un workspace con el daemon";
export const STEP_CHAT_LABEL = "Ir a un chat y enviar el primer prompt";
export const SKIP_LABEL = "Saltar";
export const WIZARD_TITLE = "Primer uso";
export const EMPTY_WORKSPACE_COPY =
  "El filesystem vive en la máquina del daemon, no en el navegador. En el cwd del proyecto corre: chavez tui   o   chavez headless workspace open";
export const NO_RUNNER_LABEL = "sin runner";
export const CLIENT_BIND_HINT =
  "El navegador no es el filesystem. Bind de cliente solo crea sessions/chats; los turns necesitan el daemon.";
export const CURSOR_NOT_RUNNABLE_HINT =
  "Cursor está vinculado pero no ejecuta turns. Para el primer turn: chavez provider link claude";
export const INVALID_ONBOARDING_ACTION = "action must be skip or complete";
export const ONBOARDING_EVENT = "onboarding.updated";

export type OnboardingAction = "skip" | "complete";

export type OnboardingFacts = {
  persistedStatus: OnboardingStatus | null | undefined;
  runnableLinked: boolean;
  daemonBound: boolean;
  cursorLinkedOnly?: boolean;
};

export type OnboardingSnapshot = {
  status: OnboardingStatus;
  wizardVisible: boolean;
  steps: {
    providerLinked: boolean;
    daemonBound: boolean;
    firstTurn: boolean;
  };
  nextStep: OnboardingStep | null;
  nextCommand: string | null;
  cursorLinkedOnly: boolean;
};

export function parseOnboardingStatus(v: unknown): OnboardingStatus {
  if (v == null || v === "") return DEFAULT_ONBOARDING_STATUS;
  if (v === "pending" || v === "skipped" || v === "completed") return v;
  return DEFAULT_ONBOARDING_STATUS;
}

export function isOnboardingAction(v: unknown): v is OnboardingAction {
  return v === "skip" || v === "complete";
}

export function wizardVisible(status: OnboardingStatus): boolean {
  return status === "pending";
}

export function deriveOnboarding(facts: OnboardingFacts): OnboardingSnapshot {
  const status = parseOnboardingStatus(facts.persistedStatus);
  const providerLinked = Boolean(facts.runnableLinked);
  const daemonBound = Boolean(facts.daemonBound);
  const firstTurn = status === "completed";
  let nextStep: OnboardingStep | null = null;
  if (!providerLinked) nextStep = "provider";
  else if (!daemonBound) nextStep = "daemon";
  else if (!firstTurn) nextStep = "chat";
  if (status === "completed") nextStep = null;
  return {
    status,
    wizardVisible: wizardVisible(status),
    steps: { providerLinked, daemonBound, firstTurn },
    nextStep,
    nextCommand: commandForStep(nextStep),
    cursorLinkedOnly: Boolean(facts.cursorLinkedOnly) && !providerLinked,
  };
}

export function commandForStep(step: OnboardingStep | null): string | null {
  if (step === "provider") return NEXT_PROVIDER;
  if (step === "daemon") return NEXT_DAEMON;
  if (step === "chat") return NEXT_CHAT;
  return null;
}

/** Preflight de ask/turn. Skip no relaja esto. */
export function askPreflightError(facts: {
  runnableLinked: boolean;
  daemonBound: boolean;
}): string | null {
  if (!facts.runnableLinked) return NO_PROVIDER_ASK;
  if (!facts.daemonBound) return NO_DAEMON_ERROR;
  return null;
}

export function applyOnboardingAction(
  current: OnboardingStatus,
  action: OnboardingAction,
): OnboardingStatus {
  if (action === "complete") return "completed";
  if (current === "completed") return "completed";
  return "skipped";
}

export type WorkspaceEmptyKind = "copy" | "sin_runner" | "ready";

export function workspaceEmptyKind(opts: {
  daemonBound: boolean;
  workspaceCount: number;
}): WorkspaceEmptyKind {
  if (opts.daemonBound) return "ready";
  if (opts.workspaceCount > 0) return "sin_runner";
  return "copy";
}
```

Con `pending`, `nextStep` es el primer hueco. Con `skipped`, el hueco permanece (útil para `ask` / debug) y `wizardVisible` es false. Con `completed`, `nextStep` es `null`. `askPreflightError` **ignora** `status`: skip no deja pasar un ask sin provider/daemon.

- [ ] Crear `cli/src/onboarding/status.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  applyOnboardingAction,
  askPreflightError,
  deriveOnboarding,
  isOnboardingAction,
  NO_DAEMON_ERROR,
  NO_PROVIDER_ASK,
  NEXT_DAEMON,
  NEXT_PROVIDER,
  parseOnboardingStatus,
  wizardVisible,
  workspaceEmptyKind,
} from "./status";

describe("parseOnboardingStatus", () => {
  test("null/empty → pending", () => {
    expect(parseOnboardingStatus(null)).toBe("pending");
    expect(parseOnboardingStatus(undefined)).toBe("pending");
    expect(parseOnboardingStatus("")).toBe("pending");
  });
  test("accepts the three statuses", () => {
    expect(parseOnboardingStatus("pending")).toBe("pending");
    expect(parseOnboardingStatus("skipped")).toBe("skipped");
    expect(parseOnboardingStatus("completed")).toBe("completed");
  });
  test("typo → pending, does not throw", () => {
    expect(parseOnboardingStatus("yolo")).toBe("pending");
  });
});

describe("deriveOnboarding", () => {
  test("new account: all steps open, wizard visible", () => {
    const s = deriveOnboarding({
      persistedStatus: null,
      runnableLinked: false,
      daemonBound: false,
    });
    expect(s.status).toBe("pending");
    expect(s.wizardVisible).toBe(true);
    expect(s.steps).toEqual({
      providerLinked: false,
      daemonBound: false,
      firstTurn: false,
    });
    expect(s.nextStep).toBe("provider");
    expect(s.nextCommand).toBe(NEXT_PROVIDER);
  });

  test("provider linked, no daemon → next daemon", () => {
    const s = deriveOnboarding({
      persistedStatus: "pending",
      runnableLinked: true,
      daemonBound: false,
    });
    expect(s.nextStep).toBe("daemon");
    expect(s.nextCommand).toBe(NEXT_DAEMON);
    expect(s.wizardVisible).toBe(true);
  });

  test("provider + daemon, no turn → next chat", () => {
    const s = deriveOnboarding({
      persistedStatus: "pending",
      runnableLinked: true,
      daemonBound: true,
    });
    expect(s.nextStep).toBe("chat");
    expect(s.steps.firstTurn).toBe(false);
  });

  test("completed hides wizard and clears nextStep", () => {
    const s = deriveOnboarding({
      persistedStatus: "completed",
      runnableLinked: true,
      daemonBound: true,
    });
    expect(s.wizardVisible).toBe(false);
    expect(s.nextStep).toBe(null);
    expect(s.steps.firstTurn).toBe(true);
  });

  test("skipped hides wizard but does not fake steps", () => {
    const s = deriveOnboarding({
      persistedStatus: "skipped",
      runnableLinked: false,
      daemonBound: false,
    });
    expect(s.wizardVisible).toBe(false);
    expect(s.steps.providerLinked).toBe(false);
    expect(s.nextStep).toBe("provider");
  });

  test("cursor linked only is not providerLinked", () => {
    const s = deriveOnboarding({
      persistedStatus: "pending",
      runnableLinked: false,
      daemonBound: false,
      cursorLinkedOnly: true,
    });
    expect(s.steps.providerLinked).toBe(false);
    expect(s.cursorLinkedOnly).toBe(true);
    expect(s.nextStep).toBe("provider");
  });
});

describe("askPreflightError", () => {
  test("no provider wins over no daemon", () => {
    expect(
      askPreflightError({ runnableLinked: false, daemonBound: false }),
    ).toBe(NO_PROVIDER_ASK);
  });
  test("no daemon uses the canonical string", () => {
    expect(
      askPreflightError({ runnableLinked: true, daemonBound: false }),
    ).toBe(NO_DAEMON_ERROR);
  });
  test("ready → null", () => {
    expect(
      askPreflightError({ runnableLinked: true, daemonBound: true }),
    ).toBe(null);
  });
});

describe("applyOnboardingAction", () => {
  test("skip from pending", () => {
    expect(applyOnboardingAction("pending", "skip")).toBe("skipped");
  });
  test("complete wins over skip", () => {
    expect(applyOnboardingAction("skipped", "complete")).toBe("completed");
    expect(applyOnboardingAction("completed", "skip")).toBe("completed");
  });
  test("isOnboardingAction rejects other verbs", () => {
    expect(isOnboardingAction("skip")).toBe(true);
    expect(isOnboardingAction("dismiss")).toBe(false);
  });
});

describe("workspaceEmptyKind", () => {
  test("zero workspaces without daemon is copy, not a fake workspace", () => {
    expect(workspaceEmptyKind({ daemonBound: false, workspaceCount: 0 })).toBe(
      "copy",
    );
  });
  test("rows without daemon are sin_runner", () => {
    expect(workspaceEmptyKind({ daemonBound: false, workspaceCount: 2 })).toBe(
      "sin_runner",
    );
  });
  test("daemon bound is ready", () => {
    expect(workspaceEmptyKind({ daemonBound: true, workspaceCount: 0 })).toBe(
      "ready",
    );
  });
});

describe("wizardVisible", () => {
  test("only pending", () => {
    expect(wizardVisible("pending")).toBe(true);
    expect(wizardVisible("skipped")).toBe(false);
    expect(wizardVisible("completed")).toBe(false);
  });
});
```

- [ ] Copiar `status.ts` a `api/src/onboarding/status.ts` (cambiar el comentario keep-in-sync). Copiar el test a `api/src/onboarding/status.test.ts` ajustando el import a `./status`.

- [ ] Copiar a `web/src/lib/onboarding.ts` y `web/src/lib/onboarding.test.ts` (import `./onboarding`). Incluir **todas** las constantes y funciones: el wizard Web las usa.

- [ ] Correr:

```bash
cd cli && bun test src/onboarding/status.test.ts
cd api && bun test src/onboarding/status.test.ts
cd web && bun test src/lib/onboarding.test.ts
```

Los tres suites pasan. Cero I/O.

- [ ] Commit:

```bash
git add cli/src/onboarding/status.ts cli/src/onboarding/status.test.ts cli/package.json \
  api/src/onboarding/status.ts api/src/onboarding/status.test.ts api/package.json \
  web/src/lib/onboarding.ts web/src/lib/onboarding.test.ts web/package.json
git commit -m "feat(onboarding): derive wizard steps from vault, daemon, and status"
```

---

## Task 2: API — persistencia, GET/PUT `/me/onboarding`, auto-complete

**Files:**

- Modify: `api/src/db/schema.ts`
- Create: `api/drizzle/0001_onboarding_status.sql` (si un sibling ya usó `0001_*.sql`, el siguiente número libre; el SQL es `ADD COLUMN IF NOT EXISTS`)
- Create: `api/src/onboarding/build.ts`
- Test: `api/src/onboarding/build.test.ts`
- Create: `api/src/routes/onboarding.ts`
- Modify: `api/src/index.ts`
- Modify: `api/src/ws/hub.ts`
- Modify: `api/src/ws/handlers.ts`
- Modify: `api/src/routes/workspaces.ts`
- Modify: `api/openapi/openapi.yaml`

Cierra “Saltar wizard no bloquea API” (el endpoint existe y el resto de rutas no lo consultan) y la persistencia de complete/skip. El dispatch del primer turn marca `completed`.

- [ ] En `api/src/db/schema.ts`, ampliar `userPreferences` **añadiendo** columnas; no borrar `activeProvider` / `activeModel` / `activeEffort` ni `activeExecutionMode` si plan 3 ya la puso:

```ts
export const userPreferences = pgTable("user_preferences", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  activeProvider: text("active_provider"),
  activeModel: text("active_model"),
  activeEffort: text("active_effort"),
  onboardingStatus: text("onboarding_status"),
  onboardingCompletedAt: timestamp("onboarding_completed_at"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
```

Si `activeExecutionMode` ya está, déjala. Insertar `onboardingStatus` / `onboardingCompletedAt` junto a las demás columnas, antes de `updatedAt`.

- [ ] Crear `api/drizzle/0001_onboarding_status.sql` (o el siguiente número libre):

```sql
ALTER TABLE "user_preferences"
  ADD COLUMN IF NOT EXISTS "onboarding_status" text;
ALTER TABLE "user_preferences"
  ADD COLUMN IF NOT EXISTS "onboarding_completed_at" timestamp;
```

- [ ] Aplicar:

```bash
cd api && bun run db:push
```

Si `DATABASE_URL` no está, fallar con el error de drizzle. No editar `docker-compose.yml`.

- [ ] En `api/src/ws/hub.ts`, **añadir** métodos. No cambiar `findDaemon(userId, workspaceId)`:

```ts
findAnyDaemon(userId: string): HubConnection | null {
  for (const c of connections.values()) {
    if (c.userId === userId && c.clientKind === "daemon" && c.workspaceId) {
      return c;
    }
  }
  return null;
},
countDaemonsForWorkspace(userId: string, workspaceId: string): number {
  let n = 0;
  for (const c of connections.values()) {
    if (
      c.userId === userId &&
      c.workspaceId === workspaceId &&
      c.clientKind === "daemon"
    ) {
      n += 1;
    }
  }
  return n;
},
```

Si invariants/daemon-reconnect ya tienen `findDaemons(userId, workspaceId)`, implementar `findAnyDaemon` como “primer daemon de cualquier workspace de ese user” reusando el filtro `clientKind === "daemon"`. No reordenar first-wins.

- [ ] Crear `api/src/onboarding/build.ts`:

```ts
import { eq } from "drizzle-orm";
import { db } from "../db";
import { providerCredentials, userPreferences } from "../db/schema";
import { hub } from "../ws/hub";
import { PROVIDER_CATALOGS } from "../llm/catalog";
import {
  applyOnboardingAction,
  deriveOnboarding,
  parseOnboardingStatus,
  type OnboardingAction,
  type OnboardingSnapshot,
} from "./status";

export type OnboardingPublic = OnboardingSnapshot & {
  nextHint: string | null;
  daemon: {
    workspaceId: string;
    path: string | null;
    hostname: string | null;
  } | null;
};

function runnableIds(): Set<string> {
  return new Set(
    PROVIDER_CATALOGS.filter((p) => p.runnable).map((p) => p.id),
  );
}

export async function factsForUser(userId: string) {
  const creds = await db
    .select({ provider: providerCredentials.provider })
    .from(providerCredentials)
    .where(eq(providerCredentials.userId, userId));
  const linked = new Set(creds.map((r) => r.provider));
  const runnable = runnableIds();
  const runnableLinked = [...linked].some((id) => runnable.has(id));
  const cursorLinkedOnly =
    linked.has("cursor") && !runnableLinked;
  const daemon = hub.findAnyDaemon(userId);
  const prefs = await db
    .select()
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1);
  return {
    persistedStatus: parseOnboardingStatus(prefs[0]?.onboardingStatus),
    runnableLinked,
    daemonBound: Boolean(daemon),
    cursorLinkedOnly,
    daemon,
    prefsRow: prefs[0] ?? null,
  };
}

export async function buildOnboarding(userId: string): Promise<OnboardingPublic> {
  const facts = await factsForUser(userId);
  const snap = deriveOnboarding(facts);
  const d = facts.daemon;
  return {
    ...snap,
    nextHint: snap.cursorLinkedOnly
      ? "Cursor está vinculado pero no ejecuta turns. Para el primer turn: chavez provider link claude"
      : snap.nextCommand,
    daemon: d
      ? {
          workspaceId: d.workspaceId!,
          path: d.path,
          hostname: "hostname" in d ? (d as { hostname?: string | null }).hostname ?? null : null,
        }
      : null,
  };
}

export async function persistOnboardingAction(
  userId: string,
  action: OnboardingAction,
): Promise<OnboardingPublic> {
  const facts = await factsForUser(userId);
  const next = applyOnboardingAction(facts.persistedStatus, action);
  const now = new Date();
  const completedAt = next === "completed" ? now : facts.prefsRow?.onboardingCompletedAt ?? null;
  if (!facts.prefsRow) {
    await db.insert(userPreferences).values({
      userId,
      onboardingStatus: next,
      onboardingCompletedAt: next === "completed" ? now : null,
      updatedAt: now,
    });
  } else {
    await db
      .update(userPreferences)
      .set({
        onboardingStatus: next,
        onboardingCompletedAt: completedAt,
        updatedAt: now,
      })
      .where(eq(userPreferences.userId, userId));
  }
  return buildOnboarding(userId);
}

export async function markOnboardingComplete(
  userId: string,
): Promise<OnboardingPublic> {
  return persistOnboardingAction(userId, "complete");
}
```

Si `PROVIDER_CATALOGS` no exporta `runnable` en algún stub, Claude es `runnable: true` y Cursor `false` — no inventar un tercer provider.

- [ ] Crear `api/src/onboarding/build.test.ts` cubriendo `derive` vía facts sintéticos **sin** Postgres: extraer la parte de `cursorLinkedOnly && !runnableLinked` ya cubierta en Task 1. Aquí testear `applyOnboardingAction` otra vez no hace falta. En su lugar, un test de `hostname` opcional:

```ts
import { describe, expect, test } from "bun:test";
import { deriveOnboarding } from "./status";

test("build shape matches public snapshot", () => {
  const snap = deriveOnboarding({
    persistedStatus: "pending",
    runnableLinked: true,
    daemonBound: true,
  });
  expect(snap.nextStep).toBe("chat");
  expect(snap.wizardVisible).toBe(true);
});
```

- [ ] Crear `api/src/routes/onboarding.ts`:

```ts
import { Hono } from "hono";
import type { Session } from "../auth";
import {
  INVALID_ONBOARDING_ACTION,
  isOnboardingAction,
  ONBOARDING_EVENT,
} from "../onboarding/status";
import {
  buildOnboarding,
  persistOnboardingAction,
} from "../onboarding/build";
import { hub } from "../ws/hub";

export function createOnboardingRoutes(
  requireSession: (c: { req: { raw: Request } }) => Promise<Session | null>,
) {
  const app = new Hono();

  app.get("/onboarding", async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    const body = await buildOnboarding(session.user.id);
    return c.json(body);
  });

  app.put("/onboarding", async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    const body = await c.req.json<{ action?: unknown }>().catch(() => ({}));
    if (!isOnboardingAction(body.action)) {
      return c.json({ error: INVALID_ONBOARDING_ACTION }, 400);
    }
    const snap = await persistOnboardingAction(session.user.id, body.action);
    hub.broadcastToUser(
      session.user.id,
      hub.pushEvent(ONBOARDING_EVENT, snap),
    );
    return c.json(snap);
  });

  return app;
}
```

- [ ] En `api/src/index.ts`, montar **sin** tocar GET `/me`:

```ts
import { createOnboardingRoutes } from "./routes/onboarding";

app.route("/me", createOnboardingRoutes(requireSession));
```

Colocar esa línea **después** de `app.get("/me", ...)`. CORS `/me/*` ya cubre `/me/onboarding`.

- [ ] En `api/src/ws/handlers.ts`, al final del `case "agent.turn.request"` **después** de `sent` exitoso y **antes** del `return ok`:

```ts
import { markOnboardingComplete } from "../onboarding/build";
import { ONBOARDING_EVENT } from "../onboarding/status";
```

```ts
        if (!sent) {
          return fail(type, id, "Daemon connection unavailable");
        }
        void markOnboardingComplete(userId)
          .then((snap) => {
            broadcast(userId, ONBOARDING_EVENT, snap);
          })
          .catch(() => {
            /* onboarding must not fail the turn */
          });
        return ok(type, id, {
          accepted: true,
          daemonConnectionId: daemon.connectionId,
        });
```

El `fail` de `NO_DAEMON_ERROR` **no** llama `markOnboardingComplete`. Si `buildOnboarding` tira, el catch traga el error: el turn no falla por el wizard.

- [ ] En `api/src/routes/workspaces.ts` GET `/` (lista), añadir `daemonBound` por workspace **sin** quitar `openConnections`:

```ts
daemonBound: hub.findDaemon(session.user.id, w.id) != null,
daemonConnections: hub.countDaemonsForWorkspace(session.user.id, w.id),
```

En GET `/:workspaceId/sessions`, añadir los mismos dos campos al payload junto a `openConnections`.

- [ ] En `api/openapi/openapi.yaml`:

  1. Tras el path `/me`, añadir:

```yaml
  /me/onboarding:
    get:
      tags: [Me]
      summary: Snapshot del wizard de primer uso
      operationId: getMeOnboarding
      security:
        - bearerAuth: []
        - cookieAuth: []
      responses:
        "200":
          description: Pasos derivados + status persistido
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/OnboardingSnapshot"
        "401":
          $ref: "#/components/responses/Unauthorized"
    put:
      tags: [Me]
      summary: Saltar o completar el wizard
      operationId: putMeOnboarding
      security:
        - bearerAuth: []
        - cookieAuth: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [action]
              properties:
                action:
                  type: string
                  enum: [skip, complete]
      responses:
        "200":
          description: Snapshot actualizado
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/OnboardingSnapshot"
        "400":
          description: action inválida
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ErrorBody"
              example:
                error: action must be skip or complete
        "401":
          $ref: "#/components/responses/Unauthorized"
```

  2. En `components.schemas`, añadir `OnboardingSnapshot` (status, wizardVisible, steps, nextStep, nextCommand, nextHint, cursorLinkedOnly, daemon). `daemon` nullable con `workspaceId`, `path`, `hostname`.

  3. En `ConnectionPublic`, añadir `clientKind` si aún no está (`enum: [client, daemon]`). No quitar campos.

  4. En el schema de workspace list item (si existe `WorkspacePublic`), añadir `daemonBound` boolean y `daemonConnections` integer. Si el listado está inlined, documentar las dos keys nuevas en la descripción del GET `/workspaces`.

- [ ] Correr:

```bash
cd api && bun test src/onboarding/status.test.ts src/onboarding/build.test.ts
```

- [ ] Commit:

```bash
git add api/src/db/schema.ts api/drizzle api/src/onboarding api/src/routes/onboarding.ts \
  api/src/index.ts api/src/ws/hub.ts api/src/ws/handlers.ts api/src/routes/workspaces.ts \
  api/openapi/openapi.yaml
git commit -m "feat(onboarding): persist skip/complete and expose GET /me/onboarding"
```

---

## Task 3: CLI — login, whoami, ask con el siguiente paso concreto

**Files:**

- Create: `cli/src/onboarding/print.ts`
- Test: `cli/src/onboarding/print.test.ts`
- Modify: `cli/src/commands/login.ts`
- Modify: `cli/src/commands/whoami.ts`
- Modify: `cli/src/commands/headless.ts`
- Modify: `cli/src/index.ts`

Cierra el escenario **CLI post-login**. Login y whoami explican los tres comandos. `chat ask` sin provider/daemon sale con exit 1 y el string congelado. Skip no se exige: no hay flag obligatorio.

- [ ] Crear `cli/src/onboarding/print.ts`:

```ts
import type { OnboardingSnapshot } from "./status";
import {
  CURSOR_NOT_RUNNABLE_HINT,
  HINT_LOGIN_HEADER,
  STEP_CHAT_LABEL,
  STEP_DAEMON_LABEL,
  STEP_PROVIDER_LABEL,
} from "./status";

export type OnboardingPrintable = Pick<
  OnboardingSnapshot,
  "status" | "wizardVisible" | "steps" | "nextCommand" | "cursorLinkedOnly"
>;

export function formatOnboardingHint(snap: OnboardingPrintable): string {
  if (!snap.wizardVisible) return "";
  const box = (ok: boolean) => (ok ? "[x]" : "[ ]");
  const lines = [
    HINT_LOGIN_HEADER,
    `  ${box(snap.steps.providerLinked)} ${STEP_PROVIDER_LABEL}`,
    `      chavez provider link claude`,
    `  ${box(snap.steps.daemonBound)} ${STEP_DAEMON_LABEL}`,
    `      chavez tui   (o: chavez headless workspace open)`,
    `  ${box(snap.steps.firstTurn)} ${STEP_CHAT_LABEL}`,
    `      chavez headless chat ask <chatId> <prompt>`,
  ];
  if (snap.cursorLinkedOnly) lines.push(`  ${CURSOR_NOT_RUNNABLE_HINT}`);
  if (snap.nextCommand) lines.push(`  → ${snap.nextCommand}`);
  return lines.join("\n");
}
```

- [ ] Crear `cli/src/onboarding/print.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { formatOnboardingHint } from "./print";
import { HINT_LOGIN_HEADER } from "./status";

const pending = {
  status: "pending" as const,
  wizardVisible: true,
  steps: {
    providerLinked: false,
    daemonBound: false,
    firstTurn: false,
  },
  nextCommand: "Siguiente paso: chavez provider link claude",
  cursorLinkedOnly: false,
};

test("pending prints three steps and header", () => {
  const text = formatOnboardingHint(pending);
  expect(text.startsWith(HINT_LOGIN_HEADER)).toBe(true);
  expect(text).toContain("[ ] Vincular provider (Claude)");
  expect(text).toContain("chavez provider link claude");
  expect(text).toContain("chavez tui");
  expect(text).toContain("chavez headless workspace open");
  expect(text).toContain("chavez headless chat ask");
});

test("completed/skipped prints nothing", () => {
  expect(
    formatOnboardingHint({
      ...pending,
      status: "completed",
      wizardVisible: false,
      nextCommand: null,
    }),
  ).toBe("");
  expect(
    formatOnboardingHint({
      ...pending,
      status: "skipped",
      wizardVisible: false,
    }),
  ).toBe("");
});

test("cursor-only adds the runnable hint", () => {
  const text = formatOnboardingHint({ ...pending, cursorLinkedOnly: true });
  expect(text).toContain("Cursor está vinculado pero no ejecuta turns");
});
```

- [ ] En `cli/src/commands/login.ts`, tras `saveConfig(...)` y el `console.log("Login correcto...")`, **antes** del `return`:

```ts
  import { apiFetch } from "../api-client";
  import { formatOnboardingHint } from "../onboarding/print";
  import type { OnboardingSnapshot } from "../onboarding/status";
```

(`import` arriba del archivo, no dentro de la función.)

```ts
      console.log("Login correcto. Sesión guardada en ~/.chavez/config.json");
      try {
        const snap = await apiFetch<OnboardingSnapshot>("/me/onboarding");
        const hint = formatOnboardingHint(snap);
        if (hint) {
          console.log("");
          console.log(hint);
        }
      } catch {
        console.log("");
        console.log("Siguiente paso: chavez provider link claude");
        console.log(
          "Luego: chavez tui   (o: chavez headless workspace open)",
        );
      }
      return;
```

El fallback cubre una API vieja sin `/me/onboarding`. Login **nunca** falla por el hint.

- [ ] En `cli/src/commands/whoami.ts`, tras las líneas de User/Name:

```ts
import { formatOnboardingHint } from "../onboarding/print";
import type { OnboardingSnapshot } from "../onboarding/status";

  try {
    const snap = await apiFetch<OnboardingSnapshot>("/me/onboarding");
    const hint = formatOnboardingHint(snap);
    if (hint) {
      console.log("");
      console.log(hint);
    }
  } catch {
    // whoami de identidad no depende del wizard
  }
```

No imprimir el bloque si `wizardVisible` es false.

- [ ] En `cli/src/commands/headless.ts`, **dentro** de `action === "ask"`, **antes** de `client.request({ type: "agent.turn.request", ...})`:

```ts
import {
  askPreflightError,
  NO_DAEMON_ERROR,
  NO_PROVIDER_ASK,
  type OnboardingSnapshot,
} from "../onboarding/status";
```

```ts
      if (action === "ask") {
        const chatId = rest[0];
        const prompt = rest.slice(1).join(" ");
        if (!chatId || !prompt) {
          throw new Error("Uso: … chat ask <chatId> <prompt…>");
        }
        try {
          const snap = await apiFetch<OnboardingSnapshot>("/me/onboarding");
          const pre = askPreflightError({
            runnableLinked: snap.steps.providerLinked,
            daemonBound: snap.steps.daemonBound,
          });
          if (pre) throw new Error(pre);
        } catch (err) {
          if (
            err instanceof Error &&
            (err.message === NO_PROVIDER_ASK || err.message === NO_DAEMON_ERROR)
          ) {
            throw err;
          }
          // GET onboarding caído: dejar que agent.turn.request aplique NO_DAEMON_ERROR
        }
        const res = await client.request(
          {
            type: "agent.turn.request",
            chatId,
            prompt,
          },
          30_000,
        );
```

`workspace open|close|status`, `session *`, `chat create|list|append|get|watch` y `connections` **no** exigen onboarding.

- [ ] En `cli/src/index.ts`, al final del bloque `Usage:` (antes del cierre del template), añadir:

```
  Primer uso: chavez login → provider link claude → tui | headless workspace open → chat ask
```

No cambiar el routing de comandos.

- [ ] Correr:

```bash
cd cli && bun test src/onboarding/status.test.ts src/onboarding/print.test.ts
```

- [ ] Commit:

```bash
git add cli/src/onboarding/print.ts cli/src/onboarding/print.test.ts \
  cli/src/commands/login.ts cli/src/commands/whoami.ts cli/src/commands/headless.ts \
  cli/src/index.ts
git commit -m "feat(onboarding): CLI login/whoami hint and ask preflight next step"
```

---

## Task 4: TUI — banner de primer uso y error accionable

**Files:**

- Modify: `tui/src/App.tsx`
- Modify: `tui/package.json`

La TUI **es** daemon: al estar `bound`, el paso 2 está hecho. El banner cubre provider + primer chat. Compose no se bloquea (skip implícito: el usuario puede pulsar `m` igual). El primer turn aceptado (local o vía `agent.turn.dispatch`) completa el wizard en API (Task 2).

- [ ] Añadir `"test": "bun test"` en `tui/package.json` si falta. No hace falta un test de Ink: el módulo CLI ya cubre `formatOnboardingHint`.

- [ ] En `tui/src/App.tsx`:

  1. Imports:

```tsx
import {
  NO_PROVIDER_ASK,
  type OnboardingSnapshot,
} from "../../cli/src/onboarding/status";
import { formatOnboardingHint } from "../../cli/src/onboarding/print";
```

  2. State:

```tsx
  const [onboarding, setOnboarding] = useState<OnboardingSnapshot | null>(null);
```

  3. En el `useEffect` de connect, tras `apiFetch<ProvidersResponse>("/providers", {}, token)` y **antes** o **después** del bind, fetch onboarding (si 404 de API vieja, ignorar):

```tsx
        try {
          const ob = await apiFetch<OnboardingSnapshot>(
            "/me/onboarding",
            {},
            token,
          );
          if (!cancelled) setOnboarding(ob);
        } catch {
          // API sin onboarding: TUI sigue
        }
```

  4. En el `onPush` existente, si `msg.type === "onboarding.updated"`:

```tsx
      if (msg.type === "onboarding.updated") {
        setOnboarding(msg.data as OnboardingSnapshot);
        return;
      }
```

Colocar **antes** del early-return de `agent.turn.dispatch` o junto a los otros tipos; no tragar el dispatch.

  5. Unificar el fail de provider en `sendWithLlm`. Reemplazar:

```tsx
        if (!providersInfo?.providers.claude?.linked) {
          setLog("Claude no está vinculado — chavez provider link claude");
          return;
        }
```

por:

```tsx
        if (!providersInfo?.providers.claude?.linked) {
          setLog(NO_PROVIDER_ASK);
          return;
        }
```

El `finally` que baja `busy` sigue igual. Cursor stub (mensaje “aún no implementado”) **no** se convierte en complete del wizard: no llama `agent.turn.request`; el complete lo hace la API en el dispatch. Un turn local de Claude pasa por `publishAgentTurn` → stream → la API completa en el `agent.turn.request` de Web, **no** en el path local. Para el path local (usuario pulsa `m` en TUI), `publishAgentTurn` no pasa por `agent.turn.request`. Completar también desde TUI tras un `publishAgentTurn` **exitoso**:

```tsx
        await publishAgentTurn({
          client,
          chatId: activeChatId,
          prompt: text,
          cwd,
          token,
        });
        await loadChat(activeChatId);
        setLog("Respuesta recibida");
        try {
          const snap = await apiFetch<OnboardingSnapshot>(
            "/me/onboarding",
            { method: "PUT", body: JSON.stringify({ action: "complete" }) },
            token,
          );
          setOnboarding(snap);
        } catch {
          // non-fatal
        }
```

Si el turn tira, **no** PUT complete. `setLog` del `catch` ya muestra el error (accionable).

Tras `publishAgentTurn` del handler `agent.turn.dispatch` (turn disparado desde Web): la API ya marcó complete en Task 2; opcionalmente refetch. No duplicar PUT si el push `onboarding.updated` llega.

  6. Banner bajo el header de provider, **solo** si `onboarding?.wizardVisible`:

```tsx
      {onboarding?.wizardVisible ? (
        <Text color="yellow">
          {formatOnboardingHint(onboarding).split("\n")[0]}
          {onboarding.nextCommand ? ` — ${onboarding.nextCommand}` : ""}
        </Text>
      ) : null}
```

Una sola línea (el bloque de 7 líneas no cabe). El detalle sigue en `whoami` / Web.

  7. Si `status !== "bound"` y hay `error`, el `Text color="red"` existente permanece: es el error accionable de bind.

- [ ] No añadir tecla nueva para skip. Usar la TUI **es** usarla igual (escenario skip). Skip explícito vive en Web.

- [ ] Commit:

```bash
git add tui/src/App.tsx tui/package.json
git commit -m "feat(onboarding): TUI first-run banner and provider next-step error"
```

---

## Task 5: Web — wizard post-sign-up y workspace sin fingir daemon

**Files:**

- Create: `web/src/components/OnboardingWizard.tsx`
- Modify: `web/src/lib/query-keys.ts`
- Modify: `web/src/lib/hooks.ts`
- Modify: `web/src/lib/ws-context.tsx`
- Modify: `web/src/components/HubPanel.tsx`
- Modify: `web/src/components/WorkspacesPanel.tsx`
- Modify: `web/src/components/WorkspaceDetailPanel.tsx`
- Modify: `web/src/styles/global.css`

Cierra **Web post-sign-up** y la mitad de **Saltar wizard**. Tras crear cuenta, `/` muestra los tres pasos. Workspaces no se presenta como runner.

- [ ] En `web/src/lib/query-keys.ts` añadir:

```ts
  onboarding: ["onboarding"] as const,
```

- [ ] En `web/src/lib/hooks.ts`, ampliar `Workspace`:

```ts
export type Workspace = {
  id: string;
  path?: string;
  name?: string;
  openConnections?: number;
  daemonBound?: boolean;
  daemonConnections?: number;
  userId?: string;
  createdAt?: string;
  updatedAt?: string;
};
```

Importar tipos del módulo de onboarding:

```ts
import type { OnboardingSnapshot } from "./onboarding";
```

Hooks:

```ts
export function useOnboarding(enabled = true) {
  return useQuery({
    queryKey: queryKeys.onboarding,
    enabled,
    queryFn: () => apiJson<OnboardingSnapshot>("/me/onboarding"),
  });
}

export function useOnboardingAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (action: "skip" | "complete") =>
      apiJson<OnboardingSnapshot>("/me/onboarding", {
        method: "PUT",
        body: JSON.stringify({ action }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.onboarding });
    },
  });
}
```

- [ ] En `web/src/lib/ws-context.tsx`, en el `useEffect` que registra `onPush` (el que ya invalida workspaces/chats), añadir: si `ev.type === "onboarding.updated"`, `void qc.invalidateQueries({ queryKey: queryKeys.onboarding })`. Importar `queryKeys` si aún no está. No cambiar bind/unbind.

- [ ] Crear `web/src/components/OnboardingWizard.tsx`:

```tsx
import {
  CLIENT_BIND_HINT,
  CURSOR_NOT_RUNNABLE_HINT,
  EMPTY_WORKSPACE_COPY,
  SKIP_LABEL,
  STEP_CHAT_LABEL,
  STEP_DAEMON_LABEL,
  STEP_PROVIDER_LABEL,
  WIZARD_TITLE,
  type OnboardingSnapshot,
} from "../lib/onboarding";
import { useOnboardingAction } from "../lib/hooks";

export function OnboardingWizard({
  snap,
}: {
  snap: OnboardingSnapshot;
}) {
  const skip = useOnboardingAction();
  if (!snap.wizardVisible) return null;

  const items: Array<{
    done: boolean;
    label: string;
    href?: string;
    detail: string;
  }> = [
    {
      done: snap.steps.providerLinked,
      label: STEP_PROVIDER_LABEL,
      href: "/providers",
      detail: "chavez provider link claude",
    },
    {
      done: snap.steps.daemonBound,
      label: STEP_DAEMON_LABEL,
      detail: EMPTY_WORKSPACE_COPY,
    },
    {
      done: snap.steps.firstTurn,
      label: STEP_CHAT_LABEL,
      href: snap.daemon ? `/workspaces/${snap.daemon.workspaceId}` : "/workspaces",
      detail: snap.daemon
        ? `${snap.daemon.hostname ? snap.daemon.hostname + " · " : ""}${snap.daemon.path ?? ""}`
        : "Cuando el daemon esté bound, abre un chat y envía el primer prompt.",
    },
  ];

  return (
    <section className="panel onboarding-wizard" data-testid="onboarding-wizard">
      <h2>{WIZARD_TITLE}</h2>
      <ol className="onboarding-steps">
        {items.map((it) => (
          <li key={it.label} className={it.done ? "ok" : ""}>
            <span className="badge">{it.done ? "hecho" : "pendiente"}</span>{" "}
            {it.href && !it.done ? <a href={it.href}>{it.label}</a> : it.label}
            <p className="muted" style={{ margin: "0.25rem 0 0", fontSize: "0.85rem" }}>
              {it.detail}
            </p>
          </li>
        ))}
      </ol>
      {snap.cursorLinkedOnly && (
        <p className="muted">{CURSOR_NOT_RUNNABLE_HINT}</p>
      )}
      {snap.daemon && (
        <p className="ok">
          Daemon:{" "}
          <code>
            {snap.daemon.hostname ? `${snap.daemon.hostname} · ` : ""}
            {snap.daemon.path}
          </code>
        </p>
      )}
      {!snap.steps.daemonBound && (
        <p className="muted">{CLIENT_BIND_HINT}</p>
      )}
      <button
        type="button"
        className="secondary"
        disabled={skip.isPending}
        onClick={() => void skip.mutateAsync("skip")}
      >
        {skip.isPending ? "…" : SKIP_LABEL}
      </button>
    </section>
  );
}
```

Si `OnboardingSnapshot` en Web no tiene `daemon` (el módulo puro de Task 1 no lo incluye), **extender** `web/src/lib/onboarding.ts`:

```ts
export type OnboardingPublic = OnboardingSnapshot & {
  nextHint?: string | null;
  daemon?: {
    workspaceId: string;
    path: string | null;
    hostname: string | null;
  } | null;
};
```

Usar `OnboardingPublic` en hooks y en el wizard. No hace falta duplicar `daemon` en CLI.

- [ ] En `web/src/components/HubPanel.tsx`:

  1. `const onboarding = useOnboarding(signedIn);`
  2. Importar `OnboardingWizard`.
  3. **Dentro** de `{signedIn && ( ... )}` del header, si `onboarding.data?.wizardVisible`, renderizar `<OnboardingWizard snap={onboarding.data} />` **encima** del grid API/CLI/Workspaces.
  4. No mostrar el recuento “Workspaces: 0” como si hubiera runner. Sustituir el párrafo de “Providers vinculados / Workspaces” cuando el wizard es visible por un resumen de pasos:

```tsx
        {signedIn && onboarding.data?.wizardVisible && (
          <OnboardingWizard snap={onboarding.data} />
        )}
        {signedIn && !onboarding.data?.wizardVisible && (
          <p className="muted">
            Providers vinculados: {linkedCount ?? 0}
            {" · "}
            Workspaces: {workspaces.data?.length ?? 0}
            {" · "}
            <a href="/providers">Vincular providers</a>
          </p>
        )}
```

Dejar el bloque de sesión / health / WS como está. El grid de tres cards permanece (skip / completed lo usan).

- [ ] En `web/src/components/WorkspacesPanel.tsx`:

  1. `useOnboarding(signedIn)` y `workspaceEmptyKind` / `EMPTY_WORKSPACE_COPY` / `NO_RUNNER_LABEL` / `CLIENT_BIND_HINT`.
  2. Calcular:

```tsx
  const anyDaemon = (workspaces.data || []).some((w) => w.daemonBound);
  const emptyKind = workspaceEmptyKind({
    daemonBound: anyDaemon,
    workspaceCount: workspaces.data?.length ?? 0,
  });
```

  3. **Antes** del form de bind, si `emptyKind === "copy"`:

```tsx
            <p>{EMPTY_WORKSPACE_COPY}</p>
            <pre>{`chavez tui
chavez headless workspace open`}</pre>
            <p className="muted">{CLIENT_BIND_HINT}</p>
```

     No renderizar “Sin workspaces aún. Haz bind de un path.” — esa frase es el anti-patrón del Gherkin.

  4. El form de bind se envuelve en `<details>`:

```tsx
          <details>
            <summary>Bind de cliente (avanzado)</summary>
            {/* form onBind existente */}
          </details>
```

     Label del input: dejar “Bind path (absoluto)”. El summary deja claro que no es el daemon.

  5. En cada `<li>` del listado, si `!w.daemonBound`, badge `NO_RUNNER_LABEL` (clase `err` o default), **además** de `openConnections` si se muestra. No usar `openConnections > 0` como “hay runner”.

  6. Si `emptyKind === "sin_runner"`, un párrafo encima de la lista: `{EMPTY_WORKSPACE_COPY}`.

- [ ] En `web/src/components/WorkspaceDetailPanel.tsx`:

  1. Tras el `<code>{path}</code>`, badge de runner:

```tsx
              {detail.data.workspace.daemonBound ? (
                <span className="badge ok">daemon</span>
              ) : (
                <span className="badge err">{NO_RUNNER_LABEL}</span>
              )}
```

     Importar `NO_RUNNER_LABEL` y `EMPTY_WORKSPACE_COPY` desde `../lib/onboarding`. Ampliar el tipo inline si `useWorkspaceSessions` no tipa `daemonBound` en `workspace`: añadir `daemonBound?: boolean` al `Workspace` (ya hecho). El GET de sessions (Task 2) lo manda en el root **y** conviene copiarlo a `workspace` en el queryFn **o** leer `data.daemonBound` del payload. Ajustar `useWorkspaceSessions` en `hooks.ts`:

```ts
      const data = await apiJson<{
        workspace: Workspace;
        sessions: WorkspaceSessionOverview[];
        openConnections: number;
        daemonBound?: boolean;
        daemonConnections?: number;
      }>(`/workspaces/${workspaceId}/sessions`);
      return {
        ...data,
        workspace: {
          ...data.workspace,
          daemonBound: data.daemonBound ?? data.workspace.daemonBound,
          daemonConnections:
            data.daemonConnections ?? data.workspace.daemonConnections,
        },
      };
```

  2. Si `!daemonBound`, párrafo `{EMPTY_WORKSPACE_COPY}` **antes** de la lista de sessions. No ocultar sessions existentes (skip / usuarios que ya crearon chats). El empty de “Sin sessions.” permanece debajo.

- [ ] En `web/src/styles/global.css` añadir:

```css
.onboarding-steps {
  margin: 0.5rem 0 1rem;
  padding-left: 1.2rem;
}
.onboarding-steps li {
  margin-bottom: 0.6rem;
}
```

- [ ] Correr:

```bash
cd web && bun test src/lib/onboarding.test.ts
```

- [ ] Commit:

```bash
git add web/src/components/OnboardingWizard.tsx web/src/lib/query-keys.ts \
  web/src/lib/hooks.ts web/src/lib/ws-context.tsx web/src/lib/onboarding.ts \
  web/src/components/HubPanel.tsx web/src/components/WorkspacesPanel.tsx \
  web/src/components/WorkspaceDetailPanel.tsx web/src/styles/global.css
git commit -m "feat(onboarding): Web wizard after sign-up and no fake empty workspace"
```

---

## Task 6: Primer turn — stream o error accionable, wizard completo

**Files:**

- Modify: `web/src/components/ChatDetailPanel.tsx`
- Modify: `web/src/lib/ws-hooks.ts`
- Test: `web/src/lib/onboarding.test.ts` (casos extra de preflight, ya cubiertos en Task 1; no duplicar si pasan)

Cierra **Primer turn**. Provider linked + daemon bound → `agent.turn.request` corre. Web pinta stream (ya existe) o el error canónico. El complete lo hace la API (Task 2) + push `onboarding.updated` (Task 5 invalida). Preflight en Web para no mandar un turn inútil.

- [ ] En `web/src/lib/ws-hooks.ts`, `useWsAgentTurn` se queda igual (mismo RPC). El preflight es en el panel, no en el hook.

- [ ] En `web/src/components/ChatDetailPanel.tsx`:

  1. Imports: `useOnboarding`, `useWorkspaceSessions` no hace falta. `askPreflightError`, `EMPTY_WORKSPACE_COPY`, `NO_PROVIDER_ASK`, `NO_DAEMON_ERROR` desde `../lib/onboarding`. `useOnboarding(signedIn)`.

  2. En `onAgent`, **antes** de `agent.mutateAsync`:

```tsx
    const pre = askPreflightError({
      runnableLinked: Boolean(onboarding.data?.steps.providerLinked),
      daemonBound: Boolean(onboarding.data?.steps.daemonBound),
    });
    if (pre) {
      setMsg({ kind: "error", text: pre });
      return;
    }
```

     Si `onboarding` aún carga, no bloquear: dejar que la API responda `NO_DAEMON_ERROR`. Solo preflight cuando `onboarding.data` existe.

  3. El `catch` de `onAgent` ya hace `formatQueryError`. Asegurar que un fail WS con `error === NO_DAEMON_ERROR` se pinta entero (el cliente WS debe surfacer `error` del `ok: false`). Si `formatQueryError` ya usa `err.message`, no cambiar.

  4. Encima del form “Enviar al agente”, si `onboarding.data && askPreflightError(...)`:

```tsx
          {(() => {
            const pre =
              onboarding.data &&
              askPreflightError({
                runnableLinked: onboarding.data.steps.providerLinked,
                daemonBound: onboarding.data.steps.daemonBound,
              });
            return pre ? <p className="error">{pre}</p> : null;
          })()}
```

     El botón se puede dejar enabled: el submit re-muestra el mismo error. No deshabilitar el form (skip = usarlo igual; el usuario puede vincular en otra pestaña y reintentar).

  5. El bloque de stream (`chat.stream.start/delta/end/error`) **no se toca** salvo: en `chat.stream.error`, el texto ya va a `setMsg`. Suficiente para “error accionable”.

  6. No PUT complete desde Web: la API lo hace al aceptar el turn. El wizard del hub desaparece por `onboarding.updated`.

- [ ] Confirmar que `publish-turn.ts` **no** cambia el string de Claude no vinculado en el daemon (path residual si el preflight se salta). Opcional: alinear el throw de `publish-turn.ts` a `NO_PROVIDER_ASK`:

```ts
import { NO_PROVIDER_ASK } from "../onboarding/status";
  if (!providers.providers?.claude?.linked) {
    throw new Error(NO_PROVIDER_ASK);
  }
```

Eso unifica Web/TUI/watch. Hacerlo en `cli/src/llm/publish-turn.ts`. El mensaje viejo `"Claude no está vinculado — chavez provider link claude"` deja de emitirse.

- [ ] Commit:

```bash
git add web/src/components/ChatDetailPanel.tsx web/src/lib/ws-hooks.ts \
  cli/src/llm/publish-turn.ts
git commit -m "feat(onboarding): first turn preflight and actionable stream errors"
```

---

## Task 7: Skip no bloquea + smoke Gherkin

**Files:**

- Create: `cli/scripts/onboarding-smoke.ts`
- Create: `api/src/onboarding/skip-gate.test.ts`
- Modify: `cli/package.json` (nada si `test` ya está)

Demuestra los cuatro escenarios sin LLM vivo (cuota). Skip + pending nunca 403 en vault/workspaces.

- [ ] Crear `api/src/onboarding/skip-gate.test.ts` como documentación ejecutable del contrato de gate (puro):

```ts
import { describe, expect, test } from "bun:test";
import { askPreflightError, deriveOnboarding } from "./status";

test("skipped still requires provider+daemon for ask", () => {
  const s = deriveOnboarding({
    persistedStatus: "skipped",
    runnableLinked: false,
    daemonBound: false,
  });
  expect(s.wizardVisible).toBe(false);
  expect(
    askPreflightError({
      runnableLinked: s.steps.providerLinked,
      daemonBound: s.steps.daemonBound,
    }),
  ).not.toBeNull();
});

test("skipped with provider+daemon allows ask", () => {
  const s = deriveOnboarding({
    persistedStatus: "skipped",
    runnableLinked: true,
    daemonBound: true,
  });
  expect(s.wizardVisible).toBe(false);
  expect(
    askPreflightError({
      runnableLinked: true,
      daemonBound: true,
    }),
  ).toBeNull();
});
```

Esto es el invariante “no bloquea API ni headless”: el status skipped no entra en `askPreflightError`. Las rutas HTTP no leen `onboardingStatus` (verificación por grep en el smoke).

- [ ] Crear `cli/scripts/onboarding-smoke.ts`:

```ts
/**
 * Smoke Gherkin plan 21 — sin LLM.
 * Need: API up, chavez login (CHAVEZ_ACCESS_TOKEN or ~/.chavez/config.json).
 *
 * A) GET /me/onboarding 200, wizardVisible boolean
 * B) PUT action=yolo → 400 action must be skip or complete
 * C) PUT skip → wizardVisible false; GET /providers 200; GET /workspaces 200
 * D) PUT complete → status completed
 * E) chat ask preflight strings (unit already); here: GET snapshot steps
 */
import { apiFetch, ApiError } from "../src/api-client";
import { loadConfig } from "../src/config";
import {
  INVALID_ONBOARDING_ACTION,
  type OnboardingSnapshot,
} from "../src/onboarding/status";

const config = loadConfig();
const token = process.env.CHAVEZ_ACCESS_TOKEN || config.accessToken;
if (!token) {
  console.error("Need login");
  process.exit(1);
}

const snap = await apiFetch<OnboardingSnapshot>("/me/onboarding");
console.log("A) GET", snap.status, "wizardVisible=", snap.wizardVisible);
if (typeof snap.wizardVisible !== "boolean") {
  throw new Error("wizardVisible missing");
}
if (!snap.steps || typeof snap.steps.providerLinked !== "boolean") {
  throw new Error("steps missing");
}

try {
  await apiFetch("/me/onboarding", {
    method: "PUT",
    body: JSON.stringify({ action: "yolo" }),
  });
  throw new Error("yolo should 400");
} catch (err) {
  if (!(err instanceof ApiError) || err.status !== 400) throw err;
  const body = err.body as { error?: string } | undefined;
  const msg = body?.error || err.message;
  if (msg !== INVALID_ONBOARDING_ACTION) {
    throw new Error(`expected ${INVALID_ONBOARDING_ACTION}, got ${msg}`);
  }
  console.log("B) PUT yolo → 400", msg);
}

const skipped = await apiFetch<OnboardingSnapshot>("/me/onboarding", {
  method: "PUT",
  body: JSON.stringify({ action: "skip" }),
});
if (skipped.wizardVisible) throw new Error("skip must hide wizard");
console.log("C) skip wizardVisible=false");

const providers = await apiFetch<{ providers: unknown }>("/providers");
if (!providers.providers) throw new Error("GET /providers blocked after skip");
const workspaces = await apiFetch<{ workspaces: unknown[] }>("/workspaces");
if (!Array.isArray(workspaces.workspaces)) {
  throw new Error("GET /workspaces blocked after skip");
}
console.log("C) providers+workspaces still 200");

const completed = await apiFetch<OnboardingSnapshot>("/me/onboarding", {
  method: "PUT",
  body: JSON.stringify({ action: "complete" }),
});
if (completed.status !== "completed") {
  throw new Error("complete did not stick");
}
if (completed.wizardVisible) throw new Error("completed still visible");
console.log("D) complete", completed.status);

const again = await apiFetch<OnboardingSnapshot>("/me/onboarding", {
  method: "PUT",
  body: JSON.stringify({ action: "skip" }),
});
if (again.status !== "completed") {
  throw new Error("skip must not undo complete");
}
console.log("D) skip after complete stays completed");

console.log("onboarding-smoke ok");
```

- [ ] Correr (API + sesión; si no hay login, el script sale 1 con `"Need login"` — no fingir éxito):

```bash
cd api && bun test src/onboarding
cd cli && bun test src/onboarding
cd web && bun test src/lib/onboarding.test.ts
# con stack:
cd cli && bun run scripts/onboarding-smoke.ts
```

- [ ] Grep de control (no es test automatizado; el implementador lo corre y no debe haber matches en rutas de producto):

```bash
rg "onboardingStatus" api/src/routes/providers.ts api/src/routes/workspaces.ts
rg "wizardVisible" api/src/ws/handlers.ts
```

Cero matches: providers/workspaces/handlers no leen el wizard para autorizar. `handlers.ts` solo llama `markOnboardingComplete` **después** de un dispatch ok.

- [ ] Commit:

```bash
git add cli/scripts/onboarding-smoke.ts api/src/onboarding/skip-gate.test.ts
git commit -m "test(onboarding): skip does not gate API; smoke covers four Gherkin paths"
```

---

## Mapa escenario → task

| Escenario Gherkin | Tasks |
|---|---|
| Web post-sign-up (pasos provider / abrir workspace / chat; no workspace vacío como daemon) | 1, 2, 5 |
| CLI post-login (whoami/login explican; ask sin provider/daemon → paso concreto) | 1, 3 |
| Primer turn (corre; Web/TUI stream o error accionable; wizard completo) | 2, 4, 6 |
| Saltar wizard (se puede usar igual; no bloquea API ni headless) | 2, 5, 7 |

## Fuera de alcance (no implementar en esta fase)

- Cursor cloud, Cursor ejecutable (plan 4), voz, extensión IDE, `<input type="file">`.
- Notificaciones OS/email (plan 24). In-app = el wizard y el error en chat/TUI.
- Org, roles, link de solo lectura como membresía.
- Tours de más de 3 pasos, README embebido, checklist persistido por workspace.
- Cambiar `NO_DAEMON_ERROR`, first-wins, heartbeat, cola, worktrees.
- Subir el picker `@` por encima de 10.
)
</tool_call>