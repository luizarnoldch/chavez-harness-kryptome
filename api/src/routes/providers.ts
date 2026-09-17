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
import {
  defaultsForProvider,
  validatePreferences,
  type ValidatedPrefs,
} from "../llm/prefs-validate";
import type { CursorParamSelection } from "../llm/cursor-types";
import { publicProviderPayload } from "../llm/provider-payload";
import { hub } from "../ws/hub";
import { UNAUTHORIZED } from "../ws/errors";
import {
  isLlmProvider,
  isVaultProvider,
} from "./provider-ids";

export type { LlmProviderId, ProviderId, VaultProviderId } from "./provider-ids";
export type AuthKind = "oauth_token" | "api_key";

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
    activeParams?: CursorParamSelection[] | null;
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
      activeParams: patch.activeParams ?? null,
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
        ...(patch.activeParams !== undefined
          ? { activeParams: patch.activeParams }
          : {}),
        updatedAt: now,
      })
      .where(eq(userPreferences.userId, userId));
  }
}

async function loadCatalogsForUser(userId: string) {
  const claudeRow = await loadCatalogRow(userId, "claude");
  const cursorRow = await loadCatalogRow(userId, "cursor");
  return {
    claude: {
      id: "claude" as const,
      label: PROVIDER_LABELS.claude,
      models: parseClaudeModels(claudeRow?.rawJson ?? wrapClaudeRaw(CLAUDE_MODELS)),
    },
    cursor: {
      id: "cursor" as const,
      label: PROVIDER_LABELS.cursor,
      models: parseCursorModels(cursorRow?.rawJson ?? null),
    },
  };
}

