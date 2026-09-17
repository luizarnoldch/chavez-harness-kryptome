import { useEffect, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ARCHIVE_LABEL,
  AUTOTITLE_PENDING_HINT,
  displayChatTitle,
  normalizeTitleInput,
  PIN_LABEL,
  UNARCHIVE_LABEL,
  UNPIN_LABEL,
} from "../lib/chat-org";
import {
  formatQueryError,
  usePatchChat,
  type AgentSession,
  type Chat,
} from "../lib/hooks";
import { useWs } from "../lib/ws-context";
import { useWsChatUpdate } from "../lib/ws-hooks";
import { queryKeys } from "../lib/query-keys";

export function chatOrgActionLabels(chat: {
  pinnedAt?: string | null;
  archivedAt?: string | null;
}) {
  return {
    pin: chat.pinnedAt ? UNPIN_LABEL : PIN_LABEL,
    archive: chat.archivedAt ? UNARCHIVE_LABEL : ARCHIVE_LABEL,
  };
}

type ChatPatch = {
  title?: string;
  pinned?: boolean;
  archived?: boolean;
  sessionId?: string;
};

export function ChatOrgBar({
  chat,
  sessions = [],
  variant = "detail",
}: {
  chat: Chat;
  sessions?: AgentSession[];
  variant?: "detail" | "row";
}) {
  const ws = useWs();
  const qc = useQueryClient();
  const wsUpdate = useWsChatUpdate();
  const patch = usePatchChat();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(chat.title);
  const [error, setError] = useState<string | null>(null);
  const labels = chatOrgActionLabels(chat);
  const pending = ws.status === "open" ? wsUpdate.isPending : patch.isPending;

  useEffect(() => setTitle(chat.title), [chat.title]);

  async function update(values: ChatPatch) {
    setError(null);
    try {
      const input = { chatId: chat.id, ...values };
      if (ws.status === "open") {
        await wsUpdate.mutateAsync(input);
      } else {
        await patch.mutateAsync(input);
      }
      void qc.invalidateQueries({ queryKey: queryKeys.chat(chat.id) });
      void qc.invalidateQueries({ queryKey: ["workspaceSessions"] });
      void qc.invalidateQueries({ queryKey: ["sessionChats"] });
      void qc.invalidateQueries({ queryKey: ["chatSearch"] });
    } catch (err) {
      setError(formatQueryError(err));
      throw err;
    }
  }

  async function submitTitle(e: FormEvent) {
    e.preventDefault();
    const normalized = normalizeTitleInput(title);
    if (!normalized.ok) {
      setError(normalized.error);
      return;
    }
    try {
      await update({ title: normalized.title });
      setEditing(false);
    } catch {
      // update renders the actionable error
    }
  }

  return (
    <div className={`chat-org-bar ${variant === "row" ? "chat-row" : ""}${chat.archivedAt ? " archived" : ""}`}>
      {editing ? (
        <form className="chat-title-form" onSubmit={submitTitle}>
          <input
            type="text"
            aria-label="Título del chat"
            value={title}
            disabled={pending}
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
          />
          <button type="submit" disabled={pending}>Guardar</button>
          <button
            type="button"
            className="secondary"
            disabled={pending}
            onClick={() => {
              setTitle(chat.title);
              setEditing(false);
              setError(null);
            }}
          >
            Cancelar
          </button>
        </form>
      ) : variant === "row" ? (
        <a href={`/chats/${chat.id}`}>
          {chat.pinnedAt ? <span className="chat-pin">* </span> : null}
          {displayChatTitle(chat)}
        </a>
      ) : (
        <strong>{displayChatTitle(chat)}</strong>
      )}

      {!editing && (
        <button
          type="button"
          className="secondary"
          disabled={pending}
          onClick={() => setEditing(true)}
        >
          Editar
        </button>
      )}
      <button
        type="button"
        className="secondary"
        disabled={pending}
        onClick={() => void update({ pinned: !chat.pinnedAt }).catch(() => {})}
      >
        {labels.pin}
      </button>
      <button
        type="button"
        className="secondary"
        disabled={pending}
        onClick={() =>
          void update({ archived: !chat.archivedAt }).catch(() => {})
        }
      >
        {labels.archive}
      </button>
      {variant === "detail" && sessions.length > 0 && (
        <label className="chat-session-select">
          Mover a session
          <select
            value={chat.sessionId}
            disabled={pending}
            onChange={(e) =>
              void update({ sessionId: e.target.value }).catch(() => {})
            }
          >
            {sessions.map((session) => (
              <option key={session.id} value={session.id}>
                {session.title || session.id}
              </option>
            ))}
          </select>
        </label>
      )}
      {chat.titleSource === "default" && variant === "detail" && (
        <span className="muted">{AUTOTITLE_PENDING_HINT}</span>
      )}
      {error && <span className="error">{error}</span>}
    </div>
  );
}
