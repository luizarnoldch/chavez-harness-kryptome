import { Hono } from "hono";
import { loadShareView } from "../chats/share";
import { missingJson } from "../lib/no-team";
import { assertPublicShareView } from "../lib/share-not-membership";

export function createSharePublicRoutes() {
  const app = new Hono();
  app.get("/:token", async (c) => {
    const token = c.req.param("token");
    const view = await loadShareView(token);
    if (!view) return c.json(missingJson("share"), 404);
    assertPublicShareView(view);
    return c.json(view);
  });
  return app;
}
