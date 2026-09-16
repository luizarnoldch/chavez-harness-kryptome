# Plan 6 — Diffs y revisión de cambios del agente

Contexto: [README](../README.md).

Complementa tools + modos. El usuario ve qué se escribió y puede aceptar o descartar.

### Objetivo

Cada turn que mute archivos publica un set de cambios. Web, TUI y CLI watch muestran el mismo diff. En `ask`, el diff es el material de aprobación. En `auto`, el diff es post-facto. En `plan`, no hay diffs de escritura.

```gherkin
# language: es
Característica: Diffs del turn
  Para revisar lo que el agente cambió
  Como usuario en Web, TUI o CLI
  Quiero ver archivos tocados y un diff unificado

  Antecedentes:
    Dado un workspace git con daemon bound
    Y un chat abierto

  Escenario: Turn auto con varios writes
    Dado modo auto
    Cuando el agente edita tres archivos
    Entonces al terminar el turn veo esos tres paths
    Y cada uno tiene un diff unificado
    Y Web, TUI y watch muestran el mismo set

  Escenario: Diff en ask es la aprobación
    Dado modo ask
    Cuando el agente propone un edit
    Entonces awaiting_approval incluye el diff
    Y si apruebo, el archivo cambia y el diff pasa a aplicado
    Y si rechazo, el archivo no cambia y no queda diff aplicado

  Escenario: Modo plan no genera diffs de escritura
    Dado modo plan
    Cuando el agente responde
    Entonces no hay archivos tocados
    Y no aparece un panel de diffs vacío como si hubiera cambios

  Escenario: Recargar Web conserva los diffs del turn
    Dado un turn ya terminado con diffs
    Cuando recargo el chat
    Entonces los diffs históricos siguen asociados a ese turn
    Y no se mezclan con el turn siguiente

  Escenario: Archivo creado vs modificado vs borrado
    Dado writes, edits y un delete
    Entonces cada path indica created | modified | deleted
    Y el diff de created muestra el contenido nuevo acotado
    Y el de deleted no exige el blob completo si es enorme

  Escenario: Diff enorme se trunca
    Cuando un archivo cambia miles de líneas
    Entonces el UI trunca con marca explícita
    Y puedo pedir el diff completo bajo demanda
    Y los clientes no se congelan

  Escenario: Turn sin mutación
    Dado un turn solo de read/grep
    Entonces no hay sección de diffs
    Y no se finge “0 archivos”

  Escenario: CLI watch imprime resumen
    Cuando hay diffs
    Entonces watch lista paths y un stat (+/- líneas)
    Y no vuelca el diff entero salvo flag/verbose
```

---
