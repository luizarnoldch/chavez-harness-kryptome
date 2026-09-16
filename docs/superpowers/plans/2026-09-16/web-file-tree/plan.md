# Plan 18 — Árbol y búsqueda de archivos en Web

Contexto: [README](../README.md).

El picker `@` sigue máx. 10. El árbol es exploración.

```gherkin
# language: es
Característica: Árbol de archivos Web
  Para navegar el workspace remoto
  Como usuario en Web
  Quiero un árbol lazy del disco del daemon

  Escenario: Árbol lazy
    Cuando abro el workspace
    Entonces veo la raíz (acotada)
    Y expandir una carpeta pide al daemon
    Y aplica ignore (plan 8)
    Y se ve hostname · path

  Escenario: Búsqueda por nombre
    Cuando busco "auth"
    Entonces veo matches acotados
    Y elegir uno puede insertar @ o abrir preview

  Escenario: Preview texto e imagen
    Entonces texto se muestra acotado
    Y imagen se renderiza
    Y binario no se finge como texto

  Escenario: Sin daemon
    Entonces el árbol explica que no hay filesystem
    Y no lista el disco del servidor API

  Escenario: Insertar @ desde el árbol
    Cuando elijo “adjuntar”
    Entonces se inserta un chip @ como el picker
    Y sigue siendo uno a uno
```

---
