import { describe, expect, test } from "bun:test";
import { ASK_CI_INVALID, CI_USAGE } from "../ci/constants";
import { CiCliError } from "../ci/errors";
import { foldCiEvents } from "../ci/outcome";
import type { RunCiInput, runCiTurn } from "../ci/run";
import { ciCommandBody } from "./ci";

function successfulRun(
  calls: RunCiInput[],
): typeof runCiTurn {
  return (async (input: Parameters<typeof runCiTurn>[0]) => {
    calls.push(input);
    return {
      outcome: foldCiEvents([{ kind: "stream_end" }]),
      exitCode: 0,
      chatId: input.chatId || "new-chat",
    };
  }) as typeof runCiTurn;
}

describe("ciCommandBody", () => {
  test("pasa mode y prompt al runner", async () => {
    const calls: RunCiInput[] = [];
    await ciCommandBody(["--mode", "auto", "go"], {
      run: successfulRun(calls),
      exit: () => {},
      write: () => {},
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ modeFlag: "auto", prompt: "go" });
  });

  test("imprime ci ok y sale cero tras stream end", async () => {
    const lines: Array<{ stream: string; text: string }> = [];
    const exits: number[] = [];
    await ciCommandBody(["go"], {
      run: successfulRun([]),
      exit: (code) => exits.push(code),
      write: (stream, text) => lines.push({ stream, text }),
    });
    expect(lines).toContainEqual({ stream: "stdout", text: "ci ok" });
    expect(exits).toEqual([0]);
  });

  test("propaga CiCliError con exit 2", async () => {
    const error = new CiCliError(ASK_CI_INVALID, 2);
    const run = (async () => {
      throw error;
    }) as typeof runCiTurn;
    expect(
      ciCommandBody(["go"], {
        run,
        exit: () => {
          throw new Error("exit no debe ejecutarse");
        },
        write: () => {},
      }),
    ).rejects.toBe(error);
    expect(error.exitCode).toBe(2);
  });

  test("rechaza prompt vacío leído desde stdin", async () => {
    expect(
      ciCommandBody([], {
        run: successfulRun([]),
        exit: () => {},
        readPrompt: async () => "",
        write: () => {},
      }),
    ).rejects.toMatchObject({ message: CI_USAGE, exitCode: 1 });
  });
});
