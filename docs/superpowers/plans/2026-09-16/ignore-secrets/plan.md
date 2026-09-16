# Plan 8 — Ignore, secretos y alcance de `@` / tools

Contexto: [README](../README.md).

Complementa attach + tools + git.

```gherkin
# language: es
Característica: Ignore y redacción de secretos
  Para no indexar basura ni filtrar keys
  Como usuario
  Quiero que @, grep y el árbol respeten ignore

  Escenario: gitignore aplica al picker @
    Dado node_modules en .gitignore
    Cuando escribo "@node"
    Entonces no aparecen archivos dentro de node_modules
    Y el tope de 10 no se gasta en dependencias

  Escenario: Ignore del harness
    Dado patrones extra (.git, .env, vault, binarios enormes)
    Entonces grep/read/@ no los ofrecen por defecto
    Y un path escrito a mano a .env se rechaza o redacta

  Escenario: Forzar un archivo ignorado
    Dado que menciono a mano un path ignorado que existe
    Entonces o se pide confirmación (ask) o se avisa y no se hidrata
    Y no se silencia

  Escenario: Output de tool con key
    Dado un grep que matchea una API key
    Entonces el output visible está redactado
    Y el vault de Chavez nunca aparece en la timeline

  Escenario: Diff no muestra secretos
    Dado un edit que toca .env
    Entonces el cambio se bloquea o el diff redacta valores
    Y Git (plan 7) no lo commitea

  Escenario: Web árbol (plan 18) usa el mismo ignore
    Cuando abro el árbol
    Entonces no listo node_modules por defecto
    Y hostname/path del daemon siguen visibles
```

---
