# Planes funcionales — 2026-09-16

Necesidades de producto en Gherkin (CLI, TUI, API, Web). No es implementación y no nombra archivos de código.

Cada plan vive en su carpeta:

| Plan | Carpeta |
|---|---|
| 1. Attach de archivos con `@` | [attach-files](./attach-files/plan.md) |
| 2. Tools de filesystem / SO | [agent-tools](./agent-tools/plan.md) |
| 3. Modos `plan` / `auto` / `ask` | [execution-modes](./execution-modes/plan.md) |
| 4. Cursor provider ejecutable | [cursor-provider](./cursor-provider/plan.md) |
| 5. Invariantes y regresiones | [invariants](./invariants/plan.md) |
| 6. Diffs y revisión de cambios | [diffs-review](./diffs-review/plan.md) |
| 7. Git del workspace hasta PR | [git-workspace](./git-workspace/plan.md) |
| 8. Ignore y secretos | [ignore-secrets](./ignore-secrets/plan.md) |
| 9. Reglas usuario + proyecto + local | [project-rules](./project-rules/plan.md) |
| 10. Compactar contexto | [context-compact](./context-compact/plan.md) |
| 11. Comandos `/` | [slash-commands](./slash-commands/plan.md) |
| 12. Undo del último turn (git) | [checkpoints-undo](./checkpoints-undo/plan.md) |
| 13. Aprobaciones una a una | [approvals](./approvals/plan.md) |
| 14. Artefacto de modo plan | [plan-artifact](./plan-artifact/plan.md) |
| 15. Uso y costo | [usage-cost](./usage-cost/plan.md) |
| 16. Thinking, steer, cancel | [thinking-steer-cancel](./thinking-steer-cancel/plan.md) |
| 17. Daemon reconnect / multi-host | [daemon-reconnect](./daemon-reconnect/plan.md) |
| 18. Árbol y búsqueda en Web | [web-file-tree](./web-file-tree/plan.md) |
| 19. MCP, skills y subagentes | [mcp-skills-subagents](./mcp-skills-subagents/plan.md) |
| 20. Loop de tests/linter | [verification-loop](./verification-loop/plan.md) |
| 21. Onboarding y primer turn | [onboarding](./onboarding/plan.md) |
| 22. Organización de sessions/chats | [chat-organization](./chat-organization/plan.md) |
| 23. Export / import / compartir | [export-share](./export-share/plan.md) |
| 24. Notificaciones in-app | [notifications](./notifications/plan.md) |
| 25. CI / headless no interactivo | [ci-headless](./ci-headless/plan.md) |
| 26. Sandbox de red | [sandbox-network](./sandbox-network/plan.md) |
| 27. Terminal PTY | [pty-terminal](./pty-terminal/plan.md) |
| 28. Worktree como cwd (no paralelo) | [worktree-cwd](./worktree-cwd/plan.md) |
| 29. Cola de turns | [turn-queue](./turn-queue/plan.md) |
| 30. Fetch web | [web-fetch](./web-fetch/plan.md) |
| 31. Memoria entre chats | [memory](./memory/plan.md) |
| 32. Biblioteca de prompts | [prompt-library](./prompt-library/plan.md) |
| 33. Sin org (invariante) | [no-team-invariant](./no-team-invariant/plan.md) |
| 34. Replay del turn | [turn-replay](./turn-replay/plan.md) |
| 35. Code review agent | [code-review-agent](./code-review-agent/plan.md) |
| 36. Marketplace MCP/skills | [mcp-skills-marketplace](./mcp-skills-marketplace/plan.md) |

---

## Contexto de producto (invariantes)

Chavez es un hub de agente de código con cuatro superficies:

| Superficie | Rol |
|---|---|
| **Web** | Consola: auth, providers, workspaces, timeline del chat, disparo de turns |
| **API** | Auth, vault, catálogo, persistencia, fan-out WebSocket |
| **CLI** | Auth device-code, headless (workspace/session/chat/ask/watch), launcher TUI |
| **TUI** | Cliente daemon: navega sessions/chats, compone prompts, ejecuta el agente en el cwd |

Reglas que todos los planes deben respetar:

1. El **filesystem real vive en la máquina del daemon** (CLI headless o TUI), no en el navegador ni en el servidor de API.
2. Un turn de agente solo corre si hay **daemon bound** al workspace. Sin daemon, el usuario recibe un error claro.
3. Web, CLI `watch` y TUI ven el **mismo chat en vivo** (mensajes, stream, tools).
4. Provider, modelo, esfuerzo/params y **modo de ejecución** activos se **persisten en preferencias** y se respetan en todas las superficies.
5. Claude ya es un provider **ejecutable**. Cursor hoy se puede vincular, pero **no ejecuta** turns. El [plan 4](./cursor-provider/plan.md) cierra esa brecha.
6. Las tools del LLM se ejecutan **por defecto** (sin configuración extra del usuario) sobre el workspace abierto; el **modo** decide si hay confirmación.

---

## Decisiones de producto (cerradas)

