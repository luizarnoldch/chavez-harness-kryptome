# Plan 17 — Daemon: reconnect, presencia, multi-host

Contexto: [README](../README.md).

Complementa hostname/path del picker.

```gherkin
# language: es
Característica: Daemon estable
  Para no perder el runner
  Como usuario
  Quiero reconectar y ver qué máquina ejecuta

  Escenario: Reconnect
    Dado un corte de red corto
    Cuando el daemon vuelve
    Entonces se re-bindea al mismo workspace
    Y Web deja de mostrar “sin runner”

  Escenario: Turn en curso y sleep
    Dado que la laptop duerme a mitad de turn
    Entonces al despertar el turn está error/cancelled o se reanuda de forma explícita
    Y no queda busy eterno

  Escenario: Presencia
    Entonces Web muestra hostname, path y last-seen
    Y CLI connections lista el daemon

  Escenario: Dos daemons
    Entonces gana el primero (invariante)
    Y el segundo se informa, no duplica tools

  Escenario: Heartbeat
    Cuando el daemon muere
    Entonces Web lo nota en segundos
    Y @ picker y agent.turn fallan con el mismo error de runner
```

---
