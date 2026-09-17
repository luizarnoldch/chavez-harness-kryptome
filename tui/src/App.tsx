import React, { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { hostname } from "node:os";
import { ChavezWsClient } from "../../cli/src/ws/client";
import { apiFetch } from "../../cli/src/api-client";
import {
  completeWorkspace,
  type FsCandidate,
} from "../../cli/src/llm/fs-complete";
import { listWorkspaceDir } from "../../cli/src/llm/fs-tree";
import {
  cycleExecutionMode,
  parseExecutionMode,
  type ExecutionMode,
} from "../../cli/src/llm/execution-mode";
import { handleToolResolutionPush } from "../../cli/src/llm/handle-tool-resolution";
import { publishAgentTurn } from "../../cli/src/llm/publish-turn";
import { abortTurn, beginTurnAbort } from "../../cli/src/llm/turn-abort";
import {
  applyStreamDelta,
  mergeTimeline,
  shouldShowLiveAssistant,
  type TimelineMessage,
} from "../../cli/src/llm/timeline";
import { toolHeadline } from "../../cli/src/llm/tool-display";
import {
  defaultEffort,
  defaultModelId,
  getModel,
  type EffortLevel,
} from "../../cli/src/llm/catalog";
import { clampCursorParams } from "../../cli/src/llm/catalog-codec";
import type { CursorModelInfo, CursorParamSelection } from "../../cli/src/llm/cursor-types";
import { env } from "./lib/config";

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
type Message = TimelineMessage;
type ListFocus = "sessions" | "chats";

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

function formatTuiMessage(m: Message): { color: string; text: string } {
  if (m.role === "tool") {
    const meta = (m.metadata || {}) as Record<string, unknown>;
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
    const text = toolHeadline(sdkName, status, meta.input);
    return { color, text };
  }
  const modeTag =
    m.role === "user" &&
    typeof (m.metadata as Record<string, unknown> | null)?.executionMode ===
      "string"
      ? ` [${(m.metadata as Record<string, unknown>).executionMode}]`
      : "";
  return {
    color: m.role === "assistant" ? "green" : "magenta",
    text: `${m.role}${modeTag}: ${m.content.replace(/\s+/g, " ").slice(0, 100)}${
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
  const [status, setStatus] = useState<"connecting" | "bound" | "error">(
    "connecting",
  );
  const [error, setError] = useState<string | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [chats, setChats] = useState<Chat[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
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
  const [client, setClient] = useState<ChavezWsClient | null>(null);
  const [log, setLog] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [daemonRole, setDaemonRole] = useState<"primary" | "standby" | null>(
    null,
  );
  const [daemonHostname, setDaemonHostname] = useState("");
  const [streamText, setStreamText] = useState("");
  const [streaming, setStreaming] = useState(false);
  const streamIdRef = useRef<string | null>(null);
  const deltaStateRef = useRef({ nextSeq: 1, buffer: new Map<number, string>() });

  const [provider, setProvider] = useState<"claude" | "cursor">("claude");
  const [modelId, setModelId] = useState<string>("claude-sonnet-4-6");
  const [effort, setEffort] = useState<EffortLevel>("medium");
  const [activeParams, setActiveParams] = useState<CursorParam[]>([]);
  const [executionMode, setExecutionMode] = useState<ExecutionMode>("ask");
  const [providersInfo, setProvidersInfo] = useState<ProvidersResponse | null>(
    null,
  );

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
      const mention = activeMention(next);
      if (!mention) {
        setPickerOpen(false);
        setPickerItems([]);
        return;
      }
      const items = completeWorkspace(cwd, mention.query, 10);
      setPickerOpen(true);
      setPickerItems(items);
      setPickerIndex((i) => (items.length ? Math.min(i, items.length - 1) : 0));
    },
    [cwd],
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

  useEffect(() => {
    if (!token) {
      setStatus("error");
      setError("Missing CHAVEZ_ACCESS_TOKEN");
      return;
    }
    const c = new ChavezWsClient(token);
    let cancelled = false;
    (async () => {
      try {
        const info = await apiFetch<ProvidersResponse>("/providers", {}, token);
        if (cancelled) return;
        setProvidersInfo(info);

        let nextProvider =
          (info.activeProvider as "claude" | "cursor") || "claude";
        const linkedClaude = info.providers.claude?.linked;
        const linkedCursor = info.providers.cursor?.linked;
        if (nextProvider === "claude" && !linkedClaude && linkedCursor) {
          nextProvider = "cursor";
        }
        if (nextProvider === "cursor" && !linkedCursor && linkedClaude) {
          nextProvider = "claude";
        }
        setProvider(nextProvider);

        const nextModels = (info.providers[nextProvider]?.models ??
          []) as AnyModel[];
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
          const params =
            selected
              ? clampCursorParams(asCursorModel(selected)!, info.activeParams ?? [])
              : [];
          setActiveParams(params);
          setEffort("none");
          if (info.activeModel && info.activeModel !== mid) {
            void persistPrefs({
              activeProvider: "cursor",
              activeModel: mid || null,
              activeEffort: null,
              activeParams: params,
            });
          }
        } else {
          const eff =
            (info.activeEffort as EffortLevel) ||
            defaultEffort("claude", mid);
          setEffort(eff);
          setActiveParams([]);
        }
        setExecutionMode(parseExecutionMode(info.activeExecutionMode));

        await c.connect();
        // Register as daemon so Web agent.turn.request can dispatch here.
        const bound = await c.bind(cwd.replace(/\\/g, "/"), "daemon");
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
        setDaemonRole(
          boundData.role === "standby" || boundData.role === "primary"
            ? boundData.role
            : "primary",
        );
        setDaemonHostname(boundData.hostname || hostname());
        setClient(c);
        setStatus("bound");

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
    async (chatId: string) => {
      if (!client) return;
      const res = await client.request({ type: "chat.get", chatId });
      if (res.ok) {
        const data = res.data as { messages?: Message[]; diffs?: TurnDiff[] };
        setMessages(data.messages ?? []);
        setDiffs((data.diffs ?? []).filter((d) => d.status === "proposed" || d.status === "applied"));
      }
    },
    [client],
  );

  const selectSession = useCallback(
    async (session: Session | undefined, opts?: { openFirstChat?: boolean }) => {
      if (!session) return;
      setActiveSessionId(session.id);
      setActiveChatId(null);
      setMessages([]);
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
  const turnBusyRef = useRef(false);
  const daemonRoleRef = useRef(daemonRole);
  activeChatIdRef.current = activeChatId;
  activeSessionIdRef.current = activeSessionId;
  sessionsRef.current = sessions;
  daemonRoleRef.current = daemonRole;

  // Live sync + execute agent.turn.dispatch from Web (TUI is daemon).
  useEffect(() => {
    if (!client) return;
    const off = client.onPush((msg) => {
      const data = (msg.data || {}) as {
        chatId?: string;
        prompt?: string;
        path?: string;
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
        path?: string;
      };

      if (handleToolResolutionPush(msg)) return;

      if (msg.type === "prefs.updated") {
        const d = (msg.data || {}) as {
          activeExecutionMode?: string;
          activeProvider?: string;
          activeModel?: string;
          activeEffort?: string;
          activeParams?: CursorParam[] | null;
        };
        if (d.activeExecutionMode) {
          setExecutionMode(parseExecutionMode(d.activeExecutionMode));
        }
        if (d.activeParams) setActiveParams(d.activeParams);
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

      if (msg.type === "agent.turn.cancel") {
        const cancelChatId = (data as { chatId?: string }).chatId;
        if (cancelChatId) abortTurn(cancelChatId);
        setLog("Cancelando turn…");
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

        const ac = beginTurnAbort(data.chatId);
        void publishAgentTurn({
          client,
          chatId: data.chatId,
          prompt: data.prompt,
          cwd: data.path || cwd,
          token,
          mentions: data.mentions,
          executionMode: parseExecutionMode(
            (data as { executionMode?: string }).executionMode,
          ),
          abortController: ac,
        })
          .then(async () => {
            setLog("Turn remoto completado");
            await loadChat(data.chatId!);
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
        (msg.type === "message.appended" || msg.type.startsWith("chat.tool.")) &&
        data.message &&
        data.chatId &&
        data.chatId === activeChatIdRef.current
      ) {
        setMessages((prev) => mergeTimeline(prev, data.message!));
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
        }
      }

      if (msg.type === "chat.stream.error") {
        const err = String(data.error || data.content || "");
        if (
          err === "Turn already running on this daemon" ||
          err.includes("no ejecuta agente") ||
          err.includes("No daemon bound") ||
          err.includes("Claude no está vinculado")
        ) {
          setLog(err);
        }
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
        const ac = beginTurnAbort(activeChatId);
        await publishAgentTurn({
          client,
          chatId: activeChatId,
          prompt: text,
          cwd,
          token,
          executionMode,
          abortController: ac,
        });
        await loadChat(activeChatId);
        setLog("Respuesta recibida");
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
    ],
  );

  useInput(async (ch, key) => {
    if (key.ctrl && ch === "c") {
      client?.close();
      exit();
      return;
    }

    if (key.escape) {
      if (busy && activeChatId && client) {
        abortTurn(activeChatId);
        void client.request({ type: "agent.turn.cancel", chatId: activeChatId });
        setLog("Turn cancelled");
        return;
      }
      if (mode === "compose") {
        if (pickerOpen) {
          setPickerOpen(false);
          setPickerItems([]);
          setLog("Picker cerrado");
          return;
        }
        setMode("command");
        setInput("");
        setLog("Compose cancelado");
        return;
      }
      client?.close();
      exit();
      return;
    }

    if (mode === "compose") {
      if (busy) return;
      if (key.escape) {
        if (pickerOpen) {
          setPickerOpen(false);
          setPickerItems([]);
          setLog("Picker cerrado");
          return;
        }
        setMode("command");
        setInput("");
        setLog("Compose cancelado");
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
        setPickerOpen(false);
        if (!text) return;
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
      const awaiting = messages.find((m) => {
        const meta = (m.metadata || {}) as Record<string, unknown>;
        return (
          m.role === "tool" &&
          meta.status === "awaiting_approval" &&
          meta.toolCallId
        );
      });
      if (!awaiting) {
        setLog("No tool awaiting approval");
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
      setLog(
        res.ok
          ? `${decision} ${toolCallId.slice(0, 8)}…`
          : res.error || "No tool awaiting approval",
      );
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

    // Mutations blocked while generating.
    if (busy) return;

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
        {workspaceId ? ` · workspace ${workspaceId.slice(0, 8)}…` : ""}
        {daemonRole === "primary" ? " · daemon/runner" : ""}
        {daemonHostname ? ` · ${daemonHostname}` : ""}
      </Text>
      {daemonRole === "standby" ? (
        <Text color="red">
          Another daemon is already primary for this workspace; this connection
          is standby
        </Text>
      ) : null}
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
      <Text dimColor>
        [Tab] listas  [↑↓]  [Enter] abrir  [1-9] session  [s][c][m][d]  [p]
        [[]/]] model  [{"{"}/{"}"}] {provider === "cursor" ? "params" : "effort"}  [o] mode  [q] quit
      </Text>
      {busy ? (
        <Text color="yellow">
          … generando respuesta · Esc cancela el turn (no cierra la TUI)
        </Text>
      ) : null}
      {messages.some((m) => {
        const st = String(
          (m.metadata as Record<string, unknown> | null)?.status || "",
        );
        return m.role === "tool" && st === "awaiting_approval";
      }) ? (
        <Box flexDirection="column">
          <Text color="yellow">
            awaiting approval — [y] sí  [n] no (uno a uno, sin “siempre”)
          </Text>
          {messages
            .filter((m) => {
              const meta = (m.metadata || {}) as Record<string, unknown>;
              return m.role === "tool" && meta.status === "awaiting_approval";
            })
            .map((m) => {
              const meta = (m.metadata || {}) as Record<string, unknown>;
              const diff = meta.diff as { preview?: string } | undefined;
              const preview = String(diff?.preview || "");
              if (!preview) return null;
              return (
                <Text key={`ap-${m.id}`} dimColor>
                  {preview.split("\n").slice(0, 16).join("\n")}
                </Text>
              );
            })}
        </Box>
      ) : null}
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
          const ignored = m.role === "user" ? ignoredAttachLines(m) : [];
          return (
            <Box key={m.id} flexDirection="column">
              <Text wrap="truncate-end" color={color}>
                {text}
              </Text>
              {ignored.map((line) => (
                <Text key={line} color="yellow">
                  ⚠ {line}
                </Text>
              ))}
            </Box>
          );
        })}
        {shouldShowLiveAssistant(messages, streamIdRef.current, streaming) ? (
          <Text color="green" wrap="truncate-end">
            assistant: {streamText.replace(/\s+/g, " ").slice(0, 100) || "…"}
          </Text>
        ) : null}
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
        <Text>
          compose&gt; {input}
          <Text inverse> </Text>
        </Text>
      ) : null}
      {mode === "compose" && pickerOpen ? (
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
      {log ? <Text dimColor>{log}</Text> : null}
    </Box>
  );
}
