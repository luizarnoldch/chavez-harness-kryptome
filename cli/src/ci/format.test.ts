import { describe, expect, test } from "bun:test";
import { ASK_CI_INVALID, CI_FAIL_PREFIX, CI_OK_LINE } from "./constants";
import { formatCiOutcome, formatCiPush } from "./format";
import { foldCiEvents } from "./outcome";

describe("formatCiPush", () => {
  test("chat.tool.start → línea tool · sin JSON", () => {
    const line = formatCiPush({
      type: "chat.tool.start",
      data: {
        message: {
          metadata: {
            toolName: "read",
            status: "running",
            input: { file_path: "src/auth.ts" },
          },
        },
      },
    });
    expect(line).toBeTruthy();
    expect(line!).toContain("tool ·");
    expect(line!.trimStart()[0]).not.toBe("{");
  });

  test("chat.stream.delta incluye assistant y delta", () => {
    const line = formatCiPush({
      type: "chat.stream.delta",
      data: { delta: "Hola" },
    });
    expect(line).toContain("assistant");
    expect(line).toContain("Hola");
  });

  test("chat.stream.error redacta sk-ant en el error", () => {
    const line = formatCiPush({
      type: "chat.stream.error",
      data: { error: "failed sk-ant-api03-aaaa" },
    });
    expect(line).toBeTruthy();
    expect(line!).not.toContain("sk-ant-");
  });

  test("data con api_key no filtra sk-ant-", () => {
    const line = formatCiPush({
      type: "chat.tool.start",
      data: {
        api_key: "sk-ant-api03-zzzz",
        message: {
          metadata: {
            toolName: "read",
            status: "running",
          },
        },
      },
    });
    expect(line).toBeTruthy();
    expect(line!).not.toContain("sk-ant-");
  });
});

describe("formatCiOutcome", () => {
  test("stream_end → stdout ci ok", () => {
    const out = foldCiEvents([{ kind: "stream_end" }]);
    expect(formatCiOutcome(out)).toEqual({
      stream: "stdout",
      text: CI_OK_LINE,
    });
  });

  test("askRejected → stderr con mensaje ask", () => {
    const out = { ...foldCiEvents([]), askRejected: true };
    const line = formatCiOutcome(out);
    expect(line.stream).toBe("stderr");
    expect(line.text).toContain(ASK_CI_INVALID);
  });

  test("verification failed → stderr ci fail:", () => {
    const out = foldCiEvents([
      { kind: "stream_end", verificationStatus: "failed" },
    ]);
    const line = formatCiOutcome(out);
    expect(line.stream).toBe("stderr");
    expect(line.text.startsWith(CI_FAIL_PREFIX)).toBe(true);
  });
});
