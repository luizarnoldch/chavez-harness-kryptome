import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AppProviders } from "./AppProviders";
import {
  formatQueryError,
  useChat,
  useChatExport,
  useChatReplay,
  useChatShare,
  useConnections,
  useCreateShare,
  useMe,
  useOnboarding,
  useProviderPreferences,
  useProviders,
  useRevokeShare,
  useSession,
  useWorkspaceSessions,
  type ChatMessage,
} from "../lib/hooks";
import { ReplayPanel } from "./ReplayPanel";
import { DaemonPresence, NO_DAEMON_ERROR } from "./DaemonPresence";
import {
  askPreflightError,
} from "../lib/onboarding";
import { FileTreePanel } from "./FileTreePanel";
import { apiJson } from "../lib/api";
import { appendMention } from "../lib/mentions";
import {
  diffsForStream,
  kindLabel,
  statLabel,
  streamIdOf,
  type TurnFileDiff,
} from "../lib/diff-display";
import { ALREADY_RESOLVED_ERROR } from "../lib/approval-constants";
import {
  formatRemaining,
  remainingApprovalMs,
} from "../lib/approval-deadline";
import {
  formatApprovalHeadline,
  type ApprovalPrompt,
} from "../lib/approval-prompt";
import {
  NETWORK_REQUEST_LABEL,
  bannerNeedsNetwork,
} from "../lib/network-constants";
import { parseExecutionMode } from "../lib/execution-mode";
import { rulesWatchLine, type RulesMetadata } from "../lib/rules-display";
import { parseMentions } from "../lib/mentions";
import { queryKeys } from "../lib/query-keys";
import { useWs } from "../lib/ws-context";
import {
  useWsAgentCancel,
  useWsAgentSteer,
  useWsAgentTurn,
  useWsChatAppend,
  useWsChatCompact,
  useWsChatCreate,
  useWsChatGet,
  useWsPlanApply,
  useWsPlanSetCurrent,
  useWsPlanUpdate,
  useWsQueueCancel,
  useWsToolResolve,
  useWsTurnRetry,
  useWsTurnUndo,
} from "../lib/ws-hooks";
import {
  QUEUE_POSITION_PREFIX,
  formatWebQueueHint,
  isQueuedMessage,
  type QueueSnapshot,
} from "../lib/queue";
import { PlanCard } from "./PlanCard";
import { asPlanMeta, isPlanArtifact } from "../lib/plan-artifact";
import { isSlashInput } from "../lib/slash";
import { runSlash, type PrefsSnapshot, type SlashIo } from "../lib/slash-run";
import {
  formatContextBanner,
  isCompactMarker,
} from "../lib/context-budget";
import { canUndoLastTurn } from "../lib/turn-select";
import { NO_GIT_UI, UNDO_NOOP, UNDO_REQUIRES_GIT } from "../lib/undo-constants";
import {
  AttachmentChips,
  type AttachmentMeta,
} from "./AttachmentChips";
import { MentionComposer } from "./MentionComposer";
import { ChatUsagePanel, TurnCostBadge } from "./ChatUsagePanel";
import { GitPanel } from "./GitPanel";
import { WorktreeBar } from "./WorktreeBar";
import { canonicalToolName, truncateToolText } from "../lib/tool-display";
import {
  canonicalMcpName,
  groupToolsBySubagent,
  mcpFailedBanner,
} from "../lib/mcp-display";
import {
  toolKindLabel,
  verificationBannerText,
  verificationFromMeta,
  VERIFY_TIMEOUT_ERROR,
} from "../lib/verify-display";
import {
  applyStreamDelta,
  mergeTimeline,
  shouldShowLiveAssistant,
} from "../lib/timeline";
import { ThinkingBlock } from "./ThinkingBlock";
import {
  STEER_UNSUPPORTED,
  thinkingFromMetadata,
} from "../lib/thinking";
import { ChatOrgBar } from "./ChatOrgBar";
import { displayChatTitle } from "../lib/chat-org";
import { useNotifications } from "../lib/notification-context";
import {
  emptyNotificationState,
  shouldShowWebChatBanner,
} from "../lib/notifications";
import { hydrateFromMessages } from "../lib/notification-hydrate";

function IgnoredAttachNote({ m }: { m: ChatMessage }) {
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
  if (!items.length) return null;
  return (
    <ul className="muted" style={{ fontSize: "0.8rem" }}>
      {items.map((a) => (
        <li key={String(a.path)}>
          ⚠ {a.error || `Ignored path (not hydrated): ${a.path}`}
        </li>
      ))}
    </ul>
  );
}

const READ_CANON = new Set(["read", "grep", "glob", "git_status", "git_diff"]);

function isReadTool(meta: Record<string, unknown>): boolean {
  const canon = String(meta.toolName || "").toLowerCase();
  const sdk = String(meta.sdkName || "");
  return (
    READ_CANON.has(canon) ||
    sdk === "Read" ||
    sdk === "Grep" ||
    sdk === "Glob" ||
    sdk === "LS"
  );
}

