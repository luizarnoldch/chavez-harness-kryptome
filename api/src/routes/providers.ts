import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import {
  providerCatalogs,
  providerCredentials,
  userPreferences,
} from "../db/schema";
import { decryptSecret, encryptSecret } from "../lib/crypto";
import type { Session } from "../auth";
import { CLAUDE_MODELS, PROVIDER_LABELS } from "../llm/catalog";
import {
  parseClaudeModels,
  parseCursorModels,
  wrapClaudeRaw,
} from "../llm/catalog-codec";
import {
  catalogIsFresh,
  fetchCursorModelsRaw,
} from "../llm/cursor-discover";
import {
  DEFAULT_EXECUTION_MODE,
  INVALID_MODE_ERROR,
  isExecutionMode,
} from "../llm/execution-mode";
import { hub } from "../ws/hub";

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
    activeExecutionMode?: string | null;
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
      activeExecutionMode: patch.activeExecutionMode ?? DEFAULT_EXECUTION_MODE,
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
        ...(patch.activeExecutionMode !== undefined
          ? { activeExecutionMode: patch.activeExecutionMode }
          : {}),
        updatedAt: now,
      })
      .where(eq(userPreferences.userId, userId));
  }
}

function publicPrefs(row: {
  activeProvider: string | null;
  activeModel: string | null;
  activeEffort: string | null;
  activeExecutionMode?: string | null;
  activeParams?: Array<{ id: string; value: string }> | null;
} | undefined) {
  return {
    activeProvider: row?.activeProvider ?? null,
    activeModel: row?.activeModel ?? null,
    activeEffort: row?.activeEffort ?? null,
    activeParams: row?.activeParams ?? null,
    activeExecutionMode: isExecutionMode(row?.activeExecutionMode)
      ? row!.activeExecutionMode
      : DEFAULT_EXECUTION_MODE,
  };
}

