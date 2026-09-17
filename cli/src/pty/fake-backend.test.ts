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
});
