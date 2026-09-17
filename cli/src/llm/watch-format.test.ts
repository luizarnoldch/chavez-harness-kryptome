import { describe, expect, test } from "bun:test";
import { formatWatchLine } from "./watch-format";

describe("formatWatchLine", () => {
  test("tool start then result in order", () => {
    const start = formatWatchLine({
      type: "chat.tool.start",
      data: {
        message: {
          role: "tool",
          metadata: {
            sdkName: "Read",
            toolName: "read",
            status: "running",
            input: { file_path: "src/auth.ts" },
          },
        },
      },
    });
    expect(start).toBe("tool · read · running  src/auth.ts");
    const done = formatWatchLine({
      type: "chat.tool.result",
      data: {
        message: {
          role: "tool",
          content: "export function login() {}",
          metadata: { sdkName: "Read", toolName: "read", status: "done", output: "export function login() {}" },
        },
      },
    });
    expect(done).toContain("tool · read · done");
    expect(done).toContain("export function login");
  });

  test("delta", () => {
    expect(
      formatWatchLine({ type: "chat.stream.delta", data: { delta: "Hola" } }),
    ).toBe("assistant Δ Hola");
  });

  test("huge output is truncated", () => {
    const line = formatWatchLine({
      type: "chat.tool.result",
      data: {
        message: {
          metadata: { toolName: "grep", status: "done", output: "m".repeat(20_000) },
        },
      },
    });
    expect(line).toContain("[truncated:");
    expect(String(line).length).toBeLessThan(5000);
  });

  test("skips duplicate updated append", () => {
    expect(
      formatWatchLine({
        type: "message.appended",
        data: { updated: true, message: { role: "tool", content: "x" } },
      }),
    ).toBeNull();
  });
});
