import { Hono } from "hono";
import { and, asc, eq, or, sql } from "drizzle-orm";
import { db } from "../db";
import { savedPrompts } from "../db/schema";
import type { Session } from "../auth";
import { hub } from "../ws/hub";
import {
  PROMPTS_CAP_ERROR,
  PROMPTS_MAX,
  parseSavePromptInput,
  promptNameTaken,
  promptNotFound,
  normalizePromptName,
  PROMPT_BODY_ERROR,
  PROMPT_TITLE_ERROR,
  PROMPT_TITLE_MAX,
  PROMPT_BODY_MAX,
} from "../llm/prompt-library";

type RequireSession = (c: {
  req: { raw: Request };
}) => Promise<Session | null>;

function toPublic(row: typeof savedPrompts.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    title: row.title,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function listForUser(userId: string) {
  const rows = await db
    .select()
    .from(savedPrompts)
    .where(eq(savedPrompts.userId, userId))
    .orderBy(asc(savedPrompts.name));
  return rows.map(toPublic);
}

async function broadcastPrompts(userId: string) {
  const prompts = await listForUser(userId);
  hub.broadcastToUser(userId, hub.pushEvent("prompt.changed", { prompts }));
}

async function findOwned(userId: string, nameOrId: string) {
  const name = normalizePromptName(nameOrId);
  const rows = await db
    .select()
    .from(savedPrompts)
    .where(
      and(
        eq(savedPrompts.userId, userId),
        or(eq(savedPrompts.id, nameOrId), eq(savedPrompts.name, name)),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export function createPromptRoutes(requireSession: RequireSession) {
  const app = new Hono();

  app.get("/", async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    return c.json({ prompts: await listForUser(session.user.id) });
  });

  app.get("/:nameOrId", async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    const nameOrId = c.req.param("nameOrId");
    const row = await findOwned(session.user.id, nameOrId);
    if (!row) {
      return c.json({ error: promptNotFound(nameOrId) }, 404);
    }
    return c.json({ prompt: toPublic(row) });
  });

  app.post("/", async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    const body = await c.req.json().catch(() => ({}));
    let input;
    try {
      input = parseSavePromptInput(body as {
        name?: unknown;
        title?: unknown;
        body?: unknown;
      });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Invalid prompt" },
        400,
      );
    }
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(savedPrompts)
      .where(eq(savedPrompts.userId, session.user.id));
    if (Number(n) >= PROMPTS_MAX) {
      return c.json({ error: PROMPTS_CAP_ERROR }, 400);
    }
    const now = new Date();
    try {
      const inserted = await db
        .insert(savedPrompts)
        .values({
          id: crypto.randomUUID(),
          userId: session.user.id,
          name: input.name,
          title: input.title,
          body: input.body,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      const prompt = toPublic(inserted[0]!);
      await broadcastPrompts(session.user.id);
      return c.json({ prompt }, 201);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (/saved_prompts_user_name_uidx|unique/i.test(msg)) {
        return c.json({ error: promptNameTaken(input.name) }, 409);
      }
      throw err;
    }
  });

  app.put("/:nameOrId", async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    const existing = await findOwned(session.user.id, c.req.param("nameOrId"));
    if (!existing) {
      return c.json({ error: promptNotFound(c.req.param("nameOrId")) }, 404);
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      name?: unknown;
      title?: unknown;
      body?: unknown;
    };
    let name = existing.name;
    let title = existing.title;
    let promptBody = existing.body;
    try {
      if (body.name != null) {
        const parsed = parseSavePromptInput({
          name: body.name,
          title: body.title ?? existing.title,
          body: body.body ?? existing.body,
        });
        name = parsed.name;
        title = parsed.title;
        promptBody = parsed.body;
      } else {
        if (body.title != null) {
          title = String(body.title).trim();
          if (title.length < 1 || title.length > PROMPT_TITLE_MAX) {
            throw new Error(PROMPT_TITLE_ERROR);
          }
        }
        if (body.body != null) {
          promptBody = String(body.body).trim();
          if (promptBody.length < 1 || promptBody.length > PROMPT_BODY_MAX) {
            throw new Error(PROMPT_BODY_ERROR);
          }
        }
      }
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Invalid prompt" },
        400,
      );
    }
    try {
      const updated = await db
        .update(savedPrompts)
        .set({ name, title, body: promptBody, updatedAt: new Date() })
        .where(
          and(
            eq(savedPrompts.id, existing.id),
            eq(savedPrompts.userId, session.user.id),
          ),
        )
        .returning();
      await broadcastPrompts(session.user.id);
      return c.json({ prompt: toPublic(updated[0]!) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (/saved_prompts_user_name_uidx|unique/i.test(msg)) {
        return c.json({ error: promptNameTaken(name) }, 409);
      }
      throw err;
    }
  });

  app.delete("/:nameOrId", async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    const existing = await findOwned(session.user.id, c.req.param("nameOrId"));
    if (!existing) {
      return c.json({ error: promptNotFound(c.req.param("nameOrId")) }, 404);
    }
    await db
      .delete(savedPrompts)
      .where(
        and(
          eq(savedPrompts.id, existing.id),
          eq(savedPrompts.userId, session.user.id),
        ),
      );
    await broadcastPrompts(session.user.id);
    return c.json({ ok: true, name: existing.name });
  });

  return app;
}
