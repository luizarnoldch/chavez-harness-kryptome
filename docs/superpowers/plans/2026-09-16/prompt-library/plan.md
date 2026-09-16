# Plan 32 — Biblioteca de prompts

Contexto: [README](../README.md).

Distinta de skills (plan 19): el usuario pega un prompt, no un procedimiento de agente.

```gherkin
# language: es
Característica: Prompts guardados
  Para no reescribir briefs
  Como usuario
  Quiero una biblioteca

  Escenario: Guardar desde el compositor
    Entonces el prompt queda en mi cuenta
    Y aparece en Web y TUI

  Escenario: Insertar
    Al elegir uno se inserta en el compositor
    Y puedo mezclar con @

  Escenario: No se ejecuta solo
    Guardar no dispara un turn

  Escenario: CLI
    Puedo listar y usar un prompt por nombre en ask
```

---
