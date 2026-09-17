import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { userSkills } from "../db/schema";
import { hub } from "../ws/hub";
import type { Session } from "../auth";
import {
  USER_SKILL_BODY_ERROR,
  USER_SKILL_DESC_ERROR,
  USER_SKILL_NAME_ERROR,
  USER_SKILLS_CAP_ERROR,
  USER_SKILL_BODY_MAX,
  USER_SKILL_DESC_MAX,
  USER_SKILLS_MAX,
  isSkillName,
  validateUserSkill,
} from "../llm/skills-constants";

function publicSkill(row: typeof userSkills.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    body: row.body,
    enabled: row.enabled,
    source: row.source ?? "manual",
    catalogId: row.catalogId ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function createSkillRoutes(
  requireSession: (c: { req: { raw: Request } }) => Promise<Session | null>,
) {
  const app = new Hono();

  app.get("/", async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    const rows = await db
      .select()
      .from(userSkills)
      .where(eq(userSkills.userId, session.user.id));
    return c.json({ skills: rows.map(publicSkill) });
  });

  app.post("/", async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    const body = await c.req.json().catch(() => ({}));
    const existing = await db
      .select({ id: userSkills.id })
      .from(userSkills)
      .where(eq(userSkills.userId, session.user.id));
    const validated = validateUserSkill({
      ...(body as object),
      existingCount: existing.length,
    });
    if (!validated.ok) return c.json({ error: validated.error }, 400);
    const now = new Date();
    const row = {
      id: crypto.randomUUID(),
      userId: session.user.id,
      name: validated.name,
      description: validated.description,
      body: validated.body,
      enabled: validated.enabled,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await db.insert(userSkills).values(row);
    } catch {
      return c.json({ error: `skill name "${validated.name}" already exists` }, 400);
    }
    try {
      hub.broadcastToUser(
        session.user.id,
        hub.pushEvent("skills.updated", {
          skillId: row.id,
          op: "create",
          skill: publicSkill(row as typeof userSkills.$inferSelect),
        }),
      );
    } catch {
      // do not block HTTP
    }
    return c.json(
      { skill: publicSkill(row as typeof userSkills.$inferSelect) },
      201,
    );
  });

  app.put("/:id", async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    const id = c.req.param("id");
    const found = await db
      .select()
      .from(userSkills)
      .where(and(eq(userSkills.id, id), eq(userSkills.userId, session.user.id)))
      .limit(1);
    if (!found[0]) return c.json({ error: "Not found" }, 404);
    const patch = await c.req.json().catch(() => ({}));
    const next: Partial<typeof found[0]> = { updatedAt: new Date() };
    if ((patch as { name?: string }).name != null) {
      const name = String((patch as { name: string }).name).trim();
      if (!isSkillName(name)) return c.json({ error: USER_SKILL_NAME_ERROR }, 400);
      next.name = name;
    }
    if ((patch as { description?: string }).description != null) {
      const description = String(
        (patch as { description: string }).description,
      ).trim();
      if (!description || description.length > USER_SKILL_DESC_MAX) {
        return c.json({ error: USER_SKILL_DESC_ERROR }, 400);
      }
      next.description = description;
    }
    if ((patch as { body?: string }).body != null) {
      const skillBody = String((patch as { body: string }).body);
      if (!skillBody || skillBody.length > USER_SKILL_BODY_MAX) {
        return c.json({ error: USER_SKILL_BODY_ERROR }, 400);
      }
      next.body = skillBody;
    }
    if ((patch as { enabled?: boolean }).enabled != null) {
      next.enabled = Boolean((patch as { enabled: boolean }).enabled);
    }
    const updated = { ...found[0], ...next };
    await db.update(userSkills).set(next).where(eq(userSkills.id, id));
    try {
      hub.broadcastToUser(
        session.user.id,
        hub.pushEvent("skills.updated", {
          skillId: id,
          op: "update",
          skill: publicSkill(updated),
        }),
      );
    } catch {
      // ignore
    }
    return c.json({ skill: publicSkill(updated) });
  });

  app.delete("/:id", async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    const id = c.req.param("id");
    const found = await db
      .select({ id: userSkills.id })
      .from(userSkills)
      .where(and(eq(userSkills.id, id), eq(userSkills.userId, session.user.id)))
      .limit(1);
    if (!found[0]) return c.json({ error: "Not found" }, 404);
    await db.delete(userSkills).where(eq(userSkills.id, id));
    try {
      hub.broadcastToUser(
        session.user.id,
        hub.pushEvent("skills.updated", { skillId: id, op: "delete" }),
      );
    } catch {
      // ignore
    }
    return c.json({ ok: true });
  });

  return app;
}

void USER_SKILLS_CAP_ERROR;
