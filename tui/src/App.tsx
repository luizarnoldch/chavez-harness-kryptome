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
import { publishAgentTurn } from "../../cli/src/llm/publish-turn";
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
import { randomUUID } from "node:crypto";
import {
  NO_GIT_UI,
  TURN_BUSY_ERROR,
  UNDO_ALREADY,
  UNDO_NOOP,
  UNDO_REQUIRES_GIT,
} from "../../cli/src/llm/undo-constants";
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
import { workspaceHash } from "../../cli/src/workspace";
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
import {
  assistantVerificationLine,
  toolLine,
  verificationFailureLog,
} from "./verify-line";

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
type Chat = { id: string; title: string; sessionId: string };
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

function formatTuiMessage(m: Message): { color: string; text: string } {
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
  if (m.role === "tool") {
    const meta = (m.metadata || {}) as Record<string, unknown>;
    const kind = String(meta.kind || "");
    if (kind === "verify" || kind === "lint") {
      const status = String(meta.status || "running");
      return {
        color: status === "error" ? "red" : "cyan",
        text: toolLine(m),
      };
    }
    const sdkName = String(meta.sdkName || meta.toolName || "tool");
    const status = String(meta.status || "running");
    const color =
      status === "error"
        ? "red"
        : status === "done"
          ? "cyan"
          : status === "awaiting_approval"
            ? "magenta"
            : "yellow";
    const resolved = meta.resolution
      ? ` · ${ALREADY_RESOLVED_ERROR}`
      : "";
    const text = `${toolHeadline(sdkName, status, meta.input)}${resolved}`;
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
  return {
    color: m.role === "assistant" ? "green" : "magenta",
    text: `${m.role}${cancelled}${undone}${modeTag}: ${m.content.replace(/\s+/g, " ").slice(0, 100)}${
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
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
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

  const [provider, setProvider] = useState<"claude" | "cursor">("claude");
  const [modelId, setModelId] = useState<string>("claude-sonnet-4-6");
  const [effort, setEffort] = useState<EffortLevel>("medium");
  const [activeParams, setActiveParams] = useState<CursorParam[]>([]);
  const [executionMode, setExecutionMode] = useState<ExecutionMode>("ask");
  const [userRules, setUserRules] = useState<DispatchUserRule[]>([]);
  const [userRulesEnabled, setUserRulesEnabled] = useState(true);
  const [rulesOverlay, setRulesOverlay] = useState(false);
  const [projectRuleRefs, setProjectRuleRefs] = useState<RuleRef[]>([]);
  const [localRuleRefs, setLocalRuleRefs] = useState<RuleRef[]>([]);
  const [providersInfo, setProvidersInfo] = useState<ProvidersResponse | null>(
    null,
  );
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
            });
            if (chatRes.ok && !cancelled) {
              const chatRows =
                (chatRes.data as { chats?: Chat[] })?.chats ?? [];
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
              }
            }
          }
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

  const refreshChats = useCallback(async (sessionId: string) => {
    if (!client) return [] as Chat[];
    const res = await client.request({ type: "chat.list", sessionId });
    if (res.ok) {
      const rows = (res.data as { chats?: Chat[] })?.chats ?? [];
      setChats(rows);
      setChatCursor((c) => clampIndex(c, rows.length));
      return rows;
    }
    return [] as Chat[];
  }, [client]);

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
      setChatCursor((c) => {
        const idx = chats.findIndex((x) => x.id === chat.id);
        return idx >= 0 ? idx : c;
      });
      await loadChat(chat.id);
      setLog(`Chat activo: ${chat.title}`);
    },
    [chats, loadChat],
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

      if (msg.type === "agent.turn.dispatch") {
        if (!data.chatId || !data.prompt) return;
        if (daemonRoleRef.current === "standby") return;
        if (turnBusyRef.current) {
          setLog("Turn already running on this daemon");
          void client.request({
            type: "chat.stream.error",
            chatId: data.chatId,
            streamId: crypto.randomUUID(),
            content: "Turn already running on this daemon",
          });
          return;
        }
        turnBusyRef.current = true;
        setBusy(true);
        setLog(`Turn Web → chat ${data.chatId.slice(0, 8)}…`);

        if (data.sessionId) {
          setActiveSessionId(data.sessionId);
          const sIdx = sessionsRef.current.findIndex(
            (s) => s.id === data.sessionId,
          );
          if (sIdx >= 0) setSessionCursor(sIdx);
          void refreshChats(data.sessionId).then((rows) => {
            const cIdx = rows.findIndex((c) => c.id === data.chatId);
            if (cIdx >= 0) setChatCursor(cIdx);
          });
        }
        setActiveChatId(data.chatId);
        setListFocus("chats");
        void loadChat(data.chatId);

        void publishAgentTurn({
          client,
          chatId: data.chatId,
          prompt: data.prompt,
          cwd: data.path || cwd,
          token,
          mentions: data.mentions,
          attachments: (data as { attachments?: unknown[] }).attachments,
          retryOfStreamId: (data as { retryOfStreamId?: string }).retryOfStreamId,
          executionMode: parseExecutionMode(
            data.executionMode ?? (data as { executionMode?: string }).executionMode,
          ),
          planBrief: data.planBrief,
          userRules: (data as { userRules?: DispatchUserRule[] }).userRules,
          userRulesEnabled:
            (data as { userRulesEnabled?: boolean }).userRulesEnabled !== false,
        })
          .then(async () => {
            const msgs = await loadChat(data.chatId!);
            const failLog = verificationFailureLog(msgs);
            setLog(failLog || "Turn remoto completado");
          })
          .catch((e) => {
            setLog(e instanceof Error ? e.message : String(e));
          })
          .finally(() => {
            turnBusyRef.current = false;
            setBusy(false);
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
        }
      }

      if (msg.type === "chat.stream.error") {
        setBusy(false);
        turnBusyRef.current = false;
        setStreaming(false);
        const err = String(data.error || data.content || "");
        if (
          err === "Turn already running on this daemon" ||
          err.includes("no ejecuta agente") ||
          err.includes("No daemon bound") ||
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
  }, [client, cwd, token, loadChat, refreshChats]);

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
      if (turnBusyRef.current) {
        setLog("Ya hay un turn en curso");
        return;
      }
      if (daemonRole === "standby") {
        setLog("Standby — despachando al primary…");
        const res = await client.request({
          type: "agent.turn.request",
          chatId: activeChatId,
          prompt: text,
        });
        if (!res.ok) setLog(res.error || "agent.turn.request failed");
        return;
      }
      setBusy(true);
      turnBusyRef.current = true;
      setLog("Enviando…");
      try {
        setLog(`${provider} thinking (${modelId})…`);
        await publishAgentTurn({
          client,
          chatId: activeChatId,
          prompt: text,
          cwd,
          token,
          executionMode,
          userRules: userRules.filter((r) => r.enabled !== false),
          userRulesEnabled,
        });
        const msgs = await loadChat(activeChatId);
        const failLog = verificationFailureLog(msgs);
        setLog(failLog || "Respuesta recibida");
      } catch (e) {
        setLog(e instanceof Error ? e.message : String(e));
      } finally {
        turnBusyRef.current = false;
        setBusy(false);
      }
    },
    [
      client,
      activeChatId,
      loadChat,
      provider,
      providersInfo,
      modelId,
      effort,
      executionMode,
      token,
      cwd,
      daemonRole,
      userRules,
      userRulesEnabled,
    ],
  );

  useInput(async (ch, key) => {
    if (key.ctrl && ch === "c") {
      client?.close();
      exit();
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
        setLog(busy ? "Steer cancelado" : "Compose cancelado");
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
      if (busy) {
        if (key.return) {
          const text = input.trim();
          setInput("");
          setSteerDraft("");
          setMode("command");
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

    if (ch === "r") {
      setRulesOverlay(true);
      return;
    }

    if (ch === "t") {
      setThinkingOpen((open) => !open);
      return;
    }

    if (ch === "i" && busy) {
      setMode("compose");
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

    // Mutations blocked while generating.
    if (busy) return;

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
        title: `Chat ${new Date().toLocaleTimeString()}`,
      });
      if (res.ok) {
        const chat = (res.data as { chat: Chat }).chat;
        setChats((prev) => [chat, ...prev]);
        setChatCursor(0);
        setActiveChatId(chat.id);
        setMessages([]);
        setChatUsage("");
        setDiffs([]);
        setExpandDiffs(false);
        setListFocus("chats");
        setLog(`Chat ${chat.id.slice(0, 8)}…`);
      } else setLog(res.error || "chat.create failed");
      return;
    }
    if (ch === "m" && activeChatId) {
      setMode("compose");
      setInput("");
      setLog(
        "@ abre picker · Tab/Enter insertan · Esc cierra picker · Enter vacío cancela",
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

  const sessionWin = visibleWindow(sessions, sessionCursor);
  const chatWin = visibleWindow(chats, chatCursor);

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="green">
        Chavez TUI
      </Text>
      <Text>cwd: {cwd}</Text>
      <Text>
        WS: {status}
        {status === "bound" && daemonRole === "primary"
          ? " · daemon/runner"
          : ""}
        {workspaceId ? ` · workspace ${workspaceId.slice(0, 8)}…` : ""}
      </Text>
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
      <Text dimColor>
        precios: {priceLine}
        {runnableLine}
      </Text>
      {error ? <Text color="red">{error}</Text> : null}
      {contextBanner ? (
        <Text color="yellow">{contextBanner}</Text>
      ) : null}
      <Text dimColor>
        [Tab] listas  [↑↓]  [Enter] abrir  [1-9] session  [s][c][m][d][g]  [a] apply plan  [C] compact  [u] undo  [R] retry  [r] reglas  [p]  / cmds  [Esc] cancel turn  [i] steer  [t] thinking
        [[]/]] model  [{"{"}/{"}"}] {provider === "cursor" ? "params" : "effort"}  [o] mode  [g] git  [y]/[n] approval  [q] quit
      </Text>
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
        const awaiting = firstAwaiting(messages);
        if (!awaiting) {
          return resolveMsg ? (
            <Text color="yellow">{resolveMsg}</Text>
          ) : null;
        }
        const meta = (awaiting.metadata || {}) as Record<string, unknown>;
        const prompt = meta.prompt as ApprovalPrompt | undefined;
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
            <Text color="yellow">
              awaiting approval {left} — [y] sí  [n] no (uno a uno)
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
          {listFocus === "chats" ? "› " : "  "}Chats
          {chats.length > LIST_WINDOW
            ? ` (${chatCursor + 1}/${chats.length})`
            : ""}
        </Text>
        {chats.length === 0 ? (
          <Text dimColor>(ninguno — pulsa c)</Text>
        ) : (
          chatWin.slice.map((c, i) => {
            const abs = chatWin.offset + i;
            const focused = listFocus === "chats" && abs === chatCursor;
            const active = c.id === activeChatId;
            return (
              <Text
                key={c.id}
                color={active ? "yellow" : undefined}
                bold={focused}
              >
                {focused ? ">" : " "} {c.title} ({c.id.slice(0, 8)})
              </Text>
            );
          })
        )}
      </Box>
      <Box marginTop={1} flexDirection="column" height={12}>
        <Text bold>Messages</Text>
        {mergeTimeline([], messages).slice(-10).map((m) => {
          const { color, text } = formatTuiMessage(m);
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
      {mode === "compose" ? (
        <Box flexDirection="column">
          <Text>
            {busy ? "steer" : "compose"}&gt; {input}
            <Text inverse> </Text>
          </Text>
          {busy ? (
            <Text dimColor>
              Steer + Enter · Esc cancela compose (no el turn)
            </Text>
          ) : null}
        </Box>
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
