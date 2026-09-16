# Plan 22 — Organización de sessions y chats

Contexto: [README](../README.md).

```gherkin
# language: es
Característica: Hub de chats usable
  Para encontrar conversaciones
  Como usuario
  Quiero buscar, pin, archivar y títulos

  Escenario: Autotítulo
    Dado un chat nuevo
    Cuando termina el primer turn
    Entonces el título deja de ser el id
    Y puedo editarlo en Web y TUI

  Escenario: Buscar
    Cuando busco texto
    Entonces veo chats cuyo título o mensajes coinciden
    Y no se indexan outputs de tools secretos (plan 8)

  Escenario: Pin y archivar
    Entonces pin sube en la lista
    Y archivar oculta sin borrar
    Y CLI lista puede filtrar archived

  Escenario: Session agrupa chats
    Entonces mover/crear chat respeta la session del workspace
    Y Web overview no explota con 100 chats: ventana o paginación

  Escenario: Sync
    Dado pin en Web
    Entonces TUI ve el pin
```

---
