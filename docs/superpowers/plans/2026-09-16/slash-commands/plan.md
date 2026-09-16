# Plan 11 — Comandos de chat `/`

Contexto: [README](../README.md).

Complementa composer TUI/Web y CLI.

Comandos mínimos: `/mode`, `/model`, `/provider`, `/compact`, `/clear`, `/undo`, `/cost`, `/help`, `/plan` (atajo a modo plan).

`/` no se confunde con `@`.

```gherkin
# language: es
Característica: Slash commands
  Para operar el harness sin salir del chat
  Como usuario
  Quiero comandos / en TUI, Web y equivalentes CLI

  Escenario: Autocomplete de /
    Cuando escribo "/"
    Entonces veo los comandos (no archivos)
    Y el picker de @ no se abre

  Escenario: /mode ask|auto|plan
    Cuando pongo /mode auto
    Entonces la preferencia de modo cambia
    Y el siguiente turn usa auto
    Y Web/TUI coinciden

  Escenario: /provider y /model
    Cuando cambio a cursor y un modelo del catálogo
    Entonces se persiste
    Y un modelo de Claude con provider cursor se rechaza

  Escenario: /compact y /undo
    Entonces disparan los planes 10 y 12
    Y dan feedback en el chat

  Escenario: /clear
    Entonces empieza un chat nuevo o vacía el compositor según la superficie
    Y no borra el repo

  Escenario: /cost
    Entonces muestra usage del chat/turn (plan 15)
    O “sin datos” si el provider no reportó

  Escenario: /help
    Entonces lista comandos y modos
    Y un comando desconocido explica /help

  Escenario: CLI headless
    Dado flags o subcomandos equivalentes
    Entonces no hace falta TTY para mode/provider/compact
```

---
