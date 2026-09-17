import { parseMentions } from "../lib/mentions";

export type AttachmentMeta = {
  path?: string;
  kind?: string;
  status?: string;
  error?: string;
};

export function AttachmentChips({
  content,
  attachments,
}: {
  content: string;
  attachments?: AttachmentMeta[] | null;
}) {
  const fromMeta = (attachments || []).map((a) => ({
    path: String(a.path || ""),
    kind: String(a.kind || "text"),
    status: String(a.status || "ok"),
    error: a.error,
  }));
  const fromText = parseMentions(content).map((m) => ({
    path: m.path,
    kind: fromMeta.find((x) => x.path === m.path)?.kind || "text",
    status: fromMeta.find((x) => x.path === m.path)?.status || "ok",
    error: fromMeta.find((x) => x.path === m.path)?.error,
  }));
  const items = fromMeta.length ? fromMeta : fromText;
  if (!items.length) return null;
  return (
    <div className="attach-row">
      {items.map((a) => (
        <span
          key={a.path}
          title={a.error || undefined}
          className={`attach-chip ${a.kind === "image" ? "image" : ""} ${
            a.status === "ignored"
              ? "warn"
              : a.status === "secret" || a.status === "vault" || a.status !== "ok"
                ? "err"
                : ""
          }`}
        >
          @{a.path}
          {a.kind === "image" ? " · imagen" : ""}
          {a.kind === "directory" ? " · dir" : ""}
          {a.kind === "binary" ? " · binario" : ""}
          {a.status !== "ok" ? ` · ${a.status}` : ""}
        </span>
      ))}
    </div>
  );
}
