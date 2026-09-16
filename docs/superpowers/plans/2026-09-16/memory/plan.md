# Plan 31 — Memoria entre chats

Contexto: [README](../README.md).

Distinta de reglas (plan 9) y del historial de un chat.

```gherkin
# language: es
Característica: Memoria
  Para no repetir preferencias
  Como usuario
  Quiero recuerdos que cruzan chats

  Escenario: Guardar recuerdo
    Cuando digo “recuerda que el paquete de tests es bun”
    Entonces queda en memoria de usuario o de workspace
    Y un chat nuevo lo ve

  Escenario: No es una regla de archivo
    Entonces no se commitea como AGENTS.md
    Y se puede borrar desde Web/TUI

  Escenario: Alcance
    Memoria de workspace no vuela a otro repo
    Memoria de usuario sí (como capa usuario del plan 9, pero facts no instrucciones)

  Escenario: Visible
    Puedo listar y borrar recuerdos
    Y el turn puede mostrar “usé N recuerdos”

  Escenario: Compact (plan 10)
    Compact de un chat no borra la memoria global
```

---
