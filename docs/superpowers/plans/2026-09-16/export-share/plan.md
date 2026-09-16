# Plan 23 — Export, import y compartir chat

Contexto: [README](../README.md).

```gherkin
# language: es
Característica: Exportar y compartir
  Para llevarme un chat o mostrarlo
  Como dueño del chat
  Quiero export sin vault

  Escenario: Export markdown
    Cuando exporto un chat
    Entonces obtengo mensajes user/assistant y un resumen de tools/diffs
    Y no salen tokens ni keys
    Y los attaches son paths, no blobs enormes por defecto

  Escenario: Export JSON
    Entonces el JSON es el historial persistido acotado
    Y usage va en crudo por provider si existe (plan 15)

  Escenario: Import
    Cuando importo un export mío
    Entonces se crea un chat nuevo en una session
    Y no se re-ejecutan tools

  Escenario: Link de solo lectura
    Cuando creo un link
    Entonces quien lo abre ve el timeline sin poder ask ni ver vault
    Y puedo revocar el link
    Y no es un “team workspace” (plan 33 fuera)

  Escenario: Sin sesión
    Export/import/link de otro user → 404
```

---
