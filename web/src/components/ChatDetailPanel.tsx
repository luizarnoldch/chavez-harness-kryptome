import { useEffect, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AppProviders } from "./AppProviders";
import {
  formatQueryError,
  useChat,
  useConnections,
  useMe,
  useSession,
  type ChatMessage,
} from "../lib/hooks";
import { parseMentions } from "../lib/mentions";
import { queryKeys } from "../lib/query-keys";
import { useWs } from "../lib/ws-context";
import { useWsAgentTurn, useWsChatAppend } from "../lib/ws-hooks";
import {
  AttachmentChips,
  type AttachmentMeta,
} from "./AttachmentChips";
import { MentionComposer } from "./MentionComposer";

function ToolCard({ m }: { m: ChatMessage }) {
  const meta = (m.metadata || {}) as Record<string, unknown>;
  const name = String(meta.toolName || m.content || "tool");
  const status = String(meta.status || "running");
  const input = meta.input;
  const output = meta.output;
  return (
    <div className="panel tool-card" style={{ marginBottom: "0.5rem" }}>
      <span className={`badge ${status === "done" ? "ok" : status === "error" ? "err" : ""}`}>
        tool · {name} · {status}
      </span>
      {input != null && (
        <pre style={{ whiteSpace: "pre-wrap", margin: "0.5rem 0 0", fontSize: "0.8rem" }}>
          in: {typeof input === "string" ? input : JSON.stringify(input, null, 2)}
        </pre>
      )}
      {output != null && (
        <pre style={{ whiteSpace: "pre-wrap", margin: "0.5rem 0 0", fontSize: "0.8rem" }}>
          out: {typeof output === "string" ? output : JSON.stringify(output, null, 2)}
        </pre>
      )}
    </div>
  );
}

function ChatDetailInner({ chatId }: { chatId: string }) {
  const me = useMe();
  const signedIn = Boolean(me.data);
  const chat = useChat(chatId, signedIn);
  const qc = useQueryClient();
  const ws = useWs();
  const append = useWsChatAppend();
  const agent = useWsAgentTurn();
  const [prompt, setPrompt] = useState("");
  const [manual, setManual] = useState("");
  const [role, setRole] = useState("user");
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null,
  );
  const [streamText, setStreamText] = useState("");
  const [streaming, setStreaming] = useState(false);

  useEffect(() => {
    return ws.onPush((ev) => {
      const data = ev.data as {
        chatId?: string;
        delta?: string;
        error?: string;
        message?: ChatMessage;
      };
      if (data?.chatId && data.chatId !== chatId) return;
      if (ev.type === "chat.stream.start") {
        setStreaming(true);
        setStreamText("");
      }
      if (ev.type === "chat.stream.delta" && data?.delta) {
        setStreaming(true);
        setStreamText((prev) => prev + data.delta);
      }
      if (ev.type === "chat.stream.end" || ev.type === "chat.stream.error") {
        setStreaming(false);
        setStreamText("");
        if (ev.type === "chat.stream.error" && data?.error) {
          setMsg({ kind: "error", text: data.error });
        }
        void qc.invalidateQueries({ queryKey: queryKeys.chat(chatId) });
      }
      if (ev.type === "message.appended" || ev.type.startsWith("chat.tool.")) {
        void qc.invalidateQueries({ queryKey: queryKeys.chat(chatId) });
      }
    });
  }, [ws, chatId, qc]);

  async function onAgent(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      await agent.mutateAsync({
        chatId,
        prompt: prompt.trim(),
        mentions: parseMentions(prompt.trim()).map((m) => m.path),
      });
      setPrompt("");
      setMsg({
        kind: "ok",
        text: "Turn aceptado — TUI o headless daemon ejecutará el agente.",
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
  const connections = useConnections(signedIn);
  const wsPath = session.data?.workspace?.path;
  const daemon = (connections.data || []).find(
    (c) => c.clientKind === "daemon" && c.path === wsPath,
  );
  const daemonLabel = daemon
    ? `${daemon.hostname || "daemon"} · ${daemon.path}`
    : null;
  const daemonError =
    connections.isLoading || daemon
      ? null
      : "No hay filesystem disponible. Abre CLI (chavez headless workspace open) o TUI (chavez tui) en este path.";
  const messages = chat.data?.messages || [];

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
        / <code>{chatId.slice(0, 8)}…</code>
      </p>
      <div className="panel">
        <h1>Chat</h1>
        <p>
          WS:{" "}
          <span className={`badge ${ws.status === "open" ? "ok" : ""}`}>
            {ws.status}
          </span>
          {streaming && <span className="badge ok"> streaming</span>}
        </p>
        <p className="muted" style={{ fontSize: "0.85rem" }}>
          Turns de agente: deja abierta la <strong>TUI</strong> (
          <code>chavez tui</code>) en el cwd del workspace, o{" "}
          <code>chavez headless workspace open</code>. Appends manuales
          sincronizan siempre vía WS.
        </p>
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
            <p>
              <strong>{chat.data.chat.title}</strong>
            </p>
            <div className="messages">
              {messages.map((m) =>
                m.role === "tool" ? (
                  <ToolCard key={m.id} m={m} />
                ) : (
                  <div
                    key={m.id}
                    className="panel"
                    style={{ marginBottom: "0.5rem" }}
                  >
                    <span className="badge">{m.role}</span>
                    {m.role === "user" ? (
                      <AttachmentChips
                        content={m.content}
                        attachments={
                          (m.metadata as { attachments?: AttachmentMeta[] } | null)
                            ?.attachments
                        }
                      />
                    ) : null}
                    <pre
                      style={{ whiteSpace: "pre-wrap", margin: "0.5rem 0 0" }}
                    >
                      {m.content}
                    </pre>
                  </div>
                ),
              )}
              {streaming && (
                <div className="panel" style={{ marginBottom: "0.5rem" }}>
                  <span className="badge ok">assistant · live</span>
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
          <form onSubmit={onAgent}>
            <label htmlFor="prompt">Prompt</label>
            <MentionComposer
              textareaId="prompt"
              chatId={chatId}
              value={prompt}
              onChange={setPrompt}
              disabled={agent.isPending || ws.status !== "open"}
              daemonLabel={daemonLabel}
              daemonError={daemonError}
            />
            <button
              type="submit"
              disabled={agent.isPending || ws.status !== "open"}
            >
              {agent.isPending ? "Enviando…" : "agent.turn.request"}
            </button>
          </form>
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
  );
}

export function ChatDetailPanel({ chatId }: { chatId: string }) {
  return (
    <AppProviders>
      <ChatDetailInner chatId={chatId} />
    </AppProviders>
  );
}
