import { buildApprovalPrompt, formatApprovalHeadline } from "./approval-prompt";
import type { ExecutionMode } from "./execution-mode";
import { NETWORK_REQUEST_LABEL } from "./network-constants";
import { sanitizeToolInput, summarizeToolInput } from "./tool-display";
import { canonicalToolName } from "./tool-names";
import { isFetchSdkName } from "./web-fetch-constants";
import { urlFromToolInput } from "./web-fetch-ssrf";
import { fetchToolMetadata } from "./web-fetch-display";

/**
 * Metadata stamped on awaiting_approval for ask (incl. network asks).
 * Keep needsNetwork as a top-level boolean — not only inside prompt/headline.
 */
export function buildAskMetadata(input: {
  toolName: string;
  toolInput: Record<string, unknown>;
  executionMode: ExecutionMode | string;
  needsNetwork: boolean;
  streamId?: string;
  approvalDeadline?: string;
  remainingMs?: number;
  proposedPreview?: string | null;
  branch?: string | null;
  proposedDiff?: unknown;
}): Record<string, unknown> {
  const prompt = buildApprovalPrompt(
    input.toolName,
    input.toolInput,
    input.proposedPreview ?? null,
    { branch: input.branch ?? null, needsNetwork: input.needsNetwork },
  );
  const fetchExtra = isFetchSdkName(input.toolName)
    ? fetchToolMetadata(
        input.toolName,
        input.toolInput,
        "awaiting_approval",
      )
    : null;
  return {
    sdkName: input.toolName,
    input: sanitizeToolInput(input.toolInput),
    summary: summarizeToolInput(input.toolName, input.toolInput),
    executionMode: input.executionMode,
    needsNetwork: Boolean(input.needsNetwork) || Boolean(fetchExtra),
    streamId: input.streamId,
    approvalDeadline: input.approvalDeadline,
    remainingMs: input.remainingMs,
    prompt,
    headline: prompt
      ? formatApprovalHeadline(prompt)
      : `${canonicalToolName(input.toolName)}${input.needsNetwork ? ` · ${NETWORK_REQUEST_LABEL}` : ""}`,
    diff: input.proposedDiff,
    ...(fetchExtra
      ? {
          kind: "fetch",
          url: fetchExtra.url || urlFromToolInput(input.toolInput),
          toolName: "fetch",
        }
      : {}),
  };
}
