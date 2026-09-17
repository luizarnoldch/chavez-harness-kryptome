import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeAuth } from "./claude-runner";
import { buildClaudeEnv } from "./claude-runner";
import {
  buildCompactSource,
  buildSummarizerPrompt,
  extractLastDiff,
  extractLastPlan,
  extractiveSummary,
  splitCompactWindow,
  SUMMARY_MAX_CHARS,
  type ChatRow,
  type CompactTrigger,
} from "./compact";

export type CompactRunInput = {
  messages: ChatRow[];
  trigger: CompactTrigger;
  /** Current user message id — overflow path. Never summarized. */
  excludeMessageIds?: string[];
  sidecarDiffs?: Array<Record<string, unknown>> | null;
  model: string;
  cwd: string;
  auth: ClaudeAuth | null;
  /** When false, skip LLM and use extractiveSummary. */
  llmEnabled: boolean;
};

function denyAllTools(): { behavior: "deny"; message: string } {
  return {
    behavior: "deny",
    message: "Compact summarizer cannot run tools",
  };
}

export async function summarizeForCompact(input: CompactRunInput): Promise<{
  summary: string;
  lastDiff: string | null;
  lastPlan: string | null;
  compactedUntilMessageId: string;
  compactedMessageCount: number;
  tooShort: boolean;
  method: "llm" | "extractive";
}> {
  const window = splitCompactWindow(input.messages, {
    excludeIds: new Set(input.excludeMessageIds ?? []),
  });
  const lastDiff = extractLastDiff(input.messages, input.sidecarDiffs);
  const lastPlan = extractLastPlan(input.messages);
  if (window.tooShort) {
    return {
      summary: "",
      lastDiff,
      lastPlan,
      compactedUntilMessageId: window.compactedUntilMessageId,
      compactedMessageCount: 0,
      tooShort: true,
      method: "extractive",
    };
  }

  const source = buildCompactSource(window.head);
  let summary = extractiveSummary(window.head);
  let method: "llm" | "extractive" = "extractive";

  if (input.llmEnabled && input.auth) {
    const prompt = buildSummarizerPrompt(source, { lastDiff, lastPlan });
    const env = buildClaudeEnv(input.auth);
    let text = "";
    try {
      for await (const message of query({
        prompt,
        options: {
          model: input.model,
          cwd: input.cwd,
          env,
          settingSources: [],
          tools: [],
          allowedTools: [],
          permissionMode: "default",
          canUseTool: async () => denyAllTools(),
        } as never,
      })) {
        const msg = message as Record<string, unknown>;
        if (String(msg.type || "") === "result" && String(msg.subtype || "") === "success") {
          if (typeof msg.result === "string") text = msg.result;
        }
      }
    } catch {
      text = "";
    }
    if (text.trim()) {
      summary = text.trim().slice(0, SUMMARY_MAX_CHARS);
      method = "llm";
    }
  }

  if (method === "extractive" && input.llmEnabled) {
    try {
      const mod = await import("./cursor-runner");
      const fn = (mod as { summarizeCursorCompact?: Function }).summarizeCursorCompact;
      if (typeof fn === "function") {
        const t = await fn({
          prompt: buildSummarizerPrompt(source, { lastDiff, lastPlan }),
          cwd: input.cwd,
          model: input.model,
        });
        if (typeof t === "string" && t.trim()) {
          summary = t.trim().slice(0, SUMMARY_MAX_CHARS);
          method = "llm";
        }
      }
    } catch {
      // cursor-runner absent or not runnable — keep extractive/claude
    }
  }

  return {
    summary,
    lastDiff,
    lastPlan,
    compactedUntilMessageId: window.compactedUntilMessageId,
    compactedMessageCount: window.compactedMessageCount,
    tooShort: false,
    method,
  };
}
