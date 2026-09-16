# Plan 4 — Integrar Cursor como provider ejecutable

Paridad Claude. Contexto y decisiones: [README](../README.md). Relacionados: [tools](../agent-tools/plan.md), [modos](../execution-modes/plan.md).

## Objetivo

Cursor se comporta como Claude en el harness: se vincula, se elige modelo, se ejecuta un **agente local** sobre el workspace, se streamean texto y tools, y se persiste el chat. El usuario puede cambiar de provider/modelo/params/modo desde CLI, TUI, Web y API.

Los catálogos de Claude y Cursor se recolectan **completos**. Cada provider tiene JSON distinto: se **persiste el JSON crudo** y se **deserializa** con los types de ese provider (esfuerzo Claude vs params Cursor: `optimize_for`, `fast`, etc.). No se aplana a un único schema que pierda campos.

## Actores

- Usuario
- Vault de credenciales (API)
- Catálogo de modelos (estático para Claude; descubierto para Cursor)
- Runner de Cursor en el daemon
- Clientes de chat

---

### Característica: vincular y desvincular Cursor

```gherkin
# language: es
Característica: Credenciales de Cursor
  Para poder ejecutar el agente Cursor
  Como usuario
  Quiero guardar una API key de Cursor en el vault de Chavez

  Escenario: Vincular Cursor con API key desde CLI
    Dado que estoy logueado en el CLI
    Cuando vinculo el provider cursor con una API key
    Entonces queda linked en el vault
    Y `provider list` muestra cursor como linked (api_key)
    Y la key no se imprime en logs ni en whoami

  Escenario: Vincular Cursor desde Web
    Dado que estoy en la consola de providers
    Cuando guardo una API key de Cursor
    Entonces el estado linked se refleja también en el CLI
    Y puedo usarla sin volver a pegarla

  Escenario: Vincular Cursor vía flujo web abierto desde CLI
    Dado el comando de link con opción web
    Cuando se abre el hub de providers con token
    Entonces puedo pegar la key en el navegador
    Y al guardar, el CLI ve el provider linked

  Escenario: Desvincular Cursor
    Dado Cursor linked
    Cuando lo desvinculo
    Entonces deja de ser ejecutable
    Y un turn con provider activo cursor falla con "no credentials"
    Y Claude, si sigue linked, no se afecta

  Escenario: Revelar credencial es explícito y autenticado
    Dado que pido ver la key de Cursor
    Entonces hace falta sesión
    Y no se expone en listados por defecto
```

### Característica: catálogo y selección de provider / modelo

```gherkin
# language: es
Característica: Providers y modelos unificados
  Para manejar Claude y Cursor igual
  Como usuario
  Quiero ver qué providers están linked, cuáles son ejecutables, y elegir modelo

  Escenario: Catálogo de Cursor deja de ser stub
    Dado Cursor linked con una key válida
    Cuando consulto providers
    Entonces Cursor aparece como runnable
    Y la lista de modelos incluye los que la cuenta puede usar
    Y ya no se presenta como stub no ejecutable

  Escenario: Se recolecta el catálogo completo de Cursor
    Dado una key válida
    Cuando se pide el catálogo
    Entonces se guarda el JSON crudo que devolvió Cursor
    Y se deserializa con los types de Cursor (id, params, variants, optimize_for, fast, etc.)
    Y si la cuenta tiene Router, aparecen Cost / Balance / Intelligence
    Y si Router no está habilitado, no se ofrece como si existiera

  Escenario: Se recolecta el catálogo completo de Claude
    Dado Claude linked
    Cuando se pide el catálogo
    Entonces se guarda el JSON crudo de Claude
    Y se deserializa con los types de Claude (id, label, precios, effortLevels)
    Y no se fuerza el shape de Cursor sobre Claude ni al revés

  Escenario: JSON distintos conviven
    Dado ambos providers linked
    Cuando Web o TUI piden providers
    Entonces cada catálogo llega con su payload nativo
    Y la UI de Claude muestra esfuerzo
    Y la UI de Cursor muestra params de ese modelo (Router u otros)
    Y un campo desconocido no se descarta al persistir el JSON crudo

  Escenario: Fallback si el catálogo remoto falla
    Dado que Cursor está linked pero el discovery de modelos falla
    Cuando abro la UI de providers
    Entonces veo un error o el último JSON crudo cacheado
    Y no se pierde la key
    Y no se marca runnable con un modelo inventado que va a fallar al primer turn

  Escenario: Cursor no ofrece runtime cloud
    Dado Cursor activo
    Cuando creo un turn
    Entonces siempre corre local contra el cwd del daemon
    Y no hay opción de cloud VM / repos remotos en esta fase

  Escenario: Elegir Cursor como provider activo (CLI)
    Dado Claude y Cursor linked
    Cuando hago provider set cursor
    Entonces el provider activo es cursor
    Y TUI y Web leen la misma preferencia

  Escenario: Elegir modelo y params (Web)
    Dado provider activo cursor
    Cuando selecciono un modelo y, si aplica, un param (fast u optimize_for)
    Entonces se persiste en preferencias
    Y el siguiente turn usa esa selección

  Escenario: Elegir provider/modelo/esfuerzo (TUI)
    Dado la TUI abierta
    Cuando ciclo provider y modelo
    Entonces no puedo dejar un modelo de Claude activo con provider Cursor
    Y el esfuerzo/params se recorta a lo que el modelo soporta
    Y la preferencia se guarda

  Escenario: Preferencias inválidas se rechazan
    Dado que pongo activeProvider=cursor y un modelId de Claude
    Cuando guardo preferencias
    Entonces la API rechaza o corrige de forma explícita
    Y no se dispara un turn con un par imposible

  Escenario: Claude sigue igual
    Dado que el activo es Claude
    Cuando corro un turn
    Entonces sigue usando el catálogo, esfuerzo y credenciales de Claude
    Y no requiere key de Cursor
```

