# Plan 9 — Reglas de proyecto (usuario + proyecto + local)

Contexto: [README](../README.md).

Complementa historial y providers. Tres capas, no un solo archivo.

| Capa | Dónde vive | Se commitea |
|---|---|---|
| Usuario | Preferencias/reglas del usuario Chavez (todas las máquinas de esa cuenta) | No en el repo |
| Proyecto | Archivos de reglas del workspace (AGENTS y nativos Claude/Cursor si existen) | Sí |
| Local | Overrides de esta máquina/workspace | No |

```gherkin
# language: es
Característica: Reglas en capas
  Para que el agente respete convenciones
  Como usuario
  Quiero reglas de usuario, de repo y locales

  Escenario: Las tres capas se inyectan en el turn
    Dado reglas en usuario, proyecto y local
    Cuando corre un turn
    Entonces el LLM recibe las tres
    Y local gana sobre proyecto, proyecto sobre usuario, si hay conflicto explícito

  Escenario: Proyecto carga AGENTS y nativos
    Dado AGENTS.md y reglas Claude o Cursor en el repo
    Entonces ambas se cargan como capa proyecto
    Y no se exige que el usuario copie reglas a mano

  Escenario: Local no se sube a git
    Dado reglas locales
    Entonces commit/PR (plan 7) no las incluye
    Y otra máquina no las ve

  Escenario: Usuario sigue entre workspaces
    Dado una regla de usuario "responde en español"
    Cuando cambio de workspace
    Entonces sigue aplicando
    Y se puede desactivar por workspace

  Escenario: Visible qué reglas usó el turn
    Cuando termina un turn
    Entonces Web/TUI muestran cuántas reglas y de qué capa
    Y puedo inspeccionar títulos, no necesariamente el texto completo si es enorme

  Escenario: Sin archivos de reglas
    Entonces el turn corre igual
    Y no falla por “falta AGENTS.md”

  Escenario: Regla local pide no usar bash
    Dado modo auto
    Entonces esa restricción se respeta además del modo
    Y una invocación bash queda denied
```

---
