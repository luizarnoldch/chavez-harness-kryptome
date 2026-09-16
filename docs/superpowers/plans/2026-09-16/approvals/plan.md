# Plan 13 — Aprobaciones una a una (cierre de `ask`)

Contexto: [README](../README.md).

Lote y “siempre permitir” **fuera**. Este plan cierra huecos de UX del modo ask.

```gherkin
# language: es
Característica: Aprobación una a una
  Para no dejar el turn colgado
  Como usuario
  Quiero aprobar o rechazar cada write/edit/bash

  Escenario: Cualquier cliente observador puede aprobar
    Dado awaiting_approval
    Entonces Web, TUI o CLI watch pueden resolver
    Y el primero gana
    Y el segundo ve “ya resuelto”

  Escenario: Timeout
    Dado que nadie aprueba
    Entonces tras un timeout visible la tool se deniega
    Y el turn no queda busy para siempre

  Escenario: Headless no auto-aprueba
    Dado modo ask y solo daemon headless
    Entonces espera a Web/watch
    Y no ejecuta write en silencio

  Escenario: Diff junto a la pregunta
    Entonces el pedido muestra path + diff o comando
    Y no solo el nombre de la tool

  Escenario: Lecturas no pasan por aquí
    Entonces read/grep/glob no aparecen como approval
```

---
