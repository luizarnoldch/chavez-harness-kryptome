import { and, eq } from "drizzle-orm";
import { db } from "../db";
import {
  agentSessions,
  chats,
  workspaces,
} from "../db/schema";
import {
  NOT_FOUND_CHAT,
  NOT_FOUND_SESSION,
  NOT_FOUND_WORKSPACE,
  missingJson,
} from "../lib/no-team";

export { missingJson, NOT_FOUND_CHAT, NOT_FOUND_SESSION, NOT_FOUND_WORKSPACE };

export async function loadOwnedWorkspace(workspaceId: string, userId: string) {
  const rows = await db
    .select()
    .from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), eq(workspaces.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function loadOwnedSession(sessionId: string, userId: string) {
  const rows = await db
    .select()
    .from(agentSessions)
    .where(
      and(eq(agentSessions.id, sessionId), eq(agentSessions.userId, userId)),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function loadOwnedChat(chatId: string, userId: string) {
  const rows = await db
    .select()
    .from(chats)
    .where(and(eq(chats.id, chatId), eq(chats.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}
