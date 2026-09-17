import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { formatQueryError } from "../lib/hooks";
import { activeMention } from "../lib/mentions";
import { useWsFsComplete, type FsCandidate } from "../lib/ws-hooks";
import { AttachmentChips } from "./AttachmentChips";

export function MentionComposer({
  chatId,
  value,
  onChange,
  disabled,
  daemonLabel,
  daemonError,
  textareaId,
}: {
  chatId: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  daemonLabel: string | null;
  daemonError: string | null;
  textareaId?: string;
}) {
  const complete = useWsFsComplete();
  const [cursor, setCursor] = useState(0);
  const [items, setItems] = useState<FsCandidate[]>([]);
  const [hi, setHi] = useState(0);
  const [rpcError, setRpcError] = useState<string | null>(null);
  const [header, setHeader] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mention = activeMention(value, cursor);
  const pickerOpen = Boolean(mention);

  useEffect(() => {
    if (!mention || daemonError) {
      setItems([]);
      setRpcError(null);
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void complete
        .mutateAsync({ chatId, query: mention.query })
        .then((res) => {
          const data = (res.data || {}) as {
            hostname?: string | null;
            cwd?: string | null;
            candidates?: FsCandidate[];
          };
          const next = (data.candidates || []).slice(0, 10);
          setItems(next);
          setHi(0);
          setRpcError(null);
          if (data.hostname || data.cwd) {
            setHeader(`${data.hostname || "daemon"} · ${data.cwd || ""}`);
          }
        })
        .catch((err) => {
          setItems([]);
          setRpcError(formatQueryError(err));
        });
    }, 80);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [mention?.start, mention?.query, chatId, daemonError]);

  function insert(c: FsCandidate) {
    if (!mention) return;
    const raw = c.isDir ? `${c.path}/` : c.path;
    const token = /\s/.test(raw) ? `@"${raw}"` : `@${raw}`;
    const next = value.slice(0, mention.start) + token + " " + value.slice(cursor);
    onChange(next);
    setItems([]);
    setCursor(mention.start + token.length + 1);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (!pickerOpen || daemonError) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHi((i) => (items.length ? (i + 1) % items.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHi((i) => (items.length ? (i - 1 + items.length) % items.length : 0));
    } else if (e.key === "Enter" && items[hi]) {
      e.preventDefault();
      insert(items[hi]!);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setItems([]);
    }
  }

  const headerText = header || daemonLabel || "daemon · (cwd)";
  const bodyError = daemonError || rpcError;

  return (
    <div className="composer-wrap">
      <textarea
        id={textareaId}
        rows={3}
        required
        value={value}
        disabled={disabled}
        onChange={(e) => {
          onChange(e.target.value);
          setCursor(e.target.selectionStart);
        }}
        onKeyUp={(e) => setCursor(e.currentTarget.selectionStart)}
        onSelect={(e) => setCursor(e.currentTarget.selectionStart)}
        onKeyDown={onKeyDown}
        placeholder="Escribe @ para adjuntar un archivo del daemon"
      />
      <AttachmentChips content={value} />
      {pickerOpen && (
        <div className="mention-picker" role="listbox">
          <header>{headerText}</header>
          {bodyError ? (
            <p className="error" style={{ margin: "0.5rem 0.7rem" }}>
              {bodyError}
            </p>
          ) : items.length === 0 ? (
            <p className="muted" style={{ margin: "0.5rem 0.7rem" }}>
              Sin coincidencias
            </p>
          ) : (
            items.map((c, i) => (
              <button
                type="button"
                key={c.path}
                className={`pick ${i === hi ? "active" : ""}`}
                onClick={() => insert(c)}
              >
                {c.isDir ? `${c.path}/` : c.path}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
