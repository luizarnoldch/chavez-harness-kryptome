# Task 9 report

- **watch-format**: rama `pty` → `tool · pty · ${status}  ${hostname} · ${cwd}` cuando vienen en metadata; test nuevo pasa.
- **persist**: `persistPtyTranscript` ya en daemon `pty.exit`; API insert usa `redactJson` + hostname/cwd en metadata; test `CHAVEZ_ACCESS_TOKEN=abc` → `***`.
- **CI**: `gatePty({ ci: true, mode: "ask" })` ya cubierto; runner in-process pasa `ci: true`, `ptyAllowed: false` + comentario; sin GitHub Action.
- **OpenAPI** `/ws`: tipos `pty.*` + nota cwd daemon / CI sin PTY.
- **cursor-runner**: comentario Shell one-shot; sin reclasificar a Pty.
- **index.ts**: help `chavez tui` menciona tecla `t`; sin subcomando `chavez pty`.
- **Tests**: 36 pass (`watch-format`, `redact`, `gate`).
