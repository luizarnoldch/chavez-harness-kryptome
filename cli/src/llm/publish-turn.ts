import { apiFetch } from "../api-client";
import { isCiEnvironment } from "../ci/environment";
import { emitTurnBookends } from "../queue/bookends";
import type { ChavezWsClient, WsRequest } from "../ws/client";
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
import { buildAskMetadata } from "./ask-metadata";
import {
  parseExecutionMode,
  type ExecutionMode,
} from "./execution-mode";
import { selectRunner } from "./select-runner";
import { endTurn } from "./turn-control";
import {
  takeAbortReason,
  TURN_INTERRUPTED,
} from "./turn-abort";
import {
  beginTurnSession,
  endTurnSession,
  finalizeThinking,
  getTurnSession,
  onThinkingEvent,
  takeFollowUp,
  TURN_CANCELLED,
  type TurnSession,
} from "./turn-session";
import { isFetchSdkName } from "./web-fetch-constants";
import { fetchToolMetadata } from "./web-fetch-display";
import { formatAttachments, historyFromChatMessages } from "./history";
import {
  COMPACT_OVERFLOW_ERROR,
  isContextOverflowError,
} from "./context-budget";
import { applyCompact, usageFromPrompt } from "./compact-apply";
import type { ClaudeAuth } from "./claude-runner";
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
import { turnToolMetadata, turnUserMetadata } from "./turn-identity";
import { detectGit } from "./git-detect";
import { gitToolClass, parseGitSdkName } from "./git-names";
import { extractPrUrl } from "./git-pr";
import { userAskedToPublishReview } from "./review-parse";
import {
  applyRulesToCursorPrompt,
  loadTurnRules,
  type DispatchUserRule,
} from "./rules-inject";
import { extractPlanMarkdown, pendingApplyPlan } from "./plan-artifact";
import { resolveTurnPrompt, streamEndMetadata } from "./plan-turn";
import {
  USAGE_META_KIND,
  stripUsageSecrets,
} from "./usage-codec";
import {
  VERIFY_EXPLAIN_PROMPT,
  VERIFY_TIMEOUT_ERROR,
} from "./verify-constants";
import {
  VerifyTimeoutError,
  createTurnVerifyState,
  noteToolResult,
  noteToolStart,
  runPactIfNeeded,
  shouldExplain,
  stampSilentSuccess,
  watchdogTimedOut,
} from "./verify-turn";
import { loadSkillsFromDisk } from "./skills-load";
import { skillsMetadata } from "./skills-merge";
import type { McpServerRuntimeStatus } from "./mcp-constants";
import { SUBAGENT_MAX_PER_TURN } from "./subagent-constants";
import { createMemoryHttpApi } from "./memory-api";
import {
  formatMemoryPrompt,
  joinSystemPrompts,
  memoryMetadata,
  type MemoryRecord,
} from "./memory-format";
import type { PtyManager } from "../pty/manager";

export function streamEndPayload(input: {
  chatId: string;
  streamId: string;
  content: string;
  usageMeta: Record<string, unknown> | null;
}): Omit<WsRequest, "id"> {
  const req: Omit<WsRequest, "id"> = {
    type: "chat.stream.end",
    chatId: input.chatId,
    streamId: input.streamId,
    content: input.content,
  };
  if (input.usageMeta) req.metadata = input.usageMeta;
  return req;
}

