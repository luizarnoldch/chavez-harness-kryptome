import { emptySnapshot, textSnapshot, type Snapshot } from "./unified-diff";

export function toolPathFromInput(input: Record<string, unknown> | null): string | null {
  if (!input) return null;
  for (const k of ["file_path", "notebook_path", "path"] as const) {
    const v = input[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

export function writeContentsFromInput(input: Record<string, unknown> | null): string | null {
  if (!input) return null;
  if (typeof input.content === "string") return input.content;
  if (typeof input.contents === "string") return input.contents;
  return null;
}

/**
 * Proposed after-image for Write / Edit / NotebookEdit.
 * Edit: first occurrence of old_string → new_string (paridad Claude Edit).
 * Write: contents. Created if before.existed === false.
 */
export function proposedAfterSnapshot(
  sdkName: string,
  input: Record<string, unknown> | null,
  before: Snapshot,
): Snapshot | null {
  const name = sdkName;
  if (name === "Write") {
    const content = writeContentsFromInput(input);
    if (content == null) return null;
    return textSnapshot(content);
  }
  if (name === "Edit" || name === "NotebookEdit") {
    const oldS = typeof input?.old_string === "string" ? input.old_string : null;
    const newS = typeof input?.new_string === "string" ? input.new_string : null;
    if (oldS == null || newS == null) return null;
    const src = before.text ?? "";
    const idx = src.indexOf(oldS);
    if (idx < 0) return null;
    const next = src.slice(0, idx) + newS + src.slice(idx + oldS.length);
    return textSnapshot(next);
  }
  return null;
}

export { emptySnapshot };
