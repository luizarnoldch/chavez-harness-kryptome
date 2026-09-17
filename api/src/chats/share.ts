import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../db";
import { chatShareLinks, chats } from "../db/schema";
import { env } from "../lib/config";
import { generateShareToken } from "./share-token";
import {
  SHARE_NOT_FOUND,
  shareUrl,
  shareViewFromExport,
  type ShareView,
} from "./export-share";
import { loadChatMessages, loadOwnedChat } from "./export-load";

export async function getActiveShare(chatId: string, userId: string) {
  const rows = await db
    .select()
    .from(chatShareLinks)
    .where(
      and(
        eq(chatShareLinks.chatId, chatId),
        eq(chatShareLinks.userId, userId),
        isNull(chatShareLinks.revokedAt),
      ),
    )
    .orderBy(desc(chatShareLinks.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export function publicSharePayload(row: {
  token: string;
  createdAt: Date;
}) {
  return {
    token: row.token,
    url: shareUrl(env.public.webOrigin, row.token),
    createdAt: row.createdAt,
  };
}

export async function createShare(chatId: string, userId: string) {
  const chat = await loadOwnedChat(chatId, userId);
  if (!chat) return { ok: false as const, error: "Chat not found" };
  const existing = await getActiveShare(chatId, userId);
  if (existing) {
    return { ok: true as const, share: publicSharePayload(existing), created: false };
  }
  const now = new Date();
  const row = {
    id: crypto.randomUUID(),
    chatId,
    userId,
    token: generateShareToken(),
    createdAt: now,
    revokedAt: null as Date | null,
  };
  await db.insert(chatShareLinks).values(row);
  return { ok: true as const, share: publicSharePayload(row), created: true };
}

export async function revokeShare(chatId: string, userId: string) {
  const chat = await loadOwnedChat(chatId, userId);
  if (!chat) return { ok: false as const, error: "Chat not found" };
  const existing = await getActiveShare(chatId, userId);
  if (!existing) return { ok: false as const, error: SHARE_NOT_FOUND };
  await db
    .update(chatShareLinks)
    .set({ revokedAt: new Date() })
    .where(eq(chatShareLinks.id, existing.id));
  return { ok: true as const, revoked: true };
}

export async function loadShareView(token: string): Promise<ShareView | null> {
  const rows = await db
    .select()
    .from(chatShareLinks)
    .where(eq(chatShareLinks.token, token))
    .limit(1);
  const link = rows[0];
  if (!link || link.revokedAt) return null;
  const chatRows = await db
    .select()
    .from(chats)
    .where(eq(chats.id, link.chatId))
    .limit(1);
  const chat = chatRows[0];
  if (!chat) return null;
  const messages = await loadChatMessages(chat.id);
  return shareViewFromExport(
    chat.title,
    chat.createdAt.toISOString(),
    messages,
  );
}