### Característica: ejecutar turns con Cursor

```gherkin
# language: es
Característica: Agente Cursor local sobre el workspace
  Para tener paridad de runtime con Claude
  Como usuario
  Quiero que el daemon ejecute Cursor contra el cwd del workspace

  Antecedentes:
    Dado Cursor linked y activo
    Y un modelo válido seleccionado
    Y daemon bound al workspace

  Escenario: Primer turn Cursor
    Dado un chat vacío
    Cuando envío "resume este repositorio"
    Entonces el daemon arranca un agente Cursor local en el cwd
    Y aparecen stream deltas
    Y un mensaje assistant final persistido

  Escenario: Historial se reinyecta
    Dado un chat con turns previos (hechos con Claude o Cursor)
    Cuando envío un follow-up con Cursor
    Entonces el modelo recibe el historial del chat
    Y no responde como si fuera el primer mensaje

  Escenario: Tools de Cursor se normalizan al mismo contrato visual
    Dado que Cursor invoca read/edit/shell
    Cuando llegan eventos del SDK
    Entonces se publican como tool start/result con nombre, id, input, output, status
    Y Web/TUI/CLI los renderizan igual que las tools de Claude

  Escenario: Cancelación
    Dado un turn Cursor en curso
    Cuando el usuario cancela
    Entonces el run pasa a cancelled
    Y el stream termina
    Y el chat acepta un turn nuevo

  Escenario: Error de autenticación Cursor
    Dado una key inválida o revocada
    Cuando arranca el turn
    Entonces el usuario ve un error de auth de Cursor
    Y se sugiere re-vincular
    Y no se cuelga el daemon

  Escenario: Error de modelo no disponible
    Dado un modelId que la cuenta ya no puede usar
    Cuando arranca el turn
    Entonces el error nombra el modelo
    Y se sugiere elegir otro del catálogo descubierto

  Escenario: Cambiar de Claude a Cursor a mitad de un chat
    Dado un chat que ya tiene mensajes hechos con Claude
    Cuando activo Cursor y envío un follow-up
    Entonces el turn corre con Cursor
    Y el historial previo se conserva
    Y las tools nuevas se siguen viendo en la timeline

  Escenario: Cursor no ejecuta si no es el provider activo
    Dado provider activo Claude
    Cuando envío un turn
    Entonces corre Claude
    Y no se gasta la key de Cursor
```

### Característica: superficies de selección consistentes

```gherkin
# language: es
Característica: CLI, TUI, API y Web manejan el mismo estado de provider
  Para no divergir quién está activo
  Como usuario
  Quiero una sola fuente de preferencias

  Escenario: API expone catálogos y estado
    Cuando pido el estado de providers
    Entonces obtengo linked, authKind, runnable, models (JSON nativo por provider), activeProvider, activeModel, activeEffort/params, activeMode
    Y sin sesión recibo 401

  Escenario: Web refleja runnable
    Dado Cursor linked y runnable
    Entonces la consola no muestra "stub"
    Y permite elegir Cursor como activo y disparar turns

  Escenario: TUI refleja runnable
    Dado Cursor activo y runnable
    Entonces la TUI no etiqueta LLM: stub
    Y un prompt en compose dispara el runner de Cursor

  Escenario: CLI whoami / provider status
    Cuando consulto el estado
    Entonces veo provider activo, modelo y si Cursor está linked/runnable

  Escenario: Turn sin key con provider Cursor activo
    Dado Cursor activo pero no linked
    Cuando pido un turn desde cualquier superficie
    Entonces el error es el mismo de fondo: falta credencial
    Y se indica cómo vincular (CLI o Web)
```
