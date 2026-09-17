/** Keep in sync with cli/src/llm/prompt-library.ts (validate + errors only). */

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

export function promptNotFound(name: string): string {
  return `Prompt not found: ${name}`;
}

export function promptNameTaken(name: string): string {
  return `Prompt name already exists: ${name}`;
}

export type SavePromptInput = {
  name: string;
  title: string;
  body: string;
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
