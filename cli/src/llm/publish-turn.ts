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
import {
  sanitizeToolInput,
  stringifyToolOutput,
  summarizeToolInput,
  toolHeadline,
} from "./tool-display";
import { canonicalToolName } from "./tool-names";

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

  const inFlight = new Map<string, { toolName: string; input?: unknown }>();
  let streamStarted = false;
  let streamId = crypto.randomUUID();

  try {
    const blocked = blockingAttachError(attachments);
    if (blocked) {
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

    await client.request({ type: "agent.turn.started", chatId });
    await client.request({
      type: "chat.stream.start",
      chatId,
      streamId,
    });
    streamStarted = true;

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
          if (inFlight.has(ev.toolCallId)) return;
          inFlight.set(ev.toolCallId, { toolName: ev.toolName, input: ev.input });
          const sdkName = ev.toolName;
          const name = canonicalToolName(sdkName);
          await client.request({
            type: "chat.tool.start",
            chatId,
            streamId,
            toolCallId: ev.toolCallId,
            toolName: name,
            content: toolHeadline(sdkName, "running", ev.input),
            metadata: {
              sdkName,
              input: sanitizeToolInput(ev.input),
              summary: summarizeToolInput(sdkName, ev.input),
              streamId,
            },
          });
        }
        if (ev.kind === "tool_result") {
          const prev = inFlight.get(ev.toolCallId);
          inFlight.delete(ev.toolCallId);
          const sdkName = ev.toolName || prev?.toolName || "tool";
          const output = stringifyToolOutput(ev.output);
          await client.request({
            type: "chat.tool.result",
            chatId,
            streamId,
            toolCallId: ev.toolCallId,
            toolName: canonicalToolName(sdkName),
            content: output,
            status: ev.status === "error" ? "error" : "done",
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
    if (streamStarted) {
      for (const [toolCallId, info] of inFlight) {
        try {
          await client.request({
            type: "chat.tool.result",
            chatId,
            streamId,
            toolCallId,
            toolName: canonicalToolName(info.toolName),
            content: stringifyToolOutput(message),
            status: "error",
          });
        } catch {
          // ignore
        }
      }
      inFlight.clear();
      await client.request({
        type: "chat.stream.error",
        chatId,
        streamId,
        content: message,
      });
    }
    throw err;
  } finally {
    try {
      await client.request({ type: "agent.turn.ended", chatId });
    } catch {
      // connection already dead
    }
  }
}
