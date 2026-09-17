import { describe, expect, test } from "bun:test";
import type { PtyBackend } from "./backend";
import {
  PTY_BUSY,
  PTY_IDLE_CLOSED,
  PTY_IDLE_MS,
  PTY_MAX_SESSIONS,
  PTY_NOT_FOUND,
} from "./constants";
import { createFakeBackend } from "./fake-backend";
import { PtyManager, type PtyManagerHooks } from "./manager";
import type { PtyOpenInput } from "./types";

const encoder = new TextEncoder();

function createHarness(now: () => number = () => 1_000) {
  const backend = createFakeBackend();
  const data: Array<{ ptyId: string; text: string }> = [];
  const exits: Array<{ ptyId: string; reason: string }> = [];
  const hooks: PtyManagerHooks = {
    onData: (ptyId, chunk) => {
      data.push({ ptyId, text: new TextDecoder().decode(chunk) });
    },
    onExit: (ptyId, info) => {
      exits.push({ ptyId, reason: info.reason });
    },
  };
  const manager = new PtyManager(backend, hooks, now, 5);
  return { backend, data, exits, manager };
}

function input(overrides: Partial<PtyOpenInput> = {}): PtyOpenInput {
  return {
    kind: "user",
    ownerConnectionId: "owner-1",
    cwd: "/tmp",
    ...overrides,
  };
}

describe("PtyManager", () => {
  test("abre user interactivo y agent con bash aislado", () => {
    const fake = createFakeBackend();
    const spawns: Parameters<PtyBackend["spawn"]>[0][] = [];
    const backend: PtyBackend = {
      spawn(options) {
        spawns.push(options);
        return fake.spawn(options);
      },
    };
    const hooks: PtyManagerHooks = { onData() {}, onExit() {} };
    const manager = new PtyManager(backend, hooks, () => 1_000, 5);

    manager.open(input());
    manager.open(input({ kind: "agent", command: "printf hello" }));

    expect(spawns[0]!.args).toEqual(["-i"]);
    expect(spawns[1]!.file).toBe("/bin/bash");
    expect(spawns[1]!.args).toEqual(["-lc", "printf hello"]);
  });

  test("rechaza una sesión por encima del máximo", () => {
    const { manager } = createHarness();
    for (let i = 0; i < PTY_MAX_SESSIONS; i++) {
      manager.open(input({ ownerConnectionId: `owner-${i}` }));
    }

    expect(() => manager.open(input())).toThrow(PTY_BUSY);
  });

  test("oculta una sesión a un owner distinto y no escribe", () => {
    const { backend, manager } = createHarness();
    const { ptyId } = manager.open(input());

    expect(() => manager.write(ptyId, "other-owner", encoder.encode("no"))).toThrow(
      PTY_NOT_FOUND,
    );
    expect(backend.children[0]!.writes).toHaveLength(0);
  });

  test("ownerGone envía TERM y escala a KILL si el child no sale", async () => {
    const { backend, manager } = createHarness();
    backend.autoExitOnKill = false;
    manager.open(input());

    await manager.ownerGone("owner-1");

    expect(backend.children[0]!.killed).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("reapIdle cierra una sesión vencida con PTY_IDLE_CLOSED", async () => {
    let now = 1_000;
    const { backend, exits, manager } = createHarness(() => now);
    backend.autoExitOnKill = false;
    manager.open(input());
    now += PTY_IDLE_MS + 1;

    manager.reapIdle();
    await Bun.sleep(10);

    expect(manager.sessions.size).toBe(0);
    expect(exits).toEqual([{ ptyId: expect.any(String), reason: PTY_IDLE_CLOSED }]);
  });

  test("killAll vacía todas las sesiones", async () => {
    const { manager } = createHarness();
    manager.open(input({ ownerConnectionId: "owner-1" }));
    manager.open(input({ ownerConnectionId: "owner-2" }));

    await manager.killAll();

    expect(manager.sessions.size).toBe(0);
  });

  test("mantiene aislados datos y transcript entre user y agent", () => {
    const { backend, data, manager } = createHarness();
    const user = manager.open(input());
    const agent = manager.open(
      input({ kind: "agent", ownerConnectionId: "owner-2", command: "date" }),
    );

    backend.children[1]!.emitData("agent output");

    expect(manager.sessions.get(user.ptyId)!.transcript).toBe("");
    expect(data).toEqual([{ ptyId: agent.ptyId, text: "agent output" }]);
  });

  test("no expone bash ni bashOneShot", () => {
    const { manager } = createHarness();

    expect("bash" in manager).toBe(false);
    expect("bashOneShot" in manager).toBe(false);
  });

  test("open nunca llama unref en el child", () => {
    const { backend, manager } = createHarness();

    manager.open(input());

    expect(backend.children[0]!.unrefCalled).toBe(false);
  });
});
