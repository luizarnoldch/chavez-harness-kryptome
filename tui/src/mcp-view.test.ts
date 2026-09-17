import { describe, expect, test } from "bun:test";
import {
  formatTuiToolLine,
  indentIfChild,
  mcpFailedBanner,
} from "./tool-line";

describe("TUI MCP, skills, and subagent helpers", () => {
  test("formats a running subagent", () => {
    expect(
      formatTuiToolLine(
        { kind: "subagent", agentType: "explore", status: "running" },
        "",
      ),
    ).toBe("subagent · explore · running");
  });

  test("indents child tools by at most two levels", () => {
    expect(indentIfChild("tool · Read · done", "parent")).toBe(
      "  tool · Read · done",
    );
    expect(indentIfChild("  tool · Read · done", "parent")).toBe(
      "    tool · Read · done",
    );
    expect(indentIfChild("    tool · Read · done", "parent")).toBe(
      "    tool · Read · done",
    );
  });

  test("formats an MCP failure banner while native tools continue", () => {
    expect(
      mcpFailedBanner({
        servers: [
          { name: "foo", status: "failed" },
          { name: "ok", status: "connected" },
          { name: "bar", status: "failed" },
        ],
      }),
    ).toBe("MCP failed: foo, bar — native tools continue");
  });

  test("formats a local skill", () => {
    expect(
      formatTuiToolLine(
        { kind: "skill", name: "pdf", layer: "local", status: "done" },
        "",
      ),
    ).toBe("skill · pdf · done");
  });
});