async function loadCatalogRow(userId: string, provider: string) {
  const rows = await db
    .select()
    .from(providerCatalogs)
    .where(
      and(
        eq(providerCatalogs.userId, userId),
        eq(providerCatalogs.provider, provider),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function upsertCatalog(
  userId: string,
  provider: string,
  rawJson: unknown,
  lastError: string | null,
) {
  const existing = await loadCatalogRow(userId, provider);
  const now = new Date();
  if (!existing) {
    await db.insert(providerCatalogs).values({
      userId,
      provider,
      rawJson,
      fetchedAt: now,
      lastError,
    });
    return;
  }
  await db
    .update(providerCatalogs)
    .set({
      rawJson,
      fetchedAt: now,
      lastError,
    })
    .where(
      and(
        eq(providerCatalogs.userId, userId),
        eq(providerCatalogs.provider, provider),
      ),
    );
}

async function refreshClaudeCatalog(userId: string) {
  const raw = wrapClaudeRaw(CLAUDE_MODELS);
  await upsertCatalog(userId, "claude", raw, null);
  return { raw, lastError: null as string | null };
}

async function refreshCursorCatalog(
  userId: string,
  apiKey: string,
  force: boolean,
): Promise<{ raw: unknown; lastError: string | null }> {
  const existing = await loadCatalogRow(userId, "cursor");
  if (existing && !force && catalogIsFresh(existing.fetchedAt)) {
    return { raw: existing.rawJson, lastError: existing.lastError };
  }
  try {
    const raw = await fetchCursorModelsRaw(apiKey);
    await upsertCatalog(userId, "cursor", raw, null);
    return { raw, lastError: null };
  } catch (err) {
    const lastError = err instanceof Error ? err.message : String(err);
    if (existing) {
      await db
        .update(providerCatalogs)
        .set({ lastError })
        .where(
          and(
            eq(providerCatalogs.userId, userId),
            eq(providerCatalogs.provider, "cursor"),
          ),
        );
      return { raw: existing.rawJson, lastError };
    }
    return { raw: null, lastError };
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
    const force = c.req.query("refresh") === "1";
    const rows = await db
      .select({
        provider: providerCredentials.provider,
        authKind: providerCredentials.authKind,
        updatedAt: providerCredentials.updatedAt,
        ciphertext: providerCredentials.ciphertext,
      })
      .from(providerCredentials)
      .where(eq(providerCredentials.userId, userId));

    const prefs = await db
      .select()
      .from(userPreferences)
      .where(eq(userPreferences.userId, userId))
      .limit(1);

    const claudeRow = rows.find((r) => r.provider === "claude");
    const cursorRow = rows.find((r) => r.provider === "cursor");
    const claudeLinked = Boolean(claudeRow);
    const cursorLinked = Boolean(cursorRow);

    let claudeRaw: unknown = null;
    let claudeErr: string | null = null;
    let cursorRaw: unknown = null;
    let cursorErr: string | null = null;

    if (claudeLinked) {
      const refreshed = await refreshClaudeCatalog(userId);
      claudeRaw = refreshed.raw;
      claudeErr = refreshed.lastError;
    } else {
      const cached = await loadCatalogRow(userId, "claude");
      claudeRaw = cached?.rawJson ?? null;
      claudeErr = cached?.lastError ?? null;
    }

    if (cursorLinked && cursorRow) {
      const secret = await decryptSecret(cursorRow.ciphertext);
      const refreshed = await refreshCursorCatalog(userId, secret, force);
      cursorRaw = refreshed.raw;
      cursorErr = refreshed.lastError;
    } else {
      const cached = await loadCatalogRow(userId, "cursor");
      cursorRaw = cached?.rawJson ?? null;
      cursorErr = cached?.lastError ?? null;
    }

    const claudeModels = parseClaudeModels(claudeRaw);
    const cursorModels = parseCursorModels(cursorRaw);
    const claudeRunnable = claudeLinked && claudeModels.length > 0;
    const cursorRunnable = cursorLinked && cursorModels.length > 0;

    return c.json({
      ...publicPrefs(prefs[0]),
      catalogs: [
        {
          id: "claude",
          label: PROVIDER_LABELS.claude,
          runnable: claudeRunnable,
          raw: claudeRaw,
          models: claudeModels,
          catalogError: claudeErr,
        },
        {
          id: "cursor",
          label: PROVIDER_LABELS.cursor,
          runnable: cursorRunnable,
          raw: cursorRaw,
          models: cursorModels,
          catalogError: cursorErr,
        },
      ],
      providers: {
        claude: {
          linked: claudeLinked,
          authKind: claudeRow?.authKind,
          updatedAt: claudeRow?.updatedAt,
          label: PROVIDER_LABELS.claude,
          runnable: claudeRunnable,
          models: claudeModels,
          catalogError: claudeErr,
        },
        cursor: {
          linked: cursorLinked,
          authKind: cursorRow?.authKind,
          updatedAt: cursorRow?.updatedAt,
          label: PROVIDER_LABELS.cursor,
          runnable: cursorRunnable,
          models: cursorModels,
          catalogError: cursorErr,
        },
      },
    });
  });

  app.put("/preferences", async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    const body = await c.req.json<{
      activeProvider?: string | null;
      activeModel?: string | null;
      activeEffort?: string | null;
      activeExecutionMode?: string | null;
    }>();

    if (
      body.activeProvider !== undefined &&
      body.activeProvider !== null &&
      !isProvider(body.activeProvider)
    ) {
      return c.json({ error: "provider must be claude or cursor" }, 400);
    }

    if (body.activeExecutionMode !== undefined) {
      if (!isExecutionMode(body.activeExecutionMode)) {
        return c.json({ error: INVALID_MODE_ERROR }, 400);
      }
    }

    await upsertPrefs(session.user.id, body);
    const prefs = await db
      .select()
      .from(userPreferences)
      .where(eq(userPreferences.userId, session.user.id))
      .limit(1);
    const payload = publicPrefs(prefs[0]);
    hub.broadcastToUser(
      session.user.id,
      hub.pushEvent("prefs.updated", payload),
    );
    return c.json(payload);
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

    if (providerParam === "cursor") {
      await refreshCursorCatalog(userId, body.secret.trim(), true);
    }
    if (providerParam === "claude") {
      await refreshClaudeCatalog(userId);
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
