# Plan 1 — Attach de archivos con `@`

Contexto y decisiones: [README](../README.md). Relacionados: [tools](../agent-tools/plan.md), [modos](../execution-modes/plan.md), [invariantes](../invariants/plan.md).

## Objetivo

El usuario menciona archivos con `@` en el compositor (CLI, TUI, Web). El LLM recibe esos archivos como contexto del turn. Las menciones se ven en el mensaje persistido y en todas las superficies sincronizadas.

## Actores

- Usuario autenticado
- Daemon del workspace (CLI o TUI)
- API (persistencia + broadcast)
- LLM del provider activo

## Fuera de alcance de esta fase

- Adjuntos desde el navegador (upload de archivos remotos que no existen en el workspace)
- `@` de personas, issues o URLs
- Cloud agents de Cursor (runtime local solamente)

---

### Característica: mencionar archivos con `@` en el compositor

```gherkin
# language: es
Característica: Attach de archivos con @
  Para que el agente trabaje sobre archivos concretos del workspace
  Como usuario de CLI, TUI o Web
  Quiero referenciar rutas con @ y que el LLM reciba su contenido

  Antecedentes:
    Dado que estoy autenticado en Chavez
    Y que tengo un workspace abierto con daemon bound
    Y que el provider activo está vinculado y es ejecutable
    Y que existe un chat en una session de ese workspace

  Escenario: Autocompletar archivos al escribir @
    Dado que el compositor del chat está enfocado
    Cuando escribo "@"
    Entonces veo como máximo 10 candidatos de archivos y carpetas del workspace
    Y los candidatos se resuelven contra el cwd del workspace, no contra el servidor de API
    Y puedo elegir uno con teclado (TUI/CLI) o clic (Web)

  Escenario: La lista se afina al escribir más texto
    Dado que el picker está abierto con "@sr"
    Cuando escribo más caracteres ("c/au")
    Entonces los 10 o menos candidatos se recalcan al prefijo
    Y el orden prioriza coincidencias más específicas (path relativo)
    Y si no hay coincidencias, el picker lo dice sin insertar un attach falso

  Escenario: Selección de uno en uno
    Dado que el picker muestra varios candidatos
    Cuando elijo uno
    Entonces se inserta un solo chip/token de ese path
    Y el picker se cierra
    Y para adjuntar otro archivo debo volver a escribir "@"

  Escenario: Autocompletar en Web usa el filesystem del daemon
    Dado que estoy en el chat Web del workspace
    Y el daemon está bound
    Cuando abro el picker de @
    Entonces la lista de archivos proviene del disco local del daemon
    Y el picker muestra hostname y path del daemon (p.ej. "host-a · /datos/Work/repo")
    Y si el daemon se desconecta, el picker explica que no hay filesystem disponible

  Escenario: Hostname/path evitan el workspace equivocado
    Dado que el hub Web no corre en la misma máquina que el daemon
    Cuando abro el picker
    Entonces veo claramente qué máquina y qué cwd se van a adjuntar
    Y no se listan archivos del servidor de API ni del navegador

  Escenario: Insertar una mención convierte el path en un attach visible
    Dado que el picker muestra "src/auth.ts"
    Cuando lo selecciono
    Entonces el compositor muestra un chip o token "@src/auth.ts"
    Y el texto crudo del prompt conserva la referencia de forma inequívoca

  Escenario: Varios archivos en el mismo prompt
    Dado que menciono "@README.md" y luego "@src/index.ts" (dos selecciones)
    Cuando envío el turn
    Entonces ambos archivos quedan asociados al mensaje de usuario
    Y el LLM recibe el contenido de los dos

  Escenario: Mencionar un directorio lista como máximo 10 entradas
    Dado que menciono una carpeta con @
    Cuando envío el turn
    Entonces el attach incluye un listado de como máximo 10 hijos (archivos/carpetas)
    Y el LLM puede usar ese contexto para orientar read/grep posteriores
    Y no se vuelca un árbol ilimitado al prompt

  Escenario: Path escrito a mano sin picker
    Dado que escribo "@package.json" sin usar el picker
    Cuando envío el turn
    Entonces el daemon resuelve la ruta relativa al workspace
    Y si el archivo existe, se adjunta igual que con el picker

  Escenario: CLI headless acepta @ en el prompt
    Dado que ejecuto un ask/turn headless con un prompt que contiene "@src/app.ts"
    Cuando el daemon procesa el turn
    Entonces resuelve y adjunta ese archivo
    Y el watch/Web/TUI muestran el mensaje de usuario con la mención

  Escenario: TUI compose mode con @
    Dado que estoy en modo compose de la TUI
    Cuando escribo "@" y navego el picker
    Entonces Tab/Enter insertan la mención
    Y Escape cierra el picker sin enviar el turn
    Y Enter con el compositor vacío no dispara un turn
```

