# Plan 5 — Capacidades principales a preservar y extender

Regresiones y huecos. Contexto y decisiones: [README](../README.md).

Estos no son features nuevas aisladas: son el armazón sin el cual `@`, tools y Cursor no sirven. Incluye regresiones y necesidades que aparecen al sumar los otros planes.

---

### Característica: auth y sesión compartida

```gherkin
# language: es
Característica: Auth Web + CLI
  Escenario: Misma cuenta
    Dado un usuario creado por magic link o password en Web
    Cuando hago login device-code en CLI
    Entonces CLI y Web operan la misma cuenta

  Escenario: Sin sesión
    Cuando pido providers, chats o WS sin token/cookie
    Entonces recibo 401
    Y no se filtran workspaces ajenos (404)

  Escenario: Token de CLI en hub
    Dado un Bearer del CLI
    Cuando abro el hub de providers con ese token
    Entonces puedo vincular Cursor o Claude sin re-login
```

### Característica: workspace, daemon y dispatch

```gherkin
# language: es
Característica: Un solo runner por workspace
  Escenario: TUI se registra como daemon
    Dado `chavez tui` en un path
    Entonces Web puede despachar agent.turn a esa TUI

  Escenario: Headless workspace open también es daemon
    Dado headless workspace open
    Entonces también puede recibir dispatch
    Y si hay dos daemons, gana una regla determinista (el primero) y el usuario no ve turns duplicados

  Escenario: Cerrar workspace
    Cuando cierro el daemon
    Entonces Web deja de poder hidratar @ y ejecutar tools
    Y el error lo dice

  Escenario: Identidad del daemon visible
    Dado un daemon bound
    Cuando Web lista el workspace o abre el picker @
    Entonces muestra hostname y path
    Y si hay dos máquinas, no se confunden los filesystems
```

### Característica: sync de chat

```gherkin
# language: es
Característica: Sessions y chats en vivo
  Escenario: Crear session/chat en CLI aparece en TUI y Web
  Escenario: Append en Web aparece en TUI
  Escenario: Stream deltas se concatenan en orden
  Escenario: Recargar Web reconstruye timeline (user, tool, assistant) sin duplicar
```

### Característica: composición del prompt del agente

```gherkin
# language: es
Característica: El turn siempre lleva contexto suficiente
  Escenario: Historial de DB + prompt actual
  Escenario: Attaches del mensaje actual hidratados
  Escenario: Tools del turn actual no se re-ejecutan al reinyectar historial
  Escenario: Mensajes tool históricos se envían como contexto, no como nuevas invocaciones
```

### Característica: cancelar, busy y presencia

```gherkin
# language: es
Característica: Control del turn
  Escenario: Indicador busy en TUI/Web mientras corre el agente
  Escenario: Cancelar turn Claude o Cursor
  Escenario: Conexiones abiertas listables (CLI connections / API)
```

### Característica: seguridad transversal

```gherkin
# language: es
Característica: El agente no es root del usuario
  Escenario: Attaches y tools no salen del workspace
  Escenario: Secrets del vault nunca viajan al LLM ni a la timeline
  Escenario: Output de tools se redacta si parece una key
  Escenario: Web no recibe el filesystem completo, solo resultados de picker/turn acotados
```
