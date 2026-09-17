import {
  CLEAR_OK,
  formatHelp,
  invalidProviderModel,
  isSlashCommandId,
  modeSetText,
  modelSetText,
  NO_CHAT_ERROR,
  NO_SESSION_ERROR,
  parseSlash,
  PROVIDER_MUST,
  providerSetText,
  SLASH_RESULT_KIND,
  SLASH_USAGE_MODE,
  SLASH_USAGE_MODEL,
  SLASH_USAGE_PROVIDER,
  UNKNOWN_SLASH,
  type SlashCommandId,
} from "./slash";
import { formatChatCost, type CostRow } from "./slash-cost";
import { INVALID_MODE_ERROR, isExecutionMode } from "./execution-mode";

export type PrefsSnapshot = {
  activeProvider: string | null;
  activeModel: string | null;
  activeEffort?: string | null;
  activeExecutionMode?: string | null;
  catalogs?: Array<{ id: string; models: Array<{ id: string }> }>;
  providers?: Record<string, { models?: Array<{ id: string }> }>;
};

export type SlashIo = {
  getPrefs: () => Promise<PrefsSnapshot>;
  putPrefs: (patch: {
    activeProvider?: string | null;
    activeModel?: string | null;
    activeExecutionMode?: string | null;
  }) => Promise<PrefsSnapshot>;
  compact?: (chatId: string) => Promise<{ text: string }>;
  undo?: (chatId: string) => Promise<{ text: string }>;
  createChat: (
    sessionId: string,
    title: string,
  ) => Promise<{ id: string }>;
  getChat: (chatId: string) => Promise<{
    messages: CostRow[];
    usage?: unknown;
  }>;
  appendResult: (
    chatId: string,
    content: string,
    meta: { kind: typeof SLASH_RESULT_KIND; command: string; ok: boolean },
  ) => Promise<void>;
};

export type SlashContext = {
  chatId: string | null;
  sessionId: string | null;
};

export type SlashRunResult = {
  ok: boolean;
  command: string;
  text: string;
  persist: boolean;
  navigatedChatId?: string;
};

function modelIdsFor(prefs: PrefsSnapshot, provider: string): string[] {
  const fromProv = prefs.providers?.[provider]?.models?.map((m) => m.id) ?? [];
  if (fromProv.length) return fromProv;
  return (
    prefs.catalogs?.find((c) => c.id === provider)?.models.map((m) => m.id) ?? []
  );
}

function belongsToProvider(
  prefs: PrefsSnapshot,
  provider: string,
  modelId: string,
): boolean {
  return modelIdsFor(prefs, provider).includes(modelId);
}

async function persist(
  io: SlashIo,
  ctx: SlashContext,
  command: string,
  ok: boolean,
  text: string,
): Promise<SlashRunResult> {
  if (ctx.chatId) {
    await io.appendResult(ctx.chatId, text, {
      kind: SLASH_RESULT_KIND,
      command,
      ok,
    });
  }
  return { ok, command, text, persist: Boolean(ctx.chatId) };
}

