# Plan 36 — Marketplace de MCP y skills

Contexto: [README](../README.md).

Instalar desde UI, sobre el plan 19.

```gherkin
# language: es
Característica: Instalar MCP/skills
  Para no editar config a mano
  Como usuario
  Quiero un catálogo

  Escenario: Listar
    En Web veo skills/MCP disponibles
    Y su origen (oficial vs proyecto)

  Escenario: Instalar skill de usuario
    Queda en la cuenta (capa usuario)
    Y el siguiente turn puede usarla (plan 19)

  Escenario: Instalar MCP de proyecto
    Escribe/actualiza config del workspace
    Y en ask se confirma porque toca el repo
    Y auto puede hacerlo si el usuario pidió instalar

  Escenario: Desinstalar
    Entonces deja de cargarse
    Y no rompe tools nativas

  Escenario: Fallo de origen
    Entonces error visible
    Y no se ejecuta código de marketplace en el API
    El daemon del usuario es quien corre MCP
```

---
