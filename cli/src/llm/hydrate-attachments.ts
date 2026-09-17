import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { classifyPath, loadIgnore } from "./ignore";
import { redactByClass } from "./secret-scan";
import { PathEscapeError, relativePosix, resolveInsideCwd } from "./workspace-path";

export const DIR_LISTING_LIMIT = 10;
export const TEXT_ATTACH_MAX_BYTES = 100_000;
export const IMAGE_ATTACH_MAX_BYTES = 4_500_000;
export const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

export type AttachKind = "text" | "image" | "binary" | "directory";
export type AttachStatus =
  | "ok"
  | "missing"
  | "forbidden"
  | "too_large"
  | "unsupported"
  | "ignored"
  | "secret"
  | "vault";

export type HydrateOpts = {
  force?: boolean;
  /** When true, secret files hydrate redacted text instead of raw. Vault still forbidden. */
  redactSecret?: boolean;
};

export type DirEntry = { name: string; isDir: boolean };

export type HydratedAttachment = {
  path: string;
  kind: AttachKind;
  status: AttachStatus;
  byteSize: number;
  mime?: string;
  truncated?: boolean;
  listing?: DirEntry[];
  /** Snapshot for LLM + history. Never raw binary. Omitted for images (bytes stay in memory only). */
  hydratedText?: string;
  sha256?: string;
  mediaType?: string;
  /** In-memory only; do not persist in chat_messages.metadata. */
  imageBase64?: string;
  error?: string;
};

function sniffUtf8(buf: Buffer): boolean {
  if (buf.includes(0)) return false;
  const sample = buf.subarray(0, Math.min(buf.length, 8192));
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample);
    return true;
  } catch {
    return false;
  }
}

function mimeFor(path: string, kind: AttachKind): string {
  const ext = extname(path).toLowerCase();
  if (kind === "image") {
    if (ext === ".png") return "image/png";
    if (ext === ".gif") return "image/gif";
    if (ext === ".webp") return "image/webp";
    return "image/jpeg";
  }
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".zip") return "application/zip";
  if (kind === "text") return "text/plain";
  return "application/octet-stream";
}

export function persistableAttachment(
  a: HydratedAttachment,
): Omit<HydratedAttachment, "imageBase64"> {
  const { imageBase64: _drop, ...rest } = a;
  return rest;
}

