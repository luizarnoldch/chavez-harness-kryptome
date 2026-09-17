# Final whole-branch review fixes

- CI client-wait sends `enqueue: false`, cancels any unexpected queued response, reports `CI_BUSY`, and cancels dispatched turns on timeout.
- Ask-mode API rejection now settles `waitForTurn`; in-process abort noise is suppressed after a known timeout.
- Cancelled stream endings become CI failures; cancelled `agent.turn.ended` without stream success remains a failure.
- CI dispatch resolves missing, null, or invalid execution-mode preferences to `auto`; valid modes remain unchanged so the strict ask gate still rejects `ask`.

## Verification

```text
cli: bun test src/ci
85 pass, 0 fail, 144 expect() calls

api: bun test src/ci
9 pass, 0 fail, 14 expect() calls

git diff --check
passed
```

## PTY terminal final review fixes

- Native PTYs now launch through `/usr/bin/setsid` when available while retaining `detached: false` and never calling `unref`; the native test verifies group termination reaps both shell leader and background child.
- Web PTY opens prefer the daemon effective cwd/worktree, then daemon path, then the workspace DB path.
- Pending opens are indexed by owner. Owner disconnect fails them, and late daemon results trigger immediate `pty.kill.dispatch` without creating a registry entry.
- Daemon socket disconnects kill all local PTYs before reconnect proceeds.
- PTY environment sanitization strips any variable name containing API key, secret, token, password, or authorization markers.

## PTY verification

```text
cli: bun test src/pty
39 pass, 0 fail, 84 expect() calls

api: bun test src/pty src/ws/pty-registry.test.ts src/ws/pty-open-pending.test.ts src/ws/handlers-pty-security.test.ts
14 pass, 0 fail, 33 expect() calls

bun run cli/scripts/pty-smoke.ts
pty-terminal smoke ok

git diff --check
passed
```
