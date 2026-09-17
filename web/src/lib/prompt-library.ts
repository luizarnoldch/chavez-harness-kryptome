/** Keep in sync with cli/src/llm/prompt-library.ts */
export { NO_DAEMON_ERROR } from "./undo-constants";

export const PROMPT_PICKER_LIMIT = 10;
export const PROMPT_NAME_MAX = 63;
export const PROMPT_TITLE_MAX = 120;
export const PROMPT_BODY_MAX = 20_000;
export const PROMPTS_MAX = 50;

export const PROMPT_NAME_RE = /^[a-z][a-z0-9_-]{0,62}$/;

export const PROMPT_NAME_ERROR =
  "name must match [a-z][a-z0-9_-]{0,62}";
export const PROMPT_TITLE_ERROR = "title must be 1–120 characters";
export const PROMPT_BODY_ERROR = "body must be 1–20000 characters";
export const PROMPTS_CAP_ERROR = "Maximum 50 saved prompts";
export const PROMPT_SAVED = "Prompt guardado";
export const PROMPT_DELETED = "Prompt borrado";
export const PROMPT_EMPTY = "0 prompts";
export const PROMPT_PICKER_HEADER = "prompts · máx 10";
export const PROMPT_ACCOUNT_LABEL = "Biblioteca · cuenta";
export const PROMPT_CHANGED_EVENT = "prompt.changed";

export const PROMPT_ASK_USAGE =
  "Uso: chavez headless chat ask <chatId> [--prompt <name>] [texto…]";
export const PROMPT_SAVE_USAGE = "Uso: chavez prompt save <name> [body…]";
export const PROMPT_GET_USAGE = "Uso: chavez prompt get <name>";
export const PROMPT_RM_USAGE = "Uso: chavez prompt rm <name>";
export const PROMPT_LIST_USAGE = "Uso: chavez prompt list [--json]";

export function promptNotFound(name: string): string {
  return `Prompt not found: ${name}`;
}

export function promptNameTaken(name: string): string {
  return `Prompt name already exists: ${name}`;
}

export type SavedPrompt = {
  id: string;
  name: string;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
};

export type SavePromptInput = {
  name: string;
  title: string;
  body: string;
};

export type PromptTrigger = {
  start: number;
  query: string;
};

export function normalizePromptName(raw: unknown): string {
  return String(raw ?? "").trim().toLowerCase();
}

export function parseSavePromptInput(raw: {
  name?: unknown;
  title?: unknown;
  body?: unknown;
}): SavePromptInput {
  const name = normalizePromptName(raw.name);
  if (!PROMPT_NAME_RE.test(name)) {
    throw new Error(PROMPT_NAME_ERROR);
  }
  const body = String(raw.body ?? "").trim();
  if (body.length < 1 || body.length > PROMPT_BODY_MAX) {
    throw new Error(PROMPT_BODY_ERROR);
  }
  const titleRaw =
    raw.title == null || String(raw.title).trim() === ""
      ? name
      : String(raw.title).trim();
  if (titleRaw.length < 1 || titleRaw.length > PROMPT_TITLE_MAX) {
    throw new Error(PROMPT_TITLE_ERROR);
  }
  return { name, title: titleRaw, body };
}

/**
 * Active `#` token at the cursor.
 * `# Título` (space after hash) is markdown, not a picker.
 * `foo#bar` is not a trigger. Keep in sync with web/src/lib/prompt-library.ts.
 */
export function activePrompt(
  text: string,
  cursor: number = text.length,
): PromptTrigger | null {
  const slice = text.slice(0, cursor);
  const start = slice.lastIndexOf("#");
  if (start < 0) return null;
  if (start > 0 && !/\s/.test(slice[start - 1]!)) return null;
  const rest = slice.slice(start + 1);
  if (/\s/.test(rest)) return null;
  if (/^\S/.test(text.slice(cursor))) return null;
  return { start, query: rest };
}

function activeAt(
  text: string,
  cursor: number,
  token: "#" | "@" | "/",
): PromptTrigger | null {
  const slice = text.slice(0, cursor);
  const start = slice.lastIndexOf(token);
  if (start < 0) return null;
  if (token === "@") {
    if (start > 0 && /[A-Za-z0-9_]/.test(slice[start - 1]!)) return null;
    const rest = slice.slice(start + 1);
    if (/\s/.test(rest)) return null;
    return { start, query: rest };
  }
  if (token === "/") {
    if (start > 0 && !/\s/.test(slice[start - 1]!)) return null;
    const rest = slice.slice(start + 1);
    if (/\n/.test(rest)) return null;
    return { start, query: rest };
  }
  return activePrompt(text, cursor);
}

export type PromptComposerTrigger =
  | { kind: "slash"; start: number; query: string }
  | { kind: "mention"; start: number; query: string }
  | { kind: "prompt"; start: number; query: string };

/**
 * Mutually exclusive trigger. The token closest to the cursor wins.
 * `#` never opens the file picker; `@` never opens the prompt picker.
 */
export function resolveComposerTrigger(
  text: string,
  cursor: number = text.length,
): PromptComposerTrigger | null {
  const candidates: PromptComposerTrigger[] = [];
  const prompt = activePrompt(text, cursor);
  if (prompt) candidates.push({ kind: "prompt", ...prompt });
  const mention = activeAt(text, cursor, "@");
  if (mention) candidates.push({ kind: "mention", ...mention });
  const slash = activeAt(text, cursor, "/");
  if (slash) candidates.push({ kind: "slash", ...slash });
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.start - a.start);
  return candidates[0]!;
}

export function filterPrompts(
  prompts: SavedPrompt[],
  query: string,
  limit = PROMPT_PICKER_LIMIT,
): SavedPrompt[] {
  const q = query.trim().toLowerCase();
  const matched = q
    ? prompts.filter(
        (p) =>
          p.name.includes(q) ||
          p.title.toLowerCase().includes(q) ||
          p.body.toLowerCase().includes(q),
      )
    : [...prompts];
  matched.sort((a, b) => a.name.localeCompare(b.name));
  return matched.slice(0, limit);
}

export function insertPromptAt(
  text: string,
  trigger: { start: number },
  cursor: number,
  body: string,
): string {
  const after = text.slice(cursor);
  const spacer = body.endsWith("\n") || after.startsWith(" ") || after.length === 0
    ? ""
    : " ";
  return `${text.slice(0, trigger.start)}${body}${spacer}${after}`;
}

export function expandAskPrompt(opts: {
  libraryBody?: string | null;
  extra: string;
}): string {
  const extra = opts.extra.trim();
  const body = (opts.libraryBody ?? "").trim();
  if (body && extra) return `${body}\n\n${extra}`;
  return body || extra;
}

export function parseAskArgs(args: string[]): {
  chatId: string;
  promptName: string | null;
  extra: string;
} {
  const chatId = args[0] ?? "";
  if (!chatId || chatId.startsWith("-")) {
    throw new Error(PROMPT_ASK_USAGE);
  }
  let promptName: string | null = null;
  const extraParts: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--prompt") {
      const n = args[++i];
      if (!n || n.startsWith("-")) throw new Error(PROMPT_ASK_USAGE);
      promptName = n;
      continue;
    }
    extraParts.push(a);
  }
  return { chatId, promptName, extra: extraParts.join(" ") };
}