export function hydrateOne(
  cwd: string,
  relPath: string,
  opts: HydrateOpts = {},
): HydratedAttachment {
  let abs: string;
  try {
    abs = resolveInsideCwd(cwd, relPath);
  } catch (err) {
    return {
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

  let st;
  try {
    st = statSync(abs);
  } catch {
    return {
      path: relPath,
      kind: "binary",
      status: "missing",
      byteSize: 0,
      error: `File not found: ${relPath}`,
    };
  }

  const set = loadIgnore(cwd);
  const cls = classifyPath(set, relPath, {
    isDir: st.isDirectory(),
    size: st.isFile() ? st.size : undefined,
    absPath: abs,
  });
  if (cls === "vault") {
    return {
      path: relPath,
      kind: st.isDirectory() ? "directory" : "text",
      status: "vault",
      byteSize: 0,
      error: `Refusing to attach Chavez vault: ${relPath}`,
    };
  }
  if (cls === "huge") {
    return {
      path: relPath,
      kind: "binary",
      status: "ignored",
      byteSize: st.size,
      error: `Ignored path (not hydrated): ${relPath} (huge file)`,
    };
  }
  if (cls === "secret") {
    if (!opts.force && !opts.redactSecret) {
      return {
        path: relPath,
        kind: "text",
        status: "secret",
        byteSize: st.size,
        error: `Refusing to attach secret file: ${relPath}`,
      };
    }
    if (st.isFile()) {
      const raw = readFileSync(abs, "utf8");
      return {
        path: relPath,
        kind: "text",
        status: "ok",
        byteSize: st.size,
        hydratedText: redactByClass(raw, "secret"),
        truncated: false,
      };
    }
  }
  if (cls === "junk" && !opts.force) {
    return {
      path: relPath,
      kind: st.isDirectory() ? "directory" : "text",
      status: "ignored",
      byteSize: 0,
      error: `Ignored path (not hydrated): ${relPath} (ignored)`,
    };
  }

  if (st.isDirectory()) {
    let names: string[] = [];
    try {
      names = readdirSync(abs);
    } catch {
      names = [];
    }
    const listing: DirEntry[] = [];
    for (const name of names.sort((a, b) => a.localeCompare(b))) {
      if (listing.length >= DIR_LISTING_LIMIT) break;
      if (name === "." || name === "..") continue;
      const childAbs = join(abs, name);
      let childIsDir = false;
      let childSize: number | undefined;
      try {
        const childSt = statSync(childAbs);
        childIsDir = childSt.isDirectory();
        childSize = childSt.isFile() ? childSt.size : undefined;
      } catch {
        childIsDir = false;
      }
      const childRel = relativePosix(cwd, childAbs);
      const childCls = classifyPath(set, childRel, {
        isDir: childIsDir,
        size: childSize,
        absPath: childAbs,
      });
      if (childCls === "secret" || childCls === "vault") continue;
      if (childCls !== "none" && !opts.force) continue;
      listing.push({ name, isDir: childIsDir });
    }
    const extra =
      names.length > DIR_LISTING_LIMIT
        ? `\n… ${names.length - DIR_LISTING_LIMIT} more entries not listed`
        : "";
    const lines = listing.map((e) => (e.isDir ? `${e.name}/` : e.name));
    return {
      path: relPath,
      kind: "directory",
      status: "ok",
      byteSize: 0,
      listing,
      hydratedText: `[directory ${relPath} — ${Math.min(names.length, DIR_LISTING_LIMIT)} of ${names.length} entries]\n${lines.join("\n")}${extra}`,
    };
  }

  const ext = extname(relPath).toLowerCase();
  const buf = readFileSync(abs);
  const sha256 = createHash("sha256").update(buf).digest("hex");

  if (IMAGE_EXT.has(ext)) {
    if (buf.length > IMAGE_ATTACH_MAX_BYTES) {
      return {
        path: relPath,
        kind: "image",
        status: "too_large",
        byteSize: buf.length,
        mime: mimeFor(relPath, "image"),
        sha256,
        error: `Image exceeds ${IMAGE_ATTACH_MAX_BYTES} bytes: ${relPath}`,
      };
    }
    const mediaType = mimeFor(relPath, "image");
    return {
      path: relPath,
      kind: "image",
      status: "ok",
      byteSize: buf.length,
      mime: mediaType,
      mediaType,
      sha256,
      imageBase64: buf.toString("base64"),
    };
  }

  if (sniffUtf8(buf)) {
    const truncated = buf.length > TEXT_ATTACH_MAX_BYTES;
    const slice = truncated ? buf.subarray(0, TEXT_ATTACH_MAX_BYTES) : buf;
    const text = slice.toString("utf8");
    const mark = truncated
      ? `\n\n[truncated: showing ${TEXT_ATTACH_MAX_BYTES} of ${buf.length} bytes]`
      : "";
    return {
      path: relPath,
      kind: "text",
      status: "ok",
      byteSize: buf.length,
      mime: mimeFor(relPath, "text"),
      truncated,
      sha256,
      hydratedText: text + mark,
    };
  }

  return {
    path: relPath,
    kind: "binary",
    status: "ok",
    byteSize: buf.length,
    mime: mimeFor(relPath, "binary"),
    sha256,
    hydratedText: `[Attached binary ${relPath} (${mimeFor(relPath, "binary")}, ${buf.length} bytes). Content is not UTF-8 and was not inlined. Use tools to inspect if the provider supports this type.]`,
  };
}

export function hydrateAll(cwd: string, paths: string[]): HydratedAttachment[] {
  return paths.map((p) => hydrateOne(cwd, p));
}

export function blockingAttachError(
  attachments: HydratedAttachment[],
): string | null {
  const bad = attachments.filter(
    (a) =>
      a.status === "missing" ||
      a.status === "forbidden" ||
      a.status === "too_large" ||
      a.status === "vault",
  );
  if (!bad.length) return null;
  return bad.map((a) => a.error || `${a.path}: ${a.status}`).join("; ");
}

/** Text injected into the LLM string prompt (images go as content blocks). */
export function attachmentsPromptBlock(
  attachments: HydratedAttachment[],
): string {
  const parts: string[] = [];
  for (const a of attachments) {
    if (a.status !== "ok") continue;
    if (a.kind === "image") {
      parts.push(
        `[Attached image ${a.path} (${a.mime}, ${a.byteSize} bytes) — sent as image block, not as text.]`,
      );
      continue;
    }
    parts.push(
      `<attached path="${a.path}" kind="${a.kind}">\n${a.hydratedText ?? ""}\n</attached>`,
    );
  }
  if (!parts.length) return "";
  return [
    "The user attached the following workspace files. Treat them as context for this turn. Do not assume later disk contents match this snapshot.",
    "",
    ...parts,
  ].join("\n");
}
