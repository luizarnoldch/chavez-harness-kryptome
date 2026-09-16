# Plan 20 — Loop de verificación (tests, linter, diagnostics)

Contexto: [README](../README.md).

```gherkin
# language: es
Característica: Verificación tras edits
  Para no dar un turn por bueno si el test pactado falla
  Como usuario
  Quiero ver tests/linter como tools

  Escenario: El usuario pide tests
    Dado "cambia X y corre los tests"
    Cuando el agente edita
    Entonces corre el comando de test en el cwd
    Y stdout acotado es el resultado de tool
    Y si falla, el turn no se vende como éxito silencioso
    Y el assistant explica el fallo

  Escenario: Linter/diagnostics
    Entonces avisos se muestran como tool o como bloque
    Y no sustituyen al diff

  Escenario: Modo plan no corre tests que mutan
    Entonces no escribe coverage ni snapshots
    Y puede proponer el comando

  Escenario: Modo ask
    Entonces el bash de test pide aprobación como cualquier bash
    Y un test es lectura+ejecución, no skip automático

  Escenario: Verificación pactada del workspace
    Dado que las reglas (plan 9) definen “npm test”
    Cuando hay edits en auto
    Entonces el agente intenta esa verificación
    Y si no hay regla, no inventa un test suite

  Escenario: Test interminable
    Entonces timeout
    Y la tool error
    Y el turn se cierra
```

---
