# Plan 21 — Onboarding y primer turn

Contexto: [README](../README.md).

```gherkin
# language: es
Característica: Primer uso
  Para no depender de un README
  Como usuario nuevo
  Quiero un camino guiado hasta el primer turn

  Escenario: Web post-sign-up
    Dado una cuenta nueva
    Cuando entro al hub
    Entonces veo los pasos: vincular provider, indicar cómo abrir un workspace, ir a un chat
    Y no se muestra un workspace vacío como si ya hubiera daemon

  Escenario: CLI post-login
    Cuando hago login por primera vez
    Entonces whoami o el siguiente comando explica: provider link, tui o workspace open, chat ask
    Y un ask sin provider/daemon falla con el siguiente paso concreto

  Escenario: Primer turn
    Dado provider linked y daemon bound
    Cuando envío el primer prompt
    Entonces el turn corre
    Y Web/TUI muestran stream o un error accionable
    Y el wizard se marca completo

  Escenario: Saltar wizard
    Entonces puedo usarlo igual
    Y no bloquea API ni headless
```

---
