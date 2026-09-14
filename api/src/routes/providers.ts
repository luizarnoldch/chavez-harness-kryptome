import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { providerCredentials, userPreferences } from "../db/schema";
import { decryptSecret, encryptSecret } from "../lib/crypto";
import type { Session } from "../auth";
import { PROVIDER_CATALOGS } from "../llm/catalog";

export type ProviderId = "claude" | "cursor";
export type AuthKind = "oauth_token" | "api_key";

const PROVIDERS: ProviderId[] = ["claude", "cursor"];

function isProvider(value: string): value is ProviderId {
  return PROVIDERS.includes(value as ProviderId);
}

function isAuthKind(value: string): value is AuthKind {
  return value === "oauth_token" || value === "api_key";
}

async function upsertPrefs(
  userId: string,
  patch: {
    activeProvider?: string | null;
    activeModel?: string | null;
    activeEffort?: string | null;
  }
) {
  const existing = await db
    .select()
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1);
  const now = new Date();
  if (existing.length === 0) {
    await db.insert(userPreferences).values({
      userId,
      activeProvider: patch.activeProvider ?? null,
      activeModel: patch.activeModel ?? null,
      activeEffort: patch.activeEffort ?? null,
      updatedAt: now,
    });
  } else {
    await db
      .update(userPreferences)
      .set({
        ...(patch.activeProvider !== undefined
          ? { activeProvider: patch.activeProvider }
          : {}),
        ...(patch.activeModel !== undefined
          ? { activeModel: patch.activeModel }
          : {}),
        ...(patch.activeEffort !== undefined
          ? { activeEffort: patch.activeEffort }
          : {}),
        updatedAt: now,
      })
      .where(eq(userPreferences.userId, userId));
  }
}

export function createProviderRoutes(
  requireSession: (c: {
    req: { raw: Request };
  }) => Promise<Session | null>
) {
  const app = new Hono();

  app.get("/", async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    const userId = session.user.id;
    const rows = await db
      .select({
        provider: providerCredentials.provider,
        authKind: providerCredentials.authKind,
        updatedAt: providerCredentials.updatedAt,
      })
      .from(providerCredentials)
      .where(eq(providerCredentials.userId, userId));

    const prefs = await db
      .select()
      .from(userPreferences)
      .where(eq(userPreferences.userId, userId))
      .limit(1);

    const linked = Object.fromEntries(
      PROVIDERS.map((provider) => {
        const row = rows.find((r) => r.provider === provider);
        const catalog = PROVIDER_CATALOGS.find((p) => p.id === provider);
        return [
          provider,
          {
            linked: Boolean(row),
            authKind: row?.authKind,
            updatedAt: row?.updatedAt,
            label: catalog?.label ?? provider,
            runnable: catalog?.runnable ?? false,
            models: catalog?.models ?? [],
          },
        ];
      })
    );

    return c.json({
      activeProvider: prefs[0]?.activeProvider ?? null,
      activeModel: prefs[0]?.activeModel ?? null,
      activeEffort: prefs[0]?.activeEffort ?? null,
      catalogs: PROVIDER_CATALOGS,
      providers: linked,
    });
  });

  app.put("/preferences", async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    const body = await c.req.json<{
      activeProvider?: string | null;
      activeModel?: string | null;
      activeEffort?: string | null;
    }>();

    if (
      body.activeProvider !== undefined &&
      body.activeProvider !== null &&
      !isProvider(body.activeProvider)
    ) {
      return c.json({ error: "provider must be claude or cursor" }, 400);
    }

    await upsertPrefs(session.user.id, body);
    const prefs = await db
      .select()
      .from(userPreferences)
      .where(eq(userPreferences.userId, session.user.id))
      .limit(1);

    return c.json({
      activeProvider: prefs[0]?.activeProvider ?? null,
      activeModel: prefs[0]?.activeModel ?? null,
      activeEffort: prefs[0]?.activeEffort ?? null,
    });
  });

  app.put("/active", async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    const body = await c.req.json<{ provider: string | null }>();
    const provider = body.provider;
    if (provider !== null && !isProvider(provider)) {
      return c.json({ error: "provider must be claude or cursor" }, 400);
    }

    await upsertPrefs(session.user.id, { activeProvider: provider });
    return c.json({ activeProvider: provider });
  });

  app.put("/:provider/credentials", async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    const providerParam = c.req.param("provider");
    if (!isProvider(providerParam)) {
      return c.json({ error: "Unknown provider" }, 404);
    }

    const body = await c.req.json<{ authKind: string; secret: string }>();
    if (!isAuthKind(body.authKind) || !body.secret?.trim()) {
      return c.json({ error: "authKind and secret are required" }, 400);
    }

    const userId = session.user.id;
    const ciphertext = await encryptSecret(body.secret.trim());
    const existing = await db
      .select()
      .from(providerCredentials)
      .where(eq(providerCredentials.userId, userId));

    const row = existing.find((r) => r.provider === providerParam);
    const now = new Date();

    if (row) {
      await db
        .update(providerCredentials)
        .set({
          authKind: body.authKind,
          ciphertext,
          updatedAt: now,
        })
        .where(eq(providerCredentials.id, row.id));
    } else {
      await db.insert(providerCredentials).values({
        id: crypto.randomUUID(),
        userId,
        provider: providerParam,
        authKind: body.authKind,
        ciphertext,
        createdAt: now,
        updatedAt: now,
      });
    }

    const prefs = await db
      .select()
      .from(userPreferences)
      .where(eq(userPreferences.userId, userId))
      .limit(1);
    if (!prefs[0]?.activeProvider) {
      await upsertPrefs(userId, { activeProvider: providerParam });
    }

    return c.json({ ok: true, provider: providerParam, authKind: body.authKind });
  });

  app.get("/:provider/credentials", async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    const providerParam = c.req.param("provider");
    if (!isProvider(providerParam)) {
      return c.json({ error: "Unknown provider" }, 404);
    }

    const userId = session.user.id;
    const rows = await db
      .select()
      .from(providerCredentials)
      .where(eq(providerCredentials.userId, userId));
    const row = rows.find((r) => r.provider === providerParam);
    if (!row) {
      return c.json({ error: "Credentials not linked" }, 404);
    }

    const secret = await decryptSecret(row.ciphertext);
    return c.json({
      provider: providerParam,
      authKind: row.authKind,
      secret,
    });
  });

  app.delete("/:provider/credentials", async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    const providerParam = c.req.param("provider");
    if (!isProvider(providerParam)) {
      return c.json({ error: "Unknown provider" }, 404);
    }

    const userId = session.user.id;
    const rows = await db
      .select()
      .from(providerCredentials)
      .where(eq(providerCredentials.userId, userId));
    const row = rows.find((r) => r.provider === providerParam);
    if (!row) {
      return c.json({ error: "Credentials not linked" }, 404);
    }

    await db
      .delete(providerCredentials)
      .where(eq(providerCredentials.id, row.id));

    return c.json({ ok: true });
  });

  return app;
}