| # | Decisión |
|---|---|
| 1 | Modos de ejecución: **`plan`**, **`auto`**, **`ask`**. Controlan confirmaciones/permisos de write/edit/bash (y equivalentes). |
| 2 | `@` admite **todo tipo de archivo** (texto, imagen, binario, directorio). El daemon hidrata según el tipo. |
| 3 | Cursor es **solo runtime local** (cwd del workspace). Cloud agents quedan fuera de alcance. |
| 4 | Catálogos de Claude y Cursor se **recolectan completos**. Si el JSON difiere, se **guarda el JSON crudo** y se **deserializa** con los types de cada provider. Params de Cursor (Router cost/balanced/intelligence, fast, etc.) se exponen como el esfuerzo de Claude. |
| 5 | Picker `@`: **máximo 10** candidatos. A medida que el usuario escribe, la lista se **afina**. La selección es **de uno en uno** (un attach por elección; se puede repetir `@` para más). Un directorio adjunto lista como máximo 10 entradas. |
| 6 | El picker Web muestra **hostname + path del daemon** para no adjuntar el workspace equivocado (multi-host). |
| 7 | Git hasta **PR en GitHub** (status, diff, branch, commit, push, PR). Token en vault. |
| 8 | **MCP + skills + subagentes**, visibles en la misma timeline. |
| 9 | Reglas en capas **usuario + proyecto + local**. Proyecto carga AGENTS y nativos Claude/Cursor. |
| 10 | Undo del **último turn vía git**. Sin repo, undo deshabilitado con mensaje. |
| 11 | Aprobaciones **una a una**. Sin lote ni “siempre permitir”. |
| 12 | Fuera de alcance: Cursor cloud, voz, extensión IDE, upload desde el navegador. |
| 13 | Notificaciones **solo in-app** (Web + TUI). Sin OS ni email. |
| 14 | CI: **exit code + log texto**. Sin JSON schema ni GitHub Action. |
| 15 | En **auto**, red denegada por defecto; FS = workspace. En **ask** se puede pedir red. |
| 16 | **Un usuario = su vault**. Sin org ni roles. Link de solo lectura no es membresía. |
| 17 | **1 turn por daemon**. Cola sí; worktrees no paralelos (solo cwd del siguiente turn). |

Resto de reglas:

- `@` referencia archivos y directorios del **workspace**, no URLs ni secrets.
- Varios `@` en el mismo prompt están permitidos (cada uno elegido por separado).
- El contenido adjunto se hidrata **en el daemon** antes de enviarlo al LLM.
- Tools por defecto: **read, write, update/edit, grep, glob/list, bash/shell**.
- Lecturas (read/grep/glob) no piden confirmación en ningún modo. Write/edit/bash dependen del modo.
- Misma visualización de tools para Claude y Cursor.

---

## Orden de entrega sugerido (funcional, no técnico)

1. [Attach](./attach-files/plan.md) — contrato `@` + picker (máx. 10, afinar, uno a uno) + hostname/path del daemon + hidratación de cualquier tipo de archivo.
2. [Tools](./agent-tools/plan.md) — tools por defecto + visualización (`start` / `awaiting_approval` / `done` / `error`) en Web, TUI y CLI.
3. [Modos](./execution-modes/plan.md) — `plan` / `auto` / `ask` persistidos y respetados en el dispatch del turn.
4. [Cursor](./cursor-provider/plan.md) — ejecutable local + catálogos JSON crudos de Claude y Cursor, deserializados con sus types.
5. [Invariantes](./invariants/plan.md) — auth, un daemon, sync, busy, cancel, path sandbox, switch Claude↔Cursor, modo no se pierde entre superficies.
6. [Ignore](./ignore-secrets/plan.md) — `@`, grep y árbol no indexan basura ni secrets.
7. [Diffs](./diffs-review/plan.md) — archivos tocados y diff por turn.
8. [Aprobaciones](./approvals/plan.md) — cierre de `ask` (quién, timeout, no auto-approve headless).
9. [Undo](./checkpoints-undo/plan.md) — último turn vía git.
10. [Git + PR](./git-workspace/plan.md) — commit/push/PR GitHub.
11. [Reglas](./project-rules/plan.md) — capas usuario / proyecto / local.
12. [Compact](./context-compact/plan.md) — presupuesto de tokens.
13. [Slash](./slash-commands/plan.md) — `/mode` `/model` `/compact` `/undo` `/cost` `/help`.
14. [Artefacto plan](./plan-artifact/plan.md) — plan editable y “aplicar”.
15. [Daemon](./daemon-reconnect/plan.md) — reconnect, presencia, heartbeat.
16. [Árbol Web](./web-file-tree/plan.md) — exploración lazy; picker `@` sigue en máx. 10.
17. [Usage](./usage-cost/plan.md) — JSON nativo por provider.
18. [Thinking / steer / cancel](./thinking-steer-cancel/plan.md).
19. [Verificación](./verification-loop/plan.md) — tests/linter como tools.
20. [MCP / skills / subagentes](./mcp-skills-subagents/plan.md) — el más caro; al final.
21. [Onboarding](./onboarding/plan.md)
22. [Organización](./chat-organization/plan.md)
23. [Notificaciones](./notifications/plan.md)
24. [Cola](./turn-queue/plan.md)
25. [Sandbox red](./sandbox-network/plan.md)
26. [CI](./ci-headless/plan.md)
27. [Replay](./turn-replay/plan.md)
28. [Export/share](./export-share/plan.md)
29. [Worktree cwd](./worktree-cwd/plan.md)
30. [Memoria](./memory/plan.md)
31. [Prompts](./prompt-library/plan.md)
32. [Fetch](./web-fetch/plan.md)
33. [PTY](./pty-terminal/plan.md)
34. [Review agent](./code-review-agent/plan.md)
35. [Marketplace](./mcp-skills-marketplace/plan.md)
36. [Sin org](./no-team-invariant/plan.md) — invariante, no feature de equipo.

Cada paso debe poder demostrarse con los escenarios Gherkin, en CLI + TUI + Web, no solo en una superficie.
