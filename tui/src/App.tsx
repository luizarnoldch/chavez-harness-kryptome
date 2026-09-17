import React, { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { ChavezWsClient } from "../../cli/src/ws/client";
import { apiFetch } from "../../cli/src/api-client";
import {
  completeWorkspace,
  type FsCandidate,
} from "../../cli/src/llm/fs-complete";
import { listWorkspaceDir } from "../../cli/src/llm/fs-tree";
import { searchWorkspace } from "../../cli/src/llm/fs-search";
import { previewFile } from "../../cli/src/llm/fs-preview";
import {
  cycleExecutionMode,
  parseExecutionMode,
  type ExecutionMode,
} from "../../cli/src/llm/execution-mode";
import { handleToolResolutionPush } from "../../cli/src/llm/handle-tool-resolution";
import {
  ALREADY_RESOLVED_ERROR,
  APPROVAL_COUNTDOWN_TICK_MS,
  NO_APPROVAL_ERROR,
} from "../../cli/src/llm/approval-constants";
import {
  formatRemaining,
  remainingApprovalMs,
} from "../../cli/src/llm/approval-deadline";
import {
  formatApprovalHeadline,
  type ApprovalPrompt,
} from "../../cli/src/llm/approval-prompt";
import {
  NETWORK_REQUEST_LABEL,
  bannerNeedsNetwork,
} from "../../cli/src/llm/network-constants";
import { publishAgentTurn } from "../../cli/src/llm/publish-turn";
import { TUI_REPLAY_HINT } from "../../cli/src/llm/turn-replay";
import {
  TUI_EXPORT_HINT,
} from "../../cli/src/chats/export-share";
import {
  isReplayReadOnlyKey,
  replayEscapeCloses,
} from "./replay-overlay";
import {
  NO_PROVIDER_ASK,
  type OnboardingSnapshot,
} from "../../cli/src/onboarding/status";
import { formatOnboardingHint } from "../../cli/src/onboarding/print";
import { applyCompact } from "../../cli/src/llm/compact-apply";
import { handleCompactDispatch } from "../../cli/src/llm/compact-dispatch";
import {
  COMPACT_MARKER_KIND,
  formatContextBanner,
  type ContextUsage,
} from "../../cli/src/llm/context-budget";
import type { DispatchUserRule } from "../../cli/src/llm/rules-inject";
import { handleUndoDispatch } from "../../cli/src/llm/run-undo";
import { abortAllTurns } from "../../cli/src/llm/turn-abort";
import {
  cancelSession,
  steerSession,
} from "../../cli/src/llm/turn-session";
import { STEER_KIND } from "../../cli/src/llm/steer";
import {
  thinkingFromMetadata,
  THINKING_COLLAPSED_LABEL,
  THINKING_OMITTED_LABEL,
  truncateThinkingPreview,
} from "../../cli/src/llm/thinking";
import {
  DAEMON_STANDBY_NOTE,
  HEARTBEAT_INTERVAL_MS,
} from "../../cli/src/ws/presence-constants";
import {
  shouldShowTuiBadge,
} from "../../cli/src/notifications/classify";
import {
  emptyNotificationState,
  hasApproval,
  hasDaemonDown,
  markChatRead,
  reduceNotification,
  type NotificationState,
} from "../../cli/src/notifications/store";
import {
  APPROVAL_LABEL,
  NO_RUNNER_LABEL,
} from "../../cli/src/notifications/constants";
import { hydrateFromMessages } from "../../cli/src/notifications/hydrate";
import { randomUUID } from "node:crypto";
import {
  NO_GIT_UI,
  TURN_BUSY_ERROR,
  UNDO_ALREADY,
  UNDO_NOOP,
  UNDO_REQUIRES_GIT,
} from "../../cli/src/llm/undo-constants";
import {
  QUEUE_DONE_LABEL,
  QUEUE_PROMOTED_LABEL,
  TUI_COMPOSE_WHILE_BUSY,
  TUI_QUEUED_HINT,
} from "../../cli/src/queue/constants";
import type { QueueSnapshot } from "../../cli/src/queue/model";
import {
  formatQueueBadge,
  isQueuedMessage,
  lastQueuedIdForChat,
} from "./queue-view";
import { canUndoLastTurn } from "../../cli/src/llm/turn-select";
import {
  applyStreamDelta,
  mergeTimeline,
  shouldShowLiveAssistant,
  type TimelineMessage,
} from "../../cli/src/llm/timeline";
import {
  formatChatUsage,
  formatTurnUsageLine,
  NO_USAGE_TEXT,
} from "../../cli/src/llm/usage-codec";
import { toolHeadline } from "../../cli/src/llm/tool-display";
import { canonicalToolName } from "../../cli/src/llm/tool-names";
import { NO_DAEMON_ERROR } from "../../cli/src/llm/mcp-constants";
import type { SkillsSnapshot } from "../../cli/src/llm/skills-constants";
import { NOT_A_GIT_UI } from "../../cli/src/llm/git-constants";
import { collectDiffVsHead } from "../../cli/src/llm/git-diff-head";
import { type GitSnapshot } from "../../cli/src/llm/git-format";
import { runGitAction, type GitRpcAction } from "../../cli/src/llm/handle-git-rpc";
import { collectGitSnapshot } from "../../cli/src/llm/git-status";
import { extractPrUrl } from "../../cli/src/llm/git-pr";
import {
  loadLocalRules,
  loadProjectRules,
  localMachineRulesPath,
  writeLocalMachineRules,
} from "../../cli/src/llm/rules-load";
import { ensureLocalRulesGitExcluded } from "../../cli/src/llm/rules-git-exclude";
import {
  rulesWatchLine,
  toRuleRef,
  type RuleRef,
  type RulesMetadata,
} from "../../cli/src/llm/rules-merge";
import {
  readWorkspaceState,
  workspaceHash,
  writeWorkspaceState,
} from "../../cli/src/workspace";
import { handleWorktreeRpc } from "../../cli/src/llm/handle-worktree-rpc";
import { initEffectiveCwd } from "../../cli/src/llm/effective-cwd";
import {
  addWorktree,
  collectWorktreeSnapshot,
  getBindPath,
  getEffectiveCwd,
  selectWorktree,
} from "../../cli/src/llm/worktree";
import {
  TUI_WORKTREE_HINT,
  WEB_WORKTREE_BADGE,
  WORKTREE_NO_GIT_UI,
} from "../../cli/src/llm/worktree-constants";
import type { WorktreeSnapshot } from "../../cli/src/llm/worktree-model";
import { formatDaemonCwdLabel } from "../../cli/src/llm/worktree-parse";
import {
  defaultEffort,
  defaultModelId,
  getModel,
  type EffortLevel,
} from "../../cli/src/llm/catalog";
import { clampCursorParams } from "../../cli/src/llm/catalog-codec";
import type { CursorModelInfo, CursorParamSelection } from "../../cli/src/llm/cursor-types";
import {
  composerTrigger,
  isSlashInput,
  slashPickerItems,
  type SlashPickItem,
} from "../../cli/src/llm/slash";
import { liveSlashIo } from "../../cli/src/llm/slash-io-live";
import { runSlash } from "../../cli/src/llm/slash-run";
import {
  asPlanMeta,
  isPlanArtifact,
  PLAN_APPLIED_EVENT,
  PLAN_CREATED_EVENT,
  PLAN_CURRENT_EVENT,
  PLAN_STATUS_CURRENT,
  PLAN_UPDATED_EVENT,
} from "../../cli/src/llm/plan-artifact";
import { env } from "./lib/config";
import { VERIFY_TIMEOUT_ERROR } from "../../cli/src/llm/verify-constants";
import {
  assistantVerificationLine,
  toolLine,
  verificationFailureLog,
} from "./verify-line";
import {
  formatTuiToolLine,
  indentIfChild,
  mcpFailedBanner,
} from "./tool-line";
import {
  ARCHIVE_LABEL,
  AUTOTITLE_PENDING_HINT,
  CHAT_UPDATED_EVENT,
  DEFAULT_CHAT_TITLE,
  NO_SEARCH_MATCHES,
  QUERY_TOO_SHORT,
  SEARCH_PLACEHOLDER,
  SHOW_ARCHIVED_LABEL,
  UNARCHIVE_LABEL,
  compareChatsForList,
  displayChatTitle,
  normalizeTitleInput,
  visibleChats,
  type ChatOrgFields,
} from "../../cli/src/chats/org";

type CursorParam = { id: string; value: string };
type AnyModel = {
  id: string;
  label?: string;
  displayName?: string;
  effortLevels?: string[];
  inputPricePerMTok?: number;
  outputPricePerMTok?: number;
  parameters?: Array<{
    id: string;
    displayName?: string;
    values: Array<{ value: string; displayName?: string }>;
  }>;
};

function modelLabel(m: AnyModel | undefined, fallback: string): string {
  return m?.displayName ?? m?.label ?? m?.id ?? fallback;
}

function asCursorModel(m: AnyModel | undefined): CursorModelInfo | undefined {
  if (!m) return undefined;
  return m as CursorModelInfo;
}

function defaultParamsForModel(model: AnyModel | undefined): CursorParam[] {
  const cm = asCursorModel(model);
  if (!cm) return [];
  return clampCursorParams(cm, []);
}

function cycleCursorParam(
  model: AnyModel | undefined,
  current: CursorParam[],
  dir: 1 | -1,
): CursorParam[] {
  const params = model?.parameters ?? [];
  const primary =
    params.find((p) => p.id === "optimize_for") ?? params[0];
  if (!primary?.values.length) return current;
  const values = primary.values.map((v) => v.value);
  const have =
    current.find((p) => p.id === primary.id)?.value ?? values[0]!;
  const nextVal = cycle(values, have, dir);
  const rest = current.filter((p) => p.id !== primary.id);
  return [...rest, { id: primary.id, value: nextVal }];
}

function formatParams(params: CursorParam[] | null | undefined): string {
  if (!params?.length) return "—";
  return params.map((p) => `${p.id}=${p.value}`).join(",");
}

type Session = { id: string; title: string };
type Chat = ChatOrgFields & { sessionId: string };
type Message = TimelineMessage & {
  metadata?: Record<string, unknown> | null;
};
type ListFocus = "sessions" | "chats";

function rulesSnapshotForCwd(cwd: string) {
  const project = loadProjectRules(cwd).map(toRuleRef);
  const local = loadLocalRules(cwd).map(toRuleRef);
  const machine = localMachineRulesPath(cwd);
  let localContent = "";
  try {
    localContent = existsSync(machine) ? readFileSync(machine, "utf8") : "";
  } catch {
    localContent = "";
  }
  return {
    project,
    local,
    localContent,
    localPath: `~/.chavez/workspaces/${workspaceHash(cwd)}/rules.local.md`,
  };
}

type TurnDiff = {
  id: string;
  streamId: string;
  path: string;
  kind: "created" | "modified" | "deleted" | string;
  status: string;
  additions: number;
  deletions: number;
  preview: string;
  truncated?: boolean;
  binary?: boolean;
  omitted?: boolean;
};

function activeMention(text: string): { start: number; query: string } | null {
  const at = text.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0 && /[A-Za-z0-9_]/.test(text[at - 1]!)) return null;
  const rest = text.slice(at + 1);
  if (/\s/.test(rest)) return null;
  return { start: at, query: rest };
}

function upsertMessage(prev: Message[], incoming: Message): Message[] {
  const i = prev.findIndex((m) => m.id === incoming.id);
  if (i >= 0) {
    const next = prev.slice();
    next[i] = incoming;
    return next;
  }
  return [...prev, incoming];
}

function firstAwaiting(list: Message[]): Message | undefined {
  return list.find((m) => {
    const meta = (m.metadata || {}) as Record<string, unknown>;
    const sdk = String(meta.sdkName || "");
    if (sdk === "Read" || sdk === "Grep" || sdk === "Glob" || sdk === "LS") {
      return false;
    }
    return (
      m.role === "tool" &&
      meta.status === "awaiting_approval" &&
      !meta.resolution &&
      meta.toolCallId
    );
  });
}

function formatTuiMessage(
  m: Message,
  childDepth = 0,
): { color: string; text: string } {
  if (isPlanArtifact(m.metadata)) {
    const meta = asPlanMeta(m.metadata)!;
    const current = meta.status === PLAN_STATUS_CURRENT;
    const title =
      (m.content || "").split("\n").find((l) => l.trim()) || "(plan)";
    return {
      color: current ? "cyan" : "blue",
      text: `${current ? "plan · current" : "plan · history"}${
        meta.pendingApply ? " · apply-next" : ""
      } r${meta.revision}: ${title.replace(/\s+/g, " ").slice(0, 90)}`,
    };
  }
  if ((m.metadata as { kind?: string } | null)?.kind === COMPACT_MARKER_KIND) {
    return { color: "cyan", text: "system: contexto compactado" };
  }
  if ((m.metadata as { kind?: string } | null)?.kind === "slash_result") {
    return {
      color: "yellow",
      text: `slash: ${m.content.replace(/\s+/g, " ").slice(0, 100)}`,
    };
  }
  if (
    (m.metadata as { kind?: string } | null)?.kind ===
    "capability_degraded"
  ) {
    const meta = (m.metadata || {}) as Record<string, unknown>;
    return {
      color: "yellow",
      text: `degraded · ${String(meta.feature || "skill")} · ${m.content}`,
    };
  }
  if (m.role === "tool") {
    const meta = (m.metadata || {}) as Record<string, unknown>;
    const kind = String(meta.kind || "");
    if (kind === "verify" || kind === "lint") {
      const status = String(meta.status || "running");
      let text = toolLine(m);
      for (let depth = 0; depth < childDepth; depth += 1) {
        text = indentIfChild(text, meta.parentToolCallId);
      }
      return {
        color: status === "error" ? "red" : "cyan",
        text,
      };
    }
    const sdkName = String(meta.sdkName || meta.toolName || "tool");
    const status = String(meta.status || "running");
    const color =
      status === "error" || status === "failed"
        ? "red"
        : status === "done"
          ? "cyan"
          : status === "awaiting_approval"
            ? "magenta"
            : "yellow";
    const resolved = meta.resolution
      ? ` · ${ALREADY_RESOLVED_ERROR}`
      : "";
    let text = formatTuiToolLine(
      meta,
      `${toolHeadline(sdkName, status, meta.input)}${resolved}`,
    );
    for (let depth = 0; depth < childDepth; depth += 1) {
      text = indentIfChild(text, meta.parentToolCallId);
    }
    return { color, text };
  }
  const modeTag =
    m.role === "user" &&
    typeof (m.metadata as Record<string, unknown> | null)?.executionMode ===
      "string"
      ? ` [${(m.metadata as Record<string, unknown>).executionMode}]`
      : "";
  const undone =
    m.metadata && (m.metadata as { undone?: boolean }).undone ? " [undone]" : "";
  const cancelled =
    m.metadata && (m.metadata as { status?: unknown }).status === "cancelled"
      ? " [cancelled]"
      : "";
  const queuedPrefix = isQueuedMessage(m.metadata) ? "[queued] " : "";
  return {
    color: m.role === "assistant" ? "green" : "magenta",
    text: `${queuedPrefix}${m.role}${cancelled}${undone}${modeTag}: ${m.content.replace(/\s+/g, " ").slice(0, 100)}${
      m.role === "user" ? formatAttachSuffix(m) : ""
    }`,
  };
}

