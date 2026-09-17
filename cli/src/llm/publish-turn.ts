import { apiFetch } from "../api-client";
import type { ChavezWsClient } from "../ws/client";
import {
  defaultEffort,
  defaultModelId,
  type EffortLevel,
} from "./catalog";
import type { AgentTurnEvent } from "./agent-events";
import { runClaudeTurn } from "./claude-runner";
import { CURSOR_NOT_RUNNABLE, CURSOR_UNLINKED } from "./cursor-errors";
import { runCursorTurn } from "./cursor-runner";
import {
  ASK_APPROVAL_TIMEOUT_MS,
  parseExecutionMode,
  type ExecutionMode,
} from "./execution-mode";
import { selectRunner } from "./select-runner";
import { endTurn } from "./turn-control";
import { beginTurnAbort, endTurnAbort, TURN_CANCELLED } from "./turn-abort";
import { formatAttachments, historyFromChatMessages } from "./history";
import { redactJson, redactText } from "./redact";
import { PathEscapeError, resolveInsideCwd } from "./workspace-path";
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
import { cancelApprovalsForChat, waitForApproval } from "./tool-approval";
import { canonicalToolName } from "./tool-names";

type ProvidersResponse = {
  activeProvider: string | null;
  activeModel: string | null;
  activeEffort: string | null;
  activeParams?: Array<{ id: string; value: string }> | null;
  activeExecutionMode: string | null;
  providers: Record<
    string,
    {
      linked?: boolean;
      runnable?: boolean;
      models?: unknown[];
      catalogError?: string | null;
    }
  >;
};

/**
 * Append user prompt, run the active provider agent, publish stream/tool events, end with assistant.
 */
