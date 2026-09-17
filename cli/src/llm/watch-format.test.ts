import { describe, expect, test } from "bun:test";
import { approvalDeadlineIso } from "./approval-deadline";
import { formatWatchLine } from "./watch-format";
import { VERIFY_TIMEOUT_ERROR } from "./verify-constants";

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

  test("formats thinking separately from assistant deltas", () => {
    expect(
      formatWatchLine({
        type: "chat.thinking.delta",
        data: { delta: "Considerando opciones" },
      }),
    ).toBe("thinking Δ Considerando opciones");
    expect(
      formatWatchLine({
        type: "chat.stream.delta",
        data: { delta: "Considerando opciones" },
      }),
    ).toBe("assistant Δ Considerando opciones");
  });

  test("formats thinking end and steer", () => {
    expect(
      formatWatchLine({
        type: "chat.thinking.end",
        data: { omitted: true },
      }),
    ).toBe("thinking · omitido");
    expect(
      formatWatchLine({
        type: "chat.steer",
        data: { outcome: "delivered", content: "cambia el enfoque" },
      }),
    ).toBe("steer · delivered · cambia el enfoque");
  });

  test("formats cancelled stream end", () => {
    expect(
      formatWatchLine({
        type: "chat.stream.end",
        data: { status: "cancelled" },
      }),
    ).toBe("stream · cancelled");
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

  test("awaiting_approval prints hint and never auto-approves", () => {
    const line = formatWatchLine({
      type: "chat.tool.update",
      data: {
        chatId: "chat-1",
        message: {
          role: "tool",
          chatId: "chat-1",
          metadata: {
            sdkName: "Write",
            toolName: "write",
            status: "awaiting_approval",
            toolCallId: "tool-9",
            input: { file_path: "out.txt" },
          },
        },
      },
    });
    expect(line).toContain("awaiting_approval");
    expect(line).toContain("approval needed");
    expect(line).not.toContain("auto-approved");
  });

  test("awaiting_approval with needsNetwork says pide red", () => {
    const line = formatWatchLine({
      type: "chat.tool.update",
      data: {
        chatId: "chat-1",
        status: "awaiting_approval",
        message: {
          role: "tool",
          metadata: {
            sdkName: "Bash",
            status: "awaiting_approval",
            needsNetwork: true,
            prompt: {
              kind: "bash",
              command: "curl https://example.com",
              needsNetwork: true,
            },
          },
        },
      },
    });
    expect(line).toContain("pide red");
    expect(line).toContain("curl https://example.com");
  });

  test("awaiting_approval ls without network has no pide red", () => {
    const line = formatWatchLine({
      type: "chat.tool.update",
      data: {
        status: "awaiting_approval",
        message: {
          role: "tool",
          metadata: {
            sdkName: "Bash",
            status: "awaiting_approval",
            needsNetwork: false,
            prompt: { kind: "bash", command: "ls", needsNetwork: false },
          },
        },
      },
    });
    expect(line).not.toContain("pide red");
  });

  test("skips duplicate updated append", () => {
    expect(
      formatWatchLine({
        type: "message.appended",
        data: { updated: true, message: { role: "tool", content: "x" } },
      }),
    ).toBeNull();
  });

  test("redacts secret tokens in tool output", () => {
    const line = formatWatchLine({
      type: "chat.tool.result",
      data: {
        message: {
          role: "tool",
          content: "sk-ant-abc",
          metadata: {
            sdkName: "Grep",
            toolName: "grep",
            status: "done",
            output: "src/config.ts:1:sk-ant-abc",
          },
        },
      },
    });
    expect(line).not.toContain("sk-ant-");
    expect(line).toContain("***");
  });

  test("awaiting write shows path + diff and approval needed, never auto-approved", () => {
    const line = formatWatchLine({
      type: "chat.tool.update",
      data: {
        chatId: "chat-1",
        message: {
          chatId: "chat-1",
          metadata: {
            toolCallId: "tool-1",
            toolName: "write",
            status: "awaiting_approval",
            approvalDeadline: approvalDeadlineIso(),
            prompt: {
              kind: "write",
              path: "NOTES.md",
              diff: "+++ b/NOTES.md\n+hello",
              truncated: false,
            },
          },
        },
      },
    });
    expect(line).toContain("NOTES.md");
    expect(line).toContain("+hello");
    expect(line).toContain("awaiting_approval");
    expect(line).toContain("approval needed");
    expect(line).toContain("chat-1");
    expect(line).toContain("tool-1");
    expect(line).not.toContain("auto-approved");
  });

  test("bash shows the command", () => {
    const line = formatWatchLine({
      type: "chat.tool.update",
      data: {
        chatId: "c",
        message: {
          metadata: {
            toolCallId: "t",
            toolName: "bash",
            status: "awaiting_approval",
            prompt: { kind: "bash", command: "npm test" },
          },
        },
      },
    });
    expect(line).toContain("npm test");
  });

  test("resolved prints ya resuelto", () => {
    const line = formatWatchLine({
      type: "chat.tool.resolved",
      data: {
        chatId: "c",
        toolCallId: "abcdefghij",
        outcome: "approve",
      },
    });
    expect(line).toContain("ya resuelto");
  });

  test("timeout line is visible", () => {
    const line = formatWatchLine({
      type: "chat.tool.resolved",
      data: {
        toolCallId: "zzzzzzzz",
        outcome: "timeout",
      },
    });
    expect(line).toContain("timeout");
    expect(line).toContain("300s");
  });

  test("prints ignored attach notices", () => {
    const line = formatWatchLine({
      type: "message.appended",
      data: {
        message: {
          role: "user",
          content: "see @.env",
          metadata: {
            ignoredAttaches: [
              { path: ".env", error: "Refusing to attach secret file: .env" },
            ],
          },
        },
      },
    });
    expect(line).toContain("⚠");
    expect(line).toContain("secret file");
  });

  test("git snapshot dirty", () => {
    const line = formatWatchLine({
      type: "workspace.git.snapshot",
      data: {
        snapshot: {
          isRepo: true,
          branch: "feat",
          ahead: 1,
          behind: 0,
          dirty: [{ path: "a.ts", index: "M", worktree: "." }],
        },
      },
    });
    expect(line).toContain("feat");
    expect(line).toContain("dirty=1");
  });

  test("github pr created", () => {
    expect(
      formatWatchLine({
        type: "github.pr.created",
        data: { url: "https://github.com/acme/demo/pull/7" },
      }),
    ).toBe("git · pr https://github.com/acme/demo/pull/7");
  });

  test("git_commit done does not dump PAT", () => {
    const line = formatWatchLine({
      type: "chat.tool.result",
      data: {
        message: {
          metadata: {
            sdkName: "mcp__chavez-git__git_commit",
            toolName: "git_commit",
            status: "done",
            input: { message: "x", token: "ghp_SECRETO" },
            output: "commit abc",
          },
        },
      },
    });
    expect(line).toContain("git_commit");
    expect(line).toContain("done");
    expect(line).not.toContain("ghp_SECRETO");
  });

  test("context usage line", () => {
    expect(
      formatWatchLine({
        type: "chat.context.usage",
        data: { chatId: "c", context: { pct: 72, level: "warn" } },
      }),
    ).toBe("context · 72% · warn");
  });
  test("compact marker", () => {
    expect(
      formatWatchLine({
        type: "chat.compact.done",
        data: { chatId: "c" },
      }),
    ).toBe("compact · contexto compactado");
  });

  test("workspace cwd changed", () => {
    const line = formatWatchLine({
      type: "workspace.cwd.changed",
      data: {
        hostname: "host-a",
        cwd: "/wt",
        snapshot: { current: { branch: "feat", isMain: false } },
      },
    });
    expect(line).toContain("host-a");
    expect(line).toContain("/wt");
    expect(line).toContain("feat");
    expect(line).not.toMatch(/ghp_/);
  });
});

