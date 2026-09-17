import { CLAUDE_MODELS, getModel } from "./catalog";
import {
  aggregateChatUsage,
  type ChatUsageView,
  type CostRow,
} from "./usage-codec";

export function pricesForUsage(): {
  claude: { inputPricePerMTok: number; outputPricePerMTok: number } | null;
  cursor: { inputPricePerMTok: number; outputPricePerMTok: number } | null;
} {
  const sonnet = CLAUDE_MODELS.find((m) => m.id.includes("sonnet")) ?? CLAUDE_MODELS[0];
  const claude = sonnet
    ? {
        inputPricePerMTok: sonnet.inputPricePerMTok,
        outputPricePerMTok: sonnet.outputPricePerMTok,
      }
    : null;
  return { claude, cursor: null };
}

export function usageForMessages(messages: CostRow[]): ChatUsageView {
  return aggregateChatUsage(messages, pricesForUsage());
}

export function usageForMessagesWithModel(
  messages: CostRow[],
  providerId: string | null | undefined,
  modelId: string | null | undefined,
): ChatUsageView {
  const prices = pricesForUsage();
  if (providerId && modelId) {
    const m = getModel(providerId, modelId);
    if (m && (m.inputPricePerMTok > 0 || m.outputPricePerMTok > 0)) {
      const pack = {
        inputPricePerMTok: m.inputPricePerMTok,
        outputPricePerMTok: m.outputPricePerMTok,
      };
      if (providerId === "cursor") prices.cursor = pack;
      if (providerId === "claude") prices.claude = pack;
    }
  }
  return aggregateChatUsage(messages, prices);
}
