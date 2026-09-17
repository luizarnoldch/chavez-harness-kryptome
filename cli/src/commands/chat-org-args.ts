export type ChatOrgFlags = Record<string, string | boolean>;

export type ChatOrgRpc =
  | {
      type: "chat.list";
      sessionId: string;
      includeArchived?: boolean;
      archivedOnly?: boolean;
    }
  | { type: "chat.search"; query: string }
  | {
      type: "chat.update";
      chatId: string;
      pinned?: boolean;
      archived?: boolean;
      title?: string;
      sessionId?: string;
    };

export function takeFlags(args: string[]): { rest: string[]; flags: ChatOrgFlags } {
  const flags: ChatOrgFlags = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--archived") flags.archivedOnly = true;
    else if (a === "--include-archived") flags.includeArchived = true;
    else if (a === "--json" || a === "--help") flags[a.slice(2)] = true;
    else rest.push(a);
  }
  return { rest, flags };
}

export function chatOrgAction(action: string, args: string[]): ChatOrgRpc {
  const { rest, flags } = takeFlags(args);

  switch (action) {
    case "list": {
      const sessionId = rest[0];
      if (!sessionId) throw new Error("Uso: … chat list <sessionId> [--archived | --include-archived]");
      return {
        type: "chat.list",
        sessionId,
        ...(flags.includeArchived ? { includeArchived: true } : {}),
        ...(flags.archivedOnly ? { archivedOnly: true } : {}),
      };
    }
    case "search": {
      const query = rest.join(" ").trim();
      if (!query) throw new Error("Uso: … chat search <query…>");
      return { type: "chat.search", query };
    }
    case "pin": {
      const chatId = rest[0];
      if (!chatId) throw new Error("Uso: … chat pin <chatId>");
      return { type: "chat.update", chatId, pinned: true };
    }
    case "unpin": {
      const chatId = rest[0];
      if (!chatId) throw new Error("Uso: … chat unpin <chatId>");
      return { type: "chat.update", chatId, pinned: false };
    }
    case "archive": {
      const chatId = rest[0];
      if (!chatId) throw new Error("Uso: … chat archive <chatId>");
      return { type: "chat.update", chatId, archived: true };
    }
    case "unarchive": {
      const chatId = rest[0];
      if (!chatId) throw new Error("Uso: … chat unarchive <chatId>");
      return { type: "chat.update", chatId, archived: false };
    }
    case "rename": {
      const chatId = rest[0];
      const title = rest.slice(1).join(" ").trim();
      if (!chatId || !title) throw new Error("Uso: … chat rename <chatId> <title…>");
      return { type: "chat.update", chatId, title };
    }
    case "move": {
      const chatId = rest[0];
      const sessionId = rest[1];
      if (!chatId || !sessionId) throw new Error("Uso: … chat move <chatId> <sessionId>");
      return { type: "chat.update", chatId, sessionId };
    }
    default:
      throw new Error(`Acción chat desconocida: ${action}`);
  }
}

export const CHAT_ORG_ACTIONS = [
  "search",
  "pin",
  "unpin",
  "archive",
  "unarchive",
  "rename",
  "move",
] as const;
