import { describe, expect, test } from "bun:test";
import { CLEAR_OK, HELP_MODES, NO_USAGE_TEXT, UNKNOWN_SLASH } from "./slash";
import { makeMemoryIo, runSlash } from "./slash-run";

const ctx = { chatId: "c1", sessionId: "s1" };

describe("runSlash", () => {
  test("/mode auto persists and does not throw", async () => {
    const { io, state } = makeMemoryIo();
    const res = await runSlash("/mode auto", io, ctx);
    expect(res.ok).toBe(true);
    expect(state.prefs.activeExecutionMode).toBe("auto");
    expect(res.text).toBe("Mode → auto");
    expect(state.results[0]).toBe("Mode → auto");
  });

  test("/plan is shortcut to mode plan", async () => {
    const { io, state } = makeMemoryIo();
    const res = await runSlash("/plan", io, ctx);
    expect(state.prefs.activeExecutionMode).toBe("plan");
    expect(res.text).toBe("Mode → plan");
  });

  test("/mode yolo rejected, prefs unchanged", async () => {
    const { io, state } = makeMemoryIo();
    const before = state.prefs.activeExecutionMode;
    const res = await runSlash("/mode yolo", io, ctx);
    expect(res.ok).toBe(false);
    expect(res.text).toBe("executionMode must be plan, auto, or ask");
    expect(state.prefs.activeExecutionMode).toBe(before);
  });

  test("Claude model with provider cursor is rejected", async () => {
    const { io, state } = makeMemoryIo();
    await runSlash("/provider cursor", io, ctx);
    expect(state.prefs.activeProvider).toBe("cursor");
    const res = await runSlash("/model claude-sonnet-4-6", io, ctx);
    expect(res.ok).toBe(false);
    expect(res.text).toContain("claude-sonnet-4-6");
    expect(res.text).toContain("cursor");
    expect(state.prefs.activeModel).not.toBe("claude-sonnet-4-6");
  });

  test("/provider cursor clamps model off Claude ids", async () => {
    const { io, state } = makeMemoryIo();
    await runSlash("/provider cursor", io, ctx);
    expect(state.prefs.activeModel).toBe("composer-2.5");
  });

  test("unknown command explains /help", async () => {
    const { io, state } = makeMemoryIo();
    const res = await runSlash("/wat", io, ctx);
    expect(res.ok).toBe(false);
    expect(res.text).toBe(UNKNOWN_SLASH);
    expect(state.results[0]).toBe(UNKNOWN_SLASH);
  });

  test("/help lists commands and modes", async () => {
    const { io } = makeMemoryIo();
    const res = await runSlash("/help", io, ctx);
    expect(res.text).toContain("/compact");
    expect(res.text).toContain(HELP_MODES);
  });

  test("/review requests a turn and never appends slash_result", async () => {
    const { io, state } = makeMemoryIo();
    const res = await runSlash("/review #7 --publish", io, ctx);
    expect(res.ok).toBe(true);
    expect(state.results).toEqual([]);
    expect(state.turns).toEqual([
      {
        chatId: "c1",
        prompt: "Revisa los cambios.",
        metadata: {
          kind: "code_review",
          review: { pr: { number: 7 }, explicitPublish: true },
        },
      },
    ]);
  });

  test("/cost sin datos", async () => {
    const { io } = makeMemoryIo();
    const res = await runSlash("/cost", io, ctx);
    expect(res.text).toBe(NO_USAGE_TEXT);
  });

  test("/clear creates a chat and does not call git", async () => {
    const { io, state } = makeMemoryIo();
    const res = await runSlash("/clear", io, ctx);
    expect(res.ok).toBe(true);
    expect(res.navigatedChatId).toBe("chat-1");
    expect(res.text).toBe(CLEAR_OK);
    expect(state.chats).toEqual(["chat-1"]);
  });

  test("/compact and /undo call injected RPCs", async () => {
    const { io } = makeMemoryIo({
      compact: async () => ({ text: "contexto compactado" }),
      undo: async () => ({ text: "undone" }),
    });
    expect((await runSlash("/compact", io, ctx)).text).toBe("contexto compactado");
    expect((await runSlash("/undo", io, ctx)).text).toBe("undone");
  });

  test("/apply calls chat.plan.apply and does not commit", async () => {
    const { io } = makeMemoryIo({
      applyPlan: async () => ({ executionMode: "auto", gitCommit: false }),
    });
    const res = await runSlash("/apply", io, ctx);
    expect(res.ok).toBe(true);
    expect(res.text).toContain("Modo auto");
    expect(res.text.toLowerCase()).toContain("brief");
  });

  test("/compact without RPC still feedbacks", async () => {
    const { io } = makeMemoryIo();
    const res = await runSlash("/compact", io, ctx);
    expect(res.ok).toBe(false);
    expect(res.text.toLowerCase()).toContain("compact");
  });
});
