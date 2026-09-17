import { useCallback, useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AppProviders } from "./AppProviders";
import {
  formatQueryError,
  useInstallSkill,
  useMarketplace,
  useMe,
  useUninstallSkill,
  type MarketplaceView,
  type MarketplaceViewRow,
} from "../lib/hooks";
import {
  filterMarketplaceRows,
  originBadgeClass,
  originLabel,
} from "../lib/marketplace-display";
import { queryKeys } from "../lib/query-keys";
import { NO_DAEMON_ERROR } from "../lib/undo-constants";
import { useWs } from "../lib/ws-context";

type MarketplaceAsk = {
  askRequestId: string;
  name: string;
  path: string;
  diff: string;
  approvalDeadline: string;
};

function MarketplaceAskModal({
  ask,
  onApprove,
  onDeny,
  busy,
  error,
}: {
  ask: MarketplaceAsk;
  onApprove: () => void;
  onDeny: () => void;
  busy: boolean;
  error: string | null;
}) {
  return (
    <div
      className="panel tool-ask"
      style={{ marginTop: "1rem", borderColor: "var(--accent-dim)" }}
      data-testid="marketplace-ask"
    >
      <h2>Confirmar cambio en {ask.path}</h2>
      <p className="muted">
        MCP <strong>{ask.name}</strong> · {ask.path}
      </p>
      <pre className="approval-diff">{ask.diff}</pre>
      <div className="approval-actions">
        <button type="button" disabled={busy} onClick={onApprove}>
          Aprobar
        </button>
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={onDeny}
        >
          Denegar
        </button>
      </div>
      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}

function MarketplacePanelInner() {
  const me = useMe();
  const signedIn = Boolean(me.data);
  const http = useMarketplace(signedIn);
  const installSkill = useInstallSkill();
  const uninstallSkill = useUninstallSkill();
  const ws = useWs();
  const qc = useQueryClient();

  const [view, setView] = useState<MarketplaceView | null>(null);
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null,
  );
  const [ask, setAsk] = useState<MarketplaceAsk | null>(null);
  const [askBusy, setAskBusy] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const [rowBusy, setRowBusy] = useState<string | null>(null);

  const refreshSnapshot = useCallback(async () => {
    if (!signedIn || ws.status !== "open") return;
    setSnapshotLoading(true);
    try {
      const res = await ws.request({ type: "workspace.marketplace.snapshot" });
      const data = (res.data || {}) as MarketplaceView;
      if (data.entries) {
        setView(data);
        return;
      }
      if (http.data) {
        setView({
          ...http.data,
          errors: [...(http.data.errors ?? []), NO_DAEMON_ERROR],
        });
      }
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      if (http.data) {
        if (text.includes(NO_DAEMON_ERROR) || text === NO_DAEMON_ERROR) {
          setView({
            ...http.data,
            errors: [...(http.data.errors ?? []), NO_DAEMON_ERROR],
          });
        } else {
          setView(http.data);
          setMsg({ kind: "error", text });
        }
      }
    } finally {
      setSnapshotLoading(false);
    }
  }, [signedIn, ws, http.data]);

  useEffect(() => {
    if (http.data && !view) {
      setView(http.data);
    }
  }, [http.data, view]);

  useEffect(() => {
    if (signedIn && ws.status === "open") {
      void refreshSnapshot();
    }
  }, [signedIn, ws.status, refreshSnapshot]);

  useEffect(() => {
    return ws.onPush((ev) => {
      if (ev.type === "marketplace.install.ask") {
        const data = (ev.data || {}) as Record<string, unknown>;
        const askRequestId = String(data.askRequestId || data.requestId || "");
        if (!askRequestId) return;
        setAsk({
          askRequestId,
          name: String(data.name || ""),
          path: String(data.path || ".mcp.json"),
          diff: String(data.diff || ""),
          approvalDeadline: String(data.approvalDeadline || ""),
        });
        setAskError(null);
        return;
      }
      if (ev.type === "marketplace.changed" || ev.type === "skills.updated") {
        void qc.invalidateQueries({ queryKey: queryKeys.marketplace });
        void refreshSnapshot();
      }
    });
  }, [ws, qc, refreshSnapshot]);

  const rows = useMemo(() => {
    const entries = view?.entries ?? http.data?.entries ?? [];
    return filterMarketplaceRows(entries, filter);
  }, [view, http.data, filter]);

  const catalogErrors = view?.errors ?? http.data?.errors ?? [];

  function setAskFromResult(data: Record<string, unknown>, fallbackName: string) {
    if (data.status !== "awaiting_approval") return false;
    const askRequestId = String(data.askRequestId || data.requestId || "");
    if (!askRequestId) return false;
    setAsk({
      askRequestId,
      name: String(data.name || fallbackName),
      path: String(data.path || ".mcp.json"),
      diff: String(data.diff || ""),
      approvalDeadline: String(data.approvalDeadline || ""),
    });
    setAskError(null);
    return true;
  }

  async function installRow(row: MarketplaceViewRow) {
    setMsg(null);
    setRowBusy(row.id);
    try {
      if (row.kind === "skill") {
        await installSkill.mutateAsync(row.catalogId || row.id);
        setMsg({ kind: "ok", text: `Skill ${row.name} instalada.` });
        await refreshSnapshot();
        return;
      }
      const res = await ws.request({
        type: "workspace.marketplace.install",
        metadata: { kind: "mcp", id: row.catalogId || row.id },
      });
      const data = (res.data || {}) as Record<string, unknown>;
      if (setAskFromResult(data, row.name)) return;
      setMsg({
        kind: "ok",
        text: String(data.message || `MCP ${row.name} instalado.`),
      });
      await refreshSnapshot();
    } catch (err) {
      setMsg({ kind: "error", text: formatQueryError(err) });
    } finally {
      setRowBusy(null);
    }
  }

  async function uninstallRow(row: MarketplaceViewRow) {
    setMsg(null);
    setRowBusy(row.id);
    try {
      if (row.kind === "skill") {
        await uninstallSkill.mutateAsync(row.name);
        setMsg({ kind: "ok", text: `Skill ${row.name} desinstalada.` });
        await refreshSnapshot();
        return;
      }
      const res = await ws.request({
        type: "workspace.marketplace.uninstall",
        metadata: { kind: "mcp", name: row.name },
      });
      const data = (res.data || {}) as Record<string, unknown>;
      if (setAskFromResult(data, row.name)) return;
      setMsg({
        kind: "ok",
        text: String(data.message || `MCP ${row.name} desinstalado.`),
      });
      await refreshSnapshot();
    } catch (err) {
      setMsg({ kind: "error", text: formatQueryError(err) });
    } finally {
      setRowBusy(null);
    }
  }

  async function decideAsk(decision: "approve" | "deny") {
    if (!ask) return;
    setAskBusy(true);
    setAskError(null);
    try {
      const res = await ws.request({
        type:
          decision === "approve"
            ? "workspace.marketplace.approve"
            : "workspace.marketplace.deny",
        metadata: { requestId: ask.askRequestId },
      });
      const data = (res.data || {}) as { message?: string };
      setAsk(null);
      setMsg({
        kind: "ok",
        text: data.message || `Marketplace ${decision}.`,
      });
      await refreshSnapshot();
    } catch (err) {
      setAskError(formatQueryError(err));
    } finally {
      setAskBusy(false);
    }
  }

  const daemonMissing = catalogErrors.some(
    (e) => e === NO_DAEMON_ERROR || e.includes(NO_DAEMON_ERROR),
  );

  return (
    <div>
      <p className="muted">
        <a href="/">Hub</a> / Marketplace
      </p>
      <div className="panel">
        <h1>Marketplace</h1>
        <p className="muted">
          Las skills oficiales se instalan en tu cuenta (siguientes turns). Los
          MCP oficiales se escriben en <code>.mcp.json</code> del workspace (el
          daemon los corre). La API no ejecuta MCP.
        </p>
        {!me.isLoading && !signedIn && (
          <p className="error">
            No autorizado — <a href="/sign-in?redirect=/marketplace">Sign in</a>
          </p>
        )}
        {(http.isLoading || snapshotLoading) && signedIn && (
          <p className="muted">Cargando catálogo…</p>
        )}
        {http.isError && (
          <p className="error">{formatQueryError(http.error)}</p>
        )}
        {daemonMissing && (
          <p className="error">{NO_DAEMON_ERROR}</p>
        )}
        {catalogErrors
          .filter((e) => e !== NO_DAEMON_ERROR && !e.includes(NO_DAEMON_ERROR))
          .map((e) => (
            <p key={e} className="error">
              {e}
            </p>
          ))}

        <label htmlFor="marketplace-filter">Filtrar</label>
        <input
          id="marketplace-filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="kind, nombre, origen…"
          disabled={!signedIn}
        />

        {signedIn && rows.length > 0 && (
          <div style={{ overflowX: "auto", marginTop: "1rem" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left", padding: "0.4rem" }}>Kind</th>
                  <th style={{ textAlign: "left", padding: "0.4rem" }}>Nombre</th>
                  <th style={{ textAlign: "left", padding: "0.4rem" }}>Origen</th>
                  <th style={{ textAlign: "left", padding: "0.4rem" }}>Estado</th>
                  <th style={{ textAlign: "left", padding: "0.4rem" }}>
                    Env requerido
                  </th>
                  <th style={{ textAlign: "left", padding: "0.4rem" }}>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} style={{ borderTop: "1px solid var(--border)" }}>
                    <td style={{ padding: "0.4rem" }}>{row.kind}</td>
                    <td style={{ padding: "0.4rem" }}>
                      <strong>{row.title || row.name}</strong>
                      {row.description ? (
                        <p className="muted" style={{ margin: "0.25rem 0 0", fontSize: "0.85rem" }}>
                          {row.description}
                        </p>
                      ) : null}
                    </td>
                    <td style={{ padding: "0.4rem" }}>
                      <span className={`badge ${originBadgeClass(row.origin)}`}>
                        {originLabel(row.origin)}
                      </span>
                    </td>
                    <td style={{ padding: "0.4rem" }}>
                      {row.installed ? "instalado" : "disponible"}
                    </td>
                    <td style={{ padding: "0.4rem" }}>
                      {row.requiredEnv.length
                        ? row.requiredEnv.join(", ")
                        : "—"}
                    </td>
                    <td style={{ padding: "0.4rem" }}>
                      {!row.installed ? (
                        <button
                          type="button"
                          disabled={rowBusy === row.id}
                          onClick={() => void installRow(row)}
                        >
                          Instalar
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="secondary"
                          disabled={rowBusy === row.id}
                          onClick={() => void uninstallRow(row)}
                        >
                          Desinstalar
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {signedIn && !http.isLoading && rows.length === 0 && (
          <p className="muted" style={{ marginTop: "1rem" }}>
            Sin coincidencias para el filtro.
          </p>
        )}

        {ask ? (
          <MarketplaceAskModal
            ask={ask}
            busy={askBusy}
            error={askError}
            onApprove={() => void decideAsk("approve")}
            onDeny={() => void decideAsk("deny")}
          />
        ) : null}

        {msg ? (
          <p className={msg.kind === "ok" ? "ok" : "error"} style={{ marginTop: "1rem" }}>
            {msg.text}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function MarketplacePanel() {
  return (
    <AppProviders notifications={false}>
      <MarketplacePanelInner />
    </AppProviders>
  );
}
