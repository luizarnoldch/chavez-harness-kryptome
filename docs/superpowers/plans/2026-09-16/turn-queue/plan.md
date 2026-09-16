# Plan 29 — Cola y background (1 running)

Contexto: [README](../README.md).

```gherkin
# language: es
Característica: Cola de turns
  Para no perder prompts
  Como usuario
  Quiero encolar si el daemon está busy

  Escenario: Segundo prompt se encola
    Dado un turn running
    Cuando envío otro desde Web o TUI
    Entonces no se rechaza en silencio
    Y queda queued con posición
    Y al terminar el actual, arranca el siguiente

  Escenario: Cancelar de la cola
    Puedo quitar un queued
    Y no corre

  Escenario: Modo ask en cola
    El queued no pide aprobación hasta que es running

  Escenario: Aviso in-app (plan 24)
    Cuando el queued pasa a running o done
    Entonces Web/TUI lo reflejan

  Escenario: CI
    En no-interactivo, busy puede esperar un timeout o fallar
    Y no encola para siempre
```

---
