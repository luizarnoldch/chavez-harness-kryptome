# Plan 27 — Terminal interactivo / PTY

Contexto: [README](../README.md).

Bash one-shot sigue siendo el default (plan 2). PTY es opt-in.

```gherkin
# language: es
Característica: PTY
  Para comandos interactivos
  Como usuario
  Quiero adjuntarme a una sesión de terminal del daemon

  Escenario: Abrir PTY
    Cuando pido un terminal en TUI o Web
    Entonces el PTY corre en el cwd del daemon
    Y hostname/path se ven
    Y aplica ignore/secrets en lo que se persiste

  Escenario: El agente no toma el PTY por defecto
    Un turn usa bash one-shot
    Y no secuestra el PTY del usuario

  Escenario: Comando interactivo vía tool
    Si el modelo pide un PTY
    Entonces en ask se aprueba
    En auto se rechaza (no hay humano para el pager)
    En CI (plan 25) PTY no está

  Escenario: Cerrar
    Al cerrar Web/TUI el PTY termina
    Y no queda un proceso huérfano sin política
```

---
