import { useMemo, useState, type FormEvent } from "react";
import { AppProviders } from "./AppProviders";
import {
  formatQueryError,
  useLinkProvider,
  useMe,
  useProviderCredentials,
  useProviderPreferences,
  useProviders,
  useSetActiveProvider,
  useUnlinkProvider,
  type ModelInfo,
} from "../lib/hooks";

function ProvidersPanelInner() {
  const providerHint = useMemo(() => {
    const q = new URLSearchParams(window.location.search);
    return q.get("provider") || "claude";
  }, []);
  const token = useMemo(
    () => new URLSearchParams(window.location.search).get("token"),
    [],
  );

  const me = useMe();
  const signedIn = Boolean(me.data) || Boolean(token);

  const { data, isLoading, isError, error, refetch, isFetching } =
    useProviders(token, signedIn && !me.isLoading);
  const setActive = useSetActiveProvider(token);
  const prefs = useProviderPreferences(token);
  const unlink = useUnlinkProvider(token);
  const link = useLinkProvider(token);

  const [secret, setSecret] = useState("");
  const [linkProvider, setLinkProvider] = useState(providerHint);
  const [authKind, setAuthKind] = useState<"api_key" | "oauth_token">(
    "api_key",
  );
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null,
  );
  const [revealProvider, setRevealProvider] = useState<string | null>(null);

  const credentials = useProviderCredentials(
    revealProvider || "",
    token,
    Boolean(revealProvider),
  );

  const activeId = data?.activeProvider;
  const models: ModelInfo[] = useMemo(() => {
    if (!data || !activeId) return [];
    const fromProvider = data.providers?.[activeId]?.models;
    if (fromProvider?.length) return fromProvider;
    const catalog = data.catalogs?.find((c) => c.id === activeId);
    return catalog?.models ?? [];
  }, [data, activeId]);

  const selectedModel = models.find((m) => m.id === data?.activeModel);
  const efforts = selectedModel?.effortLevels ?? [
    "none",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ];

  async function onLink(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      await link.mutateAsync({
        provider: linkProvider,
        secret,
        authKind,
      });
      setSecret("");
      setMsg({ kind: "ok", text: "Credenciales guardadas." });
    } catch (err) {
      setMsg({ kind: "error", text: formatQueryError(err) });
    }
  }

  async function onSavePrefs(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    const form = e.target as HTMLFormElement;
    const fd = new FormData(form);
    try {
      await prefs.mutateAsync({
        activeModel: String(fd.get("activeModel") || "") || null,
        activeEffort: String(fd.get("activeEffort") || "") || null,
        activeExecutionMode: String(fd.get("activeExecutionMode") || "ask"),
      });
      setMsg({ kind: "ok", text: "Preferencias guardadas." });
    } catch (err) {
      setMsg({ kind: "error", text: formatQueryError(err) });
    }
  }

  return (
    <div>
      <div className="panel">
        <h1>Providers</h1>
        <p>Vault y preferencias activas (Claude / Cursor).</p>
        {me.isLoading && <p className="muted">Cargando sesión…</p>}
        {!me.isLoading && !signedIn && (
          <p className="muted">
            Necesitas sesión para vincular providers.{" "}
            <a href="/sign-in?redirect=/providers">Sign in</a>
            {" · "}
            opcional: <code>?token=</code> del CLI
          </p>
        )}
        {signedIn && (isLoading || isFetching) && (
          <p className="muted">Cargando…</p>
        )}
        {signedIn && isError && (
          <p className="error">{formatQueryError(error)}</p>
        )}
        {signedIn && isError && (
          <button type="button" className="secondary" onClick={() => refetch()}>
            Reintentar
          </button>
        )}
        {signedIn && data && (
          <>
            <p>
              Activo:{" "}
              <code>
                {data.activeProvider || "—"} / {data.activeModel || "—"} /{" "}
                {data.activeEffort || "—"} / {data.activeExecutionMode || "ask"}
              </code>
            </p>
            <div className="grid">
              {Object.entries(data.providers || {}).map(([id, p]) => (
                <div key={id} className="panel" style={{ marginBottom: 0 }}>
                  <h2>{p.label || id}</h2>
                  <p>
                    {p.linked ? (
                      <span className="badge ok">linked ({p.authKind})</span>
                    ) : (
                      <span className="badge">not linked</span>
                    )}
                  </p>
                  <button
                    type="button"
                    disabled={setActive.isPending}
                    onClick={() => setActive.mutate(id)}
                  >
                    Activar
                  </button>
                  {p.linked && (
                    <>
                      <button
                        type="button"
                        className="secondary"
                        style={{ marginLeft: "0.5rem" }}
                        onClick={() =>
                          setRevealProvider((cur) => (cur === id ? null : id))
                        }
                      >
                        {revealProvider === id ? "Ocultar secret" : "Reveal"}
                      </button>
                      <button
                        type="button"
                        className="danger"
                        style={{ marginLeft: "0.5rem" }}
                        disabled={unlink.isPending}
                        onClick={() => unlink.mutate(id)}
                      >
                        Unlink
                      </button>
                    </>
                  )}
                  {revealProvider === id && (
                    <div style={{ marginTop: "0.75rem" }}>
                      {credentials.isLoading && (
                        <p className="muted">Cargando secret…</p>
                      )}
                      {credentials.isError && (
                        <p className="error">
                          {formatQueryError(credentials.error)}
                        </p>
                      )}
                      {credentials.data && (
                        <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                          {credentials.data.secret}
                        </pre>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
            {(setActive.isError || unlink.isError) && (
              <p className="error">
                {formatQueryError(setActive.error || unlink.error)}
              </p>
            )}
          </>
        )}
      </div>

      {signedIn && data && activeId && (
        <div className="panel">
          <h2>Modelo, effort y modo</h2>
          <p className="muted">
            Provider activo: <code>{activeId}</code>
          </p>
          <form onSubmit={onSavePrefs}>
            <label htmlFor="activeModel">Modelo</label>
            <select
              id="activeModel"
              name="activeModel"
              defaultValue={data.activeModel || ""}
              key={`model-${data.activeModel}-${models.length}`}
            >
              <option value="">—</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label || m.id}
                </option>
              ))}
            </select>
            <label htmlFor="activeEffort">Effort</label>
            <select
              id="activeEffort"
              name="activeEffort"
              defaultValue={data.activeEffort || ""}
              key={`effort-${data.activeEffort}`}
            >
              <option value="">—</option>
              {efforts.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
            <label htmlFor="activeExecutionMode">Modo de ejecución</label>
            <select
              id="activeExecutionMode"
              name="activeExecutionMode"
              defaultValue={data.activeExecutionMode || "ask"}
              key={`mode-${data.activeExecutionMode}`}
            >
              <option value="ask">ask</option>
              <option value="auto">auto</option>
              <option value="plan">plan</option>
            </select>
            <button type="submit" disabled={prefs.isPending}>
              {prefs.isPending ? "Guardando…" : "Guardar preferencias"}
            </button>
          </form>
        </div>
      )}

      {signedIn && (
      <div className="panel">
        <h2>Vincular credenciales</h2>
        <form onSubmit={onLink}>
          <label htmlFor="provider">Provider</label>
          <select
            id="provider"
            value={linkProvider}
            onChange={(e) => setLinkProvider(e.target.value)}
          >
            <option value="claude">claude</option>
            <option value="cursor">cursor</option>
          </select>
          <label htmlFor="authKind">Auth kind</label>
          <select
            id="authKind"
            value={authKind}
            onChange={(e) =>
              setAuthKind(e.target.value as "api_key" | "oauth_token")
            }
          >
            <option value="api_key">api_key</option>
            <option value="oauth_token">oauth_token</option>
          </select>
          <label htmlFor="secret">
            {authKind === "api_key" ? "API key" : "OAuth token"}
          </label>
          <textarea
            id="secret"
            rows={3}
            required
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder={authKind === "api_key" ? "sk-..." : "token…"}
          />
          <button type="submit" disabled={link.isPending}>
            {link.isPending ? "Guardando…" : "Guardar en vault"}
          </button>
          {msg && (
            <p className={msg.kind === "ok" ? "ok" : "error"}>{msg.text}</p>
          )}
        </form>
      </div>
      )}
    </div>
  );
}

export function ProvidersPanel() {
  return (
    <AppProviders>
      <ProvidersPanelInner />
    </AppProviders>
  );
}
