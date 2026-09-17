import {
  COMPACT_MARKER_KIND,
  COMPACT_MARKER_LABEL,
  COMPACT_NO_HISTORY,
  estimateTokens,
  measureContextUsage,
  type ContextUsage,
} from "./context-budget";
import type { CompactMarkerMeta, CompactTrigger } from "./compact";
import { summarizeForCompact } from "./compact-run";
import { historyFromChatMessages, promptWithHistory } from "./history";
import { modelContextWindow } from "./catalog";
import type { ClaudeAuth } from "./claude-runner";

export type CompactClient = {
  request: (
    msg: Record<string, unknown>,
    timeoutMs?: number,
  ) => Promise<{
    ok: boolean;
    error?: string;
    data?: unknown;
  }>;
};

export async function loadChatRows(
  client: CompactClient,
  chatId: string,
): Promise<{
  messages: Array<{
    id?: string;
    role?: string;
    content?: string;
    metadata?: Record<string, unknown> | null;
  }>;
  diffs?: Array<Record<string, unknown>>;
}> {
  const chatRes = await client.request({ type: "chat.get", chatId });
  if (!chatRes.ok) throw new Error(chatRes.error || "chat.get failed");
  const data = (chatRes.data || {}) as {
    messages?: Array<{
      id?: string;
      role?: string;
      content?: string;
      metadata?: Record<string, unknown> | null;
    }>;
    diffs?: Array<Record<string, unknown>>;
  };
  return { messages: data.messages ?? [], diffs: data.diffs };
}

export function usageFromPrompt(input: {
  prompt: string;
  messages: Array<{
    id?: string;
    role?: string;
    content?: string;
    metadata?: Record<string, unknown> | null;
  }>;
  modelId: string;
  providerId: string;
}): { usage: ContextUsage; composed: string } {
  const history = historyFromChatMessages(input.messages, input.prompt);
  const composed = promptWithHistory(input.prompt, history);
  const usedTokens = estimateTokens(composed);
  const windowTokens = modelContextWindow(input.providerId, input.modelId);
  return {
    composed,
    usage: measureContextUsage({
      usedTokens,
      windowTokens,
      modelId: input.modelId,
      providerId: input.providerId,
    }),
  };
}

export async function applyCompact(input: {
  client: CompactClient;
  chatId: string;
  cwd: string;
  trigger: CompactTrigger;
  excludeMessageIds?: string[];
  model: string;
  providerId: string;
  auth: ClaudeAuth | null;
  llmEnabled: boolean;
  usedTokensBefore?: number;
}): Promise<{
  skipped: boolean;
  reason?: string;
  message?: Record<string, unknown>;
  usage: ContextUsage;
}> {
  const { messages, diffs } = await loadChatRows(input.client, input.chatId);
  const result = await summarizeForCompact({
    messages,
    trigger: input.trigger,
    excludeMessageIds: input.excludeMessageIds,
    sidecarDiffs: diffs ?? null,
    model: input.model,
    cwd: input.cwd,
    auth: input.auth,
    llmEnabled: input.llmEnabled,
  });
  const afterMessages = messages; // marker not yet appended
  const dummyPrompt = "";
  const before = usageFromPrompt({
    prompt: dummyPrompt,
    messages: afterMessages,
    modelId: input.model,
    providerId: input.providerId,
  }).usage;

  if (result.tooShort) {
    return { skipped: true, reason: COMPACT_NO_HISTORY, usage: before };
  }

  const meta: CompactMarkerMeta = {
    kind: COMPACT_MARKER_KIND,
    trigger: input.trigger,
    summary: result.summary,
    compactedUntilMessageId: result.compactedUntilMessageId,
    lastDiff: result.lastDiff,
    lastPlan: result.lastPlan,
    compactedMessageCount: result.compactedMessageCount,
    usedTokensBefore: input.usedTokensBefore ?? before.usedTokens,
    usedTokensAfter: 0,
    modelId: input.model,
    providerId: input.providerId,
  };

  const append = await input.client.request({
    type: "chat.append",
    chatId: input.chatId,
    role: "system",
    content: COMPACT_MARKER_LABEL,
    metadata: meta,
  });
  if (!append.ok) throw new Error(append.error || "chat.append compact marker failed");

  const reloaded = await loadChatRows(input.client, input.chatId);
  const after = usageFromPrompt({
    prompt: dummyPrompt,
    messages: reloaded.messages,
    modelId: input.model,
    providerId: input.providerId,
  }).usage;

  const message = (append.data as { message?: Record<string, unknown> })?.message;
  if (message && message.metadata && typeof message.metadata === "object") {
    (message.metadata as CompactMarkerMeta).usedTokensAfter = after.usedTokens;
  }
  return { skipped: false, message, usage: after };
}
