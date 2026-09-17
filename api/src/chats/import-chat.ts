import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { agentSessions, chatMessages, chats } from "../db/schema";
import {
  importedChatTitle,
  messagesForImport,
  parseExportDocument,
  IMPORT_INVALID,
  SESSION_NOT_FOUND,
  type ChatExportDocument,
} from "./export-share";

export async function importChatDocument(input: {
  userId: string;
  sessionId: string;
  raw: unknown;
}): Promise<
  | { ok: true; chat: typeof chats.$inferSelect }
  | { ok: false; error: string }
> {
  const doc = parseExportDocument(input.raw);
  if (!doc) return { ok: false, error: IMPORT_INVALID };

  const sessions = await db
    .select()
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.id, input.sessionId),
        eq(agentSessions.userId, input.userId),
      ),
    )
    .limit(1);
  if (!sessions[0]) return { ok: false, error: SESSION_NOT_FOUND };

  const now = new Date();
  const chat = {
    id: crypto.randomUUID(),
    sessionId: input.sessionId,
    userId: input.userId,
    title: importedChatTitle(doc.chat.title),
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(chats).values(chat);

  const rows = messagesForImport(doc);
  for (const m of rows) {
    const createdAt = m.createdAt ? new Date(m.createdAt) : now;
    await db.insert(chatMessages).values({
      id: crypto.randomUUID(),
      chatId: chat.id,
      role: m.role,
      content: m.content,
      metadata: m.metadata,
      createdAt: Number.isNaN(createdAt.getTime()) ? now : createdAt,
    });
  }
  return { ok: true, chat };
}

export type { ChatExportDocument };
