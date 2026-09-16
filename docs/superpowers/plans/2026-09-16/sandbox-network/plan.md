# Plan 26 — Sandbox de bash y red

Contexto: [README](../README.md).

Path sandbox ya está en 1–5. Este plan: **red**.

```gherkin
# language: es
Característica: Red y FS del shell
  Para que auto no hable con internet
  Como usuario
  Quiero bash acotado al workspace y sin red por defecto

  Escenario: Auto sin red
    Dado modo auto
    Cuando bash hace curl a internet
    Entonces la tool falla por política de red
    Y el assistant ve el error

  Escenario: Ask puede pedir red
    Dado modo ask y un curl
    Entonces awaiting_approval dice que pide red
    Y si apruebo, corre
    Y si rechazo, no hay paquete saliente

  Escenario: Plan no muta ni sale a red
    Entonces bash de red no corre

  Escenario: FS = workspace
    Dado auto
    Entonces bash no lee/escribe fuera del cwd del workspace
    Igual que read/write (planes 2 y 8)

  Escenario: Fetch/browser (plan 30) respeta lo mismo
    En auto, fetch a internet se niega salvo que el usuario esté en ask y apruebe
```

---
