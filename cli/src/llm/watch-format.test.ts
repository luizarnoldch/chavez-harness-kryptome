import { describe, expect, test } from "bun:test";
import { approvalDeadlineIso } from "./approval-deadline";
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
});
