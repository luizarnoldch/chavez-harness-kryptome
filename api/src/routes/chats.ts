import { Hono } from "hono";
import type { Session } from "../auth";
import {
  CHAT_NOT_FOUND,
  CHAT_UPDATED_EVENT,
  SEARCH_LIMIT,
  SESSION_NOT_FOUND,
  validateChatPatchInput,
} from "../chats/org";
import { patchChat, searchChats } from "../chats/store";
import { hub } from "../ws/hub";

export function createChatOrgRoutes(
  requireSession: (c: { req: { raw: Request } }) => Promise<Session | null>,
) {
  const app = new Hono();

  app.get("/chats/search", async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    const result = await searchChats({
      userId: session.user.id,
      query: c.req.query("q") || "",
      workspaceId: c.req.query("workspaceId") || undefined,
      sessionId: c.req.query("sessionId") || undefined,
      includeArchived:
        c.req.query("includeArchived") === "1" ||
        c.req.query("includeArchived") === "true",
      limit: Number(c.req.query("limit") || SEARCH_LIMIT),
    });
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json(result);
  });

  app.patch("/chats/:chatId", async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    const body = await c.req.json().catch(() => null);
    const validated = validateChatPatchInput(body);
    if (!validated.ok) return c.json({ error: validated.error }, 400);
    const result = await patchChat(
      c.req.param("chatId"),
      session.user.id,
      validated.patch,
    );
    if (!result.ok) {
      const status =
        result.error === CHAT_NOT_FOUND || result.error === SESSION_NOT_FOUND
          ? 404
          : 400;
      return c.json({ error: result.error }, status);
    }
    hub.broadcastToUser(
      session.user.id,
      hub.pushEvent(CHAT_UPDATED_EVENT, { chat: result.chat }),
    );
    return c.json({ chat: result.chat });
  });

  return app;
}
