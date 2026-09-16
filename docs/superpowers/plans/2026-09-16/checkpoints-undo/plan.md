# Plan 12 — Checkpoints y undo del último turn (vía git)

Contexto: [README](../README.md).

```gherkin
# language: es
Característica: Undo del último turn
  Para revertir un auto-edit malo
  Como usuario
  Quiero deshacer el último turn si el workspace es git

  Escenario: Undo restaura archivos tocados
    Dado un turn que editó dos archivos en un repo git
    Cuando ejecuto undo
    Entonces esos dos vuelven al estado previo al turn
    Y los commits que el turn hubiera creado se tratan de forma explícita (revert o aviso)
    Y la timeline marca el turn como undone

  Escenario: Sin git, undo no está
    Dado un workspace sin repo
    Cuando pido undo
    Entonces veo que hace falta git
    Y el disco no se toca a ciegas

  Escenario: Solo el último turn
    Dado dos turns mutables
    Entonces undo afecta al más reciente
    Y el anterior se queda

  Escenario: Undo en ask de un turn rechazado
    Dado que rechacé todos los edits
    Entonces undo es no-op
    Y lo dice

  Escenario: Retry
    Cuando pido retry del último prompt
    Entonces se dispara un turn nuevo con el mismo texto y attaches
    Y no re-ejecuta tools históricas

  Escenario: Bash destructivo
    Dado un turn que además de edits corrió rm
    Entonces undo git restaura archivos versionados
    Y se avisa que efectos de shell no versionados pueden quedar

  Escenario: Web y TUI
    Entonces ambos pueden disparar undo
    Y el otro cliente ve el resultado
```

---
