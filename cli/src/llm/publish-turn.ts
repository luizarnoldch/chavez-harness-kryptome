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
  ASK_DENIED,
  ASK_TIMEOUT_DENIED,
  HEADLESS_WAITING,
} from "./approval-constants";
import { approvalDeadlineIso } from "./approval-deadline";
import { buildApprovalPrompt, formatApprovalHeadline } from "./approval-prompt";
import {
  parseExecutionMode,
  type ExecutionMode,
} from "./execution-mode";
import { selectRunner } from "./select-runner";
import { endTurn } from "./turn-control";
import { beginTurnAbort, endTurnAbort, TURN_CANCELLED } from "./turn-abort";
import { formatAttachments, historyFromChatMessages } from "./history";
import { redactJson, redactText } from "./redact";
import { PathEscapeError, resolveInsideCwd } from "./workspace-path";
import { decideAttach, hydrateForced } from "./attach-force";
import {
  attachmentsPromptBlock,
  blockingAttachError,
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
import { sanitizeVisibleToolOutput } from "./tool-ignore";
import { cancelApprovalsForChat, waitForApproval } from "./tool-approval";
import { canonicalToolName } from "./tool-names";
import { TurnDiffCollector, toUpsertPayload } from "./turn-diff-collector";
import { createTurnCheckpoint, finalizeCheckpoint } from "./git-checkpoint";
import { emptyCheckpoint } from "./undo-decide";
import type { Checkpoint } from "./undo-constants";
import { detectGit } from "./git-detect";
import { gitToolClass, parseGitSdkName } from "./git-names";
import { extractPrUrl } from "./git-pr";

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

async function getGitHubToken(token?: string): Promise<string | null> {
  try {
    const creds = await apiFetch<{ secret: string }>(
      "/providers/github/credentials",
      {},
      token,
    );
    return creds.secret || null;
  } catch {
    return null;
  }
}

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
  attachments?: unknown[];
  retryOfStreamId?: string;
  executionMode?: ExecutionMode;
  signal?: AbortSignal;
  abortController?: AbortController;
}): Promise<string> {
  const { client, chatId, prompt, cwd, token } = input;
  const paths = mergeMentions(prompt, input.mentions ?? []);
  let attachments: HydratedAttachment[] = [];
  const ignoredAttaches: Array<{
    path?: string;
    error?: string;
    status?: string;
  }> = [];
  const attachNotices: string[] = [];

  const inFlight = new Map<string, { toolName: string; input?: unknown }>();
  let streamStarted = false;
  let streamId = crypto.randomUUID();
  const collector = new TurnDiffCollector(streamId, cwd);
  let diffsPublished = false;
  let seq = 1;
  let credsSecret = "";
  let hadBash = false;
  let checkpoint: Checkpoint = emptyCheckpoint(streamId, "git_error");
  const ac = input.abortController ?? beginTurnAbort(chatId);
  const signal = input.signal ?? ac.signal;

  async function publishAppliedDiffs() {
    if (diffsPublished) return;
    diffsPublished = true;
    const applied = await collector.finalize();
    for (const d of applied) {
      await client.request({
        type: "chat.diff.upsert",
        chatId,
        streamId,
        diff: toUpsertPayload(d),
      });
    }
  }

  try {
    try {
      checkpoint = await createTurnCheckpoint(cwd, streamId);
    } catch {
      checkpoint = emptyCheckpoint(streamId, "git_error");
    }

    const providers = await apiFetch<ProvidersResponse>("/providers", {}, token);
    const executionMode = parseExecutionMode(
      input.executionMode ?? providers.activeExecutionMode,
    );
    const runner = selectRunner(providers);
    const active = runner.kind;
    const activeModel = providers.activeModel;

    for (const rel of paths) {
      const d = decideAttach(cwd, rel, executionMode);
      if (d.needsAsk) {
        const toolCallId = crypto.randomUUID();
        await client.request({
          type: "chat.tool.start",
          chatId,
          toolCallId,
          toolName: "attach",
          content: `Attach ignored path ${d.needsAsk.path}? (${d.needsAsk.reason})`,
          status: "awaiting_approval",
          metadata: {
            sdkName: "AttachIgnored",
            input: { path: d.needsAsk.path, reason: d.needsAsk.reason },
            status: "awaiting_approval",
          },
        });
        const outcome = await waitForApproval(toolCallId, chatId, {
          timeoutMs: ASK_APPROVAL_TIMEOUT_MS,
          signal,
        });
        if (outcome === "approve") {
          const forced = hydrateForced(cwd, rel, d.needsAsk.cls);
          attachments.push(forced);
          await client.request({
            type: "chat.tool.result",
            chatId,
            toolCallId,
            toolName: "attach",
            content: `Attached ${rel}`,
            status: "done",
            metadata: {
              sdkName: "AttachIgnored",
              output: `Attached ${rel}`,
            },
          });
        } else {
          attachments.push(d.attachment);
          const notice =
            d.attachment.error ||
            `Ignored path (not hydrated): ${rel} (${d.needsAsk.reason})`;
          attachNotices.push(notice);
          ignoredAttaches.push({
            path: rel,
            error: notice,
            status: d.attachment.status,
          });
          await client.request({
            type: "chat.tool.result",
            chatId,
            toolCallId,
            toolName: "attach",
            content: notice,
            status: "error",
            metadata: { sdkName: "AttachIgnored", output: notice },
          });
        }
        continue;
      }
      attachments.push(d.attachment);
      if (d.notice) {
        attachNotices.push(d.notice);
        ignoredAttaches.push({
          path: rel,
          error: d.notice,
          status: d.attachment.status,
        });
      }
    }

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
          streamId,
          checkpoint,
          ...(input.mentions ? { mentions: input.mentions } : {}),
          ...(input.retryOfStreamId
            ? { retryOfStreamId: input.retryOfStreamId }
            : {}),
          ...(attachments.length
            ? {
                attachments: attachments.map((a) => {
                  const p = persistableAttachment(a);
                  if (
                    a.status === "secret" ||
                    a.status === "vault" ||
                    a.status === "ignored"
                  ) {
                    const { hydratedText: _drop, ...rest } = p;
                    return rest;
                  }
                  return p;
                }),
              }
            : input.attachments
              ? { attachments: input.attachments }
              : {}),
          ...(ignoredAttaches.length ? { ignoredAttaches } : {}),
        },
      });
      if (!userRes.ok) {
        throw new Error(userRes.error || "chat.append user failed");
      }
    }
    try {
      await client.request({
        type: "chat.checkpoint.created",
        chatId,
        streamId,
        checkpoint,
      });
    } catch {
      // API may not know this type yet; turn continues
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
    const skipLines = attachNotices.map((n) => {
      if (/secret file/i.test(n)) return `[${n}]`;
      if (/vault/i.test(n)) return `[${n}]`;
      const m = /Ignored path \(not hydrated\): (.+) \((.+)\)/.exec(n);
      if (m) return `[Skipped ignored attach: ${m[1]} (${m[2]})]`;
      return `[${n}]`;
    });
    const currentAttachments = [
      ...skipLines,
      formatAttachments(
        (lastUser as { metadata?: Record<string, unknown> } | undefined)
          ?.metadata,
      ) || attachmentsPromptBlock(attachments),
    ]
      .filter((s) => s.trim())
      .join("\n");

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
        if (ev.toolName === "Bash" || ev.toolName === "bash") hadBash = true;
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
            input: redactJson(sanitizeToolInput(ev.input)),
            summary: summarizeToolInput(sdkName, ev.input),
            streamId,
          },
        });
      }
      if (ev.kind === "tool_result") {
        if (ev.toolName === "Bash" || ev.toolName === "bash" || ev.sdkName === "Bash" || ev.sdkName === "bash") {
          hadBash = true;
        }
        const prev = inFlight.get(ev.toolCallId);
        inFlight.delete(ev.toolCallId);
        const sdkName = ev.sdkName || ev.toolName || prev?.toolName || "tool";
        const toolInput =
          (ev.input && typeof ev.input === "object"
            ? (ev.input as Record<string, unknown>)
            : null) ??
          (prev?.input && typeof prev.input === "object"
            ? (prev.input as Record<string, unknown>)
            : null);
        await collector.afterTool(
          sdkName,
          toolInput,
          ev.status === "error" ? "error" : "done",
        );
        const output = sanitizeVisibleToolOutput(
          cwd,
          sdkName,
          stringifyToolOutput(ev.output),
        );
        const prUrl =
          canonicalToolName(sdkName) === "git_pr" ? extractPrUrl(output) : null;
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
            input: redactJson(sanitizeToolInput(prev?.input)),
            streamId,
            ...(prUrl ? { prUrl } : {}),
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
      let gitBranchCache: string | null | undefined;
      async function currentGitBranch(): Promise<string | null> {
        if (gitBranchCache !== undefined) return gitBranchCache;
        try {
          gitBranchCache = (await detectGit(cwd)).branch;
        } catch {
          gitBranchCache = null;
        }
        return gitBranchCache;
      }

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
        collector,
        getGitHubToken: () => getGitHubToken(token),
        onAskPermission: async ({
          toolCallId,
          toolName,
          input: toolInput,
          signal,
          proposed,
        }) => {
          inFlight.set(toolCallId, { toolName, input: toolInput });
          const deadline = approvalDeadlineIso();
          const proposedPreview =
            proposed && typeof proposed.preview === "string"
              ? proposed.preview
              : typeof (toolInput as { preview?: string }).preview === "string"
                ? String((toolInput as { preview?: string }).preview)
                : undefined;
          const gitId = parseGitSdkName(toolName);
          const branch =
            gitId && gitToolClass(gitId) === "write"
              ? await currentGitBranch()
              : null;
          const prompt = buildApprovalPrompt(
            toolName,
            toolInput,
            proposedPreview,
            { branch },
          );
          if (!prompt) {
            return "approve";
          }
          const name = canonicalToolName(toolName);
          const inputSafe = sanitizeToolInput(toolInput);
          const summary = summarizeToolInput(toolName, toolInput);
          const metadata = {
            sdkName: toolName,
            input: inputSafe,
            summary,
            executionMode,
            streamId,
            approvalDeadline: deadline,
            remainingMs: ASK_APPROVAL_TIMEOUT_MS,
            prompt,
            diff: proposed
              ? toUpsertPayload(proposed)
              : prompt.kind === "write" || prompt.kind === "edit"
                ? { path: prompt.path, preview: prompt.diff, kind: prompt.kind }
                : undefined,
          };
          const updated = await client.request({
            type: "chat.tool.update",
            chatId,
            streamId,
            toolCallId,
            toolName: name,
            status: "awaiting_approval",
            metadata,
          });
          if (!updated.ok) {
            await client.request({
              type: "chat.tool.start",
              chatId,
              streamId,
              toolCallId,
              toolName: name,
              content: formatApprovalHeadline(prompt),
              status: "awaiting_approval",
              metadata,
            });
          }
          if (proposed) {
            await client.request({
              type: "chat.diff.upsert",
              chatId,
              streamId,
              diff: toUpsertPayload(proposed),
            });
          }
          console.error(HEADLESS_WAITING);
          const outcome = await waitForApproval(toolCallId, chatId, {
            timeoutMs: ASK_APPROVAL_TIMEOUT_MS,
            signal,
          });
          if (outcome === "timeout") {
            await client.request({
              type: "chat.tool.update",
              chatId,
              streamId,
              toolCallId,
              status: "error",
              content: ASK_TIMEOUT_DENIED,
              metadata: {
                resolution: "timeout",
                resolvedBy: "timeout",
                resolvedAt: new Date().toISOString(),
                output: ASK_TIMEOUT_DENIED,
              },
            });
          }
          if (outcome === "deny" || outcome === "cancelled") {
            await client.request({
              type: "chat.tool.update",
              chatId,
              streamId,
              toolCallId,
              status: "error",
              content: ASK_DENIED,
              metadata: {
                resolution: "deny",
                resolvedAt: new Date().toISOString(),
                output: ASK_DENIED,
              },
            });
          }
          if (outcome !== "approve") {
            collector.dropProposed(toolCallId);
            if (proposed) {
              await client.request({
                type: "chat.diff.upsert",
                chatId,
                streamId,
                diff: { ...toUpsertPayload(proposed), status: "rejected" },
              });
            }
          }
          return outcome;
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
        metadata: { streamId, checkpoint },
      },
      60_000,
    );
    await publishAppliedDiffs();
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
            content: sanitizeVisibleToolOutput(
              cwd,
              info.toolName,
              stringifyToolOutput(message),
            ),
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
    try {
      await publishAppliedDiffs();
    } catch {
      // connection already dead
    }
    try {
      const extraPaths: string[] = [];
      try {
        const applied = await collector.finalize();
        extraPaths.push(...applied.map((d) => d.path));
      } catch {
        // collector optional
      }
      checkpoint = await finalizeCheckpoint(cwd, checkpoint, {
        paths: extraPaths,
        hadBash,
      });
      await client.request({
        type: "chat.checkpoint.finalized",
        chatId,
        streamId,
        checkpoint,
      });
    } catch {
      try {
        checkpoint = emptyCheckpoint(streamId, "git_error");
        await client.request({
          type: "chat.checkpoint.finalized",
          chatId,
          streamId,
          checkpoint,
        });
      } catch {
        // connection already dead
      }
    }
    endTurnAbort(chatId);
    endTurn(chatId);
    cancelApprovalsForChat(chatId);
    try {
      await client.request({ type: "agent.turn.ended", chatId, streamId });
    } catch {
      // connection already dead
    }
  }
}
