# Plan 30 — Browser / fetch web

Contexto: [README](../README.md).

```gherkin
# language: es
Característica: Fetch web
  Para leer docs fuera del repo
  Como usuario
  Quiero una tool HTTP visible

  Escenario: Fetch en ask
    Cuando el agente pide URL
    Entonces veo la URL en awaiting_approval
    Y el resultado es texto acotado
    Y entra en la timeline como tool

  Escenario: Fetch en auto
    Entonces se niega por plan 26
    Salvo que más adelante se defina allowlist (fuera: no always-allow)

  Escenario: No es MCP
    Entonces funciona sin config MCP
    Y MCP puede añadir browsers más ricos (plan 19) sin reemplazar esto

  Escenario: SSRF
    Entonces no se fetchea localhost del API ni metadata cloud
    Y el destino es la máquina del daemon, no el servidor Chavez
```

---
