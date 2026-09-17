import { describe, expect, test } from "bun:test";
import { createFakeBackend } from "./fake-backend";

describe("createFakeBackend", () => {
  test("records writes and kill signals without unref", () => {
    const backend = createFakeBackend();
    backend.spawn({
      cwd: "/tmp",
      env: {},
      file: "/bin/sh",
      args: [],
      cols: 80,
      rows: 24,
    });
    const child = backend.children[0]!;
    const data = new TextEncoder().encode("hello");

    child.write(data);
    child.kill("SIGTERM");

    expect(child.writes).toEqual([data]);
    expect(child.killed).toEqual(["SIGTERM"]);
    expect(child.unrefCalled).toBe(false);
  });

  test("delivers emitted data to onData subscribers", () => {
    const backend = createFakeBackend();
    backend.spawn({
      cwd: "/tmp",
      env: {},
      file: "/bin/sh",
      args: [],
      cols: 80,
      rows: 24,
    });
    const child = backend.children[0]!;
    const chunks: string[] = [];
    child.onData((chunk) => chunks.push(new TextDecoder().decode(chunk)));

    child.emitData("pty-data");

    expect(chunks).toEqual(["pty-data"]);
  });

  test("exits on kill by default and can disable automatic exit", () => {
    const backend = createFakeBackend();
    const first = backend.spawn({
      cwd: "/tmp",
      env: {},
      file: "/bin/sh",
      args: [],
      cols: 80,
      rows: 24,
    });
    const exits: Array<{ exitCode: number | null; signal: string | null }> = [];
    first.onExit((info) => exits.push(info));

    first.kill("SIGTERM");
    backend.autoExitOnKill = false;
    const second = backend.spawn({
      cwd: "/tmp",
      env: {},
      file: "/bin/sh",
      args: [],
      cols: 80,
      rows: 24,
    });
    second.onExit((info) => exits.push(info));
    second.kill("SIGTERM");

    expect(exits).toEqual([{ exitCode: null, signal: "SIGTERM" }]);
  });
});
