import { apiFetch } from "../api-client";
import type { ChavezWsClient } from "../ws/client";
import {
  defaultEffort,
  defaultModelId,
  type EffortLevel,
} from "./catalog";
import { runClaudeTurn } from "./claude-runner";
import { historyFromChatMessages } from "./history";
import {
  blockingAttachError,
  hydrateAll,
  persistableAttachment,
  type HydratedAttachment,
} from "./hydrate-attachments";
import { mergeMentions } from "./mentions";

type ProvidersResponse = {
  activeProvider: string | null;
  activeModel: string | null;
  activeEffort: string | null;
  providers: Record<string, { linked?: boolean }>;
};

/**
 * Append user prompt, run Claude Agent SDK, publish stream/tool events, end with assistant.
 */
export async function publishAgentTurn(input: {
  client: ChavezWsClient;
  chatId: string;
  prompt: string;
  cwd: string;
  token?: string;
  skipUserAppend?: boolean;
  mentions?: string[];
}): Promise<string> {
  const { client, chatId, prompt, cwd, token } = input;
  const paths = mergeMentions(prompt, input.mentions ?? []);
  const attachments: HydratedAttachment[] = paths.length
    ? hydrateAll(cwd, paths)
    : [];

  if (!input.skipUserAppend) {
    const userRes = await client.request({
      type: "chat.append",
      chatId,
      role: "user",
      content: prompt,
      metadata: attachments.length
        ? { attachments: attachments.map(persistableAttachment) }
        : undefined,
    });
    if (!userRes.ok) {
      throw new Error(userRes.error || "chat.append user failed");
    }
  }

  const blocked = blockingAttachError(attachments);
  if (blocked) {
    const streamId = crypto.randomUUID();
    await client.request({ type: "chat.stream.start", chatId, streamId });
    await client.request({
      type: "chat.stream.error",
      chatId,
      streamId,
      content: blocked,
    });
    throw new Error(blocked);
  }

  const providers = await apiFetch<ProvidersResponse>("/providers", {}, token);
  if (providers.activeProvider && providers.activeProvider !== "claude") {
    throw new Error(
      `Provider activo "${providers.activeProvider}" no ejecuta agente en daemon (solo claude)`,
    );
  }
  if (!providers.providers?.claude?.linked) {
    throw new Error("Claude no está vinculado — chavez provider link claude");
  }

  const creds = await apiFetch<{
    authKind: "oauth_token" | "api_key";
    secret: string;
  }>("/providers/claude/credentials", {}, token);

  const model = providers.activeModel || defaultModelId("claude") || "claude-sonnet-4-20250514";
  const effort = (providers.activeEffort ||
    defaultEffort("claude", model)) as EffortLevel;
  const streamId = crypto.randomUUID();

  const chatRes = await client.request({ type: "chat.get", chatId });
  if (!chatRes.ok) {
    throw new Error(chatRes.error || "chat.get failed");
  }
  const dbMessages =
    (chatRes.data as {
      messages?: Array<{
        role?: string;
        content?: string;
        metadata?: Record<string, unknown> | null;
      }>;
    })?.messages ?? [];
  const history = historyFromChatMessages(dbMessages, prompt);

  await client.request({
    type: "chat.stream.start",
    chatId,
    streamId,
  });

  try {
    const result = await runClaudeTurn({
      prompt,
      history,
      model,
      effort,
      auth: { authKind: creds.authKind, secret: creds.secret },
      cwd,
      attachments,
      onEvent: async (ev) => {
        if (ev.kind === "stream_delta") {
          await client.request({
            type: "chat.stream.delta",
            chatId,
            streamId,
            delta: ev.text,
          });
        }
        if (ev.kind === "tool_start") {
          await client.request({
            type: "chat.tool.start",
            chatId,
            toolCallId: ev.toolCallId,
            toolName: ev.toolName,
            content: ev.toolName,
            metadata: { input: ev.input },
          });
        }
        if (ev.kind === "tool_result") {
          await client.request({
            type: "chat.tool.result",
            chatId,
            toolCallId: ev.toolCallId,
            toolName: ev.toolName,
            content: ev.output,
            status: ev.status || "done",
          });
        }
      },
    });

    await client.request(
      {
        type: "chat.stream.end",
        chatId,
        streamId,
        content: result,
      },
      60_000,
    );
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await client.request({
      type: "chat.stream.error",
      chatId,
      streamId,
      content: message,
    });
    throw err;
  }
}
