import { describe, expect, test } from "bun:test";
import {
  APPLY_PLAN_PREAMBLE,
  APPLY_USER_PROMPT,
  DEFAULT_APPLY_MODE,
  NO_CURRENT_PLAN,
  PLAN_ARTIFACT_KIND,
  PLAN_EMPTY_ERROR,
  PLAN_STATUS_CURRENT,
  PLAN_STATUS_HISTORY,
  PLAN_TOO_LARGE,
  PLAN_MARKDOWN_MAX_CHARS,
  asPlanMeta,
  buildApplyPrompt,
  bumpRevision,
  consumePending,
  currentPlanId,
  extractPlanMarkdown,
  isPlanArtifact,
  isRunnableMode,
  markPendingApply,
  newPlanMeta,
  pendingApplyPlan,
  promoteCurrent,
  resolveApplyMode,
  validatePlanMarkdown,
} from "../lib/plan-artifact";

describe("kind / meta", () => {
  test("assistant suelto no es artefacto", () => {
    expect(isPlanArtifact({ streamId: "s" })).toBe(false);
    expect(isPlanArtifact(null)).toBe(false);
    expect(asPlanMeta({ kind: "slash_result" })).toBeNull();
  });

  test("newPlanMeta is current, not pending", () => {
    const m = newPlanMeta("sid");
    expect(m.kind).toBe(PLAN_ARTIFACT_KIND);
    expect(m.status).toBe(PLAN_STATUS_CURRENT);
    expect(m.pendingApply).toBe(false);
    expect(m.revision).toBe(1);
    expect(m.executionMode).toBe("plan");
  });
});

describe("extractPlanMarkdown", () => {
  test("full text when no fence", () => {
    expect(extractPlanMarkdown("  ## Auth refactor\n\n1. Split routes  ")).toBe(
      "## Auth refactor\n\n1. Split routes",
    );
  });

  test("single majority markdown fence", () => {
    const body = "a".repeat(80);
    const text = `Intro\n\n\`\`\`markdown\n${body}\n\`\`\`\n`;
    expect(extractPlanMarkdown(text)).toBe(body);
  });

  test("empty", () => {
    expect(extractPlanMarkdown("   ")).toBe("");
  });
});

describe("validatePlanMarkdown", () => {
  test("empty throws PLAN_EMPTY_ERROR", () => {
    expect(() => validatePlanMarkdown("  \n")).toThrow(PLAN_EMPTY_ERROR);
  });

  test("too large throws PLAN_TOO_LARGE", () => {
    expect(() =>
      validatePlanMarkdown("x".repeat(PLAN_MARKDOWN_MAX_CHARS + 1)),
    ).toThrow(PLAN_TOO_LARGE);
  });
});

describe("promoteCurrent", () => {
  test("exactly one current; old become history", () => {
    const a = {
      id: "p1",
      metadata: newPlanMeta("s1"),
      content: "old",
    };
    const b = {
      id: "p2",
      metadata: newPlanMeta("s2"),
      content: "new",
    };
    const out = promoteCurrent([a, b], "p2");
    expect(asPlanMeta(out[0]!.metadata)?.status).toBe(PLAN_STATUS_HISTORY);
    expect(asPlanMeta(out[0]!.metadata)?.pendingApply).toBe(false);
    expect(asPlanMeta(out[1]!.metadata)?.status).toBe(PLAN_STATUS_CURRENT);
    expect(currentPlanId(out)).toBe("p2");
  });

  test("non-plan rows untouched", () => {
    const rows = [
      { id: "u", role: "user", content: "hi", metadata: null },
      { id: "p", metadata: newPlanMeta("s"), content: "plan" },
    ];
    const out = promoteCurrent(rows, "p");
    expect(out[0]).toEqual(rows[0]);
  });
});

describe("apply mode + brief", () => {
  test("null lastRunnable → ask", () => {
    expect(resolveApplyMode(null)).toBe(DEFAULT_APPLY_MODE);
    expect(resolveApplyMode("plan")).toBe("ask");
    expect(resolveApplyMode("auto")).toBe("auto");
    expect(isRunnableMode("plan")).toBe(false);
  });

  test("buildApplyPrompt wraps markdown and does not mention a commit happened", () => {
    const p = buildApplyPrompt("go", "## Steps\n- a");
    expect(p.startsWith(APPLY_PLAN_PREAMBLE)).toBe(true);
    expect(p).toContain("<plan>\n## Steps\n- a\n</plan>");
    expect(p).toContain("User instruction:\ngo");
    expect(p.toLowerCase()).toContain("did not commit");
    expect(p).not.toContain("git commit -m");
  });

  test("empty user prompt uses APPLY_USER_PROMPT", () => {
    expect(buildApplyPrompt("  ", "X")).toContain(APPLY_USER_PROMPT);
  });
});

describe("pendingApply", () => {
  test("pendingApplyPlan reads current+pending only", () => {
    const current = {
      id: "p2",
      content: "NEW",
      metadata: markPendingApply(newPlanMeta("s2"), "2026-09-16T00:00:00.000Z"),
    };
    const old = {
      id: "p1",
      content: "OLD",
      metadata: {
        ...newPlanMeta("s1"),
        status: PLAN_STATUS_HISTORY,
        pendingApply: true,
      },
    };
    const rows = promoteCurrent([old, current], "p2");
    const pending = pendingApplyPlan(
      rows.map((r) =>
        r.id === "p2"
          ? { ...r, metadata: markPendingApply(asPlanMeta(r.metadata)!, "t") }
          : r,
      ),
    );
    expect(pending?.id).toBe("p2");
    expect(pending?.content).toBe("NEW");
  });

  test("consumePending clears flag", () => {
    const m = consumePending(
      markPendingApply(newPlanMeta("s"), "t"),
    );
    expect(m.pendingApply).toBe(false);
    expect(m.appliedAt).toBe("t");
  });

  test("bumpRevision", () => {
    expect(bumpRevision(newPlanMeta("s")).revision).toBe(2);
  });
});

test("frozen error strings", () => {
  expect(NO_CURRENT_PLAN).toBe("No current plan artifact in this chat");
});