export async function publishAgentTurn(input: {
  client: ChavezWsClient;
  chatId: string;
  prompt: string;
  cwd: string;
  token?: string;
  skipUserAppend?: boolean;
  mentions?: string[];
  executionMode?: ExecutionMode;
  signal?: AbortSignal;
  abortController?: AbortController;
}): Promise<string> {
  const { client, chatId, prompt, cwd, token } = input;
  const paths = mergeMentions(prompt, input.mentions ?? []);
  const attachments: HydratedAttachment[] = paths.length
    ? hydrateAll(cwd, paths)
    : [];

  const inFlight = new Map<string, { toolName: string; input?: unknown }>();
  let streamStarted = false;
  let streamId = crypto.randomUUID();
  let seq = 1;
  let credsSecret = "";
  const ac = input.abortController ?? beginTurnAbort(chatId);
  const signal = input.signal ?? ac.signal;

  try {
    const providers = await apiFetch<ProvidersResponse>("/providers", {}, token);
    const executionMode = parseExecutionMode(
      input.executionMode ?? providers.activeExecutionMode,
    );
    const runner = selectRunner(providers);
    const active = runner.kind;
    const activeModel = providers.activeModel;

    if (!input.skipUserAppend) {
      const userRes = await client.request({
        type: "chat.append",
        chatId,
        role: "user",
        content: prompt,
        metadata: {
          provider: active,
          model: activeModel,
          executionMode,
          ...(attachments.length
            ? { attachments: attachments.map(persistableAttachment) }
            : {}),
        },
      });
      if (!userRes.ok) {
        throw new Error(userRes.error || "chat.append user failed");
      }
    }

    for (const a of attachments) {
      try {
        resolveInsideCwd(cwd, a.path);
      } catch (err) {
        if (err instanceof PathEscapeError) {
          await client.request({ type: "chat.stream.start", chatId, streamId });
          streamStarted = true;
          await client.request({
            type: "chat.stream.error",
            chatId,
            streamId,
            content: err.message,
          });
          throw err;
        }
        throw err;
      }
    }

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

    if (active === "cursor" && !providers.providers.cursor.runnable) {
      throw new Error(
        providers.providers.cursor.catalogError
          ? `${CURSOR_NOT_RUNNABLE} (${providers.providers.cursor.catalogError})`
          : CURSOR_NOT_RUNNABLE,
      );
    }
    if (active === "cursor" && !providers.providers.cursor.linked) {
      throw new Error(CURSOR_UNLINKED);
    }

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
    const lastUser = [...dbMessages].reverse().find((m) => m.role === "user");
    const currentAttachments = formatAttachments(
      (lastUser as { metadata?: Record<string, unknown> } | undefined)?.metadata,
    );

    await client.request({
      type: "agent.turn.started",
      chatId,
      metadata: { executionMode },
    });
    await client.request({
      type: "chat.stream.start",
      chatId,
      streamId,
    });
    streamStarted = true;

    const onEvent = async (ev: AgentTurnEvent) => {
      if (signal.aborted) return;
      if (ev.kind === "stream_delta") {
        await client.request({
          type: "chat.stream.delta",
          chatId,
          streamId,
          delta: ev.text,
          seq,
        });
        seq += 1;
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
        const output = redactText(stringifyToolOutput(ev.output));
        await client.request({
          type: "chat.tool.result",
          chatId,
          streamId,
          toolCallId: ev.toolCallId,
          toolName: canonicalToolName(sdkName),
          content: output,
          status: ev.status === "error" ? "error" : "done",
          metadata: {
            output,
            input: redactJson(prev?.input),
          },
        });
      }
    };

    let result: string;
    if (active === "claude") {
      const creds = await apiFetch<{
        authKind: "oauth_token" | "api_key";
        secret: string;
      }>("/providers/claude/credentials", {}, token);
      credsSecret = creds.secret;
      const model =
        providers.activeModel ||
        defaultModelId("claude") ||
        "claude-sonnet-4-20250514";
      const effort = (providers.activeEffort ||
        defaultEffort("claude", model)) as EffortLevel;
      result = await runClaudeTurn({
        prompt,
        history,
        model,
        effort,
        auth: { authKind: creds.authKind, secret: creds.secret },
        cwd,
        attachments,
        attachmentsText: currentAttachments,
        abortController: ac,
        executionMode,
        onAskPermission: async ({
          toolCallId,
          toolName,
          input: toolInput,
          signal,
        }) => {
          inFlight.set(toolCallId, { toolName, input: toolInput });
          const metadata = {
            sdkName: toolName,
            input: sanitizeToolInput(toolInput),
            summary: summarizeToolInput(toolName, toolInput),
            executionMode,
          };
          const updated = await client.request({
            type: "chat.tool.update",
            chatId,
            streamId,
            toolCallId,
            toolName: canonicalToolName(toolName),
            status: "awaiting_approval",
            metadata,
          });
          if (!updated.ok) {
            await client.request({
              type: "chat.tool.start",
              chatId,
              streamId,
              toolCallId,
              toolName: canonicalToolName(toolName),
              content: toolHeadline(toolName, "awaiting_approval", toolInput),
              status: "awaiting_approval",
              metadata,
            });
          }
          return waitForApproval(toolCallId, chatId, {
            timeoutMs: ASK_APPROVAL_TIMEOUT_MS,
            signal,
          });
        },
        onEvent,
      });
      if (signal.aborted) throw new Error(TURN_CANCELLED);
    } else {
      const creds = await apiFetch<{
        authKind: "api_key" | "oauth_token";
        secret: string;
      }>("/providers/cursor/credentials", {}, token);
      credsSecret = creds.secret;
      const model = providers.activeModel;
      if (!model) {
        throw new Error(CURSOR_NOT_RUNNABLE);
      }
      result = await runCursorTurn({
        prompt,
        history,
        model,
        params: providers.activeParams ?? [],
        auth: { authKind: "api_key", secret: creds.secret },
        cwd,
        signal,
        executionMode,
        onEvent,
      });
    }

    await client.request(
      {
        type: "chat.stream.end",
        chatId,
        streamId,
        content: redactText(result),
      },
      60_000,
    );
    return result;
  } catch (err) {
    const raw = ac.signal.aborted
      ? TURN_CANCELLED
      : err instanceof Error
        ? err.message
        : String(err);
    const message =
      credsSecret && raw.includes(credsSecret)
        ? raw.split(credsSecret).join("***")
        : raw;
    if (streamStarted) {
      for (const [toolCallId, info] of inFlight) {
        try {
          await client.request({
            type: "chat.tool.result",
            chatId,
            streamId,
            toolCallId,
            toolName: canonicalToolName(info.toolName),
            content: redactText(stringifyToolOutput(message)),
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
    throw new Error(message);
  } finally {
    endTurnAbort(chatId);
    endTurn(chatId);
    cancelApprovalsForChat(chatId);
    try {
      await client.request({ type: "agent.turn.ended", chatId });
    } catch {
      // connection already dead
    }
  }
}
