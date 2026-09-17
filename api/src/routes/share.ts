import { Hono } from "hono";
import { loadShareView } from "../chats/share";
import { SHARE_NOT_FOUND } from "../chats/export-share";

export function createSharePublicRoutes() {
  const app = new Hono();
  app.get("/:token", async (c) => {
    const token = c.req.param("token");
    const view = await loadShareView(token);
    if (!view) return c.json({ error: SHARE_NOT_FOUND }, 404);
    return c.json(view);
  });
  return app;
}
