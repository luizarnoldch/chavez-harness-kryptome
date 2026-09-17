import { describe, expect, test } from "bun:test";
import {
  buildApprovalPrompt,
  formatApprovalHeadline,
} from "./approval-prompt";

describe("buildApprovalPrompt", () => {
  test("reads return null — they never become an approval", () => {
    expect(buildApprovalPrompt("Read", { file_path: "a.ts" })).toBeNull();
    expect(buildApprovalPrompt("Grep", { pattern: "x" })).toBeNull();
    expect(buildApprovalPrompt("Glob", { pattern: "**/*.ts" })).toBeNull();
    expect(buildApprovalPrompt("LS", { path: "." })).toBeNull();
  });

  test("Write shows path + diff, not just the tool name", () => {
    const p = buildApprovalPrompt("Write", {
      file_path: "NOTES.md",
      content: "hello",
    });
    expect(p).not.toBeNull();
    if (p?.kind !== "write") throw new Error("expected write");
    expect(p.path).toBe("NOTES.md");
    expect(p.diff).toContain("+++ b/NOTES.md");
    expect(p.diff).toContain("+hello");
    expect(formatApprovalHeadline(p)).toContain("NOTES.md");
    expect(formatApprovalHeadline(p)).not.toBe("write");
  });

  test("Edit shows path + old/new diff", () => {
    const p = buildApprovalPrompt("Edit", {
      file_path: "src/a.ts",
      old_string: "foo",
      new_string: "bar",
    });
    expect(p?.kind).toBe("edit");
    if (p?.kind !== "edit") throw new Error("expected edit");
    expect(p.path).toBe("src/a.ts");
    expect(p.diff).toContain("-foo");
    expect(p.diff).toContain("+bar");
  });

  test("Bash shows the command, not just bash", () => {
    const p = buildApprovalPrompt("Bash", { command: "npm test" });
    expect(p).toEqual({ kind: "bash", command: "npm test", needsNetwork: false });
    expect(formatApprovalHeadline(p!)).toContain("npm test");
  });

  test("bash curl headline says pide red", () => {
    const p = buildApprovalPrompt(
      "Bash",
      { command: "curl https://example.com" },
      null,
      true,
    );
    expect(p).toEqual({
      kind: "bash",
      command: "curl https://example.com",
      needsNetwork: true,
    });
    expect(formatApprovalHeadline(p!)).toContain("pide red");
    expect(formatApprovalHeadline(p!)).toContain("curl https://example.com");
  });

  test("bash ls without network has no pide red", () => {
    const p = buildApprovalPrompt("Bash", { command: "ls" }, null, false);
    expect(formatApprovalHeadline(p!)).not.toContain("pide red");
  });

  test("WebFetch prompt is fetch with pide red", () => {
    const p = buildApprovalPrompt(
      "WebFetch",
      { url: "https://example.com/doc" },
      null,
      true,
    );
    expect(p).toEqual({
      kind: "fetch",
      url: "https://example.com/doc",
      needsNetwork: true,
    });
    expect(formatApprovalHeadline(p!)).toContain("pide red");
    expect(formatApprovalHeadline(p!)).toContain("https://example.com/doc");
  });

  test("prefers proposedPreview from diffs-review", () => {
    const p = buildApprovalPrompt(
      "Edit",
      { file_path: "a.ts", old_string: "x", new_string: "y" },
      "diff --git a/a.ts b/a.ts\n-x\n+y",
    );
    expect(p?.kind).toBe("edit");
    if (p?.kind !== "edit") throw new Error("expected edit");
    expect(p.diff).toContain("diff --git");
  });
});
