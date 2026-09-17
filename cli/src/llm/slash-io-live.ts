import { apiFetch } from "../api-client";
import type { ChavezWsClient } from "../ws/client";
import { SLASH_RESULT_KIND } from "./slash";
import type { PrefsSnapshot, SlashIo } from "./slash-run";

export function liveSlashIo(opts: {
  client: ChavezWsClient;
  token?: string;
}): SlashIo {
  const { client, token } = opts;
  return {
    getPrefs: () => apiFetch<PrefsSnapshot>("/providers", {}, token),
    putPrefs: (patch) =>
      apiFetch<PrefsSnapshot>(
        "/providers/preferences",
        { method: "PUT", body: JSON.stringify(patch) },
        token,
      ),
    compact: async (chatId) => {
      const res = await client.request({ type: "chat.compact", chatId }, 90_000);
      if (!res.ok) throw new Error(res.error || "compact failed");
      const data = (res.data || {}) as { message?: { content?: string } };
      return { text: data.message?.content || "contexto compactado" };
    },
    undo: async (chatId) => {
      const res = await client.request(
        { type: "agent.turn.undo", chatId },
        30_000,
      );
      if (!res.ok) throw new Error(res.error || "undo failed");
      const data = (res.data || {}) as {
        noop?: boolean;
        message?: string;
      };
      return { text: data.message || (data.noop ? "Nothing to undo: the last turn made no applied changes" : "undone") };
    },
    createChat: async (sessionId, title) => {
      const res = await client.request({
        type: "chat.create",
        sessionId,
        title,
      });
      if (!res.ok) throw new Error(res.error || "chat.create failed");
      const chat = (res.data as { chat?: { id: string } })?.chat;
      if (!chat?.id) throw new Error("chat.create returned no id");
      return { id: chat.id };
    },
    getChat: async (chatId) => {
      const res = await client.request({ type: "chat.get", chatId });
      if (!res.ok) throw new Error(res.error || "chat.get failed");
      const data = (res.data || {}) as {
        messages?: Array<{ role?: string; content?: string; metadata?: unknown }>;
        chat?: { metadata?: unknown };
        context?: unknown;
        usage?: unknown;
      };
      return {
        messages: data.messages ?? [],
        usage: data.usage ?? data.context ?? data.chat?.metadata,
      };
    },
    appendResult: async (chatId, content, meta) => {
      const res = await client.request({
        type: "chat.append",
        chatId,
        role: "system",
        content,
        metadata: meta,
      });
      if (!res.ok) throw new Error(res.error || "chat.append failed");
    },
  };
}

export { SLASH_RESULT_KIND };
