import { and, asc, eq } from "drizzle-orm";
import { db } from "../db";
import { chatMessages, chats, turnFileDiffs } from "../db/schema";
import {
  assembleChatExport,
  parseExportFormat,
  FORMAT_REQUIRED,
  CHAT_NOT_FOUND,
  type ChatExportResult,
  type SourceDiffRow,
  type SourceMessage,
} from "./export-share";

export async function loadOwnedChat(chatId: string, userId: string) {
  const rows = await db
    .select()
    .from(chats)
    .where(and(eq(chats.id, chatId), eq(chats.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function loadChatMessages(chatId: string): Promise<SourceMessage[]> {
  const rows = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.chatId, chatId))
    .orderBy(asc(chatMessages.createdAt));
  return rows.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    metadata: (m.metadata as Record<string, unknown> | null) ?? null,
    createdAt: m.createdAt,
  }));
}

export async function loadExportDiffs(chatId: string): Promise<SourceDiffRow[]> {
  // plan 6: query path/kind/status/±; never select body
  try {
    const rows = await db
      .select({
        streamId: turnFileDiffs.streamId,
        path: turnFileDiffs.path,
        kind: turnFileDiffs.kind,
        status: turnFileDiffs.status,
        additions: turnFileDiffs.additions,
        deletions: turnFileDiffs.deletions,
      })
      .from(turnFileDiffs)
      .where(eq(turnFileDiffs.chatId, chatId));
    return rows.map((r) => ({
      streamId: r.streamId,
      path: r.path,
      kind: r.kind,
      status: r.status,
      additions: r.additions,
      deletions: r.deletions,
      preview: null,
      body: null,
    }));
  } catch {
    return [];
  }
}

export async function buildChatExport(input: {
  title: string;
  chatId: string;
  messages?: SourceMessage[];
}): Promise<ChatExportResult> {
  const messages = input.messages ?? (await loadChatMessages(input.chatId));
  const diffs = await loadExportDiffs(input.chatId);
  return assembleChatExport({ title: input.title, messages, diffs });
}

export { parseExportFormat, FORMAT_REQUIRED, CHAT_NOT_FOUND };