### Característica: el LLM y el historial ven el attach

```gherkin
# language: es
Característica: Hidratación y persistencia de attaches
  Para que el modelo y el resto de clientes compartan el mismo contexto
  Como usuario
  Quiero que el attach se hidrate una vez y quede en el chat

  Escenario: El daemon hidrata el contenido antes de llamar al LLM
    Dado un mensaje de usuario con attach "@src/auth.ts"
    Cuando arranca el turn
    Entonces el daemon lee el archivo del disco del workspace
    Y inyecta su contenido (o un resumen acotado) en el contexto del LLM
    Y la API no necesita tener el archivo en su propio disco

  Escenario: Attach de texto
    Dado un archivo de texto o código
    Cuando lo adjunto con @
    Entonces el LLM recibe el texto (truncado si excede el límite, con marca explícita)

  Escenario: Attach de imagen
    Dado un png/jpg/webp/gif del workspace
    Cuando lo adjunto con @
    Entonces el daemon lo envía al modelo como imagen (no como texto corrupto)
    Y el chip en el chat indica que es una imagen

  Escenario: Attach de archivo binario u otro tipo
    Dado un binario, PDF, zip u otro tipo que no es texto plano
    Cuando lo adjunto con @
    Entonces el attach se acepta (todo tipo de archivo está permitido)
    Y el daemon hidrata de la forma que el provider soporte (bytes/imagen/metadatos)
    Y si el modelo no puede consumir ese tipo, el turn falla con un error visible
    Y nunca se inyecta basura como si fuera UTF-8

  Escenario: El mensaje persistido muestra las menciones
    Dado que envié un prompt con dos @
    Cuando recargo el chat en Web, TUI o CLI watch
    Entonces el mensaje de usuario sigue mostrando esas menciones
    Y no se pierde el vínculo al recargar

  Escenario: Turns siguientes recuerdan que esos archivos se adjuntaron
    Dado un chat cuyo último mensaje de usuario adjuntó "@src/auth.ts"
    Cuando envío un follow-up sin nueva mención
    Entonces el historial del chat (incluido el attach) se reinyecta al LLM
    Y no hace falta volver a tipear @ para que el modelo recuerde ese archivo
    Pero un archivo cambiado en disco no se rehidrata a menos que se vuelva a mencionar o se use la tool read

  Escenario: Web dispara el turn; el daemon hidrata
    Dado que el usuario en Web envía "explica @src/auth.ts"
    Cuando la API despacha el turn al daemon
    Entonces el daemon resuelve el attach en su cwd
    Y el stream y la respuesta aparecen en Web, TUI y CLI watch
```

### Característica: errores, límites y seguridad del attach

```gherkin
# language: es
Característica: Guardas de attach
  Para no filtrar el disco ni romper el turn
  Como usuario
  Quiero errores claros cuando @ no se puede honrar

  Escenario: Archivo inexistente
    Dado que menciono "@no-existe.ts"
    Cuando envío el turn
    Entonces no se llama al LLM con un adjunto vacío silencioso
    Y veo un error o aviso de que la ruta no existe
    Y el mensaje puede quedar como fallido o sin attach, de forma visible

  Escenario: Ruta fuera del workspace
    Dado que menciono "@../../.ssh/id_rsa" o una ruta absoluta ajena al workspace
    Cuando el daemon resuelve el attach
    Entonces rechaza la ruta
    Y no lee ni envía ese contenido al LLM ni a la API

  Escenario: Archivo demasiado grande
    Dado un archivo de texto que excede el límite de attach
    Cuando lo menciono
    Entonces se avisa del tamaño
    Y o bien se trunca con marca explícita, o se rechaza
    Y nunca se envía un payload que rompa el turn sin feedback

  Escenario: Sin daemon no hay attach
    Dado que el workspace no tiene daemon bound
    Cuando intento enviar un prompt con @ desde Web
    Entonces recibo el mismo tipo de error que un agent.turn sin daemon
    Y se explica que hace falta CLI/TUI abierto en ese path

  Escenario: Caracter @ literal
    Dado que escribo un correo "user@example.com" o código con @decorator
    Cuando envío el prompt
    Entonces no se interpreta como attach de archivo
    Y solo se tratan como attach las menciones de path (picker o patrón de path)
```