export async function runSlash(
  raw: string,
  io: SlashIo,
  ctx: SlashContext,
): Promise<SlashRunResult> {
  const parsed = parseSlash(raw);
  if (!parsed.ok && parsed.error === "not_slash") {
    return {
      ok: false,
      command: "not_slash",
      text: UNKNOWN_SLASH,
      persist: false,
    };
  }
  if (!parsed.ok) {
    return persist(io, ctx, "unknown", false, UNKNOWN_SLASH);
  }

  const { command, args } = parsed;

  if (command === "help") {
    return persist(io, ctx, "help", true, formatHelp());
  }

  if (command === "plan") {
    if (args.length) {
      return persist(io, ctx, "plan", false, SLASH_USAGE_MODE);
    }
    const prefs = await io.putPrefs({ activeExecutionMode: "plan" });
    const mode = prefs.activeExecutionMode || "plan";
    return persist(io, ctx, "plan", true, modeSetText(mode));
  }

  if (command === "mode") {
    if (args.length !== 1) {
      return persist(io, ctx, "mode", false, SLASH_USAGE_MODE);
    }
    const mode = args[0]!.toLowerCase();
    if (!isExecutionMode(mode)) {
      return persist(io, ctx, "mode", false, INVALID_MODE_ERROR);
    }
    const prefs = await io.putPrefs({ activeExecutionMode: mode });
    return persist(
      io,
      ctx,
      "mode",
      true,
      modeSetText(prefs.activeExecutionMode || mode),
    );
  }

  if (command === "provider") {
    if (args.length !== 1) {
      return persist(io, ctx, "provider", false, SLASH_USAGE_PROVIDER);
    }
    const provider = args[0]!.toLowerCase();
    if (provider !== "claude" && provider !== "cursor") {
      return persist(io, ctx, "provider", false, PROVIDER_MUST);
    }
    const current = await io.getPrefs();
    const ids = modelIdsFor(current, provider);
    const nextModel =
      current.activeModel && belongsToProvider(current, provider, current.activeModel)
        ? current.activeModel
        : (ids[0] ?? null);
    const prefs = await io.putPrefs({
      activeProvider: provider,
      activeModel: nextModel,
    });
    return persist(
      io,
      ctx,
      "provider",
      true,
      providerSetText(prefs.activeProvider || provider),
    );
  }

  if (command === "model") {
    if (args.length !== 1) {
      return persist(io, ctx, "model", false, SLASH_USAGE_MODEL);
    }
    const modelId = args[0]!;
    const current = await io.getPrefs();
    const provider = current.activeProvider || "claude";
    if (!belongsToProvider(current, provider, modelId)) {
      return persist(
        io,
        ctx,
        "model",
        false,
        invalidProviderModel(modelId, provider),
      );
    }
    const prefs = await io.putPrefs({ activeModel: modelId });
    return persist(
      io,
      ctx,
      "model",
      true,
      modelSetText(prefs.activeModel || modelId),
    );
  }

  if (command === "compact") {
    if (!ctx.chatId) return persist(io, ctx, "compact", false, NO_CHAT_ERROR);
    if (!io.compact) {
      return persist(
        io,
        ctx,
        "compact",
        false,
        "Compact no está disponible (plan 10).",
      );
    }
    try {
      const res = await io.compact(ctx.chatId);
      // plan 10 already appends compact_marker — do not double-append
      return { ok: true, command: "compact", text: res.text, persist: false };
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      return persist(io, ctx, "compact", false, text);
    }
  }

  if (command === "undo") {
    if (!ctx.chatId) return persist(io, ctx, "undo", false, NO_CHAT_ERROR);
    if (!io.undo) {
      return persist(
        io,
        ctx,
        "undo",
        false,
        "Undo no está disponible (plan 12).",
      );
    }
    try {
      const res = await io.undo(ctx.chatId);
      return { ok: true, command: "undo", text: res.text, persist: false };
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      return persist(io, ctx, "undo", false, text);
    }
  }

  if (command === "cost") {
    if (!ctx.chatId) return persist(io, ctx, "cost", false, NO_CHAT_ERROR);
    const chat = await io.getChat(ctx.chatId);
    const text = formatChatCost(chat.messages, chat.usage);
    return persist(io, ctx, "cost", true, text);
  }

  if (command === "clear") {
    if (!ctx.sessionId) {
      return persist(io, ctx, "clear", false, NO_SESSION_ERROR);
    }
    const chat = await io.createChat(ctx.sessionId, "Chat");
    if (ctx.chatId) {
      await io.appendResult(ctx.chatId, CLEAR_OK, {
        kind: SLASH_RESULT_KIND,
        command: "clear",
        ok: true,
      });
    }
    return {
      ok: true,
      command: "clear",
      text: CLEAR_OK,
      persist: true,
      navigatedChatId: chat.id,
    };
  }

  if (isSlashCommandId(command as SlashCommandId)) {
    return persist(io, ctx, command, false, UNKNOWN_SLASH);
  }
  return persist(io, ctx, "unknown", false, UNKNOWN_SLASH);
}

export function makeMemoryIo(init?: {
  prefs?: PrefsSnapshot;
  messages?: CostRow[];
  compact?: SlashIo["compact"];
  undo?: SlashIo["undo"];
}): { io: SlashIo; state: { prefs: PrefsSnapshot; results: string[]; chats: string[] } } {
  const state = {
    prefs: init?.prefs ?? {
      activeProvider: "claude",
      activeModel: "claude-sonnet-4-6",
      activeExecutionMode: "ask",
      providers: {
        claude: { models: [{ id: "claude-sonnet-4-6" }, { id: "claude-opus-4-6" }] },
        cursor: { models: [{ id: "composer-2.5" }] },
      },
    },
    results: [] as string[],
    chats: [] as string[],
    messages: init?.messages ?? ([] as CostRow[]),
  };
  const io: SlashIo = {
    getPrefs: async () => state.prefs,
    putPrefs: async (patch) => {
      state.prefs = { ...state.prefs, ...patch };
      return state.prefs;
    },
    compact: init?.compact,
    undo: init?.undo,
    createChat: async () => {
      const id = `chat-${state.chats.length + 1}`;
      state.chats.push(id);
      return { id };
    },
    getChat: async () => ({ messages: state.messages }),
    appendResult: async (_chatId, content) => {
      state.results.push(content);
    },
  };
  return { io, state };
}
