import React, { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { ChavezWsClient } from "../../cli/src/ws/client";
import { apiFetch } from "../../cli/src/api-client";
import { publishAgentTurn } from "../../cli/src/llm/publish-turn";
import {
  defaultEffort,
  defaultModelId,
  getModel,
  type EffortLevel,
  type ModelInfo,
} from "../../cli/src/llm/catalog";
import { env } from "./lib/config";

type Session = { id: string; title: string };
type Chat = { id: string; title: string; sessionId: string };
type Message = { id: string; role: string; content: string };

type ProvidersResponse = {
  activeProvider: string | null;
  activeModel: string | null;
  activeEffort: string | null;
  providers: Record<
    string,
    {
      linked: boolean;
      authKind?: string;
      label?: string;
      runnable?: boolean;
      models?: ModelInfo[];
    }
  >;
};

function cycle<T>(items: T[], current: T, dir: 1 | -1): T {
  if (!items.length) return current;
  const idx = Math.max(0, items.indexOf(current));
  return items[(idx + dir + items.length) % items.length];
}

export function App() {
  const { exit } = useApp();
  const cwd = env.public.chavezCwd;
  const token = env.server.accessToken;
  const [status, setStatus] = useState<"connecting" | "bound" | "error">(
    "connecting"
  );
  const [error, setError] = useState<string | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [chats, setChats] = useState<Chat[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<"command" | "compose">("command");
  const [client, setClient] = useState<ChavezWsClient | null>(null);
  const [log, setLog] = useState<string>("");
  const [busy, setBusy] = useState(false);

  const [provider, setProvider] = useState<"claude" | "cursor">("claude");
  const [modelId, setModelId] = useState<string>("claude-sonnet-4-6");
  const [effort, setEffort] = useState<EffortLevel>("medium");
  const [providersInfo, setProvidersInfo] = useState<ProvidersResponse | null>(
    null
  );

  const providerMeta = providersInfo?.providers?.[provider];
  const models = providerMeta?.models ?? [];
  const model = useMemo(
    () => getModel(provider, modelId) ?? models[0],
    [provider, modelId, models]
  );
  const effortLevels = (model?.effortLevels ?? ["none"]) as EffortLevel[];

  const persistPrefs = useCallback(
    async (patch: {
      activeProvider?: string;
      activeModel?: string;
      activeEffort?: string;
    }) => {
      try {
        await apiFetch("/providers/preferences", {
          method: "PUT",
          body: JSON.stringify(patch),
        }, token);
      } catch {
        // non-fatal
      }
    },
    [token]
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

        const mid =
          info.activeModel ||
          defaultModelId(nextProvider) ||
          info.providers[nextProvider]?.models?.[0]?.id ||
          "claude-sonnet-4-6";
        setModelId(mid);
        const eff = (info.activeEffort as EffortLevel) || defaultEffort(nextProvider, mid);
        setEffort(eff);

        await c.connect();
        // Register as daemon so Web agent.turn.request can dispatch here.
        const bound = await c.bind(cwd.replace(/\\/g, "/"), "daemon");
        if (!bound.ok) throw new Error(bound.error || "bind failed");
        if (cancelled) {
          c.close();
          return;
        }
        const ws = (bound.data as { workspace?: { id: string } })?.workspace;
        setWorkspaceId(ws?.id ?? null);
        setClient(c);
        setStatus("bound");
        const list = await c.request({ type: "session.list" });
        if (list.ok) {
          const rows =
            (list.data as { sessions?: Session[] })?.sessions ?? [];
          setSessions(rows);
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

  const refreshChats = useCallback(
    async (sessionId: string) => {
      if (!client) return;
      const res = await client.request({ type: "chat.list", sessionId });
      if (res.ok) {
        setChats((res.data as { chats?: Chat[] })?.chats ?? []);
      }
    },
    [client]
  );

  const loadChat = useCallback(
    async (chatId: string) => {
      if (!client) return;
      const res = await client.request({ type: "chat.get", chatId });
      if (res.ok) {
        setMessages((res.data as { messages?: Message[] })?.messages ?? []);
      }
    },
    [client]
  );

  const activeChatIdRef = useRef(activeChatId);
  const activeSessionIdRef = useRef(activeSessionId);
  const turnBusyRef = useRef(false);
  activeChatIdRef.current = activeChatId;
  activeSessionIdRef.current = activeSessionId;

  // Live sync + handle agent.turn.dispatch from Web (TUI is daemon).
  useEffect(() => {
    if (!client) return;
    const off = client.onPush((msg) => {
      const data = (msg.data || {}) as {
        chatId?: string;
        prompt?: string;
        path?: string;
        sessionId?: string;
      };

      if (msg.type === "agent.turn.dispatch") {
        if (!data.chatId || !data.prompt) return;
        if (turnBusyRef.current) {
          setLog("Turn remoto ignorado — ya hay uno en curso");
          return;
        }
        turnBusyRef.current = true;
        setBusy(true);
        setLog(`Turn Web → chat ${data.chatId.slice(0, 8)}…`);
        void publishAgentTurn({
          client,
          chatId: data.chatId,
          prompt: data.prompt,
          cwd: data.path || cwd,
          token,
        })
          .then(async () => {
            setLog("Turn remoto completado");
            if (activeChatIdRef.current === data.chatId) {
              await loadChat(data.chatId);
            }
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
        msg.type === "message.appended" ||
        msg.type.startsWith("chat.tool.") ||
        msg.type === "chat.stream.end" ||
        msg.type === "chat.stream.error"
      ) {
        if (
          data.chatId &&
          activeChatIdRef.current &&
          data.chatId === activeChatIdRef.current
        ) {
          void loadChat(data.chatId);
        }
      }

      if (msg.type === "chat.created" && activeSessionIdRef.current) {
        void refreshChats(activeSessionIdRef.current);
      }
      if (msg.type === "session.created") {
        void client.request({ type: "session.list" }).then((list) => {
          if (list.ok) {
            setSessions(
              (list.data as { sessions?: Session[] })?.sessions ?? [],
            );
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
      setBusy(true);
      turnBusyRef.current = true;
      setLog("Enviando…");
      try {
        if (provider !== "claude") {
          const userRes = await client.request({
            type: "chat.append",
            chatId: activeChatId,
            role: "user",
            content: text,
          });
          if (!userRes.ok) throw new Error(userRes.error || "append user failed");
          await loadChat(activeChatId);
          setLog("Cursor LLM aún no implementado — solo se guardó el mensaje user");
          return;
        }
        if (!providersInfo?.providers.claude?.linked) {
          setLog("Claude no está vinculado — chavez provider link claude");
          return;
        }

        setLog(`Claude thinking (${modelId}, effort=${effort})…`);
        await publishAgentTurn({
          client,
          chatId: activeChatId,
          prompt: text,
          cwd,
          token,
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
      token,
      cwd,
    ],
  );

  useInput(async (ch, key) => {
    if (busy) return;
    if (key.escape || (key.ctrl && ch === "c")) {
      client?.close();
      exit();
      return;
    }

    if (mode === "compose") {
      if (key.return) {
        const text = input.trim();
        setInput("");
        setMode("command");
        if (!text) return;
        await sendWithLlm(text);
        return;
      }
      if (key.backspace || key.delete) {
        setInput((s) => s.slice(0, -1));
        return;
      }
      if (ch && !key.ctrl && !key.meta) {
        setInput((s) => s + ch);
      }
      return;
    }

    if (ch === "q") {
      client?.close();
      exit();
      return;
    }

    if (ch === "p") {
      const linked = (["claude", "cursor"] as const).filter(
        (id) => providersInfo?.providers[id]?.linked
      );
      if (!linked.length) {
        setLog("Ningún provider vinculado");
        return;
      }
      const next = cycle(linked, provider, 1);
      setProvider(next);
      const nextModels = providersInfo?.providers[next]?.models ?? [];
      const mid =
        defaultModelId(next) || nextModels[0]?.id || modelId;
      setModelId(mid);
      const eff = defaultEffort(next, mid);
      setEffort(eff);
      await persistPrefs({
        activeProvider: next,
        activeModel: mid,
        activeEffort: eff,
      });
      setLog(`Provider → ${next}`);
      return;
    }

    if (ch === "]" || ch === "[") {
      if (!models.length) return;
      const dir = ch === "]" ? 1 : -1;
      const ids = models.map((m) => m.id);
      const next = cycle(ids, modelId, dir);
      setModelId(next);
      const levels = getModel(provider, next)?.effortLevels ?? ["none"];
      let nextEffort = effort;
      if (!levels.includes(effort)) {
        nextEffort = defaultEffort(provider, next);
        setEffort(nextEffort);
      }
      await persistPrefs({
        activeModel: next,
        activeEffort: nextEffort,
      });
      setLog(`Model → ${next}`);
      return;
    }

    if (ch === "}" || ch === "{") {
      const dir = ch === "}" ? 1 : -1;
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
        setActiveSessionId(session.id);
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
        setActiveChatId(chat.id);
        setMessages([]);
        setLog(`Chat ${chat.id.slice(0, 8)}…`);
      } else setLog(res.error || "chat.create failed");
      return;
    }
    if (ch === "m" && activeChatId) {
      setMode("compose");
      setInput("");
      setLog("Mensaje + Enter → LLM | Enter vacío cancela");
      return;
    }
    if (ch === "1" || ch === "2" || ch === "3" || ch === "4" || ch === "5") {
      const idx = Number(ch) - 1;
      const session = sessions[idx];
      if (session) {
        setActiveSessionId(session.id);
        setActiveChatId(null);
        setMessages([]);
        await refreshChats(session.id);
        setLog(`Session activa: ${session.title}`);
      }
      return;
    }
    if (ch === "!" || ch === "@" || ch === "#" || ch === "$" || ch === "%") {
      const map: Record<string, number> = { "!": 0, "@": 1, "#": 2, $: 3, "%": 4 };
      const chat = chats[map[ch]];
      if (chat) {
        setActiveChatId(chat.id);
        await loadChat(chat.id);
        setLog(`Chat activo: ${chat.title}`);
      }
    }
  });

  const priceLine = model
    ? `$${model.inputPricePerMTok}/M in · $${model.outputPricePerMTok}/M out`
    : "—";

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="green">
        Chavez TUI
      </Text>
      <Text>cwd: {cwd}</Text>
      <Text>
        WS: {status}
        {workspaceId ? ` · workspace ${workspaceId.slice(0, 8)}…` : ""}
        {status === "bound" ? " · daemon/runner" : ""}
      </Text>
      <Text>
        provider:{" "}
        <Text color={providerMeta?.linked ? "cyan" : "red"}>
          {provider}
          {providerMeta?.linked ? ` (${providerMeta.authKind})` : " (not linked)"}
        </Text>
        {" · "}
        model: <Text color="yellow">{model?.label ?? modelId}</Text>
        {" · "}
        effort: <Text color="magenta">{effort}</Text>
      </Text>
      <Text dimColor>
        precios: {priceLine}
        {providerMeta?.runnable === false ? " · LLM: stub" : ""}
      </Text>
      {error ? <Text color="red">{error}</Text> : null}
      <Text dimColor>
        [p] provider  [[]/]] model  [{"{"}/{"}"}] effort  [s] session  [c] chat  [m] msg  [q] quit
      </Text>
      {busy ? <Text color="yellow">… generando respuesta</Text> : null}
      <Box marginTop={1} flexDirection="column">
        <Text bold>Sessions</Text>
        {sessions.length === 0 ? (
          <Text dimColor>(ninguna — pulsa s)</Text>
        ) : (
          sessions.slice(0, 5).map((s, i) => (
            <Text key={s.id} color={s.id === activeSessionId ? "cyan" : undefined}>
              {i + 1}. {s.title} ({s.id.slice(0, 8)})
            </Text>
          ))
        )}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text bold>Chats</Text>
        {chats.length === 0 ? (
          <Text dimColor>(ninguno — pulsa c)</Text>
        ) : (
          chats.slice(0, 5).map((c, i) => (
            <Text key={c.id} color={c.id === activeChatId ? "yellow" : undefined}>
              {"!@#$%"[i]}. {c.title} ({c.id.slice(0, 8)})
            </Text>
          ))
        )}
      </Box>
      <Box marginTop={1} flexDirection="column" height={10}>
        <Text bold>Messages</Text>
        {messages.slice(-8).map((m) => (
          <Text key={m.id} wrap="truncate-end">
            <Text color={m.role === "assistant" ? "green" : "magenta"}>
              {m.role}:{" "}
            </Text>
            {m.content.replace(/\s+/g, " ").slice(0, 100)}
          </Text>
        ))}
      </Box>
      {mode === "compose" ? (
        <Text>
          compose&gt; {input}
          <Text inverse> </Text>
        </Text>
      ) : null}
      {log ? <Text dimColor>{log}</Text> : null}
    </Box>
  );
}
