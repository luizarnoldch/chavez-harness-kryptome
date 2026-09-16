# Plan 10 — Contexto, compactación y presupuesto de tokens

Contexto: [README](../README.md).

Complementa historial + attaches + tools.

```gherkin
# language: es
Característica: Compactar contexto
  Para no reventar la ventana del modelo
  Como usuario
  Quiero compactar y ver cuándo el contexto está lleno

  Escenario: Aviso de contexto alto
    Dado un chat largo con muchas tools
    Cuando el presupuesto supera un umbral
    Entonces Web/TUI/CLI avisan
    Y el turn siguiente no falla en silencio

  Escenario: Compactar por comando
    Cuando ejecuto compact (slash, TUI o CLI)
    Entonces el historial se resume
    Y las tools viejas no se reenvían enteras
    Y el último diff y el último plan (si hay) se conservan
    Y Web/TUI muestran un marcador “contexto compactado”

  Escenario: Compact automático al desbordar
    Cuando un turn no cabe
    Entonces se compacta y se reintenta una vez
    O se falla con mensaje de compactar a mano
    Y no se envían megabytes de grep

  Escenario: Attaches del mensaje actual no se resumen
    Dado @ de un archivo en el prompt actual
    Cuando hay compact del pasado
    Entonces el attach actual se hidrata completo (con su tope)
    Y no se pierde

  Escenario: Tools históricas no se re-ejecutan al compactar
    Entonces solo se resume texto
    Y no se vuelven a correr grep/write

  Escenario: Ambos providers
    Dado Claude o Cursor
    Entonces el compact es del chat Chavez
    Y no depende de un API distinta por provider más que el límite de contexto del modelo activo
```

---