function formatAttachSuffix(m: Message): string {
  const atts = Array.isArray(
    (m.metadata as { attachments?: unknown } | null)?.attachments,
  )
    ? (m.metadata as { attachments: Array<Record<string, unknown>> }).attachments
    : [];
  if (!atts.length) return "";
  return (
    " " +
    atts
      .map((a) => {
        const p = String(a.path || "");
        if (a.status === "ignored" || a.status === "secret" || a.status === "vault") {
          return `[@${p} ${a.status}]`;
        }
        if (a.kind === "image") return `[@${p} imagen]`;
        if (a.kind === "directory") return `[@${p} dir]`;
        if (a.kind === "binary") return `[@${p} binario]`;
        return `[@${p}]`;
      })
      .join(" ")
  );
}

function ignoredAttachLines(m: Message): string[] {
  const meta = (m.metadata || {}) as {
    attachments?: Array<{ path?: string; status?: string; error?: string }>;
    ignoredAttaches?: Array<{ path?: string; error?: string }>;
  };
  const items = [
    ...(meta.attachments || []).filter(
      (a) => a.status === "ignored" || a.status === "secret" || a.status === "vault",
    ),
    ...(meta.ignoredAttaches || []),
  ];
  return items.map(
    (a) => a.error || `Ignored path (not hydrated): ${a.path}`,
  );
}

type ProvidersResponse = {
  activeProvider: string | null;
  activeModel: string | null;
  activeEffort: string | null;
  activeParams?: CursorParam[] | null;
  activeExecutionMode: string | null;
  providers: Record<
    string,
    {
      linked: boolean;
      authKind?: string;
      label?: string;
      runnable?: boolean;
      catalogError?: string | null;
      models?: AnyModel[];
    }
  >;
};

const LIST_WINDOW = 12;

function cycle<T>(items: T[], current: T, dir: 1 | -1): T {
  if (!items.length) return current;
  const idx = Math.max(0, items.indexOf(current));
  return items[(idx + dir + items.length) % items.length];
}

function clampIndex(i: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(i, length - 1));
}

type WorktreePanel = {
  open: boolean;
  snapshot: WorktreeSnapshot | null;
  error: string | null;
  creating: boolean;
  newBranch: string;
};

function visibleWindow<T>(
  items: T[],
  cursor: number,
  size = LIST_WINDOW,
): { slice: T[]; offset: number } {
  if (items.length <= size) return { slice: items, offset: 0 };
  let start = Math.max(0, cursor - Math.floor(size / 2));
  start = Math.min(start, items.length - size);
  return { slice: items.slice(start, start + size), offset: start };
}

