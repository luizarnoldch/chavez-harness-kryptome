import { RETRY_NO_PROMPT } from "./undo-constants";
import { metaOf, selectLastTurn, type ChatRow } from "./turn-select";

export type RetryPayload = {
  prompt: string;
  mentions: string[];
  attachments: unknown[];
  retryOfStreamId: string | null;
};

export function retryPayloadFromMessages(
  messages: ChatRow[],
): { ok: true; payload: RetryPayload } | { ok: false; error: string } {
  const last = selectLastTurn(messages);
  const user = last?.user ?? [...messages].reverse().find((m) => m.role === "user");
  const prompt = (user?.content || "").trim();
  if (!user || !prompt) return { ok: false, error: RETRY_NO_PROMPT };
  const meta = metaOf(user);
  const mentions = Array.isArray(meta.mentions)
    ? (meta.mentions.filter((x) => typeof x === "string") as string[])
    : [];
  const attachments = Array.isArray(meta.attachments) ? meta.attachments : [];
  return {
    ok: true,
    payload: {
      prompt,
      mentions,
      attachments,
      retryOfStreamId: last?.streamId ?? null,
    },
  };
}

/** Guard: retry never ships historical tool_use / toolCallId lists to the runner. */
export function retryContainsTools(payload: RetryPayload): boolean {
  const blob = JSON.stringify(payload);
  return /"toolCallId"\s*:/.test(blob) || /"tool_use"/.test(blob);
}
