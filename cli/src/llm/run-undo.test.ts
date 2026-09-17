import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChavezWsClient } from "../ws/client";
import { createTurnCheckpoint, finalizeCheckpoint } from "./git-checkpoint";
import { runGit } from "./git-exec";
import { handleUndoDispatch } from "./run-undo";
import { UNDO_REQUIRES_GIT } from "./undo-constants";

function fakeClient() {
  const calls: Array<Record<string, unknown>> = [];
  const client = {
    request: async (msg: Record<string, unknown>) => {
      calls.push(msg);
      return { ok: true, type: String(msg.type), id: "1" };
    },
  } as unknown as ChavezWsClient;
  return { client, calls };
}

describe("handleUndoDispatch", () => {
  test("git checkpoint restores files and reports done", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "chavez-run-undo-"));
    await runGit(cwd, ["init"]);
    await runGit(cwd, ["config", "user.email", "undo@chavez.test"]);
    await runGit(cwd, ["config", "user.name", "Undo Bot"]);
    writeFileSync(join(cwd, "a.ts"), "one\n");
    await runGit(cwd, ["add", "-A"]);
    await runGit(cwd, ["commit", "-m", "init"]);

    const cp0 = await createTurnCheckpoint(cwd, "s1");
    writeFileSync(join(cwd, "a.ts"), "two\n");
    writeFileSync(join(cwd, "b.ts"), "new\n");
    const fin = await finalizeCheckpoint(cwd, cp0, {
      paths: ["a.ts", "b.ts"],
      hadBash: false,
    });

    const { client, calls } = fakeClient();
    await handleUndoDispatch({
      client,
      cwd,
      data: {
        requestId: "r1",
        chatId: "c1",
        streamId: "s1",
        checkpoint: fin,
        path: cwd,
      },
    });
    expect(calls[0]?.type).toBe("agent.turn.undo.result");
    expect(calls[0]?.status).toBe("done");
    expect(readFileSync(join(cwd, "a.ts"), "utf8")).toBe("one\n");
    expect(existsSync(join(cwd, "b.ts"))).toBe(false);
  });

  test("kind none is error and does not touch disk", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "chavez-run-undo-none-"));
    writeFileSync(join(cwd, "a.ts"), "hello\n");
    const { client, calls } = fakeClient();
    await handleUndoDispatch({
      client,
      cwd,
      data: {
        requestId: "r1",
        chatId: "c1",
        streamId: "s1",
        checkpoint: {
          kind: "none",
          streamId: "s1",
          reason: "not_git",
          headSha: null,
          commitSha: null,
          treeSha: null,
          branch: null,
          paths: ["a.ts"],
          commitsCreated: [],
          hadBash: false,
          appliedMutations: true,
          createdAt: new Date().toISOString(),
        },
      },
    });
    expect(calls[0]?.type).toBe("agent.turn.undo.result");
    expect(calls[0]?.status).toBe("error");
    const meta = calls[0]?.metadata as { error?: string };
    expect(meta.error).toBe(UNDO_REQUIRES_GIT);
    expect(readFileSync(join(cwd, "a.ts"), "utf8")).toBe("hello\n");
  });
});
