import { statSync } from "node:fs";
import type { ExecutionMode } from "./execution-mode";
import type { HydratedAttachment } from "./hydrate-attachments";
import { hydrateOne } from "./hydrate-attachments";
import { classifyPath, loadIgnore } from "./ignore";
import { reasonForClass } from "./ignore-patterns";
import { resolveInsideCwd } from "./workspace-path";

export const FORCE_ATTACH_SDK = "AttachIgnored";

export function isForceAttachName(sdkName: string): boolean {
  return sdkName === FORCE_ATTACH_SDK || sdkName === "attach";
}

export type AttachDecision = {
  attachment: HydratedAttachment;
  notice?: string;
  needsAsk?: { path: string; reason: string; cls: string };
};

export function decideAttach(
  cwd: string,
  relPath: string,
  mode: ExecutionMode | "ask" | "auto" | "plan",
): AttachDecision {
  const set = loadIgnore(cwd);
  let abs = relPath;
  try {
    abs = resolveInsideCwd(cwd, relPath);
  } catch {
    const a = hydrateOne(cwd, relPath);
    return { attachment: a };
  }
  let isDir = false;
  let size: number | undefined;
  try {
    const st = statSync(abs);
    isDir = st.isDirectory();
    size = st.isFile() ? st.size : undefined;
  } catch {
    return { attachment: hydrateOne(cwd, relPath) };
  }
  const cls = classifyPath(set, relPath, { isDir, size, absPath: abs });
  if (cls === "none") return { attachment: hydrateOne(cwd, relPath) };
  const reason = reasonForClass(cls);
  if (cls === "vault") {
    const attachment = hydrateOne(cwd, relPath);
    return { attachment, notice: attachment.error };
  }
  if (cls === "secret") {
    if (mode === "ask") {
      return {
        attachment: hydrateOne(cwd, relPath),
        needsAsk: { path: relPath, reason, cls },
      };
    }
    const attachment = hydrateOne(cwd, relPath);
    return {
      attachment,
      notice: attachment.error || `Refusing to attach secret file: ${relPath}`,
    };
  }
  if (mode === "ask") {
    return {
      attachment: hydrateOne(cwd, relPath),
      needsAsk: { path: relPath, reason, cls },
    };
  }
  const attachment = hydrateOne(cwd, relPath);
  return {
    attachment,
    notice: attachment.error || `Ignored path (not hydrated): ${relPath} (${reason})`,
  };
}

export function hydrateForced(cwd: string, relPath: string, cls: string): HydratedAttachment {
  if (cls === "secret") {
    return hydrateOne(cwd, relPath, { force: true, redactSecret: true });
  }
  if (cls === "vault") return hydrateOne(cwd, relPath);
  return hydrateOne(cwd, relPath, { force: true });
}
