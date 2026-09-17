import { Hono } from "hono";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../db";
import { memories, workspaces } from "../db/schema";
import { hub } from "../ws/hub";
import type { Session } from "../auth";
import {
  MEMORY_NOT_FOUND,
  USER_MEMORIES_CAP_ERROR,
  USER_MEMORIES_MAX,
  WORKSPACE_MEMORIES_CAP_ERROR,
  WORKSPACE_MEMORIES_MAX,
  parseSaveMemoryInput,
} from "../llm/memory-constants";

export function publicMemory(row: typeof memories.$inferSelect) {
  return {
    id: row.id,
    scope: row.scope as "user" | "workspace",
    title: row.title,
    fact: row.fact,
    workspaceId: row.workspaceId ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function loadMemoriesForTurn(input: {
  userId: string;
  workspaceId: string | null;
}) {
  const userRows = await db
    .select()
    .from(memories)
    .where(
      and(eq(memories.userId, input.userId), eq(memories.scope, "user")),
    )
    .orderBy(desc(memories.createdAt));
  if (!input.workspaceId) return userRows.map(publicMemory);
  const wsRows = await db
    .select()
    .from(memories)
    .where(
      and(
        eq(memories.userId, input.userId),
        eq(memories.scope, "workspace"),
        eq(memories.workspaceId, input.workspaceId),
      ),
    )
    .orderBy(desc(memories.createdAt));
  return [...userRows, ...wsRows]
    .sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    )
    .map(publicMemory);
}

async function assertWorkspaceOwned(userId: string, workspaceId: string) {
  const rows = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), eq(workspaces.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

export function createMemoryRoutes(
  requireSession: (c: { req: { raw: Request } }) => Promise<Session | null>,
) {
  const app = new Hono();

  app.get("/", async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    const workspaceId = c.req.query("workspaceId") || null;
    if (workspaceId) {
      const ws = await assertWorkspaceOwned(session.user.id, workspaceId);
      if (!ws) return c.json({ error: "Workspace not found" }, 404);
    }
    const list = await loadMemoriesForTurn({
      userId: session.user.id,
      workspaceId,
    });
    return c.json({ memories: list });
  });

  app.post("/", async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    const json = await c.req.json().catch(() => ({}));
    let fields;
    try {
      fields = parseSaveMemoryInput(json);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400,
      );
    }
    if (fields.scope === "workspace") {
      const ws = await assertWorkspaceOwned(session.user.id, fields.workspaceId!);
      if (!ws) return c.json({ error: "Workspace not found" }, 404);
    }
    const capWhere =
      fields.scope === "user"
        ? and(eq(memories.userId, session.user.id), eq(memories.scope, "user"))
        : and(
            eq(memories.userId, session.user.id),
            eq(memories.scope, "workspace"),
            eq(memories.workspaceId, fields.workspaceId!),
          );
    const existing = await db.select({ id: memories.id }).from(memories).where(capWhere);
    const cap = fields.scope === "user" ? USER_MEMORIES_MAX : WORKSPACE_MEMORIES_MAX;
    if (existing.length >= cap) {
      return c.json(
        {
          error:
            fields.scope === "user"
              ? USER_MEMORIES_CAP_ERROR
              : WORKSPACE_MEMORIES_CAP_ERROR,
        },
        400,
      );
    }
    const dup = await db
      .select()
      .from(memories)
      .where(
        and(
          eq(memories.userId, session.user.id),
          eq(memories.scope, fields.scope),
          eq(memories.fact, fields.fact),
          fields.scope === "user"
            ? isNull(memories.workspaceId)
            : eq(memories.workspaceId, fields.workspaceId!),
        ),
      )
      .limit(1);
    if (dup[0]) {
      const row = publicMemory(dup[0]);
      hub.broadcastToUser(
        session.user.id,
        hub.pushEvent("memory.changed", {
          workspaceId: row.workspaceId,
          memories: await loadMemoriesForTurn({
            userId: session.user.id,
            workspaceId: row.workspaceId,
          }),
        }),
      );
      return c.json({ memory: row, deduped: true });
    }
    const now = new Date();
    const row = {
      id: crypto.randomUUID(),
      userId: session.user.id,
      workspaceId: fields.workspaceId,
      scope: fields.scope,
      title: fields.title!,
      fact: fields.fact,
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(memories).values(row);
    const pub = publicMemory(row);
    hub.broadcastToUser(
      session.user.id,
      hub.pushEvent("memory.changed", {
        workspaceId: pub.workspaceId,
        memories: await loadMemoriesForTurn({
          userId: session.user.id,
          workspaceId: pub.workspaceId,
        }),
      }),
    );
    return c.json({ memory: pub }, 201);
  });

  app.delete("/:id", async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    const id = c.req.param("id");
    const rows = await db
      .select()
      .from(memories)
      .where(and(eq(memories.id, id), eq(memories.userId, session.user.id)))
      .limit(1);
    if (!rows[0]) return c.json({ error: MEMORY_NOT_FOUND }, 404);
    const prev = rows[0];
    await db
      .delete(memories)
      .where(and(eq(memories.id, id), eq(memories.userId, session.user.id)));
    hub.broadcastToUser(
      session.user.id,
      hub.pushEvent("memory.changed", {
        workspaceId: prev.workspaceId ?? null,
        memories: await loadMemoriesForTurn({
          userId: session.user.id,
          workspaceId: prev.workspaceId ?? null,
        }),
      }),
    );
    return c.json({ ok: true, id });
  });

  return app;
}
