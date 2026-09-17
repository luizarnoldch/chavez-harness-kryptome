import { activePrompt } from "./prompt-library";

export const SLASH_PICKER_LIMIT = 10;
export const SLASH_RESULT_KIND = "slash_result";

export const UNKNOWN_SLASH = "Unknown command. Try /help";
export const NO_USAGE_TEXT = "sin datos";
export const CLEAR_OK = "Nuevo chat. El repo no se tocó.";
export const SLASH_USAGE_MODE = "Usage: /mode ask|auto|plan";
export const SLASH_USAGE_PROVIDER = "Usage: /provider claude|cursor";
export const SLASH_USAGE_MODEL = "Usage: /model <id>";
export const HELP_HEADER = "Commands:";
export const HELP_MODES = "Modes: plan · auto · ask";
export const NO_CHAT_ERROR = "No hay chat activo";
export const NO_SESSION_ERROR = "No hay session activa";
export const PROVIDER_MUST = "provider must be claude or cursor";

export const SLASH_COMMAND_IDS = [
  "mode",
  "model",
  "provider",
  "compact",
  "clear",
  "undo",
  "cost",
  "help",
  "plan",
  "apply",
] as const;

export type SlashCommandId = (typeof SLASH_COMMAND_IDS)[number];

export type SlashCatalogEntry = {
  id: SlashCommandId;
  usage: string;
  summary: string;
};

export const SLASH_CATALOG: SlashCatalogEntry[] = [
  {
    id: "mode",
    usage: "/mode ask|auto|plan",
    summary: "Cambia el modo de ejecución y lo persiste",
  },
  {
    id: "plan",
    usage: "/plan",
    summary: "Atajo a /mode plan",
  },
  {
    id: "apply",
    usage: "/apply",
    summary: "Aplica el plan actual (sin git commit)",
  },
  {
    id: "provider",
    usage: "/provider claude|cursor",
    summary: "Cambia el provider activo",
  },
  {
    id: "model",
    usage: "/model <id>",
    summary: "Cambia el modelo del provider activo",
  },
  {
    id: "compact",
    usage: "/compact",
    summary: "Compacta el contexto de este chat",
  },
  {
    id: "clear",
    usage: "/clear",
    summary: "Empieza un chat nuevo (no borra el repo)",
  },
  {
    id: "undo",
    usage: "/undo",
    summary: "Deshace el último turn vía git",
  },
  {
    id: "cost",
    usage: "/cost",
    summary: "Muestra usage del chat/turn",
  },
  {
    id: "help",
    usage: "/help",
    summary: "Lista comandos y modos",
  },
];

const ID_SET = new Set<string>(SLASH_COMMAND_IDS);

export function isSlashCommandId(v: string): v is SlashCommandId {
  return ID_SET.has(v);
}

export function modeSetText(mode: string): string {
  return `Mode → ${mode}`;
}

export function providerSetText(provider: string): string {
  return `Provider → ${provider}`;
}

export function modelSetText(modelId: string): string {
  return `Model → ${modelId}`;
}

export function invalidProviderModel(model: string, provider: string): string {
  return `modelId "${model}" does not belong to provider ${provider}`;
}

/** True when the whole trimmed composer is a slash command (execute on Enter). */
export function isSlashInput(text: string): boolean {
  return text.trimStart().startsWith("/");
}

/**
 * Active `/` token at the cursor. Used by the picker.
 * Does not match `@…`, `user@host`, or `src/lib`.
 * Keep in sync with web/src/lib/slash.ts.
 */
export function activeSlash(
  text: string,
  cursor: number = text.length,
): { start: number; query: string } | null {
  const slice = text.slice(0, cursor);
  const start = slice.lastIndexOf("/");
  if (start < 0) return null;
  if (start > 0 && !/\s/.test(slice[start - 1]!)) return null;
  const rest = slice.slice(start + 1);
  if (/\n/.test(rest)) return null;
  return { start, query: rest };
}

/**
 * Active `@` token at the cursor (same rules as attach-files `activeMention`).
 * Duplicated here so slash vs mention exclusion no importa de un sibling.
 */
export function activeMentionToken(
  text: string,
  cursor: number = text.length,
): { start: number; query: string } | null {
  const slice = text.slice(0, cursor);
  const at = slice.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0 && /[A-Za-z0-9_]/.test(slice[at - 1]!)) return null;
  const rest = slice.slice(at + 1);
  if (/\s/.test(rest)) return null;
  return { start: at, query: rest };
}

export type ComposerTrigger =
  | { kind: "slash"; start: number; query: string }
  | { kind: "mention"; start: number; query: string }
  | { kind: "prompt"; start: number; query: string };

/**
 * Mutually exclusive trigger. The token closer to the cursor wins;
 * `/` never opens the file picker; `#` never opens `@`.
 */
