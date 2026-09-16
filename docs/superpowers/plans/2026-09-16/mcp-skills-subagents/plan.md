# Plan 19 — MCP, skills y subagentes

Contexto: [README](../README.md).

Paridad cercana a Claude Code / Cursor.

```gherkin
# language: es
Característica: MCP, skills y subagentes
  Para extender tools más allá de read/write/grep/bash
  Como usuario
  Quiero MCP del proyecto, skills y fan-out visibles

  Escenario: MCP del workspace se carga
    Dado config MCP en el proyecto
    Cuando corre un turn
    Entonces esas tools están disponibles
    Y aparecen en la timeline con el mismo contrato (nombre, input, output, status)
    Y piden ask si son mutables (write/bash equivalentes)

  Escenario: MCP falla al arrancar
    Entonces el turn no muere entero
    Y se avisa qué servidor MCP no cargó
    Y las tools nativas siguen

  Escenario: Skills del proyecto
    Dado skills en el workspace
    Cuando el prompt encaja
    Entonces el agente puede usar esa skill
    Y la timeline indica qué skill se activó

  Escenario: Skills de usuario
    Dado skills en la cuenta Chavez
    Entonces aplican en todos sus workspaces
    Y local/proyecto pueden anular

  Escenario: Subagente
    Cuando el agente delega
    Entonces veo un grupo (running → done)
    Y las tools del hijo se anidan o se listan bajo el grupo
    Y Web/TUI/watch convergen

  Escenario: Presupuesto de subagentes
    Dado un tope
    Entonces no se lanzan más de N
    Y el exceso se rechaza visible

  Escenario: Subagente en modo plan
    Entonces los hijos tampoco mutan el disco

  Escenario: Provider Claude vs Cursor
    Entonces MCP/skills/subagentes se exponen si el runner lo soporta
    Y si Cursor no soporta un skill igual que Claude, se degrada con mensaje
    Y no se finge paridad
```

---
