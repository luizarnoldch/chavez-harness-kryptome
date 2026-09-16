# Plan 7 — Git del workspace hasta PR

Contexto: [README](../README.md).

Complementa diffs + tools. GitHub es el git host de esta fase.

### Objetivo

El usuario y el agente operan git del cwd: status, diff vs HEAD, branch, commit, push y abrir PR. Auth de GitHub vive en el vault (como un provider). Modo `ask` confirma commit/push/PR. Modo `plan` no muta git. Modo `auto` puede commitear/abrir PR si el usuario lo pidió.

```gherkin
# language: es
Característica: Git y pull requests
  Para no depender de bash git opaco
  Como usuario
  Quiero status, commit y PR visibles en todas las superficies

  Antecedentes:
    Dado un workspace que es un repo git
    Y daemon bound

  Escenario: Status visible
    Cuando pido el estado git (comando, slash o panel)
    Entonces veo branch, ahead/behind y archivos sucios
    Y Web, TUI y CLI coinciden

  Escenario: Diff contra HEAD
    Dado cambios uncommitted
    Cuando pido el diff git
    Entonces veo el diff vs HEAD
    Y es distinto del diff-por-turn (plan 6) si hubo edits manuales

  Escenario: No es un repo git
    Dado un workspace sin .git
    Entonces status/commit/PR se deshabilitan con mensaje
    Y el agente no finge un commit

  Escenario: Commit en ask
    Dado modo ask y cambios
    Cuando el agente propone commit con mensaje
    Entonces awaiting_approval muestra mensaje + lista de paths
    Y hasta aprobar, git log no cambia
    Cuando apruebo
    Entonces el commit existe en el repo local

  Escenario: Commit en auto si el usuario lo pidió
    Dado modo auto y el prompt "commitea estos cambios"
    Cuando el turn termina
    Entonces hay un commit con mensaje razonable
    Y la timeline muestra la tool/commit como done

  Escenario: Modo plan no commitea
    Dado modo plan y "commitea y abre PR"
    Entonces no hay commit ni PR
    Y la respuesta es un plan de git

  Escenario: Crear branch
    Cuando el agente crea una branch de trabajo
    Entonces el cwd queda en esa branch
    Y no se crea sobre main/master protegida sin pedirlo

  Escenario: Vincular GitHub
    Dado que no hay token de GitHub
    Cuando intento abrir PR
    Entonces se pide vincular GitHub (CLI o Web vault)
    Y no se pega el token en el chat

  Escenario: Abrir PR
    Dado GitHub vinculado, branch pusheada y commits
    Cuando pido abrir PR
    Entonces se crea el PR (título + body)
    Y Web/TUI muestran la URL
    Y watch imprime la URL

  Escenario: Push rechazado
    Cuando el remote rechaza (auth, non-fast-forward)
    Entonces la tool queda error con el motivo
    Y no se marca el PR como creado

  Escenario: Guardas
    Dado modo auto
    Entonces no se hace force push a main/master
    Y no se commitean archivos que parecen secrets
    Y un commit que incluye el vault se rechaza

  Escenario: Auth GitHub es por usuario Chavez
    Dado dos usuarios
    Entonces el token de A no abre PRs en la cuenta de B
    Y sin sesión, 401
```

---
