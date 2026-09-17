import { useEffect, useState, type FormEvent } from "react";
import { AppProviders } from "./AppProviders";
import { formatQueryError, useChatSearch, useMe } from "../lib/hooks";
import {
  displayChatTitle,
  NO_SEARCH_MATCHES,
  SEARCH_DEBOUNCE_MS,
  SEARCH_PLACEHOLDER,
} from "../lib/chat-org";

function ChatSearchInner({ initialQuery }: { initialQuery: string }) {
  const [query, setQuery] = useState(initialQuery);
  const [debounced, setDebounced] = useState(initialQuery);
  const me = useMe();
  const signedIn = Boolean(me.data);
  const search = useChatSearch(debounced, { enabled: signedIn });

  useEffect(() => {
    const timer = window.setTimeout(
      () => setDebounced(query),
      SEARCH_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [query]);

  function submit(e: FormEvent) {
    e.preventDefault();
    setDebounced(query);
    const params = new URLSearchParams();
    if (query.trim()) params.set("q", query.trim());
    window.history.replaceState(null, "", `/chats/search?${params}`);
  }

  const ready = debounced.trim().length >= 2;
  return (
    <div className="panel">
      <h1>Buscar chats</h1>
      <form onSubmit={submit}>
        <label htmlFor="chat-search">Buscar por título o mensajes</label>
        <input
          id="chat-search"
          type="search"
          value={query}
          placeholder={SEARCH_PLACEHOLDER}
          onChange={(e) => setQuery(e.target.value)}
        />
      </form>
      {!me.isLoading && !signedIn && (
        <p className="error">
          No autorizado — <a href="/sign-in?redirect=/chats/search">Sign in</a>
        </p>
      )}
      {search.isLoading && ready && <p className="muted">Buscando…</p>}
      {search.isError && <p className="error">{formatQueryError(search.error)}</p>}
      {ready && search.data?.chats.length === 0 && !search.isLoading && (
        <p className="muted">{NO_SEARCH_MATCHES}</p>
      )}
      <ul className="chat-search-results">
        {(search.data?.chats || []).map((chat) => (
          <li key={chat.id}>
            <a href={`/chats/${chat.id}`}>
              <strong>{displayChatTitle(chat)}</strong>
            </a>
            <span className="muted">
              {chat.sessionTitle ? ` · ${chat.sessionTitle}` : ""}
              {chat.workspacePath
                ? ` · ${chat.workspacePath}`
                : chat.workspaceName
                  ? ` · ${chat.workspaceName}`
                  : ""}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ChatSearchPanel({ initialQuery = "" }: { initialQuery?: string }) {
  return (
    <AppProviders>
      <ChatSearchInner initialQuery={initialQuery} />
    </AppProviders>
  );
}