function ToolCard({ m, chatId }: { m: ChatMessage; chatId: string }) {
  const meta = (m.metadata || {}) as Record<string, unknown>;
  const kind = String(meta.kind || "tool");
  const rawName = String(meta.sdkName || meta.toolName || m.content || "tool");
  const name =
    kind === "mcp" || kind === "skill" || kind === "subagent"
      ? canonicalMcpName(rawName)
      : canonicalToolName(rawName);
  const status = String(meta.status || "running");
  const kindBadge = toolKindLabel(kind, name);
  const prUrl =
    typeof meta.prUrl === "string" && meta.prUrl
      ? meta.prUrl
      : typeof meta.output === "string"
        ? /https:\/\/github\.com\/[^\s]+\/pull\/\d+/.exec(meta.output)?.[0]
        : undefined;
  const resolve = useWsToolResolve();
  const [now, setNow] = useState(() => Date.now());
  const [localError, setLocalError] = useState<string | null>(null);
  const prompt = meta.prompt as ApprovalPrompt | undefined;
  const awaiting =
    status === "awaiting_approval" &&
    !meta.resolution &&
    kind !== "skill" &&
    kind !== "subagent" &&
    !isReadTool(meta);
  const deadline =
    typeof meta.approvalDeadline === "string" ? meta.approvalDeadline : "";

  useEffect(() => {
    if (!awaiting || !deadline) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [awaiting, deadline]);

  async function decide(decision: "approve" | "deny") {
    setLocalError(null);
    try {
      const res = await resolve.mutateAsync({
        chatId,
        toolCallId: String(meta.toolCallId),
        decision,
      });
      if (!res.ok) {
        setLocalError(res.error || ALREADY_RESOLVED_ERROR);
      }
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      setLocalError(text);
    }
  }

  const badgeLabel =
    kind === "verify" || kind === "lint"
      ? `${kindBadge} · ${status}`
      : `${["mcp", "skill", "subagent"].includes(kind) ? kind : "tool"} · ${name} · ${status}`;
  const outputText =
    meta.output != null
      ? typeof meta.output === "string"
        ? truncateToolText(meta.output)
        : truncateToolText(JSON.stringify(meta.output))
      : null;
  const outputPre =
    outputText != null ? (
      <pre style={{ whiteSpace: "pre-wrap", margin: "0.5rem 0 0", fontSize: "0.8rem" }}>
        out: {outputText}
      </pre>
    ) : null;

  return (
    <div
      className={`panel tool-card${awaiting ? " tool-ask" : ""}`}
      style={{ marginBottom: "0.5rem" }}
      data-testid={awaiting ? "tool-ask" : undefined}
    >
      <span
        className={`badge ${
          kind === "verify"
            ? "test"
            : kind === "lint"
              ? "lint"
              : status === "done"
                ? "ok"
                : status === "error"
                  ? "err"
                  : awaiting
                    ? "warn"
                    : ""
        }`}
      >
        {badgeLabel}
        {meta.resolution ? ` · ${ALREADY_RESOLVED_ERROR}` : ""}
      </span>
      {awaiting && bannerNeedsNetwork(meta) ? (
        <span className="badge warn" data-testid="needs-network">
          {NETWORK_REQUEST_LABEL}
        </span>
      ) : null}
      {kind === "subagent" && status === "running" ? (
        <p className="muted" style={{ margin: "0.5rem 0 0" }}>
          running
        </p>
      ) : prompt ? (
        <p style={{ margin: "0.5rem 0 0" }}>
          {formatApprovalHeadline(prompt)}
        </p>
      ) : meta.summary ? (
        <p className="muted" style={{ margin: "0.5rem 0 0" }}>
          {String(meta.summary)}
        </p>
      ) : null}
      {prompt && (prompt.kind === "write" || prompt.kind === "edit") && (
        <pre className="approval-diff">{prompt.diff}</pre>
      )}
      {prompt?.kind === "bash" && (
        <pre className="approval-diff">$ {prompt.command}</pre>
      )}
      {prompt?.kind === "git_commit" && (
        <pre className="approval-diff">
          {prompt.message}
          {"\n"}
          {prompt.paths.join("\n")}
        </pre>
      )}
      {awaiting && deadline && (
        <p className="muted" style={{ margin: "0.5rem 0 0" }}>
          Timeout en {formatRemaining(remainingApprovalMs(deadline, now))}
        </p>
      )}
      {awaiting && (
        <div className="approval-actions">
          <button
            type="button"
            disabled={resolve.isPending}
            onClick={() => void decide("approve")}
          >
            Aprobar
          </button>
          <button
            type="button"
            className="secondary"
            disabled={resolve.isPending}
            onClick={() => void decide("deny")}
          >
            Rechazar
          </button>
        </div>
      )}
      {!awaiting && Boolean(meta.resolution) && (
        <p className="muted">
          {typeof localError === "string" && localError.includes("ya resuelto")
            ? localError
            : `${ALREADY_RESOLVED_ERROR} (${String(meta.resolution)})`}
        </p>
      )}
      {localError && <p className="error">{localError}</p>}
      {prUrl && status === "done" && (
        <p>
          <a href={prUrl} target="_blank" rel="noreferrer">
            {prUrl}
          </a>
        </p>
      )}
      {outputPre &&
        status !== "awaiting_approval" &&
        (kind === "lint" ? (
          <div className="diagnostics-block">{outputPre}</div>
        ) : (
          outputPre
        ))}
    </div>
  );
}

function SubagentGroup({
  root,
  children,
  chatId,
}: {
  root: ChatMessage;
  children: ChatMessage[];
  chatId: string;
}) {
  const meta = (root.metadata || {}) as Record<string, unknown>;
  const status = String(meta.status || "running");
  const agentType = String(meta.agentType || "subagent");
  const description = String(meta.description || root.content || "");
  return (
    <details open={status === "running"} className="panel" style={{ marginBottom: "0.5rem" }}>
      <summary>
        <span className={`badge ${status === "done" ? "ok" : status === "error" ? "err" : ""}`}>
          subagent · {agentType} · {status}
        </span>{" "}
        {description}
      </summary>
      <div style={{ marginTop: "0.5rem", marginLeft: "1rem" }}>
        <ToolCard m={root} chatId={chatId} />
        {children.map((child) => (
          <ToolCard key={child.id} m={child} chatId={chatId} />
        ))}
      </div>
    </details>
  );
}

function DiffLine({ line }: { line: string }) {
  let cls = "";
  if (line.startsWith("+") && !line.startsWith("+++")) cls = "diff-add";
  else if (line.startsWith("-") && !line.startsWith("---")) cls = "diff-del";
  else if (line.startsWith("@@")) cls = "diff-hunk";
  else if (
    line.startsWith("diff ") ||
    line.startsWith("---") ||
    line.startsWith("+++")
  ) {
    cls = "diff-meta";
  }
  return (
    <span className={cls}>
      {line}
      {"\n"}
    </span>
  );
}

function FileDiff({ d, chatId }: { d: TurnFileDiff; chatId: string }) {
  const [full, setFull] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const text = full ?? d.preview;
  async function loadFull() {
    setPending(true);
    setErr(null);
    try {
      const res = await apiJson<{
        diff: { body?: string | null; preview?: string; omitted?: boolean };
      }>(`/chats/${chatId}/diffs/${d.id}`);
      if (res.diff.omitted || res.diff.body == null) {
        setFull(res.diff.preview || d.preview);
      } else {
        setFull(res.diff.body);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="panel diff-panel" style={{ marginBottom: "0.5rem" }}>
      <p style={{ margin: 0 }}>
        <span className="badge">{kindLabel(String(d.kind))}</span>{" "}
        <code>{d.path}</code>{" "}
        <span className="muted">{statLabel(d)}</span>
        {d.status === "proposed" && <span className="badge warn"> proposed</span>}
        {d.truncated && !full && <span className="badge"> truncated</span>}
        {d.binary && <span className="badge"> binary</span>}
      </p>
      <pre style={{ whiteSpace: "pre-wrap", margin: "0.5rem 0 0" }}>
        {text.split("\n").map((line, i) => (
          <DiffLine key={i} line={line} />
        ))}
      </pre>
      {d.truncated && !full && !d.binary && (
        <p style={{ margin: "0.5rem 0 0" }}>
          <button type="button" className="secondary" disabled={pending} onClick={() => void loadFull()}>
            {pending ? "Cargando…" : "Ver diff completo"}
          </button>
        </p>
      )}
      {err && <p className="error">{err}</p>}
    </div>
  );
}

function DiffsPanel({
  diffs,
  chatId,
}: {
  diffs: TurnFileDiff[];
  chatId: string;
}) {
  if (diffs.length === 0) return null;
  return (
    <div className="diff-set" style={{ marginBottom: "0.75rem" }}>
      <p className="muted" style={{ margin: "0 0 0.35rem" }}>
        {diffs.length} archivo{diffs.length === 1 ? "" : "s"} tocado{diffs.length === 1 ? "" : "s"}
      </p>
      {diffs.map((d) => (
        <FileDiff key={d.id} d={d} chatId={chatId} />
      ))}
    </div>
  );
}

function useWebSlashIo() {
  const prefs = useProviderPreferences();
  const providers = useProviders();
  const createChat = useWsChatCreate();
  const append = useWsChatAppend();
  const getChat = useWsChatGet();
  const ws = useWs();
  const io: SlashIo = {
    getPrefs: async () => {
      const data = providers.data;
      if (!data) throw new Error("providers not loaded");
      return data as unknown as PrefsSnapshot;
    },
    putPrefs: async (patch: {
      activeProvider?: string | null;
      activeModel?: string | null;
      activeExecutionMode?: string | null;
    }) => prefs.mutateAsync(patch) as Promise<PrefsSnapshot>,
    compact: async (chatId: string) => {
      const res = await ws.request({ type: "chat.compact", chatId });
      if (!res.ok) throw new Error(res.error || "compact failed");
      const data = (res.data || {}) as { message?: { content?: string } };
      return { text: data.message?.content || "contexto compactado" };
    },
    undo: async (chatId: string) => {
      const res = await ws.request({ type: "agent.turn.undo", chatId });
      if (!res.ok) throw new Error(res.error || "undo failed");
      const data = (res.data || {}) as { message?: string; noop?: boolean };
      return {
        text:
          data.message ||
          (data.noop
            ? "Nothing to undo: the last turn made no applied changes"
            : "undone"),
      };
    },
    applyPlan: async (chatId: string) => {
      const res = await ws.request({ type: "chat.plan.apply", chatId });
      if (!res.ok) throw new Error(res.error || "chat.plan.apply failed");
      return (res.data || {}) as {
        executionMode?: string;
        gitCommit?: boolean;
      };
    },
    createChat: async (sessionId: string, title: string) => {
      const res = await createChat.mutateAsync({ sessionId, title });
      const chat = (res.data as { chat?: { id: string } })?.chat;
      if (!chat?.id) throw new Error("chat.create returned no id");
      return { id: chat.id };
    },
    getChat: async (chatId: string) => {
      const res = await getChat.mutateAsync(chatId);
      const data = (res.data || {}) as {
        messages?: Array<{ role?: string; content?: string; metadata?: unknown }>;
        usage?: unknown;
        context?: unknown;
      };
      return { messages: data.messages ?? [], usage: data.usage ?? data.context };
    },
    appendResult: async (
      chatId: string,
      content: string,
      meta: { kind: "slash_result"; command: string; ok: boolean },
    ) => {
      await append.mutateAsync({
        chatId,
        content,
        role: "system",
        metadata: meta,
      });
    },
  };
  return { io, providers };
}

function ChatDetailInner({ chatId }: { chatId: string }) {
  const notices = useNotifications();
  useEffect(() => {
    notices.setViewingChatId(chatId);
    notices.markRead(chatId);
    return () => notices.setViewingChatId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- chatId is the viewing key
  }, [chatId]);
  const me = useMe();
  const signedIn = Boolean(me.data);
  const chat = useChat(chatId, signedIn);
  const chatExport = useChatExport();
  const chatShare = useChatShare(chatId, signedIn);
  const createShare = useCreateShare();
  const revokeShare = useRevokeShare();
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  useEffect(() => {
    if (chatShare.data?.url) setShareUrl(chatShare.data.url);
  }, [chatShare.data?.url]);

  async function downloadExport(format: "md" | "json") {
    try {
      const data = await chatExport.mutateAsync({ chatId, format });
      const text =
        format === "md"
          ? String((data as { markdown?: string }).markdown || "")
          : `${JSON.stringify(data, null, 2)}\n`;
      const blob = new Blob([text], {
        type: format === "md" ? "text/markdown" : "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `chat-${chatId.slice(0, 8)}.${format === "md" ? "md" : "json"}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      /* surfaced via mutation error elsewhere if needed */
    }
  }

  async function onShare() {
    try {
      const res = await createShare.mutateAsync(chatId);
      setShareUrl(res.url);
    } catch {
      /* ignore */
    }
  }

  async function onRevoke() {
    try {
      await revokeShare.mutateAsync(chatId);
      setShareUrl(null);
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    if (!chat.data?.messages) return;
    const next = hydrateFromMessages(
      emptyNotificationState(),
      chat.data.messages.map((m) => ({
        role: m.role,
        chatId,
        metadata: (m.metadata || null) as Record<string, unknown> | null,
      })),
      chatId,
    );
    for (const n of next.items) {
      notices.apply("chat.tool.update", {
        chatId,
        toolCallId: n.toolCallId,
        metadata: {
          status: "awaiting_approval",
          toolName: "write",
          toolCallId: n.toolCallId,
        },
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- hydrate asks without resetting live daemon state
  }, [chat.data?.messages, chatId]);
  const qc = useQueryClient();
  const ws = useWs();
  const append = useWsChatAppend();
  const agent = useWsAgentTurn();
  const queueCancel = useWsQueueCancel();
  const undoMut = useWsTurnUndo();
  const retryMut = useWsTurnRetry();
  const cancelTurnMut = useWsAgentCancel();
  const steerMut = useWsAgentSteer();
  const compact = useWsChatCompact();
  const planUpdate = useWsPlanUpdate();
  const planApply = useWsPlanApply();
  const planSetCurrent = useWsPlanSetCurrent();
  const providers = useProviders(undefined, signedIn);
  const onboarding = useOnboarding(signedIn);
  const prefs = useProviderPreferences();
  const { io } = useWebSlashIo();
  const currentMode = parseExecutionMode(providers.data?.activeExecutionMode);
  const modelIds = useMemo(() => {
    const pid = providers.data?.activeProvider || "claude";
    return (providers.data?.providers?.[pid]?.models ?? [])
      .map((m) =>
        m && typeof m === "object" && "id" in m
          ? String((m as { id: unknown }).id)
          : "",
      )
      .filter(Boolean);
  }, [providers.data]);
  const [prompt, setPrompt] = useState("");
  const [manual, setManual] = useState("");
  const [role, setRole] = useState("user");
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null,
  );
  const [queueSnap, setQueueSnap] = useState<QueueSnapshot | null>(null);
  const [appliedMode, setAppliedMode] = useState<string | null>(null);
  const [streamText, setStreamText] = useState("");
  const [thinkingLive, setThinkingLive] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [replayOpen, setReplayOpen] = useState(false);
  const [replayStreamId, setReplayStreamId] = useState<string | null>(null);
  const [turnBusy, setTurnBusy] = useState(false);
  const [mcpServers, setMcpServers] = useState<
    Array<{ name: string; status: string }>
  >([]);
  const [degraded, setDegraded] = useState<string | null>(null);
  const [activeSkills, setActiveSkills] = useState<
    Array<{ name: string; layer: string }>
  >([]);
  const [steerText, setSteerText] = useState("");
  const [streamId, setStreamId] = useState<string | null>(null);
  const [runnerBound, setRunnerBound] = useState<boolean | null>(null);
  const deltaStateRef = useRef({ nextSeq: 1, buffer: new Map<number, string>() });
  const replayQuery = useChatReplay(
    chatId,
    replayStreamId,
    replayOpen && signedIn,
  );

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const attach = q.get("attach");
    if (!attach) return;
    const isDir = q.get("dir") === "1";
    setPrompt((prev) => appendMention(prev, attach, isDir));
    q.delete("attach");
    q.delete("dir");
    const search = q.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${search ? `?${search}` : ""}`,
    );
  }, [chatId]);

  useEffect(() => {
    if (ws.status !== "open") return;
    void ws
      .request({ type: "agent.queue.list", chatId })
      .then((res) => {
        setQueueSnap(res.data as QueueSnapshot);
      })
      .catch(() => {
        /* list is best-effort */
      });
  }, [ws, chatId, ws.status]);

  useEffect(() => {
    return ws.onPush((ev) => {
      const data = ev.data as {
        chatId?: string;
        delta?: string;
        seq?: number;
        error?: string;
        content?: string;
        message?: ChatMessage;
        streamId?: string;
        bound?: boolean;
        path?: string | null;
        outcome?: string;
        reason?: string;
        servers?: Array<{ name: string; status: string }>;
        name?: string;
        layer?: string;
      };
      if (ev.type === "agent.queue.updated") {
        setQueueSnap(ev.data as QueueSnapshot);
      }
      if (ev.type === "daemon.presence") {
        setRunnerBound(Boolean(data.bound));
      }
      if (data?.chatId && data.chatId !== chatId) return;
      if (ev.type === "chat.updated") {
        void qc.invalidateQueries({ queryKey: queryKeys.chat(chatId) });
      }
      if (ev.type === "agent.turn.started") setTurnBusy(true);
      if (ev.type === "agent.turn.ended") {
        setStreaming(false);
        setTurnBusy(false);
        setStreamText("");
        setThinkingLive("");
        void qc.invalidateQueries({ queryKey: queryKeys.chat(chatId) });
      }
      if (
        ev.type === "chat.checkpoint.undone" ||
        ev.type === "chat.checkpoint.finalized"
      ) {
        void qc.invalidateQueries({ queryKey: queryKeys.chat(chatId) });
      }
      if (ev.type === "chat.stream.start") {
        setStreaming(true);
        setStreamText("");
        setThinkingLive("");
        setDegraded(null);
        setActiveSkills([]);
        deltaStateRef.current = { nextSeq: 1, buffer: new Map() };
        setStreamId(data.streamId || null);
      }
      if (ev.type === "chat.mcp.status") {
        setMcpServers(Array.isArray(data.servers) ? data.servers : []);
      }
      if (ev.type === "chat.capability.degraded") {
        const degradedMessage =
          typeof data.message === "object" && data.message
            ? String((data.message as ChatMessage).content || "")
            : String((data as { content?: string }).content || "");
        if (degradedMessage) setDegraded(degradedMessage);
      }
      if (ev.type === "chat.skill.activated" && data.name) {
        setActiveSkills((current) => [
          ...current.filter(
            (skill) =>
              skill.name !== data.name || skill.layer !== String(data.layer || ""),
          ),
          { name: data.name!, layer: String(data.layer || "") },
        ]);
      }
      if (ev.type === "chat.thinking.delta" && data?.delta) {
        setThinkingLive((prev) => prev + data.delta);
      }
      if (ev.type === "chat.stream.delta" && data?.delta) {
        setStreaming(true);
        setStreamText((prev) =>
          applyStreamDelta(prev, data.delta!, data.seq, deltaStateRef.current),
        );
      }
      if (ev.type === "chat.stream.end" || ev.type === "chat.stream.error") {
        setStreaming(false);
        setTurnBusy(false);
        if (data.message) {
          qc.setQueryData(
            queryKeys.chat(chatId),
            (prev: { chat: unknown; messages: ChatMessage[] } | undefined) => {
              if (!prev) return prev;
              return {
                ...prev,
                messages: mergeTimeline(prev.messages, data.message!),
              };
            },
          );
        }
        setStreamText("");
        setThinkingLive("");
        if (ev.type === "chat.stream.error") {
          const errText =
            (data as { error?: string; content?: string; message?: string })
              .error ||
            (data as { content?: string }).content;
          if (errText === VERIFY_TIMEOUT_ERROR) {
            setMsg({ kind: "error", text: errText });
            setStreaming(false);
          } else if (errText) {
            setMsg({ kind: "error", text: errText });
          }
        }
        void qc.invalidateQueries({ queryKey: queryKeys.chat(chatId) });
      }
      if (ev.type === "chat.steer") {
        const reverted = data.outcome === "revert_to_followup";
        const delivered = data.outcome === "complete_delivered";
        setMsg({
          kind: reverted || delivered ? "ok" : "error",
          text:
            data.reason ||
            (reverted
              ? STEER_UNSUPPORTED
              : delivered
                ? "Steer injected into the running turn"
                : "Steer failed"),
        });
        void qc.invalidateQueries({ queryKey: queryKeys.chat(chatId) });
      }
      if (
        ev.type === "chat.context.usage" ||
        ev.type === "chat.compact.done"
      ) {
        void qc.invalidateQueries({ queryKey: queryKeys.chat(chatId) });
      }
      if (ev.type === "prefs.updated") {
        void qc.invalidateQueries({ queryKey: queryKeys.providers() });
        void qc.invalidateQueries({ queryKey: queryKeys.chat(chatId) });
      }
      if (ev.type.startsWith("chat.plan.")) {
        if (ev.type === "chat.plan.applied") {
          const em = (ev.data as { executionMode?: string } | undefined)
            ?.executionMode;
          if (em) setAppliedMode(em);
        }
        void qc.invalidateQueries({ queryKey: queryKeys.chat(chatId) });
        void qc.invalidateQueries({ queryKey: queryKeys.providers() });
      }
      if (
        ev.type === "message.appended" ||
        ev.type.startsWith("chat.tool.") ||
        ev.type === "chat.mcp.status" ||
        ev.type === "chat.skill.activated" ||
        ev.type === "chat.capability.degraded" ||
        ev.type.startsWith("chat.subagent.")
      ) {
        const incoming = data.message;
        if (incoming) {
          qc.setQueryData(
            queryKeys.chat(chatId),
            (prev: { chat: unknown; messages: ChatMessage[] } | undefined) => {
              if (!prev) return prev;
              return {
                ...prev,
                messages: mergeTimeline(prev.messages, incoming),
              };
            },
          );
        }
        void qc.invalidateQueries({ queryKey: queryKeys.chat(chatId) });
      }
    });
  }, [ws, chatId, qc]);

  async function runCompact() {
    setMsg(null);
    try {
      const res = await compact.mutateAsync({ chatId });
      const data = (res.data || {}) as { skipped?: boolean; reason?: string };
      if (!res.ok) {
        setMsg({ kind: "error", text: res.error || "compact failed" });
        return;
      }
      setMsg({
        kind: "ok",
        text: data.skipped
          ? data.reason || "Nothing to compact — chat is already short."
          : "contexto compactado",
      });
      void qc.invalidateQueries({ queryKey: queryKeys.chat(chatId) });
    } catch (err) {
      setMsg({ kind: "error", text: formatQueryError(err) });
    }
  }

  async function executeSlash(text: string) {
    setMsg(null);
    try {
      const sessionId = chat.data?.chat?.sessionId ?? null;
      const result = await runSlash(text, io, { chatId, sessionId });
      setPrompt("");
      setMsg({ kind: result.ok ? "ok" : "error", text: result.text });
      if (result.navigatedChatId) {
        window.location.assign(`/chats/${result.navigatedChatId}`);
        return;
      }
      void qc.invalidateQueries({ queryKey: queryKeys.chat(chatId) });
      void qc.invalidateQueries({ queryKey: queryKeys.providers() });
    } catch (err) {
      setMsg({ kind: "error", text: formatQueryError(err) });
    }
  }

  async function onAgent(e: FormEvent) {
    e.preventDefault();
    const text = prompt.trim();
    if (!text) return;
    if (text.trim() === "/apply") {
      setMsg(null);
      try {
        const res = await planApply.mutateAsync({ chatId });
        if (!res.ok) {
          setMsg({ kind: "error", text: res.error || "chat.plan.apply failed" });
          return;
        }
        const data = (res.data || {}) as {
          executionMode?: string;
          gitCommit?: boolean;
        };
        if (data.gitCommit) {
          setMsg({ kind: "error", text: "apply must not commit" });
          return;
        }
        setAppliedMode(data.executionMode || "ask");
        setPrompt("");
        setMsg({
          kind: "ok",
          text: `Plan aplicado → ${data.executionMode}. El siguiente turn usará el brief.`,
        });
        void qc.invalidateQueries({ queryKey: queryKeys.chat(chatId) });
        void qc.invalidateQueries({ queryKey: queryKeys.providers() });
      } catch (err) {
        setMsg({ kind: "error", text: formatQueryError(err) });
      }
      return;
    }
    if (isSlashInput(text)) {
      await executeSlash(text);
      return;
    }
    if (onboarding.data) {
      const pre = askPreflightError({
        runnableLinked: Boolean(onboarding.data.steps.providerLinked),
        daemonBound: Boolean(onboarding.data.steps.daemonBound),
      });
      if (pre) {
        setMsg({ kind: "error", text: pre });
        return;
      }
    }
    setMsg(null);
    try {
      const res = await agent.mutateAsync({
        chatId,
        prompt: text,
        mentions: parseMentions(text).map((m) => m.path),
      });
      setPrompt("");
      const data = res.data as { queued?: boolean; position?: number } | undefined;
      if (data?.queued) {
        setMsg({
          kind: "ok",
          text: formatWebQueueHint(Number(data.position) || 1),
        });
      } else {
        setMsg({
          kind: "ok",
          text: "Turn aceptado — TUI o headless daemon ejecutará el agente.",
        });
      }
      void qc.invalidateQueries({ queryKey: queryKeys.chat(chatId) });
    } catch (err) {
      setMsg({ kind: "error", text: formatQueryError(err) });
    }
  }

  async function onSteer(e: FormEvent) {
    e.preventDefault();
    const content = steerText.trim();
    if (!content) return;
    setMsg(null);
    try {
      const res = await steerMut.mutateAsync({ chatId, content });
      const data = (res.data || {}) as {
        outcome?: string;
        reason?: string;
      };
      setSteerText("");
      setMsg({
        kind: "ok",
        text:
          data.reason ||
          (data.outcome === "revert_to_followup"
            ? STEER_UNSUPPORTED
            : "Steer injected into the running turn"),
      });
      void qc.invalidateQueries({ queryKey: queryKeys.chat(chatId) });
    } catch (err) {
      setMsg({ kind: "error", text: formatQueryError(err) });
    }
  }

  async function onAppend(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      const res = await append.mutateAsync({
        chatId,
        content: manual.trim(),
        role,
      });
      const message = (res.data as { message?: ChatMessage } | undefined)
        ?.message;
      if (message) {
        qc.setQueryData(
          queryKeys.chat(chatId),
          (prev: { chat: unknown; messages: ChatMessage[] } | undefined) => {
            if (!prev) return prev;
            if (prev.messages.some((m) => m.id === message.id)) return prev;
            return { ...prev, messages: [...prev.messages, message] };
          },
        );
      }
      setManual("");
      setMsg({ kind: "ok", text: "Mensaje añadido (sync)." });
      void qc.invalidateQueries({ queryKey: queryKeys.chat(chatId) });
      void qc.invalidateQueries({ queryKey: ["workspaceSessions"] });
    } catch (err) {
      setMsg({ kind: "error", text: formatQueryError(err) });
    }
  }

  const sessionId = chat.data?.chat?.sessionId;
  const session = useSession(sessionId || "", Boolean(sessionId) && signedIn);
  const workspaceSessions = useWorkspaceSessions(
    session.data?.workspace?.id || "",
    Boolean(session.data?.workspace?.id) && signedIn,
  );
  const connections = useConnections(signedIn);
  const wsPath = session.data?.workspace?.path;
  const daemon = (connections.data || []).find(
    (c) =>
      c.clientKind === "daemon" &&
      (c.role === "primary" || !c.role) &&
      c.path === wsPath,
  );
  const bound =
    runnerBound !== null ? runnerBound : Boolean(daemon);
  const daemonLabel = daemon
    ? `${daemon.hostname || "daemon"} · ${daemon.path}`
    : null;
  const daemonError =
    connections.isLoading || bound ? null : NO_DAEMON_ERROR;
  const messages = mergeTimeline([], chat.data?.messages || []) as ChatMessage[];
  const toolGroups = groupToolsBySubagent(
    messages
      .filter((message) => message.role === "tool")
      .map((message) => ({
        ...message,
        metadata: message.metadata ?? undefined,
      })),
  );
  const groupedChildIds = new Set(
    [...toolGroups.childrenOf.values()].flat().map((message) => message.id),
  );
  const mcpBanner = mcpFailedBanner(mcpServers);
  const undoState = canUndoLastTurn(messages);
  const showLive = shouldShowLiveAssistant(messages, streamId, streaming);
  const allDiffs = (chat.data?.diffs || []).filter(
    (d) => d.status === "proposed" || d.status === "applied",
  );
  const rendered = new Set<string>();

  return (
    <div>
      <p className="muted">
        <a href="/">Hub</a> / <a href="/workspaces">Workspaces</a>
        {sessionId && (
          <>
            {" "}
            / <a href={`/sessions/${sessionId}`}>session</a>
          </>
        )}{" "}
        / <code>{chat.data ? displayChatTitle(chat.data.chat) : `${chatId.slice(0, 8)}…`}</code>
      </p>
      <div className="chat-with-tree">
        <FileTreePanel
          workspacePath={wsPath}
          workspaceId={session.data?.workspace?.id}
          onAttach={({ path, isDir }) => {
            setPrompt((prev) => appendMention(prev, path, isDir));
          }}
        />
        <div>
      <div className="panel">
        <h1>Chat</h1>
        <p>
          WS:{" "}
          <span className={`badge ${ws.status === "open" ? "ok" : ""}`}>
            {ws.status}
          </span>
          {streaming && <span className="badge ok"> streaming</span>}
          {(turnBusy || streaming) && (
            <span className="badge" style={{ background: "#c9a227" }}>
              {" "}
              busy
            </span>
          )}
        </p>
        <DaemonPresence
          bound={bound}
          hostname={daemon?.hostname}
          path={daemon?.path || wsPath}
          lastSeen={daemon?.lastSeen}
          error={daemonError}
        />
        <p className="muted" style={{ fontSize: "0.85rem" }}>
          Sin daemon no se hidrata @ ni se ejecutan tools.
        </p>
        <p className="muted" style={{ fontSize: "0.85rem" }}>
          Turns de agente: deja abierta la <strong>TUI</strong> (
          <code>chavez tui</code>) en el cwd del workspace, o{" "}
          <code>chavez headless workspace open</code>. Appends manuales
          sincronizan siempre vía WS.
        </p>
        <p>
          <button
            type="button"
            className="secondary"
            disabled={
              streaming ||
              !(chat.data?.messages || []).some(
                (m) => m.role === "assistant" || m.role === "tool",
              )
            }
            onClick={() => {
              setReplayStreamId(null);
              setReplayOpen(true);
            }}
          >
            Replay
          </button>
        </p>
        {replayOpen ? (
          <ReplayPanel
            text={replayQuery.data?.text || ""}
            replay={replayQuery.data?.replay}
            error={
              replayQuery.isError ? formatQueryError(replayQuery.error) : null
            }
            onClose={() => setReplayOpen(false)}
          />
        ) : null}
        {signedIn && chat.data && (
          <div className="panel">
            <h2>Exportar / compartir</h2>
            <p className="muted">
              Sin vault. Attaches como paths. Tools no se re-ejecutan al importar.
            </p>
            <button type="button" onClick={() => void downloadExport("md")}>
              Export markdown
            </button>{" "}
            <button
              type="button"
              className="secondary"
              onClick={() => void downloadExport("json")}
            >
              Export JSON
            </button>{" "}
            <button
              type="button"
              className="secondary"
              onClick={() => void onShare()}
            >
              Crear link de solo lectura
            </button>
            {shareUrl && (
              <p>
                <a href={shareUrl} target="_blank" rel="noreferrer">
                  {shareUrl}
                </a>{" "}
                <button
                  type="button"
                  className="secondary"
                  onClick={() => void onRevoke()}
                >
                  Revocar
                </button>
              </p>
            )}
          </div>
        )}
        {!me.isLoading && !signedIn && (
          <p className="error">
            No autorizado —{" "}
            <a href={`/sign-in?redirect=/chats/${chatId}`}>Sign in</a>
          </p>
        )}
        {chat.isLoading && signedIn && <p className="muted">Cargando…</p>}
        {chat.isError && (
          <p className="error">{formatQueryError(chat.error)}</p>
        )}
        {chat.data && (
          <>
            <ChatOrgBar
              chat={chat.data.chat}
              sessions={workspaceSessions.data?.sessions || []}
            />
            {formatContextBanner(chat.data?.context) && (
              <p
                className={
                  chat.data?.context?.level === "critical" ? "error" : undefined
                }
                role="status"
                style={
                  chat.data?.context?.level === "warn"
                    ? { color: "var(--warn, #b45309)" }
                    : undefined
                }
              >
                {formatContextBanner(chat.data?.context)}
              </p>
            )}
            {mcpBanner && (
              <p className="error" role="status">
                {mcpBanner}
              </p>
            )}
            {degraded && <p className="muted">{degraded}</p>}
            {notices.state.items
              .filter((n) => shouldShowWebChatBanner(n, chatId))
              .map((n) => (
                <p
                  key={n.id}
                  className={n.kind === "turn_error" || n.kind === "approval" ? "error" : "ok"}
                  data-testid="chat-turn-notice"
                  data-kind={n.kind}
                >
                  {n.title}
                  {n.kind === "approval" ? " — hasta resolver o timeout" : ""}
                </p>
              ))}
            <div className="messages">
              {messages.map((m, idx) => {
                if (groupedChildIds.has(m.id)) return null;
                const nodes = [];
                nodes.push(
                  isPlanArtifact(m.metadata) ? (
                    <PlanCard
                      key={m.id}
                      m={m}
                      busy={planUpdate.isPending || planApply.isPending || planSetCurrent.isPending}
                      onSave={async (markdown) => {
                        const res = await planUpdate.mutateAsync({
                          chatId,
                          artifactId: m.id,
                          markdown,
                        });
                        if (!res.ok) throw new Error(res.error || "chat.plan.update failed");
                        void qc.invalidateQueries({ queryKey: queryKeys.chat(chatId) });
                      }}
                      onApply={async () => {
                        const res = await planApply.mutateAsync({
                          chatId,
                          artifactId: m.id,
                        });
                        if (!res.ok) throw new Error(res.error || "chat.plan.apply failed");
                        const data = (res.data || {}) as {
                          executionMode?: string;
                          gitCommit?: boolean;
                        };
                        if (data.gitCommit) {
                          throw new Error("apply must not commit");
                        }
                        setAppliedMode(data.executionMode || "ask");
                        void qc.invalidateQueries({ queryKey: queryKeys.chat(chatId) });
                        void qc.invalidateQueries({ queryKey: queryKeys.providers() });
                      }}
                      onSetCurrent={async () => {
                        const res = await planSetCurrent.mutateAsync({
                          chatId,
                          artifactId: m.id,
                        });
                        if (!res.ok) throw new Error(res.error || "chat.plan.setCurrent failed");
                        void qc.invalidateQueries({ queryKey: queryKeys.chat(chatId) });
                      }}
                    />
                  ) : isCompactMarker(m) ? (
                    <div
                      key={m.id}
                      className="panel"
                      style={{ marginBottom: "0.5rem" }}
                      title={
                        typeof (m.metadata as { compactedMessageCount?: number })
                          ?.compactedMessageCount === "number"
                          ? `${(m.metadata as { compactedMessageCount: number }).compactedMessageCount} msgs`
                          : undefined
                      }
                    >
                      <span className="badge ok">contexto compactado</span>
                    </div>
                  ) : (m.metadata as { kind?: string } | null)?.kind ===
                    "slash_result" ? (
                    <div
                      key={m.id}
                      className="panel"
                      style={{ marginBottom: "0.5rem" }}
                    >
                      <span className="badge">slash</span>
                      <pre
                        style={{ whiteSpace: "pre-wrap", margin: "0.5rem 0 0" }}
                      >
                        {m.content}
                      </pre>
                    </div>
                  ) : isQueuedMessage(m.metadata) ? (
                    <div
                      key={m.id}
                      className="panel"
                      style={{ marginBottom: "0.5rem" }}
                    >
                      <span className="badge queued">
                        {QUEUE_POSITION_PREFIX}
                        {(() => {
                          const meta = (m.metadata || {}) as {
                            position?: number;
                            queueId?: string;
                          };
                          const live = queueSnap?.items.find(
                            (it) => it.queueId === m.id || it.queueId === meta.queueId,
                          );
                          return live?.position ?? meta.position ?? "?";
                        })()}
                      </span>
                      <pre
                        style={{ whiteSpace: "pre-wrap", margin: "0.5rem 0 0" }}
                      >
                        {m.content}
                      </pre>
                      <button
                        type="button"
                        className="secondary"
                        disabled={
                          queueCancel.isPending || ws.status !== "open"
                        }
                        onClick={async () => {
                          setMsg(null);
                          try {
                            await queueCancel.mutateAsync(m.id);
                            void qc.invalidateQueries({
                              queryKey: queryKeys.chat(chatId),
                            });
                          } catch (err) {
                            setMsg({
                              kind: "error",
                              text: formatQueryError(err),
                            });
                          }
                        }}
                      >
                        Quitar de la cola
                      </button>
                    </div>
                  ) : m.role === "tool" &&
                    String(
                      (m.metadata as Record<string, unknown> | null)?.kind || "",
                    ) === "subagent" ? (
                    <SubagentGroup
                      key={m.id}
                      root={m}
                      children={
                        toolGroups.childrenOf.get(
                          String(
                            (m.metadata as Record<string, unknown> | null)
                              ?.toolCallId || "",
                          ),
                        ) ||
                        toolGroups.childrenOf.get(
                          String(
                            (m.metadata as Record<string, unknown> | null)
                              ?.subagentId || "",
                          ),
                        ) ||
                        []
                      }
                      chatId={chatId}
                    />
                  ) : m.role === "tool" ? (
                    <ToolCard key={m.id} m={m} chatId={chatId} />
                  ) : (
                    <div
                      key={m.id}
                      className="panel"
                      style={{ marginBottom: "0.5rem" }}
                    >
                      <span className="badge">
                        {m.role}
                        {m.role === "user" &&
                        (m.metadata as { executionMode?: string } | null)
                          ?.executionMode
                          ? ` · ${(m.metadata as { executionMode: string }).executionMode}`
                          : ""}
                      </span>
                      <TurnCostBadge message={m} />
                      {(m.metadata as { undone?: boolean } | null)?.undone ? (
                        <span className="badge err">undone</span>
                      ) : null}
                      {m.role === "assistant" &&
                      (m.metadata as { status?: string } | null)?.status ===
                        "cancelled" ? (
                        <span className="badge err">cancelled</span>
                      ) : null}
                      {m.role === "user" ? (
                        <AttachmentChips
                          content={m.content}
                          attachments={
                            (m.metadata as { attachments?: AttachmentMeta[] } | null)
                              ?.attachments
                          }
                        />
                      ) : null}
                      {m.role === "assistant" ? (
                        <ThinkingBlock
                          thinking={thinkingFromMetadata(m.metadata)}
                        />
                      ) : null}
                      <pre
                        style={{ whiteSpace: "pre-wrap", margin: "0.5rem 0 0" }}
                      >
                        {m.content}
                      </pre>
                      {m.role === "assistant" ? (() => {
                        const v = verificationFromMeta(
                          m.metadata as Record<string, unknown>,
                        );
                        const banner = v ? verificationBannerText(v) : null;
                        if (!banner || !v) return null;
                        return (
                          <p
                            className={`panel verify-banner${v.status === "proposed" ? " plan" : ""}`}
                          >
                            {banner}
                          </p>
                        );
                      })() : null}
                      {m.role === "user" ? <IgnoredAttachNote m={m} /> : null}
                      {m.role === "assistant" &&
                      (m.metadata as { rules?: RulesMetadata } | null)?.rules ? (
                        <details>
                          <summary className="muted">
                            {rulesWatchLine(
                              (m.metadata as { rules: RulesMetadata }).rules
                                .counts,
                            )}
                          </summary>
                          <ul>
                            {(
                              m.metadata as { rules: RulesMetadata }
                            ).rules.applied.map((r) => (
                              <li
                                key={`${r.layer}-${r.id ?? r.path ?? r.title}`}
                              >
                                <span className="badge">{r.layer}</span>{" "}
                                {r.title}
                                {r.path ? <code> {r.path}</code> : null}
                                {r.truncated ? " …" : null}
                              </li>
                            ))}
                          </ul>
                        </details>
                      ) : null}
                    </div>
                  ),
                );
                const sid = streamIdOf(m);
                const next = messages[idx + 1];
                const nextSid = next ? streamIdOf(next) : undefined;
                const endOfTurn = sid && sid !== nextSid;
                if (endOfTurn && !rendered.has(sid)) {
                  rendered.add(sid);
                  const group = diffsForStream(allDiffs, sid);
                  if (group.length > 0) {
                    nodes.push(
                      <DiffsPanel key={`diff-${sid}`} diffs={group} chatId={chatId} />,
                    );
                  }
                }
                return nodes;
              })}
              {thinkingLive && <ThinkingBlock liveText={thinkingLive} />}
              {showLive && (
                <div className="panel" style={{ marginBottom: "0.5rem" }}>
                  <span className="badge ok">assistant · live</span>
                  {activeSkills.map((skill) => (
                    <span
                      key={`${skill.name}-${skill.layer}`}
                      className="badge"
                    >
                      skill · {skill.name} · {skill.layer}
                    </span>
                  ))}
                  <pre style={{ whiteSpace: "pre-wrap", margin: "0.5rem 0 0" }}>
                    {streamText || "…"}
                  </pre>
                </div>
              )}
              {messages.length === 0 && !streaming && (
                <p className="muted">Sin mensajes.</p>
              )}
            </div>
          </>
        )}
      </div>

      {signedIn && (
        <div className="panel">
          <h2>Enviar al agente</h2>
          {(() => {
            const pre =
              onboarding.data &&
              askPreflightError({
                runnableLinked: onboarding.data.steps.providerLinked,
                daemonBound: onboarding.data.steps.daemonBound,
              });
            return pre ? <p className="error">{pre}</p> : null;
          })()}
          {messages.some((m) => asPlanMeta(m.metadata)?.pendingApply) && (
            <p className="ok">
              Plan listo. El próximo envío al agente lo usa como brief (modo{" "}
              {appliedMode || "ask/auto"}). No se ha hecho git commit.
            </p>
          )}
          <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.75rem" }}>
            <button
              type="button"
              className="secondary"
              disabled={
                !undoState.enabled ||
                undoMut.isPending ||
                streaming ||
                ws.status !== "open"
              }
              title={
                undoState.enabled
                  ? "Deshacer el último turn (git)"
                  : undoState.reason === "UNDO_REQUIRES_GIT"
                    ? NO_GIT_UI
                    : undoState.reason === "UNDO_NOOP"
                      ? UNDO_NOOP
                      : "Undo no disponible"
              }
              onClick={async () => {
                setMsg(null);
                try {
                  const res = await undoMut.mutateAsync({ chatId });
                  if (!res.ok) {
                    setMsg({ kind: "error", text: res.error || "undo failed" });
                    return;
                  }
                  const data = (res.data || {}) as {
                    message?: string;
                    warning?: string | null;
                    noop?: boolean;
                  };
                  setMsg({
                    kind: "ok",
                    text:
                      [data.message, data.warning].filter(Boolean).join(" — ") ||
                      "undone",
                  });
                  void qc.invalidateQueries({ queryKey: queryKeys.chat(chatId) });
                } catch (err) {
                  setMsg({ kind: "error", text: formatQueryError(err) });
                }
              }}
            >
              {undoMut.isPending ? "Deshaciendo…" : "Deshacer último turn"}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={
                retryMut.isPending ||
                streaming ||
                ws.status !== "open" ||
                !messages.some((m) => m.role === "user")
              }
              title="Nuevo turn con el mismo prompt y attaches (no re-ejecuta tools)"
              onClick={async () => {
                setMsg(null);
                try {
                  const res = await retryMut.mutateAsync({ chatId });
                  if (!res.ok) {
                    setMsg({ kind: "error", text: res.error || "retry failed" });
                    return;
                  }
                  setMsg({
                    kind: "ok",
                    text: "Retry aceptado — turn nuevo con el mismo texto y attaches.",
                  });
                } catch (err) {
                  setMsg({ kind: "error", text: formatQueryError(err) });
                }
              }}
            >
              {retryMut.isPending ? "Reintentando…" : "Reintentar último prompt"}
            </button>
          </div>
          {!undoState.enabled && undoState.reason === "UNDO_REQUIRES_GIT" && (
            <p className="muted">{NO_GIT_UI}</p>
          )}
          <GitPanel
            workspaceId={session.data?.workspace?.id}
            githubLinked={Boolean(providers.data?.providers?.github?.linked)}
          />
          <ChatUsagePanel usage={chat.data?.usage} messages={messages} />
          {(queueSnap?.items.length ?? 0) > 0 && (
            <div className="queue-strip" style={{ marginBottom: "0.75rem" }}>
              <p style={{ margin: "0 0 0.35rem" }}>
                Cola: {queueSnap!.items.length}
              </p>
              <ul style={{ margin: 0, paddingLeft: "1.1rem" }}>
                {queueSnap!.items.slice(0, 5).map((it) => (
                  <li key={it.queueId}>
                    {it.position} · {it.promptPreview}{" "}
                    <button
                      type="button"
                      className="secondary"
                      disabled={
                        queueCancel.isPending || ws.status !== "open"
                      }
                      onClick={async () => {
                        setMsg(null);
                        try {
                          await queueCancel.mutateAsync(it.queueId);
                          void qc.invalidateQueries({
                            queryKey: queryKeys.chat(chatId),
                          });
                        } catch (err) {
                          setMsg({
                            kind: "error",
                            text: formatQueryError(err),
                          });
                        }
                      }}
                    >
                      quitar
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <WorktreeBar workspaceId={session.data?.workspace?.id} />
          <form onSubmit={onAgent}>
            <label htmlFor="executionMode">Modo de ejecución</label>
            <select
              id="executionMode"
              aria-label="Modo de ejecución"
              value={currentMode}
              disabled={prefs.isPending}
              onChange={(e) => {
                const next = parseExecutionMode(e.target.value, {
                  defaultOnEmpty: false,
                });
                void prefs.mutateAsync({ activeExecutionMode: next });
              }}
            >
              <option value="ask">ask — confirma write/edit/bash</option>
              <option value="auto">auto — ejecuta sin preguntar</option>
              <option value="plan">plan — solo lectura, propone</option>
            </select>
            <label htmlFor="prompt">Prompt</label>
            <MentionComposer
              textareaId="prompt"
              chatId={chatId}
              value={prompt}
              onChange={setPrompt}
              disabled={agent.isPending || ws.status !== "open"}
              daemonLabel={daemonLabel}
              daemonError={daemonError}
              modelIds={modelIds}
              onSlashExecute={(insert) => {
                void executeSlash(insert);
              }}
            />
            <button
              type="submit"
              disabled={agent.isPending || ws.status !== "open"}
            >
              {agent.isPending ? "Enviando…" : "agent.turn.request"}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={
                compact.isPending || ws.status !== "open" || streaming
              }
              onClick={() => {
                void runCompact();
              }}
            >
              {compact.isPending ? "Compactando…" : "Compactar contexto"}
            </button>
            {(turnBusy || streaming) && (
              <button
                type="button"
                className="secondary"
                disabled={cancelTurnMut.isPending || ws.status !== "open"}
                onClick={async () => {
                  setMsg(null);
                  try {
                    await cancelTurnMut.mutateAsync({ chatId });
                  } catch (err) {
                    setMsg({ kind: "error", text: formatQueryError(err) });
                  }
                }}
              >
                {cancelTurnMut.isPending ? "Cancelando…" : "Cancelar turn"}
              </button>
            )}
          </form>
          {(turnBusy || streaming) && (
            <form onSubmit={onSteer}>
              <label htmlFor="steer">Steer</label>
              <textarea
                id="steer"
                rows={2}
                value={steerText}
                onChange={(e) => setSteerText(e.target.value)}
                placeholder="Instrucción para el turn en curso"
              />
              <button
                type="submit"
                className="secondary"
                disabled={
                  steerMut.isPending ||
                  ws.status !== "open" ||
                  !steerText.trim()
                }
              >
                {steerMut.isPending ? "Enviando…" : "Steer"}
              </button>
            </form>
          )}
        </div>
      )}

      {signedIn && (
        <div className="panel">
          <h2>Append manual</h2>
          <form onSubmit={onAppend}>
            <label htmlFor="role">Role</label>
            <select
              id="role"
              value={role}
              onChange={(e) => setRole(e.target.value)}
            >
              <option value="user">user</option>
              <option value="assistant">assistant</option>
              <option value="system">system</option>
            </select>
            <label htmlFor="manual">Mensaje</label>
            <textarea
              id="manual"
              rows={3}
              required
              value={manual}
              onChange={(e) => setManual(e.target.value)}
            />
            <button
              type="submit"
              className="secondary"
              disabled={append.isPending || ws.status !== "open"}
            >
              {append.isPending ? "Enviando…" : "chat.append"}
            </button>
          </form>
          {msg && (
            <p className={msg.kind === "ok" ? "ok" : "error"}>{msg.text}</p>
          )}
        </div>
      )}
        </div>
      </div>
    </div>
  );
}

export function ChatDetailPanel({ chatId }: { chatId: string }) {
  return (
    <AppProviders>
      <ChatDetailInner chatId={chatId} />
    </AppProviders>
  );
}
