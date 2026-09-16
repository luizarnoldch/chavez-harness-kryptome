# Plan 24 — Notificaciones in-app

Contexto: [README](../README.md).

Solo Web y TUI. Sin OS, sin email.

```gherkin
# language: es
Característica: Avisos in-app
  Para no perder un ask o un turn
  Como usuario con Web o TUI abiertos
  Quiero badges en la propia app

  Escenario: Turn done
    Cuando un turn termina
    Entonces Web muestra aviso en el chat/workspace
    Y TUI muestra un badge si no estoy en ese chat

  Escenario: Ask pendiente
    Dado awaiting_approval
    Entonces Web y TUI lo destacan hasta resolver o timeout

  Escenario: Daemon caído
    Entonces ambas superficies muestran “sin runner”
    Y el aviso desaparece al reconnect (plan 17)

  Escenario: Sin spam
    Dado muchos deltas de stream
    Entonces no hay un aviso por delta
    Solo start/end/error/approval/daemon

  Escenario: CLI watch no es notificación
    Entonces watch sigue siendo el log
    Y no hay notificaciones OS
```

---