function currentPrefsFromRow(row: {
  activeProvider: string | null;
  activeModel: string | null;
  activeEffort: string | null;
  activeParams?: CursorParamSelection[] | null;
} | undefined): ValidatedPrefs {
  const provider = row?.activeProvider;
  return {
    activeProvider:
      provider === "claude" || provider === "cursor" ? provider : null,
    activeModel: row?.activeModel ?? null,
    activeEffort: row?.activeEffort ?? null,
    activeParams: row?.activeParams ?? null,
  };
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
    if (!session) return c.json({ error: UNAUTHORIZED }, 401);

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
    const githubRow = rows.find((r) => r.provider === "github");
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

    const claudePayload = publicProviderPayload({
      kind: "claude",
      linked: claudeLinked,
      raw: claudeRaw,
      lastError: claudeErr,
      authKind: claudeRow?.authKind,
      updatedAt: claudeRow?.updatedAt,
    });
    const cursorPayload = publicProviderPayload({
      kind: "cursor",
      linked: cursorLinked,
      raw: cursorRaw,
      lastError: cursorErr,
      authKind: cursorRow?.authKind,
      updatedAt: cursorRow?.updatedAt,
    });

    return c.json({
      ...publicPrefs(prefs[0]),
      catalogs: [
        {
          id: "claude",
          label: claudePayload.label,
          runnable: claudePayload.runnable,
          raw: claudePayload.raw,
          models: claudePayload.models,
          catalogError: claudePayload.catalogError,
        },
        {
          id: "cursor",
          label: cursorPayload.label,
          runnable: cursorPayload.runnable,
          raw: cursorPayload.raw,
          models: cursorPayload.models,
          catalogError: cursorPayload.catalogError,
        },
      ],
      providers: {
        claude: {
          linked: claudePayload.linked,
          authKind: claudePayload.authKind,
          updatedAt: claudePayload.updatedAt,
          label: claudePayload.label,
          runnable: claudePayload.runnable,
          models: claudePayload.models,
          catalogError: claudePayload.catalogError,
        },
        cursor: {
          linked: cursorPayload.linked,
          authKind: cursorPayload.authKind,
          updatedAt: cursorPayload.updatedAt,
          label: cursorPayload.label,
          runnable: cursorPayload.runnable,
          models: cursorPayload.models,
          catalogError: cursorPayload.catalogError,
        },
        github: {
          linked: Boolean(githubRow),
          authKind: githubRow?.authKind,
          updatedAt: githubRow?.updatedAt,
          label: "GitHub",
          runnable: false,
          models: [],
        },
      },
    });
  });

  app.put("/preferences", async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: UNAUTHORIZED }, 401);

    const body = await c.req.json<{
      activeProvider?: string | null;
      activeModel?: string | null;
      activeEffort?: string | null;
      activeExecutionMode?: string | null;
      activeParams?: CursorParamSelection[] | null;
    }>();

    if (
      body.activeProvider !== undefined &&
      body.activeProvider !== null &&
      !isLlmProvider(body.activeProvider)
    ) {
      return c.json({ error: "provider must be claude or cursor" }, 400);
    }

    if (body.activeExecutionMode !== undefined) {
      if (!isExecutionMode(body.activeExecutionMode)) {
        return c.json({ error: INVALID_MODE_ERROR }, 400);
      }
    }

    if (
      body.activeParams !== undefined &&
      body.activeParams !== null &&
      !Array.isArray(body.activeParams)
    ) {
      return c.json(
        { error: "activeParams must be an array of {id,value}" },
        400,
      );
    }

    const userId = session.user.id;
    const existing = await db
      .select()
      .from(userPreferences)
      .where(eq(userPreferences.userId, userId))
      .limit(1);
    const catalogs = await loadCatalogsForUser(userId);
    let validated: ValidatedPrefs;
    try {
      validated = validatePreferences(
        body,
        currentPrefsFromRow(existing[0]),
        catalogs,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 400);
    }

    await upsertPrefs(userId, {
      ...validated,
      ...(body.activeExecutionMode !== undefined
        ? { activeExecutionMode: body.activeExecutionMode }
        : {}),
    });
    const prefs = await db
      .select()
      .from(userPreferences)
      .where(eq(userPreferences.userId, userId))
      .limit(1);
    const payload = publicPrefs(prefs[0]);
    hub.broadcastToUser(
      userId,
      hub.pushEvent("prefs.updated", payload),
    );
    return c.json(payload);
  });

  app.put("/active", async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: UNAUTHORIZED }, 401);

    const body = await c.req.json<{ provider: string | null }>();
    const provider = body.provider;
    if (provider !== null && !isLlmProvider(provider)) {
      return c.json({ error: "provider must be claude or cursor" }, 400);
    }

    const userId = session.user.id;
    if (provider === "claude" || provider === "cursor") {
      const catalogs = await loadCatalogsForUser(userId);
      const defaults = defaultsForProvider(provider, catalogs);
      await upsertPrefs(userId, {
        activeProvider: provider,
        ...defaults,
      });
      const prefs = await db
        .select()
        .from(userPreferences)
        .where(eq(userPreferences.userId, userId))
        .limit(1);
      const payload = publicPrefs(prefs[0]);
      hub.broadcastToUser(userId, hub.pushEvent("prefs.updated", payload));
      return c.json({
        activeProvider: prefs[0]?.activeProvider ?? provider,
        activeModel: prefs[0]?.activeModel ?? defaults.activeModel,
        activeEffort: prefs[0]?.activeEffort ?? defaults.activeEffort,
        activeParams: prefs[0]?.activeParams ?? defaults.activeParams,
      });
    }

    await upsertPrefs(userId, { activeProvider: provider });
    const cleared = await db
      .select()
      .from(userPreferences)
      .where(eq(userPreferences.userId, userId))
      .limit(1);
    hub.broadcastToUser(
      userId,
      hub.pushEvent("prefs.updated", publicPrefs(cleared[0])),
    );
    return c.json({
      activeProvider: provider,
      activeModel: null,
      activeEffort: null,
      activeParams: null,
    });
  });

  app.put("/:provider/credentials", async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: UNAUTHORIZED }, 401);

    const providerParam = c.req.param("provider");
    if (!isVaultProvider(providerParam)) {
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
    if (!prefs[0]?.activeProvider && isLlmProvider(providerParam)) {
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
    if (!session) return c.json({ error: UNAUTHORIZED }, 401);

    const providerParam = c.req.param("provider");
    if (!isVaultProvider(providerParam)) {
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
    c.header("Cache-Control", "no-store");
    return c.json({
      provider: providerParam,
      authKind: row.authKind,
      secret,
    });
  });

  app.delete("/:provider/credentials", async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: UNAUTHORIZED }, 401);

    const providerParam = c.req.param("provider");
    if (!isVaultProvider(providerParam)) {
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
