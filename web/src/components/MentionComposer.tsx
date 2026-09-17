import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { formatQueryError } from "../lib/hooks";
import { activeMention } from "../lib/mentions";
import {
  composerTrigger,
  slashPickerItems,
  type SlashPickItem,
} from "../lib/slash";
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
  modelIds,
  onSlashExecute,
}: {
  chatId: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  daemonLabel: string | null;
  daemonError: string | null;
  textareaId?: string;
  modelIds?: string[];
  onSlashExecute?: (insert: string) => void;
}) {
  const complete = useWsFsComplete();
  const [cursor, setCursor] = useState(0);
  const [items, setItems] = useState<FsCandidate[]>([]);
  const [hi, setHi] = useState(0);
  const [rpcError, setRpcError] = useState<string | null>(null);
  const [header, setHeader] = useState<string | null>(null);
  const [slashItems, setSlashItems] = useState<SlashPickItem[]>([]);
  const [slashHi, setSlashHi] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const trigger = composerTrigger(value, cursor);
  const mention =
    trigger?.kind === "mention"
      ? { start: trigger.start, query: trigger.query }
      : activeMention(value, cursor);
  const slashOpen = trigger?.kind === "slash" && !slashDismissed;
  const pickerOpen = Boolean(trigger?.kind === "mention") && !slashOpen;

  useEffect(() => {
    setSlashDismissed(false);
  }, [trigger?.kind, trigger?.start]);

  useEffect(() => {
    if (trigger?.kind !== "slash") {
      setSlashItems([]);
      return;
    }
    const next = slashPickerItems(trigger.query, { modelIds });
    setSlashItems(next);
    setSlashHi((i) => (next.length ? Math.min(i, next.length - 1) : 0));
  }, [trigger?.kind, trigger?.query, modelIds?.join("|")]);

  useEffect(() => {
    if (trigger?.kind !== "mention" || daemonError) {
      setItems([]);
      setRpcError(null);
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void complete
        .mutateAsync({ chatId, query: trigger.query })
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
  }, [trigger?.kind, trigger?.start, trigger?.query, chatId, daemonError]);

  function insert(c: FsCandidate) {
    if (!mention) return;
    const raw = c.isDir ? `${c.path}/` : c.path;
    const token = /\s/.test(raw) ? `@"${raw}"` : `@${raw}`;
    const next = value.slice(0, mention.start) + token + " " + value.slice(cursor);
    onChange(next);
    setItems([]);
    setCursor(mention.start + token.length + 1);
  }

  function pickSlash(c: SlashPickItem) {
    if (c.executeOnPick && onSlashExecute) {
      onSlashExecute(c.insert);
      setSlashItems([]);
      return;
    }
    onChange(c.insert);
    setCursor(c.insert.length);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (slashOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashHi((i) => (slashItems.length ? (i + 1) % slashItems.length : 0));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashHi((i) =>
          slashItems.length ? (i - 1 + slashItems.length) % slashItems.length : 0,
        );
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && slashItems[slashHi]) {
        e.preventDefault();
        pickSlash(slashItems[slashHi]!);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashItems([]);
        setSlashDismissed(true);
        return;
      }
      return;
    }
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
        value={value}
        disabled={disabled}
        onChange={(e) => {
          onChange(e.target.value);
          setCursor(e.target.selectionStart);
        }}
        onKeyUp={(e) => setCursor(e.currentTarget.selectionStart)}
        onSelect={(e) => setCursor(e.currentTarget.selectionStart)}
        onKeyDown={onKeyDown}
        placeholder="Mensaje o /help"
      />
      <AttachmentChips content={value} />
      {slashOpen ? (
        <div className="slash-picker" role="listbox" aria-label="Slash commands">
          <div className="muted">comandos · máx 10</div>
          {slashItems.length === 0 ? (
            <div className="muted">Sin coincidencias — /help</div>
          ) : (
            slashItems.map((c, i) => (
              <button
                key={c.id}
                type="button"
                className={i === slashHi ? "slash-item active" : "slash-item"}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pickSlash(c);
                }}
              >
                {c.label}
              </button>
            ))
          )}
        </div>
      ) : pickerOpen ? (
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
      ) : null}
    </div>
  );
}
