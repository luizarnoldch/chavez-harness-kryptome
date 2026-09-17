import { apiFetch } from "../api-client";
import { applyCompact, type CompactClient } from "./compact-apply";
import { TURN_BUSY_ERROR } from "./undo-constants";

export async function handleCompactDispatch(input: {
  client: CompactClient;
  data: {
    chatId?: string;
    requestId?: string;
    path?: string;
    trigger?: "manual" | "overflow";
  };
  cwd: string;
  token?: string;
  isBusy: () => boolean;
  setBusy: (v: boolean) => void;
}): Promise<void> {
  const { client, data, cwd, token } = input;
  if (!data.chatId || !data.requestId) return;
  if (input.isBusy()) {
    await client.request({
      type: "chat.compact.result",
      requestId: data.requestId,
      chatId: data.chatId,
      metadata: { ok: false, error: TURN_BUSY_ERROR },
    });
    return;
  }
  input.setBusy(true);
  try {
    const providers = await apiFetch<{
      activeProvider: string | null;
      activeModel: string | null;
      providers?: Record<string, { linked?: boolean }>;
    }>("/providers", {}, token);
    let auth: { authKind: "oauth_token" | "api_key"; secret: string } | null =
      null;
    if (providers.providers?.claude?.linked) {
      try {
        auth = await apiFetch<{
          authKind: "oauth_token" | "api_key";
          secret: string;
        }>("/providers/claude/credentials", {}, token);
      } catch {
        auth = null;
      }
    }
    const out = await applyCompact({
      client,
      chatId: data.chatId,
      cwd: data.path || cwd,
      trigger: data.trigger || "manual",
      model: providers.activeModel || "claude-sonnet-4-6",
      providerId: providers.activeProvider || "claude",
      auth,
      llmEnabled: Boolean(auth),
    });
    await client.request({
      type: "chat.compact.result",
      requestId: data.requestId,
      chatId: data.chatId,
      metadata: {
        ok: true,
        skipped: out.skipped,
        reason: out.reason,
        context: out.usage,
      },
    });
  } catch (err) {
    await client.request({
      type: "chat.compact.result",
      requestId: data.requestId,
      chatId: data.chatId,
      metadata: {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      },
    });
  } finally {
    input.setBusy(false);
  }
}
