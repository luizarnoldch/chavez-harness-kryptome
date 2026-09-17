import { describe, expect, test } from "bun:test";
import {
  runCursorTurn,
  type CreateCursorAgent,
} from "./cursor-runner";

const fakeAgent = {
  send: async () => ({
    stream: async function* () {},
    wait: async () => ({ status: "finished", result: "ok" }),
    cancel: async () => {},
  }),
  close: () => {},
  [Symbol.asyncDispose]: async () => {},
};

const minimalInput = {
  prompt: "hi",
  model: "composer-2.5",
  auth: { authKind: "api_key" as const, secret: "secret-key" },
  cwd: "/tmp/ws",
};

describe("cursor sandbox network", () => {
  test("auto enables sandboxOptions and never cloud", async () => {
    const creates: Array<Record<string, unknown>> = [];
    await runCursorTurn({
      ...minimalInput,
      executionMode: "auto",
      createAgent: async (opts) => {
        creates.push(opts as unknown as Record<string, unknown>);
        return fakeAgent;
      },
    });
    expect(creates[0]).not.toHaveProperty("cloud");
    const local = creates[0].local as {
      cwd: string;
      sandboxOptions: { enabled: boolean };
    };
    expect(local.cwd).toBe(minimalInput.cwd);
    expect(local.sandboxOptions.enabled).toBe(true);
  });

  test("ask disables sandboxOptions so an approved curl can run", async () => {
    const creates: Array<Record<string, unknown>> = [];
    await runCursorTurn({
      ...minimalInput,
      executionMode: "ask",
      createAgent: async (opts) => {
        creates.push(opts as unknown as Record<string, unknown>);
        return fakeAgent;
      },
    });
    const local = creates[0].local as { sandboxOptions: { enabled: boolean } };
    expect(local.sandboxOptions.enabled).toBe(false);
  });
});