type ProvidersResponse = {
  activeProvider: string | null;
  activeModel: string | null;
  activeEffort: string | null;
  activeParams?: Array<{ id: string; value: string }> | null;
  activeExecutionMode: string | null;
  lastRunnableExecutionMode?: string | null;
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

type UserSkill = {
  name: string;
  description: string;
  body: string;
  enabled: boolean;
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
  queueId?: string;
  mentions?: string[];
  attachments?: unknown[];
  retryOfStreamId?: string;
  executionMode?: ExecutionMode;
  planBrief?: string;
  signal?: AbortSignal;
  abortController?: AbortController;
  /** When signal aborts: defaults to takeAbortReason / TURN_INTERRUPTED */
  interruptReason?: string;
  userRules?: DispatchUserRule[];
  userRulesEnabled?: boolean;
  userSkills?: UserSkill[];
  source?: "ci";
  memories?: MemoryRecord[];
  workspaceId?: string | null;
  ptyManager?: PtyManager;
  ptyAllowed?: boolean;
  ownerConnectionId?: string;
  ci?: boolean;
}): Promise<string> {
  const { client, chatId, prompt, cwd, token } = input;
  const explicitPublish = userAskedToPublishReview(prompt);
  const ci = input.ci === true || input.source === "ci" || isCiEnvironment();
  const paths = mergeMentions(prompt, input.mentions ?? []);
  let attachments: HydratedAttachment[] = [];
  const ignoredAttaches: Array<{
    path?: string;
    error?: string;
    status?: string;
  }> = [];
  const attachNotices: string[] = [];

  const inFlight = new Map<
    string,
    {
      toolName: string;
      input?: unknown;
      metadata?: Record<string, unknown>;
    }
  >();
  let streamStarted = false;
  let streamId = crypto.randomUUID();
  const collector = new TurnDiffCollector(streamId, cwd);
  let diffsPublished = false;
  let seq = 1;
  let credsSecret = "";
  let hadBash = false;
  let checkpoint: Checkpoint = emptyCheckpoint(streamId, "git_error");
  let sess: TurnSession | null = null;
  let signal = input.signal ?? new AbortController().signal;
  let wasCancelled = false;
  let verifyTimedOut = false;
  let verifyWatchdog: ReturnType<typeof setInterval> | null = null;
  const timedOutVerifyTools = new Set<string>();
  const mcpStatuses = new Map<string, McpServerRuntimeStatus>();
  const activatedSkills = new Set<string>();
  const spawnedSubagents = new Set<string>();
  const subagentToolCalls = new Map<string, string>();

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

    const loaded = loadTurnRules({
      cwd,
      userRules: input.userRules,
      userRulesEnabled: input.userRulesEnabled,
    });
    const memoryApi = createMemoryHttpApi(token, input.workspaceId ?? null);
    const memories =
      input.memories ??
      (await memoryApi.list(input.workspaceId ?? null).catch(() => []));
    const memoryPrompt = formatMemoryPrompt(memories);
    const appendSystemPrompt = joinSystemPrompts(
      loaded.appendSystemPrompt,
      memoryPrompt,
    );
    let userSkills = input.userSkills;
    if (!userSkills) {
      try {
        const response = await apiFetch<{ skills?: UserSkill[] }>(
          "/skills",
          {},
          token,
        );
        userSkills = response.skills ?? [];
      } catch {
        userSkills = [];
      }
    }
    userSkills = userSkills.filter((skill) => skill.enabled);
    const skillsBundle = loadSkillsFromDisk(cwd, userSkills);
    const providers = await apiFetch<ProvidersResponse>("/providers", {}, token);
    const executionMode = parseExecutionMode(
      input.executionMode ?? providers.activeExecutionMode,
    );
    const verifyState = createTurnVerifyState({
      mode: executionMode,
      pactCommand: loaded.bundle.verifyCommand ?? null,
      prompt,
    });
    type DbRow = {
      id?: string;
      role?: string;
      content?: string;
      metadata?: Record<string, unknown> | null;
    };
    let planRow: { id?: string; content?: string | null } | null = null;
    try {
      const chatBefore = await client.request({ type: "chat.get", chatId });
      if (chatBefore.ok) {
        const preMessages =
          (chatBefore.data as { messages?: DbRow[] })?.messages ?? [];
        planRow = pendingApplyPlan(
          preMessages.map((m) => ({
            id: String(m.id || ""),
            content: m.content,
            metadata: m.metadata ?? null,
          })),
        );
      }
    } catch {
      // brief is best-effort; turn still runs
    }
    const resolved = resolveTurnPrompt({
      userPrompt: prompt,
      executionMode,
      planBrief: input.planBrief,
      pendingMarkdown: planRow?.content,
    });
    const userVisible = resolved.userVisible;
    const llmPrompt = resolved.llmPrompt;
    const planMarkdown = resolved.usedPlan
      ? String(input.planBrief || planRow?.content || "")
      : "";
    const runner = selectRunner(providers);
    const active = runner.kind;
    const activeModel = providers.activeModel;
    const identity = {
      streamId,
      provider: providers.activeProvider ?? active ?? "claude",
      modelId:
        providers.activeModel ||
        defaultModelId(active === "cursor" ? "cursor" : "claude") ||
        activeModel,
      effort: providers.activeEffort || null,
      executionMode:
        "activeExecutionMode" in providers
          ? (providers as { activeExecutionMode?: string | null }).activeExecutionMode ??
            executionMode
          : executionMode,
    };
    sess = beginTurnSession({
      chatId,
      streamId,
      provider: active === "cursor" ? "cursor" : "claude",
    });
    signal = sess.abort.signal;

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
        content: userVisible,
        metadata: turnUserMetadata(identity, {
          provider: active,
          model: activeModel,
          modelId: identity.modelId,
          executionMode,
          checkpoint,
          ...(planMarkdown
            ? {
                appliedPlanArtifactId: planRow?.id || true,
                kind: "plan_apply",
              }
            : {}),
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
          ...(input.source === "ci" ? { source: "ci", ci: true } : {}),
        }),
      });
      if (!userRes.ok) {
        throw new Error(userRes.error || "chat.append user failed");
      }
      if (planMarkdown) {
        try {
          await client.request({ type: "chat.plan.consume", chatId });
        } catch (err) {
          console.error(
            "chat.plan.consume failed",
            err instanceof Error ? err.message : err,
          );
        }
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
    let dbMessages = (chatRes.data as { messages?: DbRow[] })?.messages ?? [];
    let history = historyFromChatMessages(dbMessages, userVisible);
    const lastUser = [...dbMessages].reverse().find((m) => m.role === "user");
    const lastUserId = lastUser?.id ? String(lastUser.id) : undefined;
    const skipLines = attachNotices.map((n) => {
      if (/secret file/i.test(n)) return `[${n}]`;
      if (/vault/i.test(n)) return `[${n}]`;
      const m = /Ignored path \(not hydrated\): (.+) \((.+)\)/.exec(n);
      if (m) return `[Skipped ignored attach: ${m[1]} (${m[2]})]`;
      return `[${n}]`;
    });
    let currentAttachments = [
      ...skipLines,
      formatAttachments(
        (lastUser as { metadata?: Record<string, unknown> } | undefined)
          ?.metadata,
      ) || attachmentsPromptBlock(attachments),
    ]
      .filter((s) => s.trim())
      .join("\n");

    const providerId = providers.activeProvider || "claude";
    const modelIdForBudget =
      providers.activeModel ||
      defaultModelId(providerId) ||
      "claude-sonnet-4-6";
    let compactedThisTurn = false;
    let claudeAuth: ClaudeAuth | null = null;
    if (providers.providers?.claude?.linked) {
      try {
        const creds = await apiFetch<{
          authKind: "oauth_token" | "api_key";
          secret: string;
        }>("/providers/claude/credentials", {}, token);
        claudeAuth = { authKind: creds.authKind, secret: creds.secret };
        credsSecret = creds.secret;
      } catch {
        claudeAuth = null;
      }
    }

    const measure = () =>
      usageFromPrompt({
        prompt: llmPrompt,
        messages: dbMessages,
        modelId: modelIdForBudget,
        providerId,
      });

    let { usage } = measure();
    try {
      const reported = await client.request({
        type: "chat.context.report",
        chatId,
        metadata: usage as unknown as Record<string, unknown>,
      });
      void reported.ok;
    } catch {
      // Task 5 implements chat.context.report; unknown type must not abort the turn
    }

    async function compactOverflow() {
      const out = await applyCompact({
        client: client as never,
        chatId,
        cwd,
        trigger: "overflow",
        excludeMessageIds: lastUserId ? [lastUserId] : [],
        model: modelIdForBudget,
        providerId,
        auth: claudeAuth,
        llmEnabled: Boolean(claudeAuth),
        usedTokensBefore: usage.usedTokens,
      });
      compactedThisTurn = true;
      if (!out.skipped) {
        const reloaded = await client.request({ type: "chat.get", chatId });
        if (reloaded.ok) {
          dbMessages =
            (reloaded.data as { messages?: DbRow[] })?.messages ?? dbMessages;
          history = historyFromChatMessages(dbMessages, userVisible);
          const last = [...dbMessages].reverse().find((m) => m.role === "user");
          currentAttachments = [
            ...skipLines,
            formatAttachments(
              (last as { metadata?: Record<string, unknown> } | undefined)
                ?.metadata,
            ) || attachmentsPromptBlock(attachments),
          ]
            .filter((s) => s.trim())
            .join("\n");
        }
        usage = measure().usage;
        try {
          await client.request({
            type: "chat.context.report",
            chatId,
            metadata: usage as unknown as Record<string, unknown>,
          });
        } catch {
          // ignore
        }
      }
      return out;
    }

    if (usage.level === "critical" || usage.usedTokens > usage.budgetTokens) {
      await compactOverflow();
    }

    await emitTurnBookends(client, {
      chatId,
      streamId,
      queueId: input.queueId,
      phase: "start",
      metadata: { executionMode },
    });
    await client.request({
      type: "chat.stream.start",
      chatId,
      streamId,
    });
    streamStarted = true;

    let usageMeta: Record<string, unknown> | null = null;
    const modelForUsage =
      providers.activeModel ||
      defaultModelId(active === "cursor" ? "cursor" : "claude") ||
      "";

    verifyWatchdog = setInterval(() => {
      const hit = watchdogTimedOut(verifyState);
      if (!hit || verifyTimedOut) return;
      verifyTimedOut = true;
      timedOutVerifyTools.add(hit.toolCallId);
      noteToolResult(verifyState, {
        toolCallId: hit.toolCallId,
        sdkName: "Bash",
        output: VERIFY_TIMEOUT_ERROR,
        status: "error",
      });
      inFlight.delete(hit.toolCallId);
      void (async () => {
        try {
          await client.request({
            type: "chat.tool.result",
            chatId,
            streamId,
            toolCallId: hit.toolCallId,
            toolName: "bash",
            content: VERIFY_TIMEOUT_ERROR,
            status: "error",
            metadata: {
              timedOut: true,
              exitCode: 124,
              kind: hit.kind,
              command: hit.command,
              source: "agent",
              streamId,
            },
          });
        } finally {
          sess?.abort.abort();
        }
      })().catch(() => {
        sess?.abort.abort();
      });
    }, 1_000);

    const onEvent = async (ev: AgentTurnEvent) => {
      if (signal.aborted) return;
      onThinkingEvent(sess!, ev);
      if (ev.kind === "thinking_delta") {
        await client.request({
          type: "chat.thinking.delta",
          chatId,
          streamId,
          delta: ev.text,
        });
      }
      if (ev.kind === "thinking_omitted" || ev.kind === "thinking_end") {
        const fin = finalizeThinking(sess!.thinking);
        await client.request({
          type: "chat.thinking.end",
          chatId,
          streamId,
          metadata: {
            omitted: Boolean(fin?.omitted),
            durationMs: fin?.durationMs,
          },
        });
      }
      if (ev.kind === "usage") {
        try {
          const raw = stripUsageSecrets(ev.raw);
          if (raw) {
            usageMeta = {
              kind: USAGE_META_KIND,
              provider: ev.provider,
              modelId: modelForUsage,
              usage: raw,
            };
          }
        } catch {
          // usage is optional — never fail the turn
        }
        return;
      }
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
      if (ev.kind === "mcp_status") {
        for (const server of ev.servers) mcpStatuses.set(server.name, server);
        await client.request({
          type: "chat.mcp.status",
          chatId,
          streamId,
          metadata: { servers: ev.servers },
        });
      }
      if (ev.kind === "skill_activated") {
        activatedSkills.add(ev.name);
        const applied = skillsBundle.applied.find((s) => s.name === ev.name);
        await client.request({
          type: "chat.skill.activated",
          chatId,
          streamId,
          metadata: {
            name: ev.name,
            layer: applied?.layer ?? ev.layer,
            source: applied?.path ?? ev.source,
          },
        });
      }
      if (ev.kind === "subagent_start") {
        const alreadyStarted =
          spawnedSubagents.has(ev.subagentId) ||
          inFlight.has(ev.toolCallId);
        spawnedSubagents.add(ev.subagentId);
        subagentToolCalls.set(ev.subagentId, ev.toolCallId);
        if (alreadyStarted) return;
        inFlight.set(ev.toolCallId, {
          toolName: "subagent",
          input: {
            description: ev.description,
            agentType: ev.agentType,
          },
        });
        await client.request({
          type: "chat.subagent.start",
          chatId,
          streamId,
          toolCallId: ev.toolCallId,
          metadata: { ...ev, status: "running", kind: "subagent" },
        });
        await client.request({
          type: "chat.tool.start",
          chatId,
          streamId,
          toolCallId: ev.toolCallId,
          toolName: "subagent",
          content: ev.agentType,
          metadata: {
            kind: "subagent",
            subagentId: ev.subagentId,
            agentType: ev.agentType,
            description: ev.description,
            status: "running",
            input: {
              description: ev.description,
              agentType: ev.agentType,
            },
          },
        });
      }
      if (ev.kind === "subagent_update") {
        await client.request({
          type: "chat.subagent.update",
          chatId,
          streamId,
          metadata: { ...ev },
        });
      }
      if (ev.kind === "subagent_end") {
        const toolCallId =
          subagentToolCalls.get(ev.subagentId) ?? ev.subagentId;
        inFlight.delete(toolCallId);
        await client.request({
          type: "chat.subagent.end",
          chatId,
          streamId,
          metadata: { ...ev },
        });
        await client.request({
          type: "chat.tool.result",
          chatId,
          streamId,
          toolCallId,
          toolName: "subagent",
          content: ev.summary,
          status: ev.status === "done" ? "done" : "error",
          metadata: {
            kind: "subagent",
            subagentId: ev.subagentId,
            status: ev.status,
          },
        });
      }
      if (ev.kind === "child_tool") {
        await client.request({
          type: "chat.subagent.update",
          chatId,
          streamId,
          metadata: { ...ev },
        });
      }
      if (ev.kind === "capability_degraded") {
        await client.request({
          type: "chat.capability.degraded",
          chatId,
          streamId,
          content: ev.message,
          metadata: {
            provider: ev.provider,
            feature: ev.feature,
            name: ev.name,
          },
        });
      }
      if (ev.kind === "tool_start") {
        if (ev.toolName === "Bash" || ev.toolName === "bash") hadBash = true;
        if (inFlight.has(ev.toolCallId)) return;
        inFlight.set(ev.toolCallId, {
          toolName: ev.toolName,
          input: ev.input,
          metadata: ev.metadata,
        });
        const sdkName = ev.toolName;
        const name = canonicalToolName(sdkName);
        const classified = noteToolStart(verifyState, {
          toolCallId: ev.toolCallId,
          sdkName,
          input: ev.input,
        });
        const fetchMeta = isFetchSdkName(sdkName)
          ? fetchToolMetadata(
              sdkName,
              (ev.input as Record<string, unknown> | null) ?? null,
              "running",
            )
          : null;
        await client.request({
          type: "chat.tool.start",
          chatId,
          streamId,
          toolCallId: ev.toolCallId,
          toolName: name,
          content: toolHeadline(sdkName, "running", ev.input),
          metadata: turnToolMetadata(identity, {
            sdkName,
            input: redactJson(sanitizeToolInput(ev.input)),
            summary: summarizeToolInput(sdkName, ev.input),
            command: classified.command,
            source: "agent",
            ...ev.metadata,
            kind:
              fetchMeta?.kind ??
              ev.metadata?.kind ??
              (classified.kind === "write" || classified.kind === "read"
                ? undefined
                : classified.kind),
            ...(fetchMeta
              ? {
                  url: fetchMeta.url,
                  needsNetwork: true,
                  prompt: fetchMeta.prompt,
                  toolName: "fetch",
                }
              : {}),
          }),
        });
      }
      if (ev.kind === "tool_result") {
        if (timedOutVerifyTools.has(ev.toolCallId)) return;
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
        const verification = noteToolResult(verifyState, {
          toolCallId: ev.toolCallId,
          sdkName,
          input: toolInput,
          output,
          status: ev.status,
        });
        const resultStatus =
          verification &&
          (verification.exitCode !== 0 || verification.timedOut)
            ? "error"
            : ev.status === "error"
              ? "error"
              : "done";
        const prUrl =
          canonicalToolName(sdkName) === "git_pr" ? extractPrUrl(output) : null;
        const fetchDone = isFetchSdkName(sdkName)
          ? fetchToolMetadata(
              sdkName,
              toolInput,
              resultStatus === "error" ? "error" : "done",
              output,
            )
          : null;
        await client.request({
          type: "chat.tool.result",
          chatId,
          streamId,
          toolCallId: ev.toolCallId,
          toolName: canonicalToolName(sdkName),
          content: output,
          status: resultStatus,
          metadata: {
            output,
            input: redactJson(sanitizeToolInput(prev?.input)),
            streamId,
            ...(verification
              ? {
                  kind: verification.kind,
                  command: verification.command,
                  source: verification.source,
                  exitCode: verification.exitCode,
                  timedOut: verification.timedOut,
                  truncated: verification.truncated,
                }
              : {}),
            ...(prUrl ? { prUrl } : {}),
            ...prev?.metadata,
            ...ev.metadata,
            ...(fetchDone
              ? {
                  kind: "fetch",
                  url: fetchDone.url,
                  needsNetwork: true,
                  truncated: fetchDone.truncated,
                  toolName: "fetch",
                }
              : {}),
          },
        });
        if (verification?.timedOut) throw new VerifyTimeoutError();
      }
    };

    const runTurn = async (
      turnPrompt = llmPrompt,
      turnHistory = history,
      usePromptStream = true,
    ): Promise<string> => {
    if (active === "claude") {
      if (!claudeAuth) {
        const creds = await apiFetch<{
          authKind: "oauth_token" | "api_key";
          secret: string;
        }>("/providers/claude/credentials", {}, token);
        claudeAuth = { authKind: creds.authKind, secret: creds.secret };
        credsSecret = creds.secret;
      }
      if (!claudeAuth) {
        throw new Error("Claude credentials missing");
      }
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

      const claudeResult = await runClaudeTurn({
        prompt: turnPrompt,
        history: turnHistory,
        model,
        effort,
        auth: claudeAuth,
        cwd,
        attachments,
        attachmentsText: currentAttachments,
        abortController: sess!.abort,
        promptStream: usePromptStream ? sess!.promptStream : undefined,
        executionMode,
        collector,
        appendSystemPrompt,
        memories,
        memoryApi,
        workspaceId: input.workspaceId ?? null,
        verifyPactCommand: loaded.bundle.verifyCommand,
        rulesBundle: loaded.bundle,
        userSkills,
        chatId,
        ptyManager: input.ptyManager,
        ptyAllowed:
          Boolean(input.ptyManager) &&
          input.ptyAllowed !== false &&
          !ci,
        ownerConnectionId: input.ownerConnectionId,
        ci,
        getGitHubToken: () => getGitHubToken(token),
        explicitPublish,
        onAskPermission: async ({
          toolCallId,
          toolName,
          input: toolInput,
          signal,
          proposed,
          needsNetwork,
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
            { branch, needsNetwork: Boolean(needsNetwork) },
          );
          if (!prompt) {
            return "approve";
          }
          const name = canonicalToolName(toolName);
          const metadata = buildAskMetadata({
            toolName,
            toolInput,
            executionMode,
            needsNetwork: Boolean(needsNetwork),
            streamId,
            approvalDeadline: deadline,
            remainingMs: ASK_APPROVAL_TIMEOUT_MS,
            proposedPreview,
            branch,
            proposedDiff: proposed
              ? toUpsertPayload(proposed)
              : prompt.kind === "write" || prompt.kind === "edit"
                ? { path: prompt.path, preview: prompt.diff, kind: prompt.kind }
                : undefined,
          });
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
      return claudeResult;
    }
      const creds = await apiFetch<{
        authKind: "api_key" | "oauth_token";
        secret: string;
      }>("/providers/cursor/credentials", {}, token);
      credsSecret = creds.secret;
      const model = providers.activeModel;
      if (!model) {
        throw new Error(CURSOR_NOT_RUNNABLE);
      }
      return await runCursorTurn({
        prompt: applyRulesToCursorPrompt(turnPrompt, loaded.appendSystemPrompt),
        history: turnHistory,
        model,
        params: providers.activeParams ?? [],
        auth: { authKind: "api_key", secret: creds.secret },
        cwd,
        signal,
        executionMode,
        userSkills,
        memoryApi,
        workspaceId: input.workspaceId ?? null,
        memories,
        onEvent,
        onRunReady: (handle) => {
          const current = getTurnSession(chatId);
          if (!current) return;
          current.cursorCancel = handle.cancel;
          current.cursorSteer = handle.steer;
        },
      });
    };

    let result: string;
    try {
      result = await runTurn();
    } catch (err) {
      if (isContextOverflowError(err) && !compactedThisTurn) {
        await compactOverflow();
        try {
          result = await runTurn();
        } catch (err2) {
          if (isContextOverflowError(err2)) {
            throw new Error(COMPACT_OVERFLOW_ERROR);
          }
          throw err2;
        }
      } else if (isContextOverflowError(err)) {
        throw new Error(COMPACT_OVERFLOW_ERROR);
      } else {
        throw err;
      }
    }
    if (sess.abort.signal.aborted) throw new Error(TURN_CANCELLED);

    const pact = await runPactIfNeeded(verifyState, cwd);
    if (pact.meta && !verifyState.last) verifyState.last = pact.meta;
    if (pact.ran && pact.result && pact.meta) {
      hadBash = true;
      const pactId = `verify-pact-${streamId}`;
      await client.request({
        type: "chat.tool.start",
        chatId,
        streamId,
        toolCallId: pactId,
        toolName: "bash",
        content: "bash",
        metadata: {
          sdkName: "Bash",
          kind: "verify",
          command: verifyState.pactCommand,
          source: "pact",
          input: { command: verifyState.pactCommand },
          summary: verifyState.pactCommand,
          streamId,
        },
      });
      await client.request({
        type: "chat.tool.result",
        chatId,
        streamId,
        toolCallId: pactId,
        toolName: "bash",
        content: pact.result.combined,
        status: pact.meta.timedOut || !pact.result.ok ? "error" : "done",
        metadata: {
          kind: "verify",
          command: verifyState.pactCommand,
          source: "pact",
          exitCode: pact.result.exitCode,
          timedOut: pact.result.timedOut,
          truncated: pact.result.truncated,
          output: pact.result.combined,
          streamId,
        },
      });
      if (pact.meta.timedOut) throw new VerifyTimeoutError();
    }

    if (shouldExplain(verifyState, result)) {
      verifyState.continuations += 1;
      const refreshed = await client.request({ type: "chat.get", chatId });
      const refreshedMessages = refreshed.ok
        ? ((refreshed.data as { messages?: DbRow[] })?.messages ?? dbMessages)
        : dbMessages;
      const explainHistory = historyFromChatMessages(
        refreshedMessages,
        VERIFY_EXPLAIN_PROMPT,
      );
      result = await runTurn(VERIFY_EXPLAIN_PROMPT, explainHistory, false);
      if (sess.abort.signal.aborted) throw new Error(TURN_CANCELLED);
    }

    const content = redactText(
      executionMode === "plan"
        ? extractPlanMarkdown(result) || result
        : result,
    );
    const planMeta = streamEndMetadata(executionMode);
    const endMeta: Record<string, unknown> = {
      streamId: identity.streamId,
      provider: identity.provider,
      modelId: identity.modelId,
      checkpoint,
      rules: loaded.metadata,
      memory: memoryMetadata(memories),
      thinking: finalizeThinking(sess.thinking),
      mcp: {
        failed: [...mcpStatuses.values()]
          .filter((server) => server.status === "failed")
          .map((server) => server.name),
        connected: [...mcpStatuses.values()]
          .filter((server) => server.status === "connected")
          .map((server) => server.name),
      },
      skills: skillsMetadata(skillsBundle, [...activatedSkills]),
      subagents: {
        spawned: spawnedSubagents.size,
        max: SUBAGENT_MAX_PER_TURN,
      },
      ...planMeta,
    };
    const verification = stampSilentSuccess(verifyState, result);
    if (verification) endMeta.verification = verification;
    const finalUsageMeta = usageMeta as Record<string, unknown> | null;
    if (finalUsageMeta) {
      endMeta.provider = finalUsageMeta.provider ?? identity.provider;
      endMeta.modelId = finalUsageMeta.modelId ?? identity.modelId;
      endMeta.usage = finalUsageMeta.usage;
      // Preserve plan_artifact kind; aggregation still finds usage via usageBlobFromMeta
      if (endMeta.kind == null) endMeta.kind = USAGE_META_KIND;
    }
    const endPayload = streamEndPayload({
      chatId,
      streamId,
      content,
      usageMeta: Object.keys(endMeta).length ? endMeta : null,
    });
    endPayload.status = "finished";
    await client.request(endPayload, 60_000);
    await publishAppliedDiffs();
    return result;
  } catch (err) {
    const aborted = Boolean(sess?.abort.signal.aborted);
    const isVerifyTimeout = verifyTimedOut || err instanceof VerifyTimeoutError;
    const raw = isVerifyTimeout
      ? VERIFY_TIMEOUT_ERROR
      : aborted
        ? (input.interruptReason ??
          takeAbortReason(chatId) ??
          TURN_INTERRUPTED)
        : err instanceof Error
          ? err.message
          : String(err);
    const message =
      credsSecret && raw.includes(credsSecret)
        ? raw.split(credsSecret).join("***")
        : raw;
    wasCancelled =
      !isVerifyTimeout &&
      (message === TURN_CANCELLED ||
        (aborted && message !== TURN_INTERRUPTED));
    if (streamStarted) {
      for (const [toolCallId, info] of inFlight) {
        if (wasCancelled) collector.dropProposed(toolCallId);
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
      try {
        if (wasCancelled) {
          cancelApprovalsForChat(chatId);
          await client.request({
            type: "chat.stream.end",
            chatId,
            streamId,
            status: "cancelled",
            content: sess?.assistantText || TURN_CANCELLED,
            metadata: {
              thinking: finalizeThinking(sess?.thinking ?? null),
              status: "cancelled",
            },
          });
        } else {
          await client.request({
            type: "chat.stream.error",
            chatId,
            streamId,
            content: message,
          });
        }
      } catch {
        // WS down — API sweep already broadcast TURN_INTERRUPTED
      }
    }
    throw new Error(message);
  } finally {
    if (verifyWatchdog) clearInterval(verifyWatchdog);
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
    const follow =
      sess && !sess.abort.signal.aborted ? takeFollowUp(chatId) : null;
    if (sess) endTurnSession(chatId);
    endTurn(chatId);
    cancelApprovalsForChat(chatId);
    // Enqueue follow-up via API queue before ended so drain owns the next turn
    // (no recursive publishAgentTurn — queue drain is the only dispatcher).
    if (follow) {
      try {
        await client.request({
          type: "agent.turn.request",
          chatId,
          prompt: follow.text,
        });
      } catch {
        // connection already dead
      }
    }
    await emitTurnBookends(client, {
      chatId,
      streamId,
      queueId: input.queueId,
      phase: "end",
      status: wasCancelled ? "cancelled" : "finished",
    });
  }
}
