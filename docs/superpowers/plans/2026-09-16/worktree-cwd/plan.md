# Plan 28 — Worktree como cwd (no paralelo)

Contexto: [README](../README.md).

Un solo turn por daemon. El worktree es **dónde** corre el siguiente turn.

```gherkin
# language: es
Característica: Worktree de trabajo
  Para no ensuciar main
  Como usuario
  Quiero que el siguiente turn use un worktree

  Escenario: Elegir worktree
    Dado un repo git
    Cuando elijo o creo un worktree
    Entonces el daemon cwd pasa a ese path
    Y @, tools y diffs operan ahí
    Y Web muestra hostname · path del worktree

  Escenario: No hay dos turns a la vez
    Aunque existan dos worktrees
    Entonces el segundo turn se encola (plan 29) o espera
    Y no hay dos writers

  Escenario: Sin git
    Entonces worktree no aplica
    Y se usa el cwd del workspace
```

---
