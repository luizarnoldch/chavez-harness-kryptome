# Plan 14 — Artefacto de modo `plan`

Contexto: [README](../README.md).

```gherkin
# language: es
Característica: Plan persistido
  Para aplicar después de revisar
  Como usuario
  Quiero un documento de plan editable

  Escenario: Turn en modo plan crea artefacto
    Cuando termina un turn plan
    Entonces hay un artefacto de plan asociado al chat
    Y se ve en Web/TUI distinto de un assistant suelto

  Escenario: Editar el plan en Web
    Cuando edito el markdown del plan
    Entonces se persiste
    Y TUI ve la versión nueva

  Escenario: Aplicar plan
    Cuando elijo aplicar
    Entonces el modo pasa a ask o auto (el que yo tenga para ejecutar)
    Y el siguiente turn usa el artefacto como brief
    Y no hace falta copiar-pegar

  Escenario: Varios planes en el chat
    Entonces se aplica el marcado como actual
    Y los viejos quedan en historial

  Escenario: Modo plan + git
    Entonces aplicar no commitea solo
    Y el agente puede proponer commit en el turn de aplicación
```

---
