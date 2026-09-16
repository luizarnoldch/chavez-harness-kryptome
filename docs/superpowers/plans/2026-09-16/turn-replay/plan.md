# Plan 34 — Replay y logs del turn

Contexto: [README](../README.md).

```gherkin
# language: es
Característica: Replay
  Para debuggear un turn
  Como dueño del chat
  Quiero la traza ordenada sin secrets

  Escenario: Abrir replay
    Dado un turn terminado
    Entonces veo prompt, attaches, tools, diffs, assistant, usage, modo, modelo
    En orden
    Y Web/TUI coinciden

  Escenario: Redacción
    Entonces no hay API keys ni .env
    Y outputs de tools siguen truncados

  Escenario: No re-ejecuta
    Replay es lectura
    Y no vuelve a correr bash

  Escenario: CLI
    Puedo dump del turn a texto (útil en CI, plan 25)
```

---
