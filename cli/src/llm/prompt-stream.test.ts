import { describe, expect, test } from "bun:test";
import { PromptStream } from "./prompt-stream";

describe("PromptStream", () => {
  test("initial then steer then close", async () => {
    const s = new PromptStream();
    const seen: string[] = [];
    const run = (async () => {
      for await (const m of s.iterate("first")) {
        seen.push(m.message.content);
      }
    })();
    await Bun.sleep(5);
    expect(s.pushSteer("no toques tests")).toBe(true);
    s.close();
    await run;
    expect(seen).toEqual(["first", "no toques tests"]);
    expect(s.pushSteer("late")).toBe(false);
  });

  test("close without steer ends after initial", async () => {
    const s = new PromptStream();
    const seen: string[] = [];
    const run = (async () => {
      for await (const m of s.iterate("only")) seen.push(m.message.content);
    })();
    await Bun.sleep(5);
    s.close();
    await run;
    expect(seen).toEqual(["only"]);
  });
});
