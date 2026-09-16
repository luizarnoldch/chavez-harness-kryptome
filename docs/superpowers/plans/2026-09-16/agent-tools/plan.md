# Plan 2 — Tools de filesystem / SO en el LLM

Paridad Claude Code / Cursor CLI. Contexto y decisiones: [README](../README.md). Relacionados: [attach](../attach-files/plan.md), [modos](../execution-modes/plan.md), [Cursor](../cursor-provider/plan.md).

## Objetivo

El agente, con Claude o Cursor, puede **leer, buscar, crear, actualizar y (vía shell) operar** archivos del workspace local, por defecto, sin que el usuario tenga que configurar tools. Cada invocación se ve en vivo en CLI, TUI y Web, y queda en el historial del chat.

## Actores

- LLM del provider activo
- Daemon (ejecutor de tools en el cwd)
- API (persistencia `role=tool` + broadcast)
- Clientes observadores (Web timeline, TUI messages, CLI watch)

## Tools mínimas (paridad)

| Tool | Intención |
|---|---|
| **read** | Leer un archivo (rango de líneas opcional) |
| **write** | Crear o sobrescribir un archivo |
| **update/edit** | Parchear un archivo existente |
| **grep** | Buscar texto/regex en el workspace |
| **glob / list** | Encontrar archivos por patrón o listar directorio |
| **bash / shell** | Comando en el cwd del workspace |

Otras tools del SDK del provider (todo list, etc.) pueden aparecer en la timeline con el mismo contrato visual, aunque no sean el foco de esta fase.

El **modo de ejecución** (`plan` / `auto` / `ask`) gobierna si write/edit/bash se ejecutan, se confirman o se bloquean. Las lecturas no se confirman. Ver [modos](../execution-modes/plan.md).

---

### Característica: tools disponibles por defecto

```gherkin
# language: es
Característica: Tools de agente activas por defecto
  Para operar el workspace como Claude Code o Cursor CLI
  Como usuario
  Quiero que el LLM tenga tools de archivos y shell sin configuración extra

  Antecedentes:
    Dado un workspace con daemon bound
    Y un provider ejecutable vinculado (Claude o Cursor)
    Y un chat abierto

  Escenario: El usuario no configura tools
    Dado que no he declarado ninguna tool a mano
    Cuando envío "lee el README y dime de qué trata el repo"
    Entonces el agente puede invocar read (o equivalente) sobre el workspace
    Y responde con información que solo está en esos archivos

  Escenario: Read sobre un path del workspace
    Dado el prompt "lee src/auth.ts y resume la función de login"
    Cuando el agente corre
    Entonces se emite una tool read con el path
    Y el resultado incluye el contenido o un extracto
    Y la respuesta final usa ese contenido

  Escenario: Grep en el workspace
    Dado el prompt "busca dónde se valida el device code"
    Cuando el agente corre
    Entonces puede invocar grep/search
    Y los hits se limitan al workspace
    Y la timeline muestra la query y un resultado acotado

  Escenario: Write crea un archivo
    Dado el prompt "crea NOTES.md con un resumen de este chat"
    Cuando el agente corre
    Entonces invoca write sobre una ruta dentro del workspace
    Y el archivo existe en disco al terminar el turn
    Y la timeline muestra path + estado done

  Escenario: Update/edit modifica un archivo existente
    Dado un archivo de código en el workspace
    Cuando pido un cambio concreto ("renombra la función X a Y")
    Entonces el agente usa update/edit (no necesariamente reescribe el archivo entero)
    Y el cambio queda en disco
    Y la timeline muestra el path y un diff o input comprensible

  Escenario: Glob encuentra archivos por patrón
    Dado el prompt "lista los tests e2e"
    Cuando el agente corre
    Entonces puede usar glob/list
    Y no necesita que yo haya adjuntado esos archivos con @

  Escenario: Shell corre en el cwd del workspace
    Dado el prompt "ejecuta el test de auth y dime si pasa"
    Cuando el agente corre
    Entonces puede invocar bash/shell en el cwd del workspace
    Y stdout/stderr acotados aparecen como resultado de tool
    Y un comando que falla marca la tool como error sin tumbar todo el harness

  Escenario: Varias tools en un mismo turn
    Dado un prompt que requiere explorar y luego editar
    Cuando el agente hace grep → read → edit
    Entonces cada llamada se ve en orden en la timeline
    Y el mensaje assistant final llega después de las tools
    Y el historial del chat conserva esa secuencia

  Escenario: @ y tools conviven
    Dado que adjunto "@src/auth.ts" y pido "aplica el mismo patrón en el resto del módulo"
    Cuando el agente corre
    Entonces usa el attach como contexto inicial
    Y puede grep/read/edit otros archivos del mismo módulo
```

### Característica: visualización de tools en todas las superficies

