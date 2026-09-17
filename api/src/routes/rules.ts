import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { userRules } from "../db/schema";
import { hub } from "../ws/hub";
import type { Session } from "../auth";
import {
  INVALID_DISALLOW_ERROR,
  USER_RULES_CAP_ERROR,
  USER_RULES_MAX,
  USER_RULE_BODY_ERROR,
  USER_RULE_BODY_MAX,
  USER_RULE_TITLE_ERROR,
  USER_RULE_TITLE_MAX,
  parseCanonicalToolList,
} from "../llm/rules-constants";

function publicRule(row: typeof userRules.$inferSelect) {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    enabled: row.enabled,
    disallowTools: row.disallowTools ?? [],
    allowTools: row.allowTools ?? [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function parseBodyFields(body: {
  title?: unknown;
  body?: unknown;
  enabled?: unknown;
  disallowTools?: unknown;
  allowTools?: unknown;
}, opts: { partial: boolean }) {
  const out: {
    title?: string;
    body?: string;
    enabled?: boolean;
    disallowTools?: string[];
    allowTools?: string[];
  } = {};
  if (body.title !== undefined || !opts.partial) {
    const title = String(body.title ?? "").trim();
    if (title.length < 1 || title.length > USER_RULE_TITLE_MAX) {
      throw new Error(USER_RULE_TITLE_ERROR);
    }
    out.title = title;
  }
  if (body.body !== undefined || !opts.partial) {
    const text = String(body.body ?? "");
    if (text.length < 1 || text.length > USER_RULE_BODY_MAX) {
      throw new Error(USER_RULE_BODY_ERROR);
    }
    out.body = text;
  }
  if (body.enabled !== undefined) out.enabled = Boolean(body.enabled);
  if (body.disallowTools !== undefined) {
    const list = parseCanonicalToolList(body.disallowTools);
    if (list == null) throw new Error(INVALID_DISALLOW_ERROR);
    out.disallowTools = list;
  }
  if (body.allowTools !== undefined) {
    const list = parseCanonicalToolList(body.allowTools);
    if (list == null) throw new Error(INVALID_DISALLOW_ERROR);
    out.allowTools = list;
  }
  return out;
}

export function createRuleRoutes(
  requireSession: (c: { req: { raw: Request } }) => Promise<Session | null>,
) {
  const app = new Hono();

  app.get("/", async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    const rows = await db
      .select()
      .from(userRules)
      .where(eq(userRules.userId, session.user.id));
    return c.json({ rules: rows.map(publicRule) });
  });

  app.post("/", async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    const json = await c.req.json().catch(() => ({}));
    let fields;
    try {
      fields = parseBodyFields(json, { partial: false });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
    const existing = await db
      .select({ id: userRules.id })
      .from(userRules)
      .where(eq(userRules.userId, session.user.id));
    if (existing.length >= USER_RULES_MAX) {
      return c.json({ error: USER_RULES_CAP_ERROR }, 400);
    }
    const now = new Date();
    const row = {
      id: crypto.randomUUID(),
      userId: session.user.id,
      title: fields.title!,
      body: fields.body!,
      enabled: fields.enabled ?? true,
      disallowTools: fields.disallowTools ?? [],
      allowTools: fields.allowTools ?? [],
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(userRules).values(row);
    hub.broadcastToUser(
      session.user.id,
      hub.pushEvent("rules.updated", { rules: [publicRule(row)], op: "create" }),
    );
    return c.json({ rule: publicRule(row) }, 201);
  });

  app.put("/:id", async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    const id = c.req.param("id");
    const json = await c.req.json().catch(() => ({}));
    let fields;
    try {
      fields = parseBodyFields(json, { partial: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
    const found = await db
      .select()
      .from(userRules)
      .where(and(eq(userRules.id, id), eq(userRules.userId, session.user.id)))
      .limit(1);
    if (!found[0]) return c.json({ error: "Rule not found" }, 404);
    const now = new Date();
    await db
      .update(userRules)
      .set({ ...fields, updatedAt: now })
      .where(and(eq(userRules.id, id), eq(userRules.userId, session.user.id)));
    const updated = { ...found[0], ...fields, updatedAt: now };
    hub.broadcastToUser(
      session.user.id,
      hub.pushEvent("rules.updated", { rules: [publicRule(updated)], op: "update" }),
    );
    return c.json({ rule: publicRule(updated) });
  });

  app.delete("/:id", async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    const id = c.req.param("id");
    const found = await db
      .select()
      .from(userRules)
      .where(and(eq(userRules.id, id), eq(userRules.userId, session.user.id)))
      .limit(1);
    if (!found[0]) return c.json({ error: "Rule not found" }, 404);
    await db
      .delete(userRules)
      .where(and(eq(userRules.id, id), eq(userRules.userId, session.user.id)));
    hub.broadcastToUser(
      session.user.id,
      hub.pushEvent("rules.updated", { id, op: "delete" }),
    );
    return c.json({ ok: true });
  });

  return app;
}