describe("formatWatchLine verify", () => {
  test("test tool start", () => {
    const line = formatWatchLine({
      type: "chat.tool.start",
      data: {
        metadata: {
          kind: "verify",
          command: "npm test",
          status: "running",
        },
      },
    });
    expect(line).toContain("test ·");
    expect(line).toContain("npm test");
  });

  test("lint does not look like a diff", () => {
    const lint = formatWatchLine({
      type: "chat.tool.result",
      data: {
        metadata: {
          kind: "lint",
          command: "tsc --noEmit",
          status: "done",
          output: "src/a.ts(1,1): error TS000",
        },
      },
    });
    expect(lint).toContain("lint ·");
    expect(lint).not.toMatch(/^diff ·/);
  });

  test("failed verification on stream.end", () => {
    const line = formatWatchLine({
      type: "chat.stream.end",
      data: {
        verification: {
          status: "failed",
          kind: "verify",
          command: "npm test",
          exitCode: 1,
          timedOut: false,
          source: "pact",
          truncated: false,
          silentSuccess: true,
        },
      },
    });
    expect(line).toContain("failed");
    expect(line).toContain("not silent");
  });

  test("timeout closes", () => {
    const line = formatWatchLine({
      type: "chat.stream.error",
      data: { error: VERIFY_TIMEOUT_ERROR },
    });
    expect(line).toContain("timeout");
  });
});