export function App() {
  const { exit } = useApp();
  const cwd = env.public.chavezCwd;
  const token = env.server.accessToken;
  const [status, setStatus] = useState<
    "connecting" | "bound" | "reconnecting" | "error"
  >("connecting");
  const [error, setError] = useState<string | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [chats, setChats] = useState<Chat[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [findMode, setFindMode] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findHits, setFindHits] = useState<Chat[]>([]);
  const [renameMode, setRenameMode] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [notices, setNotices] = useState<NotificationState>(emptyNotificationState);
  const noticesRef = useRef(notices);
  noticesRef.current = notices;
  const [messages, setMessages] = useState<Message[]>([]);
  const [chatUsage, setChatUsage] = useState<string>("");
  const [diffs, setDiffs] = useState<TurnDiff[]>([]);
  const [expandDiffs, setExpandDiffs] = useState(false);
  const [listFocus, setListFocus] = useState<ListFocus>("sessions");
  const [sessionCursor, setSessionCursor] = useState(0);
  const [chatCursor, setChatCursor] = useState(0);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<"command" | "compose">("command");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerItems, setPickerItems] = useState<FsCandidate[]>([]);
  const [pickerIndex, setPickerIndex] = useState(0);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashItems, setSlashItems] = useState<SlashPickItem[]>([]);
  const [slashIndex, setSlashIndex] = useState(0);
  const [client, setClient] = useState<ChavezWsClient | null>(null);
  const [log, setLog] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<"chat" | "replay">("chat");
  const [replayText, setReplayText] = useState<string>("");
  const [replayErr, setReplayErr] = useState<string | null>(null);
  type ExportOverlay = {
    markdown: string;
    url: string | null;
    status: string;
    chatId: string;
  } | null;
  const [exportOverlay, setExportOverlay] = useState<ExportOverlay>(null);
  const [queueSnap, setQueueSnap] = useState<QueueSnapshot | null>(null);
  const [steerCompose, setSteerCompose] = useState(false);
  const [contextBanner, setContextBanner] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [resolveMsg, setResolveMsg] = useState<string | null>(null);
  const [daemonRole, setDaemonRole] = useState<"primary" | "standby" | null>(
    null,
  );
  const [daemonHostname, setDaemonHostname] = useState("");
  const [lastSeen, setLastSeen] = useState<string | null>(null);
  const daemonIdRef = useRef<string>("");
  const [streamText, setStreamText] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [thinkingLive, setThinkingLive] = useState("");
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const [steerDraft, setSteerDraft] = useState("");
  const streamIdRef = useRef<string | null>(null);
  const deltaStateRef = useRef({ nextSeq: 1, buffer: new Map<number, string>() });
  const turnBusyRef = useRef(false);
  const dispatchChainRef = useRef(Promise.resolve());

  const [provider, setProvider] = useState<"claude" | "cursor">("claude");
  const [modelId, setModelId] = useState<string>("claude-sonnet-4-6");
  const [effort, setEffort] = useState<EffortLevel>("medium");
  const [activeParams, setActiveParams] = useState<CursorParam[]>([]);
  const [executionMode, setExecutionMode] = useState<ExecutionMode>("ask");
  const [userRules, setUserRules] = useState<DispatchUserRule[]>([]);
  const [userRulesEnabled, setUserRulesEnabled] = useState(true);
  const [rulesOverlay, setRulesOverlay] = useState(false);
  const [skillsOverlay, setSkillsOverlay] = useState<{
    open: boolean;
    snapshot: SkillsSnapshot | null;
    error: string | null;
  }>({ open: false, snapshot: null, error: null });
  const [mcpStatus, setMcpStatus] = useState<{
    failed?: unknown;
    servers?: unknown;
  } | null>(null);
  const [projectRuleRefs, setProjectRuleRefs] = useState<RuleRef[]>([]);
  const [localRuleRefs, setLocalRuleRefs] = useState<RuleRef[]>([]);
  const [providersInfo, setProvidersInfo] = useState<ProvidersResponse | null>(
    null,
  );
  const [onboarding, setOnboarding] = useState<OnboardingSnapshot | null>(null);
  const [gitPanel, setGitPanel] = useState<{
    open: boolean;
    showDiff: boolean;
    snapshot: GitSnapshot | null;
    diff: string | null;
    error: string | null;
    prUrl: string | null;
  }>({
    open: false,
    showDiff: false,
    snapshot: null,
    diff: null,
    error: null,
    prUrl: null,
  });
  const [wtPanel, setWtPanel] = useState<WorktreePanel>({
    open: false,
    snapshot: null,
    error: null,
    creating: false,
    newBranch: "",
  });
  const [wtCursor, setWtCursor] = useState(0);
  const [effectiveCwdLabel, setEffectiveCwdLabel] = useState(cwd);

  const providerMeta = providersInfo?.providers?.[provider];
  const models = (providerMeta?.models ?? []) as AnyModel[];
  const model = useMemo(
    () => models.find((m) => m.id === modelId) ?? models[0],
    [modelId, models],
  );
  const effortLevels = (model?.effortLevels ?? ["none"]) as EffortLevel[];

  const applyComposeText = useCallback(
    (next: string) => {
      setInput(next);
      const trigger = composerTrigger(next);
      if (trigger?.kind === "slash") {
        const modelIds = (
          providersInfo?.providers?.[provider]?.models ?? []
        ).map((m) => m.id);
        const items = slashPickerItems(trigger.query, { modelIds });
        setSlashOpen(true);
        setSlashItems(items);
        setSlashIndex((i) => (items.length ? Math.min(i, items.length - 1) : 0));
        setPickerOpen(false);
        setPickerItems([]);
        return;
      }
      setSlashOpen(false);
      setSlashItems([]);
      if (trigger?.kind !== "mention") {
        setPickerOpen(false);
        setPickerItems([]);
        return;
      }
      const items = completeWorkspace(cwd, trigger.query, 10);
      setPickerOpen(true);
      setPickerItems(items);
      setPickerIndex((i) => (items.length ? Math.min(i, items.length - 1) : 0));
    },
    [cwd, providersInfo, provider],
  );

  const persistPrefs = useCallback(
    async (patch: {
      activeProvider?: string;
      activeModel?: string | null;
      activeEffort?: string | null;
      activeExecutionMode?: string;
      activeParams?: CursorParamSelection[] | null;
    }) => {
      try {
        await apiFetch(
          "/providers/preferences",
          {
            method: "PUT",
            body: JSON.stringify(patch),
          },
          token,
        );
      } catch {
        // non-fatal
      }
    },
    [token],
  );

  const applyProvidersInfo = useCallback((info: ProvidersResponse) => {
    setProvidersInfo(info);
    let nextProvider: "claude" | "cursor" =
      info.activeProvider === "cursor" || info.activeProvider === "claude"
        ? info.activeProvider
        : "claude";
    const linkedClaude = info.providers.claude?.linked;
    const linkedCursor = info.providers.cursor?.linked;
    if (nextProvider === "claude" && !linkedClaude && linkedCursor) {
      nextProvider = "cursor";
    }
    if (nextProvider === "cursor" && !linkedCursor && linkedClaude) {
      nextProvider = "claude";
    }
    setProvider(nextProvider);
    const nextModels = (info.providers[nextProvider]?.models ?? []) as AnyModel[];
    let mid = info.activeModel;
    if (!mid || !nextModels.some((m) => m.id === mid)) {
      mid =
        nextProvider === "claude"
          ? defaultModelId("claude") || nextModels[0]?.id || "claude-sonnet-4-6"
          : nextModels[0]?.id || "";
    }
    setModelId(mid);
    const selected = nextModels.find((m) => m.id === mid);
    if (nextProvider === "cursor") {
      const params = selected
        ? clampCursorParams(asCursorModel(selected)!, info.activeParams ?? [])
        : [];
      setActiveParams(params);
      setEffort("none");
      setExecutionMode(parseExecutionMode(info.activeExecutionMode));
      return { nextProvider, mid, params };
    }
    const eff =
      (info.activeEffort as EffortLevel) || defaultEffort("claude", mid);
    setEffort(eff);
    setActiveParams([]);
    setExecutionMode(parseExecutionMode(info.activeExecutionMode));
    return { nextProvider, mid, params: [] as CursorParam[] };
  }, []);

  const reloadPrefs = useCallback(async () => {
    if (!token) return;
    try {
      const info = await apiFetch<ProvidersResponse>("/providers", {}, token);
      applyProvidersInfo(info);
    } catch {
      // non-fatal
    }
  }, [token, applyProvidersInfo]);

  useEffect(() => {
    if (!token) {
      setStatus("error");
      setError("Missing CHAVEZ_ACCESS_TOKEN");
      return;
    }
    const c = new ChavezWsClient(token);
    const daemonId = randomUUID();
    daemonIdRef.current = daemonId;
    let cancelled = false;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

    c.enableAutoReconnect({
      path: cwd.replace(/\\/g, "/"),
      clientKind: "daemon",
      hostname: hostname(),
      daemonId,
    });
    c.onClose(({ userInitiated }) => {
      if (cancelled || userInitiated) return;
      setStatus("reconnecting");
      abortAllTurns();
      turnBusyRef.current = false;
      setBusy(false);
      setStreaming(false);
    });
    c.onStatus((s) => {
      if (cancelled) return;
      if (s === "bound") setStatus("bound");
      if (s === "reconnecting") setStatus("reconnecting");
    });
    c.onRebind((res) => {
      if (cancelled) return;
      const data = (res.data || {}) as {
        role?: "primary" | "standby" | "client";
        hostname?: string | null;
      };
      setDaemonRole(
        data.role === "standby" || data.role === "primary"
          ? data.role
          : "primary",
      );
      if (data.hostname) setDaemonHostname(data.hostname);
      setStatus("bound");
    });

    (async () => {
      try {
        const info = await apiFetch<ProvidersResponse>("/providers", {}, token);
        if (cancelled) return;
        const applied = applyProvidersInfo(info);
        try {
          const ob = await apiFetch<OnboardingSnapshot>(
            "/me/onboarding",
            {},
            token,
          );
          if (!cancelled) setOnboarding(ob);
        } catch {
          // API sin onboarding: TUI sigue
        }
        try {
          const rulesRes = await apiFetch<{ rules?: DispatchUserRule[] }>(
            "/rules",
            {},
            token,
          );
          if (!cancelled) setUserRules(rulesRes.rules ?? []);
        } catch {
          if (!cancelled) setUserRules([]);
        }

        if (
          applied.nextProvider === "cursor" &&
          info.activeModel &&
          info.activeModel !== applied.mid
        ) {
          void persistPrefs({
            activeProvider: "cursor",
            activeModel: applied.mid || null,
            activeEffort: null,
            activeParams: applied.params,
          });
        }

        await c.connect();
        const bound = await c.bind(cwd.replace(/\\/g, "/"), "daemon", {
          daemonId,
        });
        if (!bound.ok) throw new Error(bound.error || "bind failed");
        if (cancelled) {
          c.close();
          return;
        }
        initEffectiveCwd(cwd.replace(/\\/g, "/"));
        const boundData = (bound.data || {}) as {
          workspace?: { id: string };
          role?: "primary" | "standby" | "client";
          hostname?: string | null;
        };
        const ws = boundData.workspace;
        setWorkspaceId(ws?.id ?? null);
        if (ws?.id) {
          try {
            const list = await apiFetch<{
              workspaces?: Array<{ id: string; userRulesEnabled?: boolean }>;
            }>("/workspaces", {}, token);
            const mine = list.workspaces?.find((w) => w.id === ws.id);
            if (typeof mine?.userRulesEnabled === "boolean") {
              setUserRulesEnabled(mine.userRulesEnabled);
            }
          } catch {
            // default true
          }
        }
        try {
          ensureLocalRulesGitExcluded(cwd);
        } catch {
          // exclude is best-effort
        }
        try {
          const snap = rulesSnapshotForCwd(cwd);
          setProjectRuleRefs(snap.project);
          setLocalRuleRefs(snap.local);
        } catch {
          setProjectRuleRefs([]);
          setLocalRuleRefs([]);
        }
        setDaemonRole(
          boundData.role === "standby" || boundData.role === "primary"
            ? boundData.role
            : "primary",
        );
        setDaemonHostname(boundData.hostname || hostname());
        setLastSeen(new Date().toISOString());
        setClient(c);
        setStatus("bound");

        heartbeatTimer = setInterval(() => {
          if (cancelled) return;
          void c
            .request({ type: "daemon.heartbeat", daemonId })
            .then((res) => {
              if (!res.ok || cancelled) return;
              const data = (res.data || {}) as {
                lastSeen?: string | null;
                role?: string;
              };
              if (typeof data.lastSeen === "string") setLastSeen(data.lastSeen);
              if (data.role === "primary" || data.role === "standby") {
                setDaemonRole(data.role);
              }
            })
            .catch(() => {});
        }, HEARTBEAT_INTERVAL_MS);

        const list = await c.request({ type: "session.list" });
        if (list.ok && !cancelled) {
          const rows =
            (list.data as { sessions?: Session[] })?.sessions ?? [];
          setSessions(rows);
          if (rows[0]) {
            setActiveSessionId(rows[0].id);
            setSessionCursor(0);
            const chatRes = await c.request({
              type: "chat.list",
              sessionId: rows[0].id,
              includeArchived: false,
            });
            if (chatRes.ok && !cancelled) {
              const chatRows = visibleChats(
                (chatRes.data as { chats?: Chat[] })?.chats ?? [],
              );
              setChats(chatRows);
              setChatCursor(0);
              if (chatRows[0]) {
                setActiveChatId(chatRows[0].id);
                const msgRes = await c.request({
                  type: "chat.get",
                  chatId: chatRows[0].id,
                });
                if (msgRes.ok && !cancelled) {
                  setMessages(
                    (msgRes.data as { messages?: Message[] })?.messages ?? [],
                  );
                }
                setListFocus("chats");
                const q = await c.request({
                  type: "agent.queue.list",
                  chatId: chatRows[0].id,
                });
                if (q.ok && !cancelled) {
                  setQueueSnap((q.data || null) as QueueSnapshot | null);
                }
              } else {
                const q = await c.request({ type: "agent.queue.list" });
                if (q.ok && !cancelled) {
                  setQueueSnap((q.data || null) as QueueSnapshot | null);
                }
              }
            }
          }
        } else if (!cancelled) {
          const q = await c.request({ type: "agent.queue.list" });
          if (q.ok) setQueueSnap((q.data || null) as QueueSnapshot | null);
        }
      } catch (e) {
        if (!cancelled) {
          setStatus("error");
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      c.close();
    };
  }, [cwd, token]);

  const refreshChats = useCallback(
    async (sessionId: string, includeArchived = showArchived) => {
      if (!client) return [] as Chat[];
      const res = await client.request({
        type: "chat.list",
        sessionId,
        includeArchived,
      });
      if (res.ok) {
        const rows = visibleChats(
          (res.data as { chats?: Chat[] })?.chats ?? [],
          { includeArchived },
        );
        setChats(rows);
        setChatCursor((c) => clampIndex(c, rows.length));
        return rows;
      }
      return [] as Chat[];
    },
    [client, showArchived],
  );

  const refreshWorktrees = useCallback(async (): Promise<WorktreeSnapshot | null> => {
    const bindPath = getBindPath() || cwd.replace(/\\/g, "/");
    try {
      const snapshot = await collectWorktreeSnapshot(bindPath);
      setWtPanel((p) => ({
        ...p,
        snapshot,
        error: snapshot.isRepo ? null : WORKTREE_NO_GIT_UI,
      }));
      const idx = snapshot.worktrees.findIndex(
        (w) => w.path === snapshot.current?.path,
      );
      setWtCursor(idx >= 0 ? idx : 0);
      return snapshot;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setWtPanel((p) => ({ ...p, error: msg }));
      return null;
    }
  }, [cwd]);

  useEffect(() => {
    if (status === "bound") void refreshWorktrees();
  }, [status, refreshWorktrees]);

  const loadChat = useCallback(
    async (chatId: string): Promise<Message[]> => {
      if (!client) return [];
      const res = await client.request({ type: "chat.get", chatId });
      if (res.ok) {
        const data = res.data as {
          messages?: Message[];
          diffs?: TurnDiff[];
          context?: ContextUsage;
          usage?: { display?: string };
        };
        const msgs = data.messages ?? [];
        setMessages(msgs);
        setNotices((prev) =>
          hydrateFromMessages(
            prev,
            msgs.map((m) => ({
              role: m.role,
              chatId,
              metadata: (m.metadata || null) as Record<string, unknown> | null,
            })),
            chatId,
          ),
        );
        setChatUsage(
          typeof data.usage?.display === "string"
            ? data.usage.display
            : formatChatUsage(msgs),
        );
        setDiffs((data.diffs ?? []).filter((d) => d.status === "proposed" || d.status === "applied"));
        setContextBanner(
          data.context ? formatContextBanner(data.context) : null,
        );
        return msgs;
      }
      return [];
    },
    [client],
  );

  const applyCurrentPlan = useCallback(async () => {
    if (!client || !activeChatId) return;
    const res = await client.request({
      type: "chat.plan.apply",
      chatId: activeChatId,
    });
    if (!res.ok) setLog(res.error || "chat.plan.apply failed");
    else {
      const data = res.data as { executionMode?: string; gitCommit?: boolean };
      if (data.gitCommit) setLog("BUG: apply committed");
      else {
        setLog(
          `Plan aplicado → ${data.executionMode}. Enter en compose dispara el turn con brief.`,
        );
      }
    }
  }, [client, activeChatId]);

  const runSlashCommand = useCallback(
    async (text: string) => {
      if (!client) return;
      const io = liveSlashIo({ client, token });
      const result = await runSlash(text, io, {
        chatId: activeChatId,
        sessionId: activeSessionId,
      });
      setLog(result.text.split("\n")[0] || result.text);
      if (result.navigatedChatId) {
        setActiveChatId(result.navigatedChatId);
        setMcpStatus(null);
        setMessages([]);
        setChatUsage("");
        if (activeSessionId) await refreshChats(activeSessionId);
        const created = await client.request({
          type: "chat.get",
          chatId: result.navigatedChatId,
        });
        if (created.ok) {
          setMessages(
            (created.data as { messages?: Message[] })?.messages ?? [],
          );
        }
      } else if (activeChatId) {
        await loadChat(activeChatId);
      }
      if (result.command === "mode" && result.ok) {
        const next = result.text.replace(/^Mode → /, "");
        if (next === "plan" || next === "auto" || next === "ask") {
          setExecutionMode(next);
        }
      }
      if (
        result.ok &&
        (result.command === "provider" || result.command === "model")
      ) {
        await reloadPrefs();
      }
    },
    [
      client,
      token,
      activeChatId,
      activeSessionId,
      loadChat,
      refreshChats,
      reloadPrefs,
    ],
  );

  useEffect(() => {
    if (!firstAwaiting(messages)) return;
    const t = setInterval(
      () => setNowMs(Date.now()),
      APPROVAL_COUNTDOWN_TICK_MS,
    );
    return () => clearInterval(t);
  }, [messages]);

  const selectSession = useCallback(
    async (session: Session | undefined, opts?: { openFirstChat?: boolean }) => {
      if (!session) return;
      setActiveSessionId(session.id);
      setActiveChatId(null);
      setMessages([]);
      setMcpStatus(null);
      setChatUsage("");
      setDiffs([]);
      setExpandDiffs(false);
      setSessionCursor((c) => {
        const idx = sessions.findIndex((s) => s.id === session.id);
        return idx >= 0 ? idx : c;
      });
      const rows = await refreshChats(session.id);
      setChatCursor(0);
      if (opts?.openFirstChat && rows[0]) {
        setActiveChatId(rows[0].id);
        await loadChat(rows[0].id);
      }
      setLog(`Session activa: ${session.title}`);
    },
    [sessions, refreshChats, loadChat],
  );

  const selectChat = useCallback(
    async (chat: Chat | undefined) => {
      if (!chat) return;
      setActiveChatId(chat.id);
      setNotices((prev) => markChatRead(prev, chat.id));
      setMcpStatus(null);
      setChatCursor((c) => {
        const idx = chats.findIndex((x) => x.id === chat.id);
        return idx >= 0 ? idx : c;
      });
      await loadChat(chat.id);
      if (client) {
        const q = await client.request({
          type: "agent.queue.list",
          chatId: chat.id,
        });
        if (q.ok) setQueueSnap((q.data || null) as QueueSnapshot | null);
      }
      setLog(`Chat activo: ${displayChatTitle(chat)}`);
    },
    [chats, loadChat, client],
  );

  const activeChatIdRef = useRef(activeChatId);
  const activeSessionIdRef = useRef(activeSessionId);
  const sessionsRef = useRef(sessions);
  const undoBusyRef = useRef(false);
  const daemonRoleRef = useRef(daemonRole);
  const messagesRef = useRef(messages);
  activeChatIdRef.current = activeChatId;
  activeSessionIdRef.current = activeSessionId;
  sessionsRef.current = sessions;
  daemonRoleRef.current = daemonRole;
  messagesRef.current = messages;

  // Live sync + execute agent.turn.dispatch from Web (TUI is daemon).
  useEffect(() => {
    if (!client) return;
    const off = client.onPush((msg) => {
      setNotices((prev) =>
        reduceNotification(
          prev,
          { type: msg.type, data: msg.data },
          { surface: "tui", activeChatId: activeChatIdRef.current },
        ).state,
      );
      if (msg.type === "onboarding.updated") {
        setOnboarding(msg.data as OnboardingSnapshot);
        return;
      }
      const data = (msg.data || {}) as {
        chatId?: string;
        prompt?: string;
        path?: string;
        planBrief?: string;
        executionMode?: string;
        sessionId?: string;
        chat?: Chat;
        session?: Session;
        requestId?: string;
        query?: string;
        mentions?: string[];
        message?: Message;
        error?: string;
        content?: string;
        delta?: string;
        seq?: number;
        streamId?: string;
        hostname?: string;
      };

      if (msg.type === CHAT_UPDATED_EVENT) {
        const chat = (msg.data as { chat?: Chat })?.chat;
        if (!chat) return;
        if (chat.sessionId === activeSessionIdRef.current) {
          setChats((prev) => {
            const next = prev.filter((c) => c.id !== chat.id);
            if (!showArchived && chat.archivedAt) return visibleChats(next);
            return visibleChats([...next, chat], {
              includeArchived: showArchived,
            });
          });
        } else if (
          chat.id === activeChatIdRef.current &&
          activeSessionIdRef.current
        ) {
          void refreshChats(activeSessionIdRef.current);
        }
        if (chat.id === activeChatIdRef.current) {
          setLog(`Chat: ${displayChatTitle(chat)}`);
        }
        return;
      }

      if (msg.type === "workspace.rules.dispatch") {
        const rulesData = (msg.data || {}) as {
          requestId?: string;
          action?: string;
          path?: string;
          payload?: { content?: string };
        };
        if (!rulesData.requestId) return;
        void (async () => {
          const rulesCwd = rulesData.path || cwd;
          try {
            ensureLocalRulesGitExcluded(rulesCwd);
            if (rulesData.action === "local.set") {
              writeLocalMachineRules(
                rulesCwd,
                String(rulesData.payload?.content ?? ""),
              );
            }
            const snapshot = rulesSnapshotForCwd(rulesCwd);
            setProjectRuleRefs(snapshot.project);
            setLocalRuleRefs(snapshot.local);
            await client.request({
              type: "workspace.rules.result",
              requestId: rulesData.requestId,
              metadata: {
                requestId: rulesData.requestId,
                snapshot,
              },
            });
          } catch (err) {
            await client.request({
              type: "workspace.rules.result",
              requestId: rulesData.requestId,
              status: "error",
              metadata: {
                requestId: rulesData.requestId,
                error: err instanceof Error ? err.message : String(err),
              },
            });
          }
        })();
        return;
      }

      if (msg.type === "rules.updated") {
        void apiFetch<{ rules?: DispatchUserRule[] }>("/rules", {}, token)
          .then((r) => setUserRules(r.rules ?? []))
          .catch(() => {});
        return;
      }
      if (msg.type === "workspace.prefs.updated") {
        const d = (msg.data || {}) as {
          workspaceId?: string;
          userRulesEnabled?: boolean;
        };
        if (typeof d.userRulesEnabled === "boolean") {
          setUserRulesEnabled(d.userRulesEnabled);
        }
        return;
      }
      if (msg.type === "workspace.rules.changed") {
        const snap = (
          msg.data as {
            snapshot?: {
              project?: RuleRef[];
              local?: RuleRef[];
            };
          }
        )?.snapshot;
        if (snap?.project) setProjectRuleRefs(snap.project);
        if (snap?.local) setLocalRuleRefs(snap.local);
        return;
      }

      if (msg.type === "workspace.git.dispatch") {
        const gitData = (msg.data || {}) as {
          requestId?: string;
          action?: string;
          path?: string;
          payload?: Record<string, unknown>;
        };
        if (!gitData.requestId) return;
        void (async () => {
          const result = await runGitAction({
            cwd: gitData.path || cwd,
            action: gitData.action as GitRpcAction,
            payload: gitData.payload || {},
            getGitHubToken: async () => {
              try {
                const creds = await apiFetch<{ secret: string }>(
                  "/providers/github/credentials",
                  {},
                  token,
                );
                return creds.secret;
              } catch {
                return null;
              }
            },
          });
          await client.request({
            type: "workspace.git.result",
            requestId: gitData.requestId,
            metadata: result as unknown as Record<string, unknown>,
            status: result.ok ? "done" : "error",
          });
          if (result.snapshot) {
            setGitPanel((p) => ({ ...p, snapshot: result.snapshot! }));
          }
          if (result.pr?.url) {
            setGitPanel((p) => ({ ...p, prUrl: result.pr!.url }));
          }
        })();
        return;
      }

      if (msg.type === "workspace.git.snapshot") {
        const snap = (msg.data as { snapshot?: GitSnapshot } | undefined)?.snapshot;
        if (snap) setGitPanel((p) => ({ ...p, snapshot: snap }));
        return;
      }
      if (msg.type === "github.pr.created") {
        const url = String((msg.data as { url?: string } | undefined)?.url || "");
        if (url) setGitPanel((p) => ({ ...p, prUrl: url }));
        return;
      }

      if (msg.type === "workspace.cwd.changed") {
        const cwdData = (msg.data || {}) as {
          cwd?: string;
          snapshot?: WorktreeSnapshot;
        };
        if (typeof cwdData.cwd === "string" && cwdData.cwd) {
          setEffectiveCwdLabel(cwdData.cwd);
        }
        if (cwdData.snapshot) {
          setWtPanel((p) =>
            p.open ? { ...p, snapshot: cwdData.snapshot! } : p,
          );
        }
        return;
      }

      if (msg.type === "chat.compact.dispatch") {
        const compactData = (msg.data || {}) as {
          chatId?: string;
          requestId?: string;
          path?: string;
          trigger?: "manual" | "overflow";
        };
        void handleCompactDispatch({
          client: client as never,
          data: compactData,
          cwd,
          token,
          isBusy: () => turnBusyRef.current,
          setBusy: (v) => {
            turnBusyRef.current = v;
            setBusy(v);
          },
        }).then(() => {
          if (
            compactData.chatId &&
            compactData.chatId === activeChatIdRef.current
          ) {
            void loadChat(compactData.chatId);
          }
        });
        return;
      }

      if (
        (msg.type === "chat.context.usage" || msg.type === "chat.compact.done") &&
        data.chatId === activeChatIdRef.current &&
        data.chatId
      ) {
        const ctx = (msg.data as { context?: ContextUsage } | undefined)?.context;
        if (ctx) setContextBanner(formatContextBanner(ctx));
        void loadChat(data.chatId);
        return;
      }

      if (handleToolResolutionPush(msg)) return;

      if (
        msg.type === "chat.mcp.status" &&
        data.chatId === activeChatIdRef.current
      ) {
        const statusData = (msg.data || {}) as {
          failed?: unknown;
          servers?: unknown;
        };
        setMcpStatus(statusData);
        return;
      }

      if (
        msg.type === "chat.skill.activated" &&
        data.chatId === activeChatIdRef.current
      ) {
        const skill = (msg.data || {}) as {
          streamId?: string;
          name?: string;
          layer?: string;
        };
        const name = String(skill.name || "skill");
        setMessages((prev) =>
          mergeTimeline(prev, {
            id: `skill:${skill.streamId || ""}:${name}`,
            role: "tool",
            content: name,
            createdAt: new Date(),
            metadata: {
              kind: "skill",
              name,
              layer: skill.layer,
              status: "activated",
            },
          }),
        );
        return;
      }

      if (
        msg.type.startsWith("chat.subagent.") &&
        data.chatId === activeChatIdRef.current
      ) {
        const subagent = (msg.data || {}) as Record<string, unknown>;
        const subagentId = String(
          subagent.subagentId ||
            subagent.toolCallId ||
            `${data.streamId || ""}:${subagent.agentType || "subagent"}`,
        );
        const defaultStatus =
          msg.type === "chat.subagent.end" ? "done" : "running";
        setMessages((prev) =>
          mergeTimeline(prev, {
            id: `subagent:${subagentId}`,
            role: "tool",
            content: String(subagent.agentType || subagentId),
            createdAt: new Date(),
            metadata: {
              ...subagent,
              kind: "subagent",
              subagentId,
              status: String(subagent.status || defaultStatus),
            },
          }),
        );
        return;
      }

      if (
        msg.type === "chat.capability.degraded" &&
        data.chatId === activeChatIdRef.current &&
        data.message
      ) {
        setMessages((prev) => mergeTimeline(prev, data.message!));
        return;
      }

      if (msg.type === "prefs.updated") {
        const d = (msg.data || {}) as {
          activeExecutionMode?: string;
          activeProvider?: string | null;
          activeModel?: string | null;
          activeEffort?: string;
          activeParams?: CursorParam[] | null;
        };
        if (d.activeExecutionMode) {
          setExecutionMode(parseExecutionMode(d.activeExecutionMode));
          setLog(`Mode → ${d.activeExecutionMode}`);
        }
        if (d.activeProvider === "claude" || d.activeProvider === "cursor") {
          setProvider(d.activeProvider);
        }
        if (d.activeModel) setModelId(d.activeModel);
        if (d.activeParams) setActiveParams(d.activeParams);
        return;
      }

      if (
        msg.type.startsWith("chat.plan.") &&
        data.chatId === activeChatIdRef.current &&
        data.chatId
      ) {
        void loadChat(data.chatId);
        if (msg.type === PLAN_UPDATED_EVENT) setLog("Plan actualizado (Web)");
        if (msg.type === PLAN_CREATED_EVENT) setLog("Plan creado");
        if (msg.type === PLAN_CURRENT_EVENT) setLog("Plan actual marcado");
        if (msg.type === PLAN_APPLIED_EVENT) {
          const em = (msg.data as { executionMode?: string })?.executionMode;
          setLog(`Plan aplicado → modo ${em}. Siguiente turn usará el brief.`);
        }
        return;
      }

      if (msg.type === "fs.complete.dispatch") {
        if (!data.requestId) return;
        const candidates = completeWorkspace(
          data.path || cwd,
          data.query || "",
          10,
        );
        void client.request({
          type: "fs.complete.result",
          requestId: data.requestId,
          hostname: hostname(),
          path: data.path || cwd,
          metadata: { cwd: data.path || cwd, candidates },
        });
        return;
      }

      if (msg.type === "fs.tree.dispatch") {
        if (!data.requestId) return;
        const workspacePath =
          (data as { workspacePath?: string }).workspacePath || cwd;
        const rel = data.path || ".";
        try {
          const tree = listWorkspaceDir(workspacePath, rel);
          void client.request({
            type: "fs.tree.result",
            requestId: data.requestId,
            hostname: hostname(),
            path: cwd,
            metadata: {
              cwd: tree.cwd,
              path: tree.path,
              entries: tree.entries,
              truncated: tree.truncated,
            },
          });
        } catch (err) {
          void client.request({
            type: "fs.tree.result",
            requestId: data.requestId,
            hostname: hostname(),
            path: cwd,
            metadata: {
              cwd: workspacePath,
              path: rel,
              entries: [],
              truncated: false,
              error: err instanceof Error ? err.message : String(err),
            },
          });
        }
        return;
      }

      if (msg.type === "fs.search.dispatch") {
        if (!data.requestId) return;
        const workspacePath =
          (data as { workspacePath?: string }).workspacePath || cwd;
        try {
          const found = searchWorkspace(workspacePath, data.query || "");
          void client.request({
            type: "fs.search.result",
            requestId: data.requestId,
            hostname: hostname(),
            path: cwd,
            metadata: {
              cwd: found.cwd,
              query: found.query,
              matches: found.matches,
              truncated: found.truncated,
            },
          });
        } catch (err) {
          void client.request({
            type: "fs.search.result",
            requestId: data.requestId,
            hostname: hostname(),
            path: cwd,
            metadata: {
              cwd: workspacePath,
              query: String(data.query || ""),
              matches: [],
              truncated: false,
              error: err instanceof Error ? err.message : String(err),
            },
          });
        }
        return;
      }

      if (msg.type === "fs.preview.dispatch") {
        if (!data.requestId) return;
        const workspacePath =
          (data as { workspacePath?: string }).workspacePath || cwd;
        const rel = data.path || "";
        try {
          const prev = previewFile(workspacePath, rel);
          void client.request({
            type: "fs.preview.result",
            requestId: data.requestId,
            hostname: hostname(),
            path: cwd,
            metadata: { ...prev },
          });
        } catch (err) {
          void client.request({
            type: "fs.preview.result",
            requestId: data.requestId,
            hostname: hostname(),
            path: cwd,
            metadata: {
              cwd: workspacePath,
              path: rel,
              kind: "binary",
              status: "forbidden",
              byteSize: 0,
              error: err instanceof Error ? err.message : String(err),
            },
          });
        }
        return;
      }

      if (msg.type === "agent.turn.cancel") {
        const cancelChatId = (data as { chatId?: string }).chatId;
        if (cancelChatId) cancelSession(cancelChatId);
        setLog("Cancelando turn…");
        return;
      }
      if (msg.type === "agent.turn.steer.dispatch") {
        const steerData = (msg.data || {}) as {
          chatId?: string;
          content?: string;
          requestId?: string;
        };
        if (!steerData.chatId || !steerData.requestId) return;
        void (async () => {
          try {
            const ack = await steerSession(
              steerData.chatId!,
              steerData.content || "",
            );
            await client.request({
              type: "chat.append",
              chatId: steerData.chatId,
              role: "user",
              content: ack.content,
              metadata: {
                kind: STEER_KIND,
                outcome: ack.outcome,
              },
            });
            await client.request({
              type: "agent.turn.steer.result",
              id: steerData.requestId,
              chatId: steerData.chatId,
              content: ack.content,
              status: ack.outcome,
              metadata: { outcome: ack.outcome, reason: ack.reason },
            });
          } catch (err) {
            await client.request({
              type: "agent.turn.steer.result",
              id: steerData.requestId,
              chatId: steerData.chatId,
              content: steerData.content,
              status: "error",
              metadata: {
                outcome: "revert_to_followup",
                reason: err instanceof Error ? err.message : String(err),
              },
            });
          }
        })();
        return;
      }

      if (msg.type === "agent.turn.started") {
        if (data.chatId === activeChatIdRef.current || daemonRoleRef.current === "standby") {
          setBusy(true);
        }
        return;
      }
      if (msg.type === "agent.turn.ended") {
        setBusy(false);
        turnBusyRef.current = false;
        setThinkingLive("");
        if (data.chatId) void loadChat(data.chatId);
        return;
      }

      if (msg.type === "agent.queue.updated") {
        const snap = (msg.data || null) as QueueSnapshot | null;
        setQueueSnap(snap);
        if (snap?.reason === "promoted") {
          const promotedChat = snap.running?.chatId;
          if (
            promotedChat &&
            promotedChat !== activeChatIdRef.current
          ) {
            setLog(QUEUE_PROMOTED_LABEL);
          }
        }
        return;
      }

      if (msg.type === "agent.turn.undo.dispatch") {
        if (turnBusyRef.current || undoBusyRef.current) {
          if (data.requestId) {
            void client.request({
              type: "agent.turn.undo.result",
              requestId: data.requestId,
              chatId: data.chatId,
              status: "error",
              metadata: { error: TURN_BUSY_ERROR, chatId: data.chatId },
            });
          }
          return;
        }
        undoBusyRef.current = true;
        void handleUndoDispatch({
          client,
          cwd,
          data: (msg.data || {}) as Parameters<typeof handleUndoDispatch>[0]["data"],
        }).finally(() => {
          undoBusyRef.current = false;
        });
        return;
      }

      if (msg.type === "workspace.worktree.dispatch") {
        const wtData = (msg.data || {}) as {
          requestId?: string;
          action?: string;
          path?: string;
          payload?: Record<string, unknown>;
        };
        if (!wtData.requestId) return;
        void (async () => {
          const bindPath = cwd.replace(/\\/g, "/");
          const result = await handleWorktreeRpc({
            bindPath,
            action: String(wtData.action || "list"),
            payload: wtData.payload,
            turnBusy: turnBusyRef.current,
          });
          if (result.ok && result.snapshot) {
            const st = readWorkspaceState(bindPath);
            writeWorkspaceState({
              path: bindPath,
              pid: process.pid,
              openedAt: st?.openedAt || new Date().toISOString(),
              workspaceId: st?.workspaceId,
              daemonId: daemonIdRef.current,
              cwd: result.snapshot.cwd,
            });
          }
          await client.request({
            type: "workspace.worktree.result",
            requestId: wtData.requestId,
            metadata: result as unknown as Record<string, unknown>,
            status: result.ok ? "done" : "error",
          });
        })();
        return;
      }

      if (msg.type === "agent.turn.dispatch") {
        if (!data.chatId || !data.prompt) return;
        if (daemonRoleRef.current === "standby") return;
        const chatId = data.chatId;
        const prompt = data.prompt;
        dispatchChainRef.current = dispatchChainRef.current
          .then(async () => {
            if (turnBusyRef.current) {
              setLog(TURN_BUSY_ERROR);
              void client.request({
                type: "chat.stream.error",
                chatId,
                streamId: crypto.randomUUID(),
                content: TURN_BUSY_ERROR,
              });
              return;
            }
            turnBusyRef.current = true;
            setBusy(true);
            setLog(`Turn Web → chat ${chatId.slice(0, 8)}…`);

            if (data.sessionId) {
              setActiveSessionId(data.sessionId);
              const sIdx = sessionsRef.current.findIndex(
                (s) => s.id === data.sessionId,
              );
              if (sIdx >= 0) setSessionCursor(sIdx);
              void refreshChats(data.sessionId).then((rows) => {
                const cIdx = rows.findIndex((c) => c.id === chatId);
                if (cIdx >= 0) setChatCursor(cIdx);
              });
            }
            setActiveChatId(chatId);
            setMcpStatus(null);
            setListFocus("chats");
            void loadChat(chatId);

            try {
              await publishAgentTurn({
                client,
                chatId,
                prompt,
                cwd: getEffectiveCwd() || cwd,
                token,
                mentions: data.mentions,
                attachments: (data as { attachments?: unknown[] }).attachments,
                retryOfStreamId: (data as { retryOfStreamId?: string })
                  .retryOfStreamId,
                executionMode: parseExecutionMode(
                  data.executionMode ??
                    (data as { executionMode?: string }).executionMode,
                ),
                planBrief: data.planBrief,
                userRules: (data as { userRules?: DispatchUserRule[] }).userRules,
                userRulesEnabled:
                  (data as { userRulesEnabled?: boolean }).userRulesEnabled !==
                  false,
                skipUserAppend: Boolean(
                  (data as { skipUserAppend?: boolean }).skipUserAppend,
                ),
                queueId: (data as { queueId?: string }).queueId,
              });
              const msgs = await loadChat(chatId);
              const failLog = verificationFailureLog(msgs);
              setLog(failLog || "Turn remoto completado");
            } catch (e) {
              setLog(e instanceof Error ? e.message : String(e));
            } finally {
              turnBusyRef.current = false;
              setBusy(false);
            }
          })
          .catch((e) => {
            setLog(e instanceof Error ? e.message : String(e));
          });
        return;
      }

      if (
        msg.type === "chat.tool.resolved" &&
        data.chatId &&
        data.chatId === activeChatIdRef.current
      ) {
        void loadChat(data.chatId);
      }

      if (
        (msg.type === "chat.checkpoint.undone" ||
          msg.type === "chat.checkpoint.finalized") &&
        data.chatId &&
        data.chatId === activeChatIdRef.current
      ) {
        void loadChat(data.chatId);
      }

      if (
        (msg.type === "message.appended" || msg.type.startsWith("chat.tool.")) &&
        data.message &&
        data.chatId &&
        data.chatId === activeChatIdRef.current
      ) {
        setMessages((prev) => mergeTimeline(prev, data.message!));
        const meta = (data.message.metadata || {}) as Record<string, unknown>;
        const name = canonicalToolName(
          String(meta.sdkName || meta.toolName || ""),
        );
        const prUrl =
          typeof meta.prUrl === "string" && meta.prUrl
            ? meta.prUrl
            : extractPrUrl(String(meta.output || data.message.content || ""));
        if (prUrl) setGitPanel((p) => ({ ...p, prUrl }));
        if (name === "git_commit" && msg.type === "chat.tool.result") {
          void collectGitSnapshot(cwd).then((snapshot) => {
            setGitPanel((p) => ({
              ...p,
              snapshot,
              error: snapshot.isRepo ? null : snapshot.message || NOT_A_GIT_UI,
            }));
          });
        }
      }

      if (
        msg.type === "chat.thinking.delta" &&
        data.chatId === activeChatIdRef.current
      ) {
        setThinkingLive((prev) => prev + String(data.delta || ""));
      }

      if (
        msg.type === "chat.thinking.end" &&
        data.chatId === activeChatIdRef.current
      ) {
        // Keep the live text visible until chat.get refreshes persisted metadata.
      }

      if (
        msg.type === "chat.diff.upsert" &&
        data.chatId &&
        data.chatId === activeChatIdRef.current
      ) {
        void loadChat(data.chatId);
      }

      if (msg.type === "chat.stream.start") {
        if (data.chatId === activeChatIdRef.current) {
          setThinkingLive("");
          setStreamText("");
          deltaStateRef.current = { nextSeq: 1, buffer: new Map() };
          setStreaming(true);
          streamIdRef.current = data.streamId || null;
        }
      }
      if (msg.type === "chat.stream.delta") {
        if (data.chatId === activeChatIdRef.current && data.delta) {
          setStreamText((prev) =>
            applyStreamDelta(
              prev,
              data.delta!,
              data.seq,
              deltaStateRef.current,
            ),
          );
        }
      }

      if (msg.type === "chat.stream.end" || msg.type === "chat.stream.error") {
        if (
          data.chatId &&
          activeChatIdRef.current &&
          data.chatId === activeChatIdRef.current
        ) {
          setStreaming(false);
          if (data.message) {
            setMessages((prev) => mergeTimeline(prev, data.message!));
          }
          setStreamText("");
          setThinkingLive("");
          void loadChat(data.chatId).then((msgs) => {
            const failLog = verificationFailureLog(msgs);
            if (failLog) setLog(failLog);
          });
        } else if (
          msg.type === "chat.stream.end" &&
          data.chatId &&
          data.chatId !== activeChatIdRef.current
        ) {
          setLog(QUEUE_DONE_LABEL);
        }
      }

      if (msg.type === "chat.stream.error") {
        setBusy(false);
        turnBusyRef.current = false;
        setStreaming(false);
        const err = String(data.error || data.content || "");
        if (err.includes("timed out") || err === VERIFY_TIMEOUT_ERROR) {
          setLog(`verify timeout · ${err}`);
        } else if (
          err === "Turn already running on this daemon" ||
          err.includes("no ejecuta agente") ||
          err.includes("No daemon bound") ||
          err.includes(NO_PROVIDER_ASK) ||
          err.includes("Claude no está vinculado") ||
          err.includes("Turn interrupted")
        ) {
          setLog(err);
        }
      }

      if (msg.type === "daemon.presence") {
        const presence = (msg.data || {}) as {
          bound?: boolean;
          daemonId?: string | null;
          lastSeen?: string | null;
          hostname?: string | null;
        };
        if (presence.bound === false && daemonRoleRef.current === "primary") {
          setStatus("reconnecting");
        }
        if (
          presence.bound === true &&
          presence.daemonId &&
          presence.daemonId === daemonIdRef.current
        ) {
          setStatus("bound");
          if (presence.lastSeen) setLastSeen(presence.lastSeen);
          if (presence.hostname) setDaemonHostname(presence.hostname);
        }
        return;
      }

      if (msg.type === "chat.share.updated") {
        const shareData = data as { chatId?: string; active?: boolean };
        setExportOverlay((prev) => {
          if (!prev || !shareData.chatId || prev.chatId !== shareData.chatId) {
            return prev;
          }
          if (shareData.active === false) {
            return { ...prev, url: null, status: "revoked" };
          }
          return prev;
        });
      }

      if (msg.type === "chat.created") {
        const created =
          data.chat ||
          (msg.data as { chat?: Chat } | undefined)?.chat;
        const sessionId = created?.sessionId;
        if (sessionId && sessionId === activeSessionIdRef.current) {
          setLog(
            `Chat nuevo (Web): ${created?.title || created?.id.slice(0, 8)}`,
          );
          void refreshChats(sessionId);
        }
      }

      if (msg.type === "session.created") {
        setLog("Session nueva (Web)");
        void client.request({ type: "session.list" }).then((list) => {
          if (list.ok) {
            const rows =
              (list.data as { sessions?: Session[] })?.sessions ?? [];
            setSessions(rows);
            setSessionCursor((c) => clampIndex(c, rows.length));
          }
        });
      }
    });
    return off;
  }, [client, cwd, token, loadChat, refreshChats, showArchived]);

  const runCompact = useCallback(
    async (chatId: string) => {
      if (!client) return;
      if (turnBusyRef.current) {
        setLog("Turn already running on this daemon");
        return;
      }
      turnBusyRef.current = true;
      setBusy(true);
      setLog("Compactando contexto…");
      try {
        const providers = await apiFetch<ProvidersResponse>(
          "/providers",
          {},
          token,
        );
        let auth: {
          authKind: "oauth_token" | "api_key";
          secret: string;
        } | null = null;
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
          client: client as never,
          chatId,
          cwd,
          trigger: "manual",
          model: providers.activeModel || modelId,
          providerId: providers.activeProvider || provider,
          auth,
          llmEnabled: Boolean(auth),
        });
        if (out.skipped) {
          setLog(out.reason || "Nothing to compact — chat is already short.");
        } else {
          setLog("contexto compactado");
        }
        setContextBanner(formatContextBanner(out.usage));
        await loadChat(chatId);
      } catch (e) {
        setLog(e instanceof Error ? e.message : String(e));
      } finally {
        turnBusyRef.current = false;
        setBusy(false);
      }
    },
    [client, cwd, token, modelId, provider, loadChat],
  );

  const sendWithLlm = useCallback(
    async (text: string) => {
      if (!client || !activeChatId) return;
      if (!providersInfo?.providers.claude?.linked && provider === "claude") {
        setLog(NO_PROVIDER_ASK);
        return;
      }
      if (daemonRole === "standby") {
        setLog("Standby — despachando al primary…");
      }
      const res = await client.request({
        type: "agent.turn.request",
        chatId: activeChatId,
        prompt: text,
      });
      if (!res.ok) {
        setLog(res.error || "agent.turn.request failed");
        return;
      }
      const data = (res.data || {}) as {
        queued?: boolean;
        position?: number;
      };
      if (data.queued) {
        setLog(`${TUI_QUEUED_HINT}${data.position ?? ""}`);
        return;
      }
      setLog("Turn aceptado");
      try {
        const snap = await apiFetch<OnboardingSnapshot>(
          "/me/onboarding",
          { method: "PUT", body: JSON.stringify({ action: "complete" }) },
          token,
        );
        setOnboarding(snap);
      } catch {
        // non-fatal
      }
    },
    [
      client,
      activeChatId,
      provider,
      providersInfo,
      token,
      daemonRole,
    ],
  );

  useInput(async (ch, key) => {
    if (key.ctrl && ch === "c") {
      client?.close();
      exit();
      return;
    }

    if (exportOverlay) {
      if (key.escape) {
        setExportOverlay(null);
        return;
      }
      if (ch === "y" && client && activeChatId) {
        const res = await client.request({
          type: "chat.share.create",
          chatId: activeChatId,
        });
        if (res.ok) {
          const url = (res.data as { url?: string })?.url || "";
          setExportOverlay({ ...exportOverlay, url, status: url });
        } else {
          setExportOverlay({
            ...exportOverlay,
            status: res.error || "share failed",
          });
        }
        return;
      }
      if (ch === "r" && client && activeChatId) {
        const res = await client.request({
          type: "chat.share.revoke",
          chatId: activeChatId,
        });
        setExportOverlay({
          ...exportOverlay,
          url: null,
          status: res.ok ? "revoked" : res.error || "revoke failed",
        });
        return;
      }
      return;
    }

    if (view === "replay") {
      if (key.escape || ch === "q") {
        setView(replayEscapeCloses("replay"));
        setReplayText("");
        setReplayErr(null);
        return;
      }
      if (isReplayReadOnlyKey(ch)) return;
      if (ch === "L" && client && activeChatId) {
        setReplayErr(null);
        const res = await client.request({ type: "chat.replay", chatId: activeChatId });
        if (!res.ok) {
          setLog(res.error || "replay failed");
          setReplayErr(res.error || "replay failed");
          setReplayText("");
          return;
        }
        const text = (res.data as { text?: string })?.text || "";
        setReplayText(text);
        setLog("Replay (solo lectura)");
        return;
      }
      return;
    }

    if (skillsOverlay.open) {
      if (key.escape) {
        setSkillsOverlay((panel) => ({ ...panel, open: false }));
        return;
      }
      if (ch === "q") {
        client?.close();
        exit();
      }
      return;
    }

    if (rulesOverlay) {
      if (key.escape) {
        setRulesOverlay(false);
        return;
      }
      if (ch === "u" && workspaceId) {
        const next = !userRulesEnabled;
        try {
          await apiFetch(
            `/workspaces/${workspaceId}/preferences`,
            {
              method: "PUT",
              body: JSON.stringify({ userRulesEnabled: next }),
            },
            token,
          );
          setUserRulesEnabled(next);
          setLog(`user rules → ${next ? "on" : "off"}`);
        } catch (e) {
          setLog(e instanceof Error ? e.message : String(e));
        }
        return;
      }
      if (ch === "q") {
        client?.close();
        exit();
      }
      return;
    }

    if (renameMode) {
      if (key.escape) {
        setRenameMode(false);
        setInput("");
        setLog("Renombrado cancelado");
        return;
      }
      if (key.return) {
        const normalized = normalizeTitleInput(input);
        if (!normalized.ok) {
          setLog(normalized.error);
          return;
        }
        const target =
          listFocus === "chats"
            ? chats[chatCursor]
            : chats.find((chat) => chat.id === activeChatId);
        if (!client || !target) {
          setLog("No hay chat para renombrar");
          return;
        }
        const res = await client.request({
          type: "chat.update",
          chatId: target.id,
          title: normalized.title,
        });
        if (!res.ok) {
          setLog(res.error || "chat.update failed");
          return;
        }
        const updated = (res.data as { chat?: Chat })?.chat;
        if (updated) {
          setChats((prev) =>
            visibleChats(
              [...prev.filter((chat) => chat.id !== updated.id), updated],
              { includeArchived: showArchived },
            ),
          );
        }
        setRenameMode(false);
        setInput("");
        setLog(`Chat: ${normalized.title}`);
        return;
      }
      if (key.backspace || key.delete) {
        setInput((value) => value.slice(0, -1));
        return;
      }
      if (ch && !key.ctrl && !key.meta) setInput((value) => value + ch);
      return;
    }

    if (findMode) {
      if (key.escape) {
        setFindMode(false);
        setFindQuery("");
        setFindHits([]);
        setChatCursor(0);
        setLog("Búsqueda cerrada");
        return;
      }
      if (key.upArrow || key.downArrow) {
        const dir = key.upArrow ? -1 : 1;
        setChatCursor((i) => clampIndex(i + dir, findHits.length));
        return;
      }
      if (key.return && findHits.length > 0) {
        const hit = findHits[chatCursor];
        if (!hit) return;
        if (hit.sessionId !== activeSessionId) {
          const session = sessions.find((s) => s.id === hit.sessionId);
          if (session) await selectSession(session);
        }
        await selectChat(hit);
        setFindMode(false);
        setFindQuery("");
        setFindHits([]);
        setListFocus("chats");
        return;
      }
      if (key.return) {
        const query = findQuery.trim();
        if (query.length < 2) {
          setLog(QUERY_TOO_SHORT);
          return;
        }
        if (!client) return;
        const res = await client.request({ type: "chat.search", query });
        if (!res.ok) {
          setLog(res.error || "chat.search failed");
          return;
        }
        const hits = visibleChats(
          (res.data as { chats?: Chat[] })?.chats ?? [],
          { includeArchived: showArchived },
        );
        setFindHits(hits);
        setChatCursor(0);
        setLog(hits.length ? `${hits.length} chat(s)` : NO_SEARCH_MATCHES);
        return;
      }
      if (key.backspace || key.delete) {
        setFindQuery((value) => value.slice(0, -1));
        setFindHits([]);
        return;
      }
      if (ch && !key.ctrl && !key.meta) {
        setFindQuery((value) => value + ch);
        setFindHits([]);
      }
      return;
    }

    if (wtPanel.open) {
      if (key.escape) {
        setWtPanel((p) => ({
          ...p,
          open: false,
          creating: false,
          newBranch: "",
        }));
        return;
      }
      if (wtPanel.creating) {
        if (key.return) {
          const branch = wtPanel.newBranch.trim();
          if (!branch) {
            setLog("branch is required");
            return;
          }
          if (busy || turnBusyRef.current) {
            setLog(TURN_BUSY_ERROR);
            return;
          }
          if (!wtPanel.snapshot?.isRepo) {
            setLog(WORKTREE_NO_GIT_UI);
            return;
          }
          void (async () => {
            try {
              const bindPath = getBindPath() || cwd.replace(/\\/g, "/");
              const snapshot = await addWorktree(
                { branch, createBranch: true },
                bindPath,
              );
              setEffectiveCwdLabel(getEffectiveCwd());
              setLog(formatDaemonCwdLabel(hostname(), getEffectiveCwd()));
              setWtPanel({
                open: false,
                snapshot,
                error: null,
                creating: false,
                newBranch: "",
              });
            } catch (err) {
              setLog(err instanceof Error ? err.message : String(err));
            }
          })();
          return;
        }
        if (key.backspace || key.delete) {
          setWtPanel((p) => ({ ...p, newBranch: p.newBranch.slice(0, -1) }));
          return;
        }
        if (ch && !key.ctrl && !key.meta) {
          setWtPanel((p) => ({ ...p, newBranch: p.newBranch + ch }));
        }
        return;
      }
      if (key.upArrow || key.downArrow) {
        const items = wtPanel.snapshot?.worktrees ?? [];
        if (!items.length) return;
        const dir = key.downArrow ? 1 : -1;
        setWtCursor((i) => (i + dir + items.length) % items.length);
        return;
      }
      if (key.return) {
        if (busy || turnBusyRef.current) {
          setLog(TURN_BUSY_ERROR);
          return;
        }
        if (!wtPanel.snapshot?.isRepo) {
          setLog(WORKTREE_NO_GIT_UI);
          return;
        }
        const entry = wtPanel.snapshot.worktrees[wtCursor];
        if (!entry) return;
        void (async () => {
          try {
            const bindPath = getBindPath() || cwd.replace(/\\/g, "/");
            const snapshot = await selectWorktree({ path: entry.path }, bindPath);
            setEffectiveCwdLabel(getEffectiveCwd());
            setLog(formatDaemonCwdLabel(hostname(), getEffectiveCwd()));
            setWtPanel({
              open: false,
              snapshot,
              error: null,
              creating: false,
              newBranch: "",
            });
          } catch (err) {
            setLog(err instanceof Error ? err.message : String(err));
          }
        })();
        return;
      }
      if (ch === "n") {
        if (busy || turnBusyRef.current) {
          setLog(TURN_BUSY_ERROR);
          return;
        }
        if (!wtPanel.snapshot?.isRepo) {
          setLog(WORKTREE_NO_GIT_UI);
          return;
        }
        setWtPanel((p) => ({ ...p, creating: true, newBranch: "" }));
        return;
      }
      return;
    }

    if (key.escape) {
      if (mode === "compose") {
        if (slashOpen) {
          setSlashOpen(false);
          setSlashItems([]);
          setLog("Slash picker cerrado");
          return;
        }
        if (pickerOpen) {
          setPickerOpen(false);
          setPickerItems([]);
          setLog("Picker cerrado");
          return;
        }
        setMode("command");
        setInput("");
        setSteerDraft("");
        setSteerCompose(false);
        setLog(
          busy && steerCompose ? "Steer cancelado" : "Compose cancelado",
        );
        return;
      }
      if (wtPanel.open) {
        setWtPanel((p) => ({
          ...p,
          open: false,
          creating: false,
          newBranch: "",
        }));
        return;
      }
      if (busy) {
        if (activeChatId && client) {
          cancelSession(activeChatId);
          void client.request({
            type: "agent.turn.cancel",
            chatId: activeChatId,
          });
          setLog("Turn cancelled");
        } else {
          setLog("Turn busy; cancel unavailable");
        }
        return;
      }
      client?.close();
      exit();
      return;
    }

    if (mode === "compose") {
      // Steer path only when opened via `i` while busy; otherwise Enter enqueues.
      if (busy && steerCompose) {
        if (key.return) {
          const text = input.trim();
          setInput("");
          setSteerDraft("");
          setMode("command");
          setSteerCompose(false);
          if (!text || !activeChatId || !client) return;
          const res = await client.request({
            type: "agent.turn.steer",
            chatId: activeChatId,
            content: text,
          });
          const data = (res.data || {}) as {
            outcome?: string;
            reason?: string;
          };
          setLog(
            res.ok
              ? data.outcome === "complete_delivered"
                ? "Steer inyectado"
                : `Steer en follow-up: ${data.reason || ""}`
              : res.error || "steer failed",
          );
          return;
        }
        if (key.backspace || key.delete) {
          const next = input.slice(0, -1);
          setInput(next);
          setSteerDraft(next);
          return;
        }
        if (ch && !key.ctrl && !key.meta) {
          const next = input + ch;
          setInput(next);
          setSteerDraft(next);
        }
        return;
      }
      if (slashOpen && (key.upArrow || key.downArrow)) {
        const dir = key.downArrow ? 1 : -1;
        setSlashIndex((i) => {
          const n = slashItems.length;
          if (!n) return 0;
          return (i + dir + n) % n;
        });
        return;
      }
      if (slashOpen && (key.tab || key.return) && slashItems[slashIndex]) {
        const item = slashItems[slashIndex]!;
        setSlashOpen(false);
        setSlashItems([]);
        if (item.executeOnPick) {
          setInput("");
          setMode("command");
          await runSlashCommand(item.insert);
        } else {
          applyComposeText(item.insert);
        }
        return;
      }
      if (slashOpen && key.return && slashItems.length === 0) {
        setSlashOpen(false);
        setLog("Sin coincidencias — /help");
        return;
      }
      if (pickerOpen && (key.upArrow || key.downArrow)) {
        const dir = key.downArrow ? 1 : -1;
        setPickerIndex((i) => {
          const n = pickerItems.length;
          if (!n) return 0;
          return (i + dir + n) % n;
        });
        return;
      }
      if (pickerOpen && (key.tab || key.return) && pickerItems[pickerIndex]) {
        const chosen = pickerItems[pickerIndex]!;
        const raw = chosen.isDir ? `${chosen.path}/` : chosen.path;
        const token = /\s/.test(raw) ? `@"${raw}"` : `@${raw}`;
        const mention = activeMention(input);
        const next = mention
          ? input.slice(0, mention.start) + token + " "
          : input + token + " ";
        applyComposeText(next);
        setPickerOpen(false);
        setPickerItems([]);
        return;
      }
      if (pickerOpen && key.return && pickerItems.length === 0) {
        setPickerOpen(false);
        setLog("Sin coincidencias");
        return;
      }
      if (key.return) {
        const text = input.trim();
        setInput("");
        setMode("command");
        setSlashOpen(false);
        setPickerOpen(false);
        if (!text) return;
        if (text.trim() === "/apply") {
          await applyCurrentPlan();
          return;
        }
        if (isSlashInput(text)) {
          await runSlashCommand(text);
          return;
        }
        await sendWithLlm(text);
        return;
      }
      if (key.tab) return;
      if (key.backspace || key.delete) {
        applyComposeText(input.slice(0, -1));
        return;
      }
      if (ch && !key.ctrl && !key.meta) {
        applyComposeText(input + ch);
      }
      return;
    }

    if (key.escape) {
      client?.close();
      exit();
      return;
    }

    if (ch === "q") {
      client?.close();
      exit();
      return;
    }

    if (ch === "l") {
      setSkillsOverlay((panel) => ({ ...panel, open: false }));
      setRulesOverlay(true);
      return;
    }

    if (ch === "k") {
      setRulesOverlay(false);
      setSkillsOverlay((panel) => ({
        ...panel,
        open: true,
        error: null,
      }));
      if (!client) {
        setSkillsOverlay({
          open: true,
          snapshot: null,
          error: NO_DAEMON_ERROR,
        });
        return;
      }
      void client
        .request({ type: "workspace.skills.snapshot" }, 15_000)
        .then((res) => {
          if (!res.ok) {
            setSkillsOverlay({
              open: true,
              snapshot: null,
              error: res.error || NO_DAEMON_ERROR,
            });
            return;
          }
          setSkillsOverlay({
            open: true,
            snapshot: res.data as SkillsSnapshot,
            error: null,
          });
        })
        .catch(() => {
          setSkillsOverlay({
            open: true,
            snapshot: null,
            error: NO_DAEMON_ERROR,
          });
        });
      return;
    }

    if (ch === "t") {
      setThinkingOpen((open) => !open);
      return;
    }

    if (ch === "L" && client && activeChatId) {
      setReplayErr(null);
      const res = await client.request({ type: "chat.replay", chatId: activeChatId });
      if (!res.ok) {
        setLog(res.error || "replay failed");
        setReplayErr(res.error || "replay failed");
        setView("replay");
        setReplayText("");
        return;
      }
      const text = (res.data as { text?: string })?.text || "";
      setReplayText(text);
      setView("replay");
      setLog("Replay (solo lectura)");
      return;
    }

    if ((ch === "e" || ch === "E") && client && activeChatId) {
      const res = await client.request({
        type: "chat.export",
        chatId: activeChatId,
        format: "md",
      });
      if (!res.ok) {
        setLog(res.error || "chat.export failed");
        return;
      }
      const markdown = String((res.data as { markdown?: string })?.markdown || "");
      setExportOverlay({
        markdown,
        url: null,
        status: TUI_EXPORT_HINT,
        chatId: activeChatId,
      });
      return;
    }

    if (ch === "i" && busy) {
      setMode("compose");
      setSteerCompose(true);
      setInput(steerDraft);
      setSlashOpen(false);
      setPickerOpen(false);
      setLog("Steer + Enter · Esc cancela compose (no el turn)");
      return;
    }

    // Navigation always available (even while busy).
    if (key.tab) {
      setListFocus((f) => (f === "sessions" ? "chats" : "sessions"));
      return;
    }
    if (key.upArrow || key.downArrow) {
      const dir = key.upArrow ? -1 : 1;
      if (listFocus === "sessions") {
        setSessionCursor((i) => clampIndex(i + dir, sessions.length));
      } else {
        setChatCursor((i) => clampIndex(i + dir, chats.length));
      }
      return;
    }
    if (key.return) {
      if (listFocus === "sessions") {
        await selectSession(sessions[sessionCursor]);
        setListFocus("chats");
      } else {
        await selectChat(chats[chatCursor]);
      }
      return;
    }
    if (ch >= "1" && ch <= "9") {
      const idx = Number(ch) - 1;
      const session = sessions[idx];
      if (session) {
        setSessionCursor(idx);
        await selectSession(session);
        setListFocus("chats");
      }
      return;
    }

    async function resolveFirstAwaiting(decision: "approve" | "deny") {
      if (!client || !activeChatId) return;
      const awaiting = firstAwaiting(messages);
      if (!awaiting) {
        setLog(NO_APPROVAL_ERROR);
        return;
      }
      const toolCallId = String(
        (awaiting.metadata as Record<string, unknown>).toolCallId,
      );
      const res = await client.request({
        type: decision === "approve" ? "agent.tool.approve" : "agent.tool.deny",
        chatId: activeChatId,
        toolCallId,
      });
      if (!res.ok) {
        setResolveMsg(res.error || ALREADY_RESOLVED_ERROR);
        setLog(res.error || ALREADY_RESOLVED_ERROR);
        return;
      }
      setResolveMsg(null);
      setLog(`${decision} ${toolCallId.slice(0, 8)}…`);
    }

    if (ch === "y" || ch === "n") {
      await resolveFirstAwaiting(ch === "y" ? "approve" : "deny");
      return;
    }

    if (ch === "d") {
      setExpandDiffs((v) => !v);
      if (activeChatId && diffs.some((d) => d.truncated)) {
        setLog(`full: chavez headless chat diff ${activeChatId} <path>`);
      }
      return;
    }

    if (ch === "g" || ch === "G") {
      const wantDiff = ch === "G";
      setGitPanel((p) => {
        if (!p.open) return { ...p, open: true, showDiff: wantDiff };
        if (wantDiff || !p.showDiff) return { ...p, showDiff: true };
        return { ...p, showDiff: false };
      });
      void (async () => {
        const snapshot = await collectGitSnapshot(cwd);
        let diff: string | null = null;
        if (wantDiff || gitPanel.showDiff || gitPanel.open) {
          if (snapshot.isRepo) {
            const d = await collectDiffVsHead(cwd);
            diff = [d.stat, d.unified].filter(Boolean).join("\n\n");
          }
        }
        setGitPanel((p) => ({
          ...p,
          snapshot,
          diff: p.showDiff || wantDiff ? diff : p.diff,
          error: snapshot.isRepo ? null : snapshot.message || NOT_A_GIT_UI,
        }));
        if (!snapshot.isRepo) setLog(NOT_A_GIT_UI);
      })();
      return;
    }

    if (ch === "w") {
      setWtPanel((p) => ({ ...p, open: true, creating: false, newBranch: "" }));
      void refreshWorktrees().then((snap) => {
        if (snap && !snap.isRepo) setLog(WORKTREE_NO_GIT_UI);
      });
      return;
    }

    if (ch === "f") {
      setFindMode(true);
      setFindQuery("");
      setFindHits([]);
      setChatCursor(0);
      setListFocus("chats");
      setLog(SEARCH_PLACEHOLDER);
      return;
    }

    if (ch === "v" && activeSessionId) {
      const next = !showArchived;
      setShowArchived(next);
      await refreshChats(activeSessionId, next);
      setLog(next ? SHOW_ARCHIVED_LABEL : "Ocultar archivados");
      return;
    }

    if (ch === "x") {
      const queueId = lastQueuedIdForChat(queueSnap, activeChatId);
      if (queueId && client) {
        void client.request({ type: "agent.queue.cancel", queueId });
        return;
      }
      if (busy) {
        setLog("No hay queued en este chat");
        return;
      }
      // not busy + no queue → archive below
    }

    // Mutations blocked while generating (except compose `m` below).
    if (busy) {
      if (ch === "m" && activeChatId) {
        setSteerCompose(false);
        setMode("compose");
        setInput("");
        setLog(TUI_COMPOSE_WHILE_BUSY);
      }
      return;
    }

    const focusedChat =
      listFocus === "chats"
        ? chats[chatCursor]
        : chats.find((chat) => chat.id === activeChatId);

    if (ch === "*" && client && focusedChat) {
      const res = await client.request({
        type: "chat.update",
        chatId: focusedChat.id,
        pinned: !focusedChat.pinnedAt,
      });
      if (!res.ok) setLog(res.error || "chat.update failed");
      else {
        const updated = (res.data as { chat?: Chat })?.chat;
        if (updated) {
          setChats((prev) =>
            visibleChats(
              [...prev.filter((chat) => chat.id !== updated.id), updated],
              { includeArchived: showArchived },
            ),
          );
          setLog(
            `${updated.pinnedAt ? "*" : "Sin pin"} ${displayChatTitle(updated)}`,
          );
        }
      }
      return;
    }

    if (ch === "x" && client && focusedChat) {
      const archived = !focusedChat.archivedAt;
      const res = await client.request({
        type: "chat.update",
        chatId: focusedChat.id,
        archived,
      });
      if (!res.ok) setLog(res.error || "chat.update failed");
      else {
        const updated = (res.data as { chat?: Chat })?.chat;
        if (updated) {
          setChats((prev) =>
            visibleChats(
              [...prev.filter((chat) => chat.id !== updated.id), updated],
              { includeArchived: showArchived },
            ),
          );
        }
        setLog(archived ? ARCHIVE_LABEL : UNARCHIVE_LABEL);
      }
      return;
    }

    if (ch === "r") {
      if (!focusedChat) {
        setLog("No hay chat para renombrar");
        return;
      }
      setRenameMode(true);
      setInput(focusedChat.title || "");
      return;
    }

    if (ch === "a" && client && activeChatId) {
      await applyCurrentPlan();
      return;
    }

    if (ch === "C" && activeChatId) {
      await runCompact(activeChatId);
      return;
    }

    if (ch === "u" && client && activeChatId) {
      if (turnBusyRef.current) {
        setLog(TURN_BUSY_ERROR);
        return;
      }
      const lastUndo = canUndoLastTurn(messagesRef.current);
      if (!lastUndo.enabled) {
        if (lastUndo.reason === "UNDO_REQUIRES_GIT") setLog(NO_GIT_UI);
        else if (lastUndo.reason === "UNDO_NOOP") setLog(UNDO_NOOP);
        else if (lastUndo.reason === "UNDO_ALREADY") setLog(UNDO_ALREADY);
        else setLog(NO_GIT_UI);
        return;
      }
      const res = await client.request(
        { type: "agent.turn.undo", chatId: activeChatId },
        30_000,
      );
      if (!res.ok) setLog(res.error || "undo failed");
      else {
        const data = (res.data || {}) as {
          message?: string;
          warning?: string | null;
          noop?: boolean;
        };
        setLog(
          [data.message, data.warning].filter(Boolean).join(" — ") || "undone",
        );
        await loadChat(activeChatId);
      }
      return;
    }
    if (ch === "R" && client && activeChatId) {
      if (turnBusyRef.current) {
        setLog(TURN_BUSY_ERROR);
        return;
      }
      const res = await client.request(
        { type: "agent.turn.retry", chatId: activeChatId },
        30_000,
      );
      if (!res.ok) setLog(res.error || "retry failed");
      else setLog("Retry disparado (turn nuevo, mismas attaches)");
      return;
    }

    if (ch === "o") {
      const next = cycleExecutionMode(executionMode, 1);
      setExecutionMode(next);
      await persistPrefs({ activeExecutionMode: next });
      setLog(`Mode → ${next}`);
      return;
    }

    if (ch === "p") {
      const linked = (["claude", "cursor"] as const).filter(
        (id) => providersInfo?.providers[id]?.linked,
      );
      if (!linked.length) {
        setLog("Ningún provider vinculado");
        return;
      }
      const next = cycle(linked, provider, 1);
      setProvider(next);
      const nextModels = (providersInfo?.providers[next]?.models ??
        []) as AnyModel[];
      const mid =
        (next === "claude"
          ? defaultModelId("claude") || nextModels[0]?.id
          : nextModels[0]?.id) || "";
      setModelId(mid);
      if (next === "cursor") {
        const params = defaultParamsForModel(
          nextModels.find((m) => m.id === mid),
        );
        setActiveParams(params);
        setEffort("none");
        await persistPrefs({
          activeProvider: next,
          activeModel: mid,
          activeEffort: null,
          activeParams: params,
        });
      } else {
        const eff = defaultEffort("claude", mid);
        setEffort(eff);
        setActiveParams([]);
        await persistPrefs({
          activeProvider: next,
          activeModel: mid,
          activeEffort: eff,
          activeParams: null,
        });
      }
      setLog(`Provider → ${next}`);
      return;
    }

    if (ch === "]" || ch === "[") {
      if (!models.length) return;
      const dir = ch === "]" ? 1 : -1;
      const ids = models.map((m) => m.id);
      const next = cycle(ids, modelId, dir);
      setModelId(next);
      const nextModel = models.find((m) => m.id === next);
      if (provider === "cursor") {
        const params = defaultParamsForModel(nextModel);
        setActiveParams(params);
        await persistPrefs({
          activeModel: next,
          activeEffort: null,
          activeParams: params,
        });
      } else {
        const levels = (nextModel?.effortLevels ??
          getModel("claude", next)?.effortLevels ??
          ["none"]) as EffortLevel[];
        let nextEffort = effort;
        if (!levels.includes(effort)) {
          nextEffort = defaultEffort("claude", next);
          setEffort(nextEffort);
        }
        await persistPrefs({
          activeModel: next,
          activeEffort: nextEffort,
          activeParams: null,
        });
      }
      setLog(`Model → ${next}`);
      return;
    }

    if (ch === "}" || ch === "{") {
      const dir = ch === "}" ? 1 : -1;
      if (provider === "cursor") {
        const nextParams = cycleCursorParam(model, activeParams, dir);
        setActiveParams(nextParams);
        await persistPrefs({ activeParams: nextParams, activeEffort: null });
        setLog(`Params → ${formatParams(nextParams)}`);
        return;
      }
      const next = cycle(effortLevels, effort, dir);
      setEffort(next);
      await persistPrefs({ activeEffort: next });
      setLog(`Effort → ${next}`);
      return;
    }

    if (ch === "s" && client) {
      const res = await client.request({
        type: "session.create",
        title: `Session ${new Date().toLocaleTimeString()}`,
      });
      if (res.ok) {
        const session = (res.data as { session: Session }).session;
        setSessions((prev) => [session, ...prev]);
        setSessionCursor(0);
        setActiveSessionId(session.id);
        setActiveChatId(null);
        setMcpStatus(null);
        setMessages([]);
        setChatUsage("");
        setDiffs([]);
        setExpandDiffs(false);
        setChatCursor(0);
        setListFocus("chats");
        setLog(`Session ${session.id.slice(0, 8)}…`);
        await refreshChats(session.id);
      } else setLog(res.error || "session.create failed");
      return;
    }
    if (ch === "c" && client && activeSessionId) {
      const res = await client.request({
        type: "chat.create",
        sessionId: activeSessionId,
        title: DEFAULT_CHAT_TITLE,
      });
      if (res.ok) {
        const chat = (res.data as { chat: Chat }).chat;
        setChats((prev) => [...prev, chat].sort(compareChatsForList));
        setChatCursor(0);
        setActiveChatId(chat.id);
        setMcpStatus(null);
        setMessages([]);
        setChatUsage("");
        setDiffs([]);
        setExpandDiffs(false);
        setListFocus("chats");
        setLog(AUTOTITLE_PENDING_HINT);
      } else setLog(res.error || "chat.create failed");
      return;
    }
    if (ch === "m" && activeChatId) {
      setSteerCompose(false);
      setMode("compose");
      setInput("");
      setLog(
        busy || (queueSnap?.items.length ?? 0) > 0
          ? TUI_COMPOSE_WHILE_BUSY
          : "@ abre picker · Tab/Enter insertan · Esc cierra picker · Enter vacío cancela",
      );
    }
  });

  const priceLine =
    model && typeof model.inputPricePerMTok === "number"
      ? `$${model.inputPricePerMTok}/M in · $${model.outputPricePerMTok}/M out`
      : "—";
  const runnableLine =
    providerMeta?.runnable === false
      ? ` · LLM: not runnable${
          providerMeta.catalogError
            ? ` (${String(providerMeta.catalogError).slice(0, 80)})`
            : ""
        }`
      : "";

  const listedChats = findMode ? findHits : chats;
  const sessionWin = visibleWindow(sessions, sessionCursor);
  const chatWin = visibleWindow(listedChats, chatCursor);
  const activeChat = chats.find((chat) => chat.id === activeChatId);
  const autotitlePending =
    activeChat?.titleSource === "default" &&
    !messages.some((message) => message.role === "assistant");
  const displayedMessages = useMemo(
    () => mergeTimeline([], messages),
    [messages],
  );
  const toolDepths = useMemo(() => {
    const depthByToolCall = new Map<string, number>();
    const depthByMessage = new Map<string, number>();
    for (const message of displayedMessages) {
      if (message.role !== "tool") continue;
      const meta = (message.metadata || {}) as Record<string, unknown>;
      const toolCallId = String(meta.toolCallId || "");
      const parentToolCallId = String(meta.parentToolCallId || "");
      const parentDepth = parentToolCallId
        ? depthByToolCall.get(parentToolCallId)
        : undefined;
      const depth =
        parentDepth == null ? 0 : Math.min(2, parentDepth + 1);
      depthByMessage.set(message.id, depth);
      if (toolCallId) depthByToolCall.set(toolCallId, depth);
    }
    return depthByMessage;
  }, [displayedMessages]);
  const failedMcpBanner = mcpFailedBanner(mcpStatus);

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="green">
        Chavez TUI
      </Text>
      <Text>
        cwd: {effectiveCwdLabel}
        {wtPanel.snapshot && !wtPanel.snapshot.current?.isMain
          ? ` · ${WEB_WORKTREE_BADGE} ${wtPanel.snapshot.current?.branch || "detached"}`
          : ""}
      </Text>
      <Text>
        WS: {status}
        {workspaceId ? ` · workspace ${workspaceId.slice(0, 8)}…` : ""}
        {status === "bound" && !hasDaemonDown(notices)
          ? daemonRole === "primary"
            ? " · daemon/runner"
            : ""
          : status === "connecting"
            ? ""
            : ` · ${NO_RUNNER_LABEL}`}
      </Text>
      {hasDaemonDown(notices) || (status !== "bound" && status !== "connecting") ? (
        <Text color="red" bold>
          {NO_RUNNER_LABEL}
        </Text>
      ) : null}
      {status === "reconnecting" ? (
        <Text color="yellow">WS reconnecting…</Text>
      ) : null}
      {daemonRole === "standby" ? (
        <Text color="red">{DAEMON_STANDBY_NOTE}</Text>
      ) : null}
      <Text>
        host: {daemonHostname || hostname()} · {cwd}
        {lastSeen ? ` · last-seen ${lastSeen}` : ""}
      </Text>
      <Text>
        provider:{" "}
        <Text color={providerMeta?.linked ? "cyan" : "red"}>
          {provider}
          {providerMeta?.linked
            ? ` (${providerMeta.authKind})`
            : " (not linked)"}
        </Text>
        {" · "}
        model:{" "}
        <Text color="yellow">{modelLabel(model, modelId)}</Text>
        {" · "}
        {provider === "cursor" ? (
          <>
            params: <Text color="magenta">{formatParams(activeParams)}</Text>
          </>
        ) : (
          <>
            effort: <Text color="magenta">{effort}</Text>
          </>
        )}
        {" · "}
        mode: <Text color="cyan">{executionMode}</Text>
      </Text>
      {onboarding?.wizardVisible ? (
        <Text color="yellow">
          {formatOnboardingHint(onboarding).split("\n")[0]}
          {onboarding.nextCommand ? ` — ${onboarding.nextCommand}` : ""}
        </Text>
      ) : null}
      <Text dimColor>
        precios: {priceLine}
        {runnableLine}
      </Text>
      {error ? <Text color="red">{error}</Text> : null}
      {contextBanner ? (
        <Text color="yellow">{contextBanner}</Text>
      ) : null}
      <Text dimColor>
        {wtPanel.open
          ? TUI_WORKTREE_HINT
          : "[Tab] listas  [↑↓]  [Enter] abrir  [s][c][m]  [E] export  [L] replay  [*] pin  [x] dequeue  [r] título  [f] buscar  [v] archivados  [l] reglas  [w] worktree  [q]"}
      </Text>
      {autotitlePending ? (
        <Text dimColor>{AUTOTITLE_PENDING_HINT}</Text>
      ) : null}
      {(() => {
        const lastUndo = canUndoLastTurn(messages);
        if (!lastUndo.enabled && lastUndo.reason === "UNDO_REQUIRES_GIT") {
          return <Text dimColor>undo: hace falta git</Text>;
        }
        return null;
      })()}
      {busy ? (
        <Text color="yellow">
          … generando · Esc cancela el turn · i steer · t thinking
        </Text>
      ) : null}
      {(() => {
        const badge = formatQueueBadge(queueSnap, activeChatId);
        return badge ? <Text color="cyan">{badge}</Text> : null;
      })()}
      {busy || (queueSnap?.items.length ?? 0) > 0 ? (
        <Text dimColor>{TUI_COMPOSE_WHILE_BUSY}</Text>
      ) : null}
      {failedMcpBanner ? (
        <Text color="red">{failedMcpBanner}</Text>
      ) : null}
      {(() => {
        const awaiting = firstAwaiting(messages);
        if (!awaiting) {
          return resolveMsg ? (
            <Text color="yellow">{resolveMsg}</Text>
          ) : null;
        }
        const meta = (awaiting.metadata || {}) as Record<string, unknown>;
        const prompt = meta.prompt as ApprovalPrompt | undefined;
        const needsNet = bannerNeedsNetwork(meta);
        const deadline =
          typeof meta.approvalDeadline === "string" ? meta.approvalDeadline : "";
        const left = deadline
          ? formatRemaining(remainingApprovalMs(deadline, nowMs))
          : "?";
        const head = prompt
          ? formatApprovalHeadline(prompt)
          : String(meta.summary || meta.toolName || "tool");
        const body =
          prompt && (prompt.kind === "write" || prompt.kind === "edit")
            ? prompt.diff.split("\n").slice(0, 8).join("\n")
            : prompt?.kind === "bash"
              ? `$ ${prompt.command}`
              : prompt?.kind === "git_commit"
                ? `${prompt.message}\n${prompt.paths.join("\n")}`
                : "";
        return (
          <Box flexDirection="column">
            <Text
              color={hasApproval(notices, activeChatId) ? "red" : "yellow"}
              bold={hasApproval(notices, activeChatId)}
            >
              {hasApproval(notices, activeChatId) ? `${APPROVAL_LABEL} ` : ""}
              awaiting approval {needsNet ? `${NETWORK_REQUEST_LABEL} ` : ""}
              {left} — [y] sí  [n] no (uno a uno)
            </Text>
            <Text>{head}</Text>
            {body ? <Text dimColor>{body}</Text> : null}
          </Box>
        );
      })()}
      {messages.some((m) => {
        const st = String((m.metadata as Record<string, unknown> | null)?.status || "");
        return m.role === "tool" && st === "running";
      }) ? (
        <Text color="yellow">tool running — compose bloqueado hasta que termine el turn</Text>
      ) : null}
      {view === "replay" ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color="cyan">
            Replay (read-only)
          </Text>
          <Text dimColor>{TUI_REPLAY_HINT}</Text>
          {replayErr ? <Text color="red">{replayErr}</Text> : null}
          <Text>{replayText || ""}</Text>
        </Box>
      ) : (
      <>
      <Box marginTop={1} flexDirection="column">
        <Text bold>
          {listFocus === "sessions" ? "› " : "  "}Sessions
          {sessions.length > LIST_WINDOW
            ? ` (${sessionCursor + 1}/${sessions.length})`
            : ""}
        </Text>
        {sessions.length === 0 ? (
          <Text dimColor>(ninguna — pulsa s)</Text>
        ) : (
          sessionWin.slice.map((s, i) => {
            const abs = sessionWin.offset + i;
            const focused =
              listFocus === "sessions" && abs === sessionCursor;
            const active = s.id === activeSessionId;
            return (
              <Text
                key={s.id}
                color={active ? "cyan" : undefined}
                bold={focused}
              >
                {focused ? ">" : " "}
                {abs < 9 ? ` ${abs + 1}` : "  "}. {s.title} ({s.id.slice(0, 8)})
              </Text>
            );
          })
        )}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text bold>
          {listFocus === "chats" ? "› " : "  "}
          {findMode ? "Buscar" : "Chats"}
          {listedChats.length > LIST_WINDOW
            ? ` (${chatCursor + 1}/${listedChats.length})`
            : ""}
          {showArchived && !findMode ? " · archivados visibles" : ""}
        </Text>
        {listedChats.length === 0 ? (
          <Text dimColor>
            {findMode ? NO_SEARCH_MATCHES : "(ninguno — pulsa c)"}
          </Text>
        ) : (
          chatWin.slice.map((c, i) => {
            const abs = chatWin.offset + i;
            const focused = listFocus === "chats" && abs === chatCursor;
            const active = c.id === activeChatId;
            const badgeKinds = notices.items.filter(
              (n) => n.chatId === c.id && shouldShowTuiBadge(n, activeChatId),
            );
            const ask = badgeKinds.some((n) => n.kind === "approval");
            const done = badgeKinds.some(
              (n) => n.kind === "turn_done" || n.kind === "turn_error",
            );
            const live = badgeKinds.some((n) => n.kind === "turn_start");
            const mark = ask ? " !" : done ? " ●" : live ? " …" : "";
            const queuedItem = queueSnap?.items.find((it) => it.chatId === c.id);
            const queuedSuffix = queuedItem
              ? ` · queued #${queuedItem.position}`
              : "";
            return (
              <Text
                key={c.id}
                color={ask ? "red" : active ? "yellow" : undefined}
                bold={focused || ask}
              >
                {focused ? ">" : " "} {c.pinnedAt ? "* " : ""}
                {displayChatTitle(c)}
                {c.archivedAt ? " (archivado)" : ""}{" "}
                <Text dimColor>({c.id.slice(0, 8)})</Text>
                {queuedSuffix ? (
                  <Text color="cyan">{queuedSuffix}</Text>
                ) : null}
                {mark ? (
                  <Text color={ask ? "red" : done ? "green" : "cyan"}>{mark}</Text>
                ) : null}
              </Text>
            );
          })
        )}
      </Box>
      <Box marginTop={1} flexDirection="column" height={12}>
        <Text bold>Messages</Text>
        {displayedMessages.slice(-10).map((m) => {
          const { color, text } = formatTuiMessage(
            m,
            toolDepths.get(m.id) ?? 0,
          );
          const thinking = thinkingFromMetadata(m.metadata ?? null);
          const ignored = m.role === "user" ? ignoredAttachLines(m) : [];
          const cost =
            m.role === "assistant" ? formatTurnUsageLine(m.metadata) : null;
          return (
            <Box key={m.id} flexDirection="column">
              {thinking ? (
                <Text dimColor>
                  {thinking.omitted
                    ? THINKING_OMITTED_LABEL
                    : thinkingOpen
                      ? `▾ ${THINKING_COLLAPSED_LABEL}: ${thinking.text}`
                      : `▸ ${THINKING_COLLAPSED_LABEL} ${truncateThinkingPreview(
                          thinking.text || "",
                        )}`}
                </Text>
              ) : null}
              <Text wrap="truncate-end" color={color}>
                {text}
                {cost ? <Text dimColor>  ({cost})</Text> : null}
              </Text>
              {ignored.map((line) => (
                <Text key={line} color="yellow">
                  ⚠ {line}
                </Text>
              ))}
              {m.role === "assistant" &&
              (m.metadata as { rules?: RulesMetadata } | undefined)?.rules ? (
                <Text dimColor>
                  {rulesWatchLine(
                    (m.metadata as { rules: RulesMetadata }).rules,
                  )}
                </Text>
              ) : null}
              {(() => {
                const vLine =
                  m.role === "assistant"
                    ? assistantVerificationLine(m.metadata)
                    : null;
                if (!vLine) return null;
                const vStatus = (
                  m.metadata as { verification?: { status?: string } } | null
                )?.verification?.status;
                return (
                  <Text
                    color={
                      vStatus === "failed" || vStatus === "timeout"
                        ? "red"
                        : undefined
                    }
                  >
                    {vLine}
                  </Text>
                );
              })()}
            </Box>
          );
        })}
        {busy && thinkingLive ? (
          <Text dimColor>
            {thinkingOpen
              ? thinkingLive.slice(-400)
              : `▸ ${THINKING_COLLAPSED_LABEL} ${truncateThinkingPreview(
                  thinkingLive,
                )}`}
          </Text>
        ) : null}
        {shouldShowLiveAssistant(messages, streamIdRef.current, streaming) ? (
          <Text color="green" wrap="truncate-end">
            assistant: {streamText.replace(/\s+/g, " ").slice(0, 100) || "…"}
          </Text>
        ) : null}
        <Text dimColor>
          cost: {chatUsage || NO_USAGE_TEXT}
        </Text>
        {diffs.length > 0 ? (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>
              diffs {diffs.length}  (d expande)
            </Text>
            {diffs.map((d) => (
              <Text key={d.id} wrap="truncate-end">
                {d.kind === "created" ? "+" : d.kind === "deleted" ? "−" : "~"}{" "}
                {d.path}  +{d.additions} −{d.deletions}
                {d.truncated ? " [truncated]" : ""}
                {d.binary ? " [binary]" : ""}
              </Text>
            ))}
            {expandDiffs &&
              diffs.slice(0, 3).map((d) => (
                <Box key={`${d.id}-p`} flexDirection="column">
                  <Text dimColor>{d.path}</Text>
                  <Text>{d.preview.split("\n").slice(0, 12).join("\n")}</Text>
                  {d.truncated && activeChatId ? (
                    <Text dimColor>
                      full: chavez headless chat diff {activeChatId} {d.path}
                    </Text>
                  ) : null}
                </Box>
              ))}
          </Box>
        ) : null}
      </Box>
      </>
      )}
      {exportOverlay ? (
        <Box flexDirection="column" borderStyle="single" paddingX={1} marginTop={1}>
          <Text bold>Export / share</Text>
          <Text dimColor>{TUI_EXPORT_HINT}  [Y] link  [R] revocar</Text>
          {exportOverlay.url ? <Text color="cyan">{exportOverlay.url}</Text> : null}
          <Text dimColor>{exportOverlay.status}</Text>
          <Text>{exportOverlay.markdown.split("\n").slice(0, 18).join("\n")}</Text>
        </Box>
      ) : null}
      {mode === "compose" ? (
        <Box flexDirection="column">
          <Text>
            {busy && steerCompose ? "steer" : "compose"}&gt; {input}
            <Text inverse> </Text>
          </Text>
          {busy && steerCompose ? (
            <Text dimColor>
              Steer + Enter · Esc cancela compose (no el turn)
            </Text>
          ) : busy || (queueSnap?.items.length ?? 0) > 0 ? (
            <Text dimColor>{TUI_COMPOSE_WHILE_BUSY}</Text>
          ) : null}
        </Box>
      ) : null}
      {renameMode ? (
        <Text>
          título&gt; {input}
          <Text inverse> </Text>
        </Text>
      ) : null}
      {findMode ? (
        <Text>
          buscar&gt; {findQuery || SEARCH_PLACEHOLDER}
          <Text inverse> </Text>
        </Text>
      ) : null}
      {mode === "compose" && slashOpen ? (
        <Box flexDirection="column">
          <Text dimColor>/ commands · máx 10 · no archivos</Text>
          {slashItems.length === 0 ? (
            <Text color="yellow">Sin coincidencias — /help</Text>
          ) : (
            slashItems.map((c, i) => (
              <Text
                key={c.id}
                color={i === slashIndex ? "cyan" : undefined}
                bold={i === slashIndex}
              >
                {i === slashIndex ? ">" : " "} {c.label}
              </Text>
            ))
          )}
          <Text dimColor>Tab/Enter insertan · Esc cierra</Text>
        </Box>
      ) : null}
      {mode === "compose" && pickerOpen && !slashOpen ? (
        <Box flexDirection="column">
          <Text dimColor>
            @ picker · {hostname()} · {cwd} · máx 10
          </Text>
          {pickerItems.length === 0 ? (
            <Text color="yellow">Sin coincidencias</Text>
          ) : (
            pickerItems.map((c, i) => (
              <Text
                key={c.path}
                color={i === pickerIndex ? "cyan" : undefined}
                bold={i === pickerIndex}
              >
                {i === pickerIndex ? ">" : " "}{" "}
                {c.isDir ? `${c.path}/` : c.path}
              </Text>
            ))
          )}
          <Text dimColor>Tab/Enter insertan · Esc cierra el picker</Text>
        </Box>
      ) : null}
      {skillsOverlay.open ? (
        <Box flexDirection="column" marginTop={1} borderStyle="single">
          <Text bold>
            Skills{" "}
            {skillsOverlay.snapshot
              ? `user=${skillsOverlay.snapshot.counts.user} project=${skillsOverlay.snapshot.counts.project} local=${skillsOverlay.snapshot.counts.local} applied=${skillsOverlay.snapshot.counts.total}`
              : ""}
          </Text>
          <Text dimColor>[esc] cerrar</Text>
          {skillsOverlay.error ? (
            <Text color="red">{skillsOverlay.error}</Text>
          ) : skillsOverlay.snapshot ? (
            skillsOverlay.snapshot.applied.map((skill) => (
              <Text key={`${skill.layer}:${skill.name}`}>
                - {skill.layer}: {skill.name}
              </Text>
            ))
          ) : (
            <Text dimColor>cargando…</Text>
          )}
        </Box>
      ) : null}
      {rulesOverlay ? (
        <Box flexDirection="column" marginTop={1} borderStyle="single">
          <Text bold>
            Reglas  user={userRules.filter((r) => r.enabled !== false).length}{" "}
            project={projectRuleRefs.length} local={localRuleRefs.length}{" "}
            usuario en este workspace: {userRulesEnabled ? "on" : "off"}
          </Text>
          <Text dimColor>[u] toggle usuario   [esc] cerrar</Text>
          {userRules.map((r) => (
            <Text key={r.id}>
              - user: {r.title}
              {r.enabled === false ? " (off)" : ""}
              {r.body && r.body.length > 2000 ? " …" : ""}
            </Text>
          ))}
          {projectRuleRefs.map((r) => (
            <Text key={r.id ?? r.path ?? r.title}>
              - project: {r.title}
              {r.path ? ` (${r.path})` : ""}
              {r.truncated ? " …" : ""}
            </Text>
          ))}
          {localRuleRefs.map((r) => (
            <Text key={r.id ?? r.path ?? r.title}>
              - local: {r.title}
              {r.path ? ` (${r.path})` : ""}
              {r.truncated ? " …" : ""}
            </Text>
          ))}
        </Box>
      ) : null}
      {wtPanel.open ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>worktree</Text>
          {wtPanel.error ? (
            <Text color="yellow">{wtPanel.error}</Text>
          ) : null}
          {wtPanel.creating ? (
            <Text>
              nueva rama: {wtPanel.newBranch}
              <Text color="cyan">▌</Text>
            </Text>
          ) : wtPanel.snapshot?.isRepo ? (
            wtPanel.snapshot.worktrees.map((entry, i) => (
              <Text
                key={entry.path}
                color={i === wtCursor ? "cyan" : undefined}
              >
                {i === wtCursor ? "> " : "  "}
                {entry.isMain ? "@main" : entry.branch || "(detached)"} {entry.path}
                {entry.locked ? " [locked]" : ""}
              </Text>
            ))
          ) : null}
        </Box>
      ) : null}
      {gitPanel.open ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>
            git{" "}
            {gitPanel.snapshot?.isRepo
              ? `${gitPanel.snapshot.branch || "(detached)"}  ↑${gitPanel.snapshot.ahead} ↓${gitPanel.snapshot.behind}`
              : "disabled"}
          </Text>
          {!gitPanel.snapshot?.isRepo ? (
            <Text color="yellow">{gitPanel.error || NOT_A_GIT_UI}</Text>
          ) : gitPanel.snapshot.dirty.length === 0 ? (
            <Text dimColor>clean</Text>
          ) : (
            gitPanel.snapshot.dirty.slice(0, 12).map((f) => (
              <Text key={f.path}>
                {"  "}
                {f.index}
                {f.worktree} {f.path}
              </Text>
            ))
          )}
          {gitPanel.prUrl ? <Text color="cyan">pr  {gitPanel.prUrl}</Text> : null}
          {gitPanel.showDiff && gitPanel.diff ? (
            <Text>
              {gitPanel.diff.split("\n").slice(0, 40).join("\n")}
            </Text>
          ) : gitPanel.open && gitPanel.snapshot?.isRepo ? (
            <Text dimColor>G diff vs HEAD</Text>
          ) : null}
        </Box>
      ) : null}
      {log ? <Text dimColor>{log}</Text> : null}
    </Box>
  );
}
