import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { userSkills } from "../db/schema";
import type { Session } from "../auth";
import { hub } from "../ws/hub";
import {
  MARKETPLACE_KIND_LAYER,
  marketplaceAlreadyInstalled,
  marketplaceNotFound,
  marketplaceUninstalled,
  validateMarketplaceInstallBody,
} from "../llm/marketplace-constants";
import { loadOfficialCatalog, lookupOfficial } from "../llm/marketplace-catalog";
import { mergeMarketplaceView } from "../llm/marketplace-view";
import {
  USER_SKILLS_MAX,
  USER_SKILLS_CAP_ERROR,
} from "../llm/skills-constants";

function publicSkill(row: {
  id: string;
  name: string;
  description: string;
  body: string;
  enabled: boolean;
  source?: string;
  catalogId?: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
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

export function createMarketplaceRoutes(
  requireSession: (c: { req: { raw: Request } }) => Promise<Session | null>,
) {
  const app = new Hono();

  app.get("/", async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    const { entries, errors } = loadOfficialCatalog();
    const rows = await db
      .select()
      .from(userSkills)
      .where(eq(userSkills.userId, session.user.id));
    const view = mergeMarketplaceView({
      catalog: entries,
      catalogErrors: errors,
      installedSkills: rows.map((r) => ({
        name: r.name,
        layer: "user" as const,
        catalogId: r.catalogId,
      })),
    });
    return c.json({
      entries: view.entries,
      errors: view.errors,
      nativeToolsContinue: true as const,
    });
  });

  app.post("/install", async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    const body = await c.req.json().catch(() => ({}));
    const validated = validateMarketplaceInstallBody(body);
    if (!validated.ok) return c.json({ error: validated.error }, 400);
    const { id } = validated;
    const found = lookupOfficial(id);
    if (!found.ok) return c.json({ error: found.error }, 404);
    if (found.entry.kind !== "skill" || !found.entry.body) {
      return c.json({ error: marketplaceNotFound(id) }, 404);
    }
    const existing = await db
      .select()
      .from(userSkills)
      .where(eq(userSkills.userId, session.user.id));
    if (existing.some((r) => r.name === found.entry.name)) {
      return c.json({ error: marketplaceAlreadyInstalled(found.entry.name) }, 409);
    }
    if (existing.length >= USER_SKILLS_MAX) {
      return c.json({ error: USER_SKILLS_CAP_ERROR }, 400);
    }
    const now = new Date();
    const row = {
      id: crypto.randomUUID(),
      userId: session.user.id,
      name: found.entry.name,
      description: found.entry.description,
      body: found.entry.body,
      enabled: true,
      source: "marketplace" as const,
      catalogId: found.entry.id,
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(userSkills).values(row);
    const skills = [...existing, row].map((r) => publicSkill(r));
    try {
      hub.broadcastToUser(
        session.user.id,
        hub.pushEvent("skills.updated", { skills }),
      );
      hub.broadcastToUser(
        session.user.id,
        hub.pushEvent("marketplace.changed", {
          kind: "skill",
          op: "install",
          name: row.name,
        }),
      );
    } catch {
      // HTTP ok even if broadcast fails
    }
    return c.json({ skill: publicSkill(row) }, 201);
  });

  app.post("/uninstall", async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    const body = await c.req.json().catch(() => ({}));
    const kind = String((body as { kind?: string }).kind || "");
    const name = String((body as { name?: string }).name || "").trim();
    if (kind === "mcp") return c.json({ error: MARKETPLACE_KIND_LAYER }, 400);
    if (kind !== "skill" || !name) return c.json({ error: MARKETPLACE_KIND_LAYER }, 400);
    const found = await db
      .select()
      .from(userSkills)
      .where(
        and(eq(userSkills.userId, session.user.id), eq(userSkills.name, name)),
      )
      .limit(1);
    if (!found[0]) return c.json({ error: `Not installed: ${name}` }, 404);
    await db.delete(userSkills).where(eq(userSkills.id, found[0].id));
    try {
      hub.broadcastToUser(
        session.user.id,
        hub.pushEvent("skills.updated", { op: "delete", name }),
      );
      hub.broadcastToUser(
        session.user.id,
        hub.pushEvent("marketplace.changed", { kind: "skill", op: "uninstall", name }),
      );
    } catch {
      // ignore
    }
    return c.json({ ok: true, name, message: marketplaceUninstalled("skill", name) });
  });

  return app;
}