```gherkin
# language: es
Característica: Ver llamadas a tools en vivo
  Para saber qué está haciendo el agente
  Como usuario en Web, TUI o CLI
  Quiero ver cada tool: nombre, estado, input y resultado

  Antecedentes:
    Dado un turn en curso que invoca tools
    Y al menos dos clientes observando el mismo chat (p.ej. Web + TUI)

  Escenario: Inicio de tool
    Cuando el LLM emite una tool call
    Entonces todos los clientes ven una entrada "tool · <nombre> · running"
    Y se muestra un input comprensible (path, query, comando) sin secretos crudos de credenciales

  Escenario: Resultado de tool
    Cuando la tool termina bien
    Entonces el estado pasa a done
    Y se muestra un output acotado (truncado si es enorme)
    Y la entrada no desaparece al terminar el stream

  Escenario: Tool awaiting_approval
    Dado modo ask y una write/edit/bash
    Cuando la tool pide permiso
    Entonces todos los clientes ven estado awaiting_approval
    Y pueden aprobar o rechazar
    Y no se muestra como done hasta que corre de verdad

  Escenario: Tool con error
    Cuando la tool falla (archivo no existe, comando exit != 0, permiso denegado)
    Entonces el estado pasa a error
    Y el motivo es visible
    Y el agente puede continuar el turn o finalizar con mensaje de error, sin colgar el chat

  Escenario: CLI watch
    Dado `chat watch` sobre ese chat
    Cuando ocurren start/result de tools
    Entonces el watch imprime esos eventos en orden
    Y también los deltas de texto del assistant

  Escenario: TUI timeline
    Dado la TUI con el chat abierto
    Cuando hay tools
    Entonces la lista de mensajes distingue user / assistant / tool
    Y un tool running se actualiza in-place a done/error
    Y el compositor permanece usable o muestra busy de forma explícita

  Escenario: Web timeline
    Dado el detalle de chat en Web
    Cuando hay tools
    Entonces cada tool es una tarjeta con badge de estado
    Y el stream de texto del assistant se ve aparte
    Y al recargar la página, las tools históricas siguen ahí

  Escenario: Preview del workspace
    Dado el overview del workspace en Web
    Cuando el último evento del chat es una tool
    Entonces el preview no miente (no muestra un assistant vacío si lo último fue una tool)
    Y un click abre la timeline completa

  Escenario: Persistencia
    Dado un turn que invocó tres tools y luego respondió
    Cuando me desconecto y vuelvo a abrir el chat
    Entonces veo las tres tools y el assistant final en el mismo orden
    Y los metadatos (nombre, estado, input, output) siguen disponibles
```

### Característica: ejecución local, límites y fallos de tools

```gherkin
# language: es
Característica: Tools ejecutan en el workspace local con guardas
  Para no operar fuera del proyecto ni dejar el chat inconsistente
  Como usuario
  Quiero que las tools estén acotadas al cwd del daemon

  Escenario: El ejecutor es el daemon
    Dado un turn disparado desde Web
    Cuando el modelo pide read de un archivo
    Entonces la lectura ocurre en el disco de la máquina del daemon
    Y no en el servidor de API ni en el navegador

  Escenario: Path traversal rechazado
    Dado que el modelo pide read/write de una ruta fuera del workspace
    Cuando el daemon ejecuta la tool
    Entonces la tool falla con error de path
    Y no se lee ni escribe fuera del workspace

  Escenario: Turn concurrente
    Dado que ya hay un turn en curso en ese daemon
    Cuando llega otro agent.turn
    Entonces se rechaza o se encola de forma visible
    Y no se mezclan tools de dos turns en el mismo chat

  Escenario: Sin daemon
    Dado que no hay daemon bound
    Cuando Web o CLI piden un turn que requeriría tools
    Entonces el usuario recibe error de "no hay runner"
    Y no queda un mensaje tool huérfano

  Escenario: Provider no ejecutable
    Dado que el provider activo no puede correr agente
    Cuando pido un turn
    Entonces se explica que hay que vincular/activar un provider ejecutable
    Y no se simulan tools falsas

  Escenario: Fallo a mitad de stream
    Dado que una tool o el provider corta la conexión a mitad del turn
    Cuando ocurre el error
    Entonces se emite stream error
    Y las tools ya empezadas quedan en error o done según corresponda
    Y el chat sigue aceptando un turn nuevo

  Escenario: Output enorme de grep o shell
    Dado un grep o comando con salida masiva
    Cuando se publica el resultado
    Entonces se trunca de forma visible
    Y el LLM recibe un resultado acotado
    Y los clientes no se congelan renderizando megabytes
```

### Característica: paridad de experiencia entre superficies

```gherkin
# language: es
Característica: Misma semántica de tools en CLI, TUI, API y Web
  Para que no importe quién dispara el turn
  Como usuario
  Quiero el mismo contrato de eventos

  Escenario: Turn desde TUI
    Dado que envío el prompt desde la TUI
    Entonces CLI watch y Web ven las mismas tools y el mismo assistant

  Escenario: Turn desde Web
    Dado que envío el prompt desde Web
    Entonces el daemon TUI/headless ejecuta las tools
    Y TUI y Web muestran la misma timeline

  Escenario: Turn desde CLI headless ask
    Dado que envío el prompt con chat ask
    Entonces watch, TUI y Web convergen al mismo historial

  Escenario: Append manual no dispara tools
    Dado que hago un append de nota humana
    Entonces no se invocan tools
    Y el mensaje aparece como user/system según el rol elegido
```
