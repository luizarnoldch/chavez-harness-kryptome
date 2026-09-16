# Plan 3 — Modos de ejecución: `plan`, `auto`, `ask`

Contexto y decisiones: [README](../README.md). Relacionados: [tools](../agent-tools/plan.md), [Cursor](../cursor-provider/plan.md).

## Objetivo

El usuario elige cómo el agente usa tools destructivas. Los tres modos existen en CLI, TUI, Web y API, se persisten con el resto de preferencias, y aplican igual a Claude y a Cursor.

## Semántica

| Modo | Lectura (read/grep/glob) | Write / update / bash | Intención |
|---|---|---|---|
| **`ask`** | Auto | Pide confirmación en TUI/CLI/Web antes de ejecutar | Por defecto seguro |
| **`auto`** | Auto | Ejecuta sin confirmación | Evitar permisos (paridad headless / “bypass”) |
| **`plan`** | Auto | No aplica cambios en disco ni corre shell de mutación | Explorar y proponer; el usuario cambia a `auto` o `ask` para ejecutar |

Confirmación en `ask`: la tool queda `running` / `awaiting_approval` hasta que un cliente aprueba o rechaza. El rechazo marca la tool como error/denied y el modelo puede continuar. Timeout o desconexión no deja el turn colgado para siempre: se deniega o se cancela con mensaje visible.

---

```gherkin
# language: es
Característica: Modos de ejecución del agente
  Para controlar confirmaciones de write/edit/bash
  Como usuario de CLI, TUI o Web
  Quiero elegir plan, auto o ask y que todas las superficies lo respeten

  Antecedentes:
    Dado un workspace con daemon bound
    Y un provider ejecutable vinculado
    Y un chat abierto

  Escenario: Preferencia de modo persistida
    Dado que pongo el modo en "auto" desde Web
    Cuando abro la TUI o disparo un ask headless
    Entonces el turn corre en modo auto
    Y CLI/TUI/Web muestran el mismo modo activo

  Escenario: Cambiar modo desde TUI
    Dado modo ask
    Cuando ciclo el modo a plan
    Entonces se guarda en preferencias
    Y el siguiente turn ya no escribe archivos

  Escenario: Cambiar modo desde CLI
    Dado un comando o flag de modo
    Cuando lo pongo en ask
    Entonces Web refleja modo ask
    Y write/edit/bash piden confirmación

  Escenario: Modo ask confirma write
    Dado modo ask
    Cuando el agente invoca write o edit
    Entonces la timeline muestra la tool en awaiting_approval
    Y TUI, Web y CLI ven el pedido (path + resumen del cambio)
    Y hasta que apruebo, el archivo en disco no cambia
    Cuando apruebo
    Entonces la tool corre y pasa a done
    Y el archivo queda escrito

  Escenario: Modo ask rechaza bash
    Dado modo ask
    Cuando el agente invoca bash y rechazo
    Entonces la tool queda denied/error
    Y el comando no se ejecutó
    Y el agente puede continuar o terminar el turn
    Y el chat no queda busy para siempre

  Escenario: Confirmación desde Web, ejecución en daemon
    Dado modo ask y un turn disparado desde Web
    Cuando Cursor o Claude pide un edit
    Entonces el diálogo de aprobación aparece en Web (y en TUI si está abierta)
    Y al aprobar, el daemon es quien escribe en su cwd

  Escenario: Modo auto no pide confirmación
    Dado modo auto
    Cuando el agente hace write, edit y bash
    Entonces las tools se ejecutan sin prompt de permiso
    Y siguen siendo visibles en la timeline (running → done/error)

  Escenario: Modo plan no muta el workspace
    Dado modo plan
    Cuando pido "refactoriza auth y corre los tests"
    Entonces el agente puede read/grep/glob
    Y no escribe archivos
    Y no ejecuta shell que mute el sistema
    Y la respuesta es un plan o propuesta
    Y al terminar, el árbol del workspace es el mismo

  Escenario: Pasar de plan a auto para aplicar
    Dado un chat que acaba de producir un plan en modo plan
    Cuando cambio a auto y digo "aplica el plan"
    Entonces el agente puede write/edit/bash sin confirmación
    Y el historial del plan sigue en el chat

  Escenario: Lecturas nunca piden confirmación
    Dado modo ask
    Cuando el agente hace read, grep o glob
    Entonces no aparece diálogo de permiso
    Y las tools se ven en la timeline como de costumbre

  Escenario: Path fuera del workspace se rechaza también en auto
    Dado modo auto
    Cuando el modelo pide write fuera del workspace
    Entonces la tool falla por sandbox
    Y auto no significa “sin límites de path”

  Escenario: Modo inválido se rechaza
    Dado que intento guardar modo "yolo" u otro valor
    Entonces la API rechaza
    Y el modo activo no cambia

  Escenario: El modo viaja con el turn
    Dado que Web tiene modo ask y disparo un turn
    Cuando el daemon ejecuta
    Entonces usa ask, no un default local distinto
    Y el mensaje/turn queda etiquetado con el modo usado

  Escenario: Headless en ask sin TTY
    Dado CLI headless sin TUI y modo ask
    Cuando una tool pide confirmación
    Entonces o bien el watch/Web pueden aprobar, o el turn espera con timeout visible
    Y no se auto-aprueba en silencio
```
