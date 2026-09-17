import { describe, expect, test } from "bun:test";
import {
  buildCompactSource,
  extractLastDiff,
  extractLastPlan,
  extractiveSummary,
  isCompactMarker,
  messagesAfterCompactedUntil,
  renderRowForCompact,
  splitCompactWindow,
  stubToolContent,
  TOOL_STUB_MAX_CHARS,
} from "./compact";

const rows = [
  { id: "1", role: "user", content: "hola" },
  { id: "2", role: "assistant", content: "ok" },
  {
    id: "3",
    role: "tool",
    content: "g".repeat(5000),
    metadata: { toolName: "grep", status: "done" },
  },
  {
    id: "4",
    role: "user",
    content: "sigue",
    metadata: {
      attachments: [{ path: "old.ts", kind: "text", hydratedText: "OLDSECRET" }],
    },
  },
  { id: "5", role: "assistant", content: "plan x", metadata: { executionMode: "plan" } },
  {
    id: "6",
    role: "user",
    content: "aplica @src/a.ts",
    metadata: {
      attachments: [{ path: "src/a.ts", kind: "text", hydratedText: "CURRENT_FULL" }],
    },
  },
];

describe("stubToolContent", () => {
  test("does not send megabytes of grep", () => {
    const s = stubToolContent("x".repeat(50_000));
    expect(s.length).toBeLessThan(TOOL_STUB_MAX_CHARS + 80);
    expect(s).toMatch(/omitted after compact/);
  });
});

describe("splitCompactWindow", () => {
  test("excludes current user message from head (attaches stay out of summary)", () => {
    const w = splitCompactWindow(rows, { excludeIds: new Set(["6"]), keepRecent: 2 });
    expect(w.head.some((m) => m.id === "6")).toBe(false);
    expect(w.tooShort).toBe(false);
    const src = buildCompactSource(w.head);
    expect(src).not.toMatch(/CURRENT_FULL/);
    expect(src).toMatch(/omitted after compact|OLDSECRET|sigue/);
  });
  test("too short chat", () => {
    const w = splitCompactWindow(rows.slice(0, 2));
    expect(w.tooShort).toBe(true);
    expect(w.head).toEqual([]);
  });
});

describe("renderRowForCompact", () => {
  test("stubs tools and historical attaches", () => {
    const tool = renderRowForCompact(rows[2]!);
    expect(tool).toMatch(/^TOOL grep/);
    expect(tool.length).toBeLessThan(600);
    const old = renderRowForCompact(rows[3]!);
    expect(old).toMatch(/omitted after compact/);
    expect(old).not.toMatch(/OLDSECRET/);
  });
});

describe("pins", () => {
  test("last plan from executionMode", () => {
    expect(extractLastPlan(rows)).toBe("plan x");
  });
  test("current plan_artifact wins over later history", () => {
    const msgs = [
      {
        id: "p1",
        role: "assistant",
        content: "old current",
        metadata: { kind: "plan_artifact", status: "current" },
      },
      {
        id: "p2",
        role: "assistant",
        content: "newer history",
        metadata: { kind: "plan_artifact", status: "history" },
      },
    ];
    expect(extractLastPlan(msgs)).toBe("old current");
  });
  test("last diff from sidecar", () => {
    const d = extractLastDiff(rows, [
      {
        path: "src/a.ts",
        kind: "modified",
        status: "applied",
        additions: 3,
        deletions: 1,
        preview: "+ hi",
      },
    ]);
    expect(d).toMatch(/src\/a\.ts/);
    expect(d).toMatch(/\+ hi/);
  });
  test("missing pins are null, compact still possible", () => {
    expect(extractLastDiff([{ id: "1", role: "user", content: "x" }])).toBeNull();
    expect(extractLastPlan([{ id: "1", role: "user", content: "x" }])).toBeNull();
  });
});

describe("marker window", () => {
  test("messages after compactedUntil keep the current attach", () => {
    const tail = messagesAfterCompactedUntil(rows, "5");
    expect(tail.map((m) => m.id)).toEqual(["6"]);
    const meta = (tail[0]!.metadata || {}) as Record<string, unknown>;
    const atts = Array.isArray(meta.attachments)
      ? (meta.attachments as Array<Record<string, unknown>>)
      : [];
    expect(String(atts[0]?.hydratedText)).toBe("CURRENT_FULL");
  });
  test("isCompactMarker", () => {
    expect(isCompactMarker({ metadata: { kind: "compact_marker" } })).toBe(true);
    expect(isCompactMarker({ role: "system", content: "contexto compactado" })).toBe(
      false,
    );
  });
});

describe("extractiveSummary", () => {
  test("does not include full grep", () => {
    const s = extractiveSummary([rows[2]!]);
    expect(s.length).toBeLessThan(500);
    expect(s).not.toMatch(/g{1000}/);
  });
});
