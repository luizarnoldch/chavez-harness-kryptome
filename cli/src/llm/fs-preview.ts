import { loadIgnore, classifyPath, reasonForClass } from "./ignore";
import {
  DIR_LISTING_LIMIT,
  IMAGE_ATTACH_MAX_BYTES,
  hydrateOne,
  type AttachKind,
  type DirEntry,
} from "./hydrate-attachments";
import { PathEscapeError, resolveInsideCwd } from "./workspace-path";

export const PREVIEW_TEXT_MAX_BYTES = 32_000;

export type FsPreviewKind = AttachKind;
export type FsPreviewStatus =
  | "ok"
  | "missing"
  | "forbidden"
  | "ignored"
  | "too_large";

export type FsPreview = {
  cwd: string;
  path: string;
  kind: FsPreviewKind;
  status: FsPreviewStatus;
  byteSize: number;
  mime?: string;
  truncated?: boolean;
  /** File contents. Only when kind === "text" and status === "ok". */
  text?: string;
  mediaType?: string;
  /** Ephemeral. Only when kind === "image" and status === "ok". Never persist. */
  imageBase64?: string;
  listing?: DirEntry[];
  notice?: string;
  error?: string;
};

export function binaryPreviewNotice(mime: string, bytes: number): string {
  return `Binario · ${mime} · ${bytes} bytes. No se muestra como texto.`;
}

export function previewFile(cwd: string, relPath: string): FsPreview {
  const set = loadIgnore(cwd);
  let abs: string;
  try {
    abs = resolveInsideCwd(cwd, relPath);
  } catch (err) {
    return {
      cwd,
      path: relPath,
      kind: "binary",
      status: "forbidden",
      byteSize: 0,
      error:
        err instanceof PathEscapeError
          ? `Path outside workspace: ${relPath}`
          : err instanceof Error
            ? err.message
            : String(err),
    };
  }

  const cls = classifyPath(set, relPath, { absPath: abs });
  if (cls !== "none") {
    const reason = reasonForClass(cls);
    return {
      cwd,
      path: relPath,
      kind: "binary",
      status: "ignored",
      byteSize: 0,
      notice: `Path ignorado (${reason}): no se previsualiza.`,
    };
  }

  const a = hydrateOne(cwd, relPath);
  if (a.status === "missing" || a.status === "forbidden") {
    return {
      cwd,
      path: relPath,
      kind: a.kind,
      status: a.status,
      byteSize: a.byteSize,
      mime: a.mime,
      error: a.error,
    };
  }
  if (a.kind === "image") {
    if (a.status === "too_large" || a.byteSize > IMAGE_ATTACH_MAX_BYTES) {
      return {
        cwd,
        path: relPath,
        kind: "image",
        status: "too_large",
        byteSize: a.byteSize,
        mime: a.mime,
        error: a.error || `Image exceeds ${IMAGE_ATTACH_MAX_BYTES} bytes: ${relPath}`,
      };
    }
    return {
      cwd,
      path: relPath,
      kind: "image",
      status: "ok",
      byteSize: a.byteSize,
      mime: a.mime,
      mediaType: a.mediaType || a.mime,
      imageBase64: a.imageBase64,
    };
  }
  if (a.kind === "directory") {
    const listing = (a.listing || []).slice(0, DIR_LISTING_LIMIT);
    return {
      cwd,
      path: relPath,
      kind: "directory",
      status: "ok",
      byteSize: 0,
      listing,
      truncated: (a.listing || []).length >= DIR_LISTING_LIMIT,
      notice: a.hydratedText,
    };
  }
  if (a.kind === "binary") {
    const mime = a.mime || "application/octet-stream";
    return {
      cwd,
      path: relPath,
      kind: "binary",
      status: "ok",
      byteSize: a.byteSize,
      mime,
      notice: binaryPreviewNotice(mime, a.byteSize),
    };
  }

  const full = a.hydratedText || "";
  const rawLen = a.byteSize;
  const slice =
    full.length > PREVIEW_TEXT_MAX_BYTES
      ? full.slice(0, PREVIEW_TEXT_MAX_BYTES)
      : full.replace(/\n\n\[truncated: showing \d+ of \d+ bytes\]$/, "");
  const truncated = rawLen > PREVIEW_TEXT_MAX_BYTES || Boolean(a.truncated);
  const shown = Math.min(PREVIEW_TEXT_MAX_BYTES, slice.length);
  const text = truncated
    ? `${slice.slice(0, PREVIEW_TEXT_MAX_BYTES)}\n\n[truncated: showing ${shown} of ${rawLen} bytes]`
    : slice;
  return {
    cwd,
    path: relPath,
    kind: "text",
    status: "ok",
    byteSize: rawLen,
    mime: a.mime,
    truncated,
    text,
  };
}
