import { useEffect, useState } from "react";
import {
  THINKING_COLLAPSED_LABEL,
  THINKING_OMITTED_LABEL,
  WEB_THINKING_LS_KEY,
  truncateThinkingPreview,
  type ThinkingPersist,
} from "../lib/thinking";

export function ThinkingBlock({
  thinking,
  liveText,
}: {
  thinking?: ThinkingPersist | null;
  liveText?: string;
}) {
  const omitted = thinking?.omitted === true;
  const text = omitted ? "" : thinking?.text || liveText || "";
  const [open, setOpen] = useState(false);

  useEffect(() => {
    try {
      setOpen(localStorage.getItem(WEB_THINKING_LS_KEY) === "1");
    } catch {
      // Ignore unavailable storage.
    }
  }, []);

  if (!omitted && !text) return null;

  function toggle() {
    setOpen((current) => {
      const next = !current;
      try {
        localStorage.setItem(WEB_THINKING_LS_KEY, next ? "1" : "0");
      } catch {
        // Ignore unavailable storage.
      }
      return next;
    });
  }

  if (omitted) {
    return (
      <div className="thinking-block omitted">
        <span className="badge">{THINKING_OMITTED_LABEL}</span>
      </div>
    );
  }

  return (
    <div className="thinking-block">
      <button type="button" className="thinking-toggle" onClick={toggle}>
        {open ? "▾" : "▸"} {THINKING_COLLAPSED_LABEL}
      </button>
      {open ? (
        <pre className="thinking-body">{text}</pre>
      ) : (
        <p className="muted thinking-preview">
          {truncateThinkingPreview(text)}
        </p>
      )}
    </div>
  );
}
