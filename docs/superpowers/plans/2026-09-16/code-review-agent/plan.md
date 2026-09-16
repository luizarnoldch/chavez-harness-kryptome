# Plan 35 — Code review agent

Contexto: [README](../README.md).

Usa diffs (6) y git/PR (7). Es un **tipo de turn**, no otro provider.

```gherkin
# language: es
Característica: Review de PR o diff
  Para revisar cambios
  Como usuario
  Quiero un turn de review

  Escenario: Review del diff del turn
    Cuando pido review
    Entonces el agente lee el diff (plan 6 o vs HEAD)
    Y comenta hallazgos
    Y en plan no escribe
    Y en ask los writes de “fix” se aprueban uno a uno

  Escenario: Review de un PR GitHub
    Dado PR URL o número y GitHub linked
    Entonces el contexto es ese PR
    Y el resultado puede ser comentario en el chat
    Y publicar review en GitHub pide ask
    Y auto no publica reviews en GitHub salvo que el usuario lo pida en auto de forma explícita (mismo listón que commit)

  Escenario: Sin PR
    Entonces review local del working tree
    Y no falla por falta de GitHub
```

---