export function composerTrigger(
  text: string,
  cursor: number = text.length,
): ComposerTrigger | null {
  const candidates: ComposerTrigger[] = [];
  const slash = activeSlash(text, cursor);
  if (slash) candidates.push({ kind: "slash", ...slash });
  const mention = activeMentionToken(text, cursor);
  if (mention) candidates.push({ kind: "mention", ...mention });
  const prompt = activePrompt(text, cursor);
  if (prompt) candidates.push({ kind: "prompt", ...prompt });
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.start - a.start);
  return candidates[0]!;
}

export type ParsedSlash =
  | { ok: true; command: SlashCommandId; args: string[]; raw: string }
  | { ok: false; error: "not_slash"; raw: string }
  | { ok: false; error: "unknown"; raw: string; name: string };

function tokenize(body: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    out.push(m[1] ?? m[2] ?? m[3] ?? "");
  }
  return out.filter((t) => t.length > 0);
}

export function parseSlash(text: string): ParsedSlash {
  const raw = text.trim();
  if (!raw.startsWith("/")) return { ok: false, error: "not_slash", raw };
  const body = raw.slice(1);
  const tokens = tokenize(body);
  const name = (tokens[0] ?? "").toLowerCase();
  if (!name) {
    return { ok: true, command: "help", args: [], raw };
  }
  if (!isSlashCommandId(name)) {
    return { ok: false, error: "unknown", raw, name };
  }
  return { ok: true, command: name, args: tokens.slice(1), raw };
}

export type SlashPickItem = {
  id: string;
  label: string;
  insert: string;
  executeOnPick: boolean;
};

function prefixScore(id: string, prefix: string): number {
  const p = prefix.toLowerCase();
  const s = id.toLowerCase();
  if (!p) return 0;
  if (s === p) return 0;
  if (s.startsWith(p)) return 1;
  // Single-char prefixes must start the id ("a" → ask/auto, not plan).
  if (p.length >= 2 && s.includes(p)) return 2;
  return 99;
}

function rankIds(ids: string[], prefix: string, limit: number): string[] {
  const p = prefix.toLowerCase();
  const scored = ids
    .map((id) => ({ id, score: prefixScore(id, p) }))
    .filter((x) => x.score < 99)
    .sort((a, b) => a.score - b.score || a.id.localeCompare(b.id));
  return scored.slice(0, limit).map((x) => x.id);
}

const MODE_ARGS = ["ask", "auto", "plan"] as const;
const PROVIDER_ARGS = ["claude", "cursor"] as const;

export function slashPickerItems(
  query: string,
  opts: { modelIds?: string[] } = {},
): SlashPickItem[] {
  const q = query.replace(/^\s+/, "");
  const space = q.indexOf(" ");
  const cmdToken = (space < 0 ? q : q.slice(0, space)).toLowerCase();
  const rest = space < 0 ? "" : q.slice(space + 1);
  const completingArgs = space >= 0;

  if (!completingArgs) {
    const ids = rankIds([...SLASH_COMMAND_IDS], cmdToken, SLASH_PICKER_LIMIT);
    return ids.map((id) => {
      const entry = SLASH_CATALOG.find((e) => e.id === id)!;
      const needsArgs = id === "mode" || id === "provider" || id === "model";
      return {
        id,
        label: `${entry.usage}  — ${entry.summary}`,
        insert: needsArgs ? `/${id} ` : `/${id}`,
        executeOnPick: !needsArgs,
      };
    });
  }

  if (cmdToken === "mode") {
    const args = rankIds([...MODE_ARGS], rest.trim(), SLASH_PICKER_LIMIT);
    return args.map((a) => ({
      id: `mode:${a}`,
      label: `/mode ${a}`,
      insert: `/mode ${a}`,
      executeOnPick: true,
    }));
  }
  if (cmdToken === "provider") {
    const args = rankIds([...PROVIDER_ARGS], rest.trim(), SLASH_PICKER_LIMIT);
    return args.map((a) => ({
      id: `provider:${a}`,
      label: `/provider ${a}`,
      insert: `/provider ${a}`,
      executeOnPick: true,
    }));
  }
  if (cmdToken === "model") {
    const ids = rankIds(opts.modelIds ?? [], rest.trim(), SLASH_PICKER_LIMIT);
    return ids.map((a) => ({
      id: `model:${a}`,
      label: `/model ${a}`,
      insert: `/model ${a}`,
      executeOnPick: true,
    }));
  }
  return [];
}

export function formatHelp(): string {
  const lines = [
    HELP_HEADER,
    ...SLASH_CATALOG.map((e) => `  ${e.usage}  — ${e.summary}`),
    HELP_MODES,
  ];
  return lines.join("\n");
}

export function isSlashResultMeta(meta: unknown): boolean {
  if (!meta || typeof meta !== "object") return false;
  return (meta as { kind?: unknown }).kind === SLASH_RESULT_KIND;
}
