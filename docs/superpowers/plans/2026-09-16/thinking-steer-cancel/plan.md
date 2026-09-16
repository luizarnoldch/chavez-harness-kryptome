# Plan 16 — Thinking, steer y cancelación fina

Contexto: [README](../README.md).

```gherkin
# language: es
Característica: Thinking, steer y cancel
  Para controlar un turn en vuelo
  Como usuario
  Quiero ver razonamiento, inyectar texto y cancelar

  Escenario: Thinking colapsable
    Dado un modelo que emite thinking
    Entonces Web/TUI pueden mostrar u ocultar
    Y no se confunde con el assistant final
    Y recargar conserva el thinking si se persistió (o lo omite de forma explícita)

  Escenario: Steer a mitad de turn
    Dado un turn running
    Cuando envío un steer (“no toques tests”)
    Entonces si el provider lo soporta, se inyecta
    Y si no, se explica y queda como follow-up al terminar
    Y CLI/TUI/Web pueden steerear

  Escenario: Cancelar el turn
    Cuando cancelo
    Entonces stream termina cancelled
    Y tools in-flight paran
    Y diffs no aplicados no se escriben
    Y el chat acepta un turn nuevo

  Escenario: Cancelar no es undo
    Dado writes ya aplicados antes del cancel
    Entonces esos archivos siguen
    Y puedo undo (plan 12) si hay git
```

---
