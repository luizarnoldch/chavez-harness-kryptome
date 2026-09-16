# Plan 15 — Uso, costo y tokens

Contexto: [README](../README.md).

Catálogos JSON nativos: cada provider reporta usage distinto; se guarda crudo y se deserializa con types propios (igual que modelos).

```gherkin
# language: es
Característica: Usage por turn y chat
  Para ver consumo
  Como usuario
  Quiero tokens y costo estimado en Web, TUI y /cost

  Escenario: Turn reporta usage
    Cuando un turn Claude o Cursor termina
    Entonces se guarda el JSON crudo de usage
    Y se muestran input/output/cache si vienen
    Y si no vienen, “sin datos” no es error

  Escenario: Agregado del chat
    Entonces el detalle de chat suma turns
    Y /cost y el panel Web coinciden

  Escenario: Cursor vs Claude
    Entonces no se fuerza el mismo schema
    Y Router/cost de Cursor no se etiqueta como effort de Claude

  Escenario: whoami / CLI
    Entonces puedo ver usage reciente
    Y no se imprimen keys

  Escenario: Usage no bloquea el chat
    Dado que el provider no manda usage
    Entonces el assistant y las tools igual se persisten
```

---
