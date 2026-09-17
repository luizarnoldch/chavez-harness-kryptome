import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useWs } from "../lib/ws-context";
import { useWsPtyOpen } from "../lib/ws-hooks";
import { NO_DAEMON_ERROR } from "../lib/pty-constants";
import {
  decodePtyChunk,
  encodePtyChunk,
  formatPtyHeader,
} from "../lib/pty-ws";

export type AttachedPty = {
  ptyId: string;
  chatId?: string;
  hostname?: string;
  cwd?: string;
  kind?: string;
};

type PtyTerminalProps = {
  chatId?: string;
  open: boolean;
  onClosed: () => void;
  attachedPty?: AttachedPty | null;
};

const NO_FILESYSTEM_COPY =
  "No hay filesystem: arranca el daemon (chavez headless workspace open o chavez tui). El terminal no corre en el servidor.";

export function PtyTerminal({
  chatId,
  open,
  onClosed,
  attachedPty,
}: PtyTerminalProps) {
  const ws = useWs();
  const openPty = useWsPtyOpen();
  const hostRef = useRef<HTMLDivElement>(null);
  const ptyIdRef = useRef<string | null>(null);
  const closedIdsRef = useRef(new Set<string>());
  const [header, setHeader] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [exited, setExited] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !hostRef.current) return;

    let disposed = false;
    const term = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily: "var(--mono)",
    });
    setHeader("");
    setError(null);
    setExited(null);
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    fit.fit();

    const closePty = () => {
      const ptyId = ptyIdRef.current;
      if (!ptyId || closedIdsRef.current.has(ptyId)) return;
      closedIdsRef.current.add(ptyId);
      ptyIdRef.current = null;
      void ws.request({ type: "pty.close", ptyId }).catch(() => {});
    };

    const attach = (data: AttachedPty) => {
      if (ptyIdRef.current && ptyIdRef.current !== data.ptyId) return false;
      ptyIdRef.current = data.ptyId;
      setHeader(
        data.hostname
          ? formatPtyHeader(data.hostname, data.cwd || "")
          : `daemon · ${data.cwd || ""}`,
      );
      setError(null);
      setExited(null);
      requestAnimationFrame(() => term.focus());
      return true;
    };

    const initialAttach =
      attachedPty?.kind === "agent" &&
      (!chatId || !attachedPty.chatId || attachedPty.chatId === chatId)
        ? attachedPty
        : null;
    if (initialAttach) attach(initialAttach);

    const offPush = ws.onPush((event) => {
      const data = (event.data || {}) as AttachedPty & {
        chunk?: string;
        exitCode?: number | null;
        reason?: string;
      };
      if (event.type === "pty.attach") {
        if (
          data.kind === "agent" &&
          (!chatId || !data.chatId || data.chatId === chatId)
        ) {
          attach(data);
        }
        return;
      }
      if (!data.ptyId || data.ptyId !== ptyIdRef.current) return;
      if (event.type === "pty.data" && data.chunk) {
        term.write(decodePtyChunk(data.chunk));
      }
      if (event.type === "pty.exit") {
        ptyIdRef.current = null;
        setExited(
          data.reason ||
            (data.exitCode == null
              ? "Terminal cerrado"
              : `Proceso terminado (${data.exitCode})`),
        );
      }
    });

    const dataDisposable = term.onData((data) => {
      const ptyId = ptyIdRef.current;
      if (!ptyId) return;
      void ws
        .request({
          type: "pty.input",
          ptyId,
          chunk: encodePtyChunk(data),
          encoding: "base64",
        })
        .catch((err) =>
          setError(err instanceof Error ? err.message : String(err)),
        );
    });

    const resize = new ResizeObserver(() => {
      if (disposed) return;
      fit.fit();
      const dimensions = fit.proposeDimensions();
      const ptyId = ptyIdRef.current;
      if (ptyId && dimensions) {
        void ws
          .request({
            type: "pty.resize",
            ptyId,
            cols: dimensions.cols,
            rows: dimensions.rows,
          })
          .catch(() => {});
      }
    });
    resize.observe(hostRef.current);
    window.addEventListener("beforeunload", closePty);

    if (!initialAttach) {
      const dimensions = fit.proposeDimensions();
      void openPty
        .mutateAsync({
          chatId,
          cols: dimensions?.cols,
          rows: dimensions?.rows,
        })
        .then((response) => {
          if (disposed) {
            const orphanId = (response.data as { ptyId?: string } | undefined)
              ?.ptyId;
            if (orphanId) {
              void ws
                .request({ type: "pty.close", ptyId: orphanId })
                .catch(() => {});
            }
            return;
          }
          const data = response.data as
            | {
                ptyId?: string;
                hostname?: string;
                cwd?: string;
              }
            | undefined;
          if (!data?.ptyId) throw new Error("pty.open returned no ptyId");
          attach({
            ptyId: data.ptyId,
            hostname: data.hostname,
            cwd: data.cwd,
          });
        })
        .catch((err) => {
          if (!disposed) {
            setError(err instanceof Error ? err.message : String(err));
          }
        });
    }

    return () => {
      disposed = true;
      closePty();
      window.removeEventListener("beforeunload", closePty);
      resize.disconnect();
      offPush();
      dataDisposable.dispose();
      term.dispose();
    };
    // One terminal instance owns one PTY for the lifetime of this open panel.
    // attachedPty is read only on mount; later agent attaches go through onPush.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, chatId, ws]);

  if (!open) return null;

  return (
    <section className="panel" aria-label="Terminal PTY">
      <div className="pty-header">{header || "pty · conectando…"}</div>
      <div ref={hostRef} className="pty-wrap" />
      {error ? <p className="error">{error}</p> : null}
      {error === NO_DAEMON_ERROR || error?.includes(NO_DAEMON_ERROR) ? (
        <p className="muted">{NO_FILESYSTEM_COPY}</p>
      ) : null}
      {exited ? <p className="muted">{exited}</p> : null}
      <button
        type="button"
        className="secondary"
        onClick={() => {
          const ptyId = ptyIdRef.current;
          if (ptyId && !closedIdsRef.current.has(ptyId)) {
            closedIdsRef.current.add(ptyId);
            ptyIdRef.current = null;
            void ws.request({ type: "pty.close", ptyId }).catch(() => {});
          }
          onClosed();
        }}
      >
        Cerrar terminal
      </button>
    </section>
  );
}
