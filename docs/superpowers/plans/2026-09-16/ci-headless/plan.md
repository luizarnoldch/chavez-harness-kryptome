# Plan 25 — CI / headless no interactivo

Contexto: [README](../README.md).

Exit code + log texto. Sin JSON schema. Sin GitHub Action.

```gherkin
# language: es
Característica: Chavez en CI
  Para usar el agente en un pipeline
  Como automatización
  Quiero un comando que termina con 0 o !=0 y un log

  Escenario: Turn auto en CI
    Dado provider, modo auto, daemon o runner de CI en el cwd
    Cuando corro un ask no interactivo
    Entonces stdout/stderr narran tools y el assistant
    Y el proceso sale 0 si el turn finished ok

  Escenario: Fallo
    Dado error de provider, tool error fatal o tests pactados en rojo (plan 20)
    Entonces exit != 0
    Y el log incluye el motivo

  Escenario: Modo ask en CI
    Entonces no espera aprobación humana
    Y sale != 0 con “ask no válido en no-interactivo”
    O el invocador debe pasar auto de forma explícita

  Escenario: Sin TTY
    Entonces no abre TUI
    Y no pide secrets por prompt (solo env/vault ya linked)

  Escenario: Log no contiene vault
    Entonces keys redactadas
```

---
