import { Hono } from "hono";
import { cors } from "hono/cors";
import { upgradeWebSocket, websocket } from "hono/bun";
import { env } from "./lib/config";
import { auth } from "./auth";
import { createProviderRoutes } from "./routes/providers";
import {
  createSessionChatRoutes,
  createWorkspaceRoutes,
} from "./routes/workspaces";
import { hub } from "./ws/hub";
import { handleWsMessage } from "./ws/handlers";
import { openApiRoutes } from "./openapi";
import { UNAUTHORIZED } from "./ws/errors";

type Variables = {
  wsUserId: string;
};

const app = new Hono<{ Variables: Variables }>();

const corsMiddleware = cors({
  origin: env.public.trustedOrigins,
  credentials: true,
});

// CORS only on HTTP routes — not on /ws (upgrade headers)
app.use("/api/*", corsMiddleware);
app.use("/me", corsMiddleware);
app.use("/me/*", corsMiddleware);
app.use("/providers/*", corsMiddleware);
app.use("/workspaces/*", corsMiddleware);
app.use("/sessions/*", corsMiddleware);
app.use("/chats/*", corsMiddleware);
app.use("/connections", corsMiddleware);
app.use("/health", corsMiddleware);
app.use("/sign-in", corsMiddleware);
app.use("/device", corsMiddleware);
app.use("/device/*", corsMiddleware);
app.use("/docs", corsMiddleware);
app.use("/openapi.json", corsMiddleware);

async function requireSession(c: { req: { raw: Request } }) {
  return auth.api.getSession({ headers: c.req.raw.headers });
}

app.get("/health", (c) => c.json({ ok: true }));

app.route("/", openApiRoutes);

app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

app.get("/me", async (c) => {
  const session = await requireSession(c);
  if (!session) return c.json({ error: UNAUTHORIZED }, 401);
  return c.json({
    user: {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
    },
  });
});

/** Set password for magic-link-only accounts (Better Auth setPassword is server-only). */
app.post("/me/password", async (c) => {
  const session = await requireSession(c);
  if (!session) return c.json({ error: UNAUTHORIZED }, 401);
  const body = await c.req.json().catch(() => ({}));
  const newPassword = String(
    (body as { newPassword?: string; password?: string }).newPassword ||
      (body as { password?: string }).password ||
      "",
  );
  if (newPassword.length < 8) {
    return c.json({ error: "Password must be at least 8 characters" }, 400);
  }
  try {
    await auth.api.setPassword({
      body: { newPassword },
      headers: c.req.raw.headers,
    });
    return c.json({ ok: true });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to set password";
    const already =
      /already|PASSWORD_ALREADY/i.test(message) ||
      String((err as { body?: { code?: string } })?.body?.code || "").includes(
        "PASSWORD_ALREADY",
      );
    return c.json(
      { error: already ? "Password already set — use sign-in" : message },
      already ? 400 : 400,
    );
  }
});

app.get("/sign-in", (c) => {
  const redirect = c.req.query("redirect") || "/device";
  const web = env.public.webOrigin.replace(/\/$/, "");
  const q = new URLSearchParams({ redirect });
  return c.redirect(`${web}/sign-in?${q.toString()}`);
});

app.post("/sign-in", async (c) => {
  const body = await c.req.parseBody();
  const email = String(body.email || "").trim().toLowerCase();
  const redirect = String(body.redirect || "/device");
  const web = env.public.webOrigin.replace(/\/$/, "");
  if (!email) {
    return c.redirect(
      `${web}/sign-in?redirect=${encodeURIComponent(redirect)}&error=email`,
    );
  }

  const callbackURL = redirect.startsWith("http")
    ? redirect
    : `${web}${redirect.startsWith("/") ? redirect : `/${redirect}`}`;

  await auth.api.signInMagicLink({
    body: {
      email,
      callbackURL,
      newUserCallbackURL: callbackURL,
      name: email.split("@")[0] || "Chavez user",
    },
    headers: c.req.raw.headers,
  });

  return c.redirect(
    `${web}/sign-in?sent=1&email=${encodeURIComponent(email)}&redirect=${encodeURIComponent(redirect)}`,
  );
});

app.get("/device", (c) => {
  const userCode = c.req.query("user_code") || "";
  const web = env.public.webOrigin.replace(/\/$/, "");
  const q = userCode
    ? `?user_code=${encodeURIComponent(userCode)}`
    : "";
  return c.redirect(`${web}/device${q}`);
});

app.get("/device/approve", (c) => {
  const userCode = (c.req.query("user_code") || "").replace(/-/g, "").toUpperCase();
  const web = env.public.webOrigin.replace(/\/$/, "");
  if (!userCode) return c.redirect(`${web}/device`);
  return c.redirect(
    `${web}/device/approve?user_code=${encodeURIComponent(userCode)}`,
  );
});

app.get("/providers/link", (c) => {
  const provider = c.req.query("provider") || "claude";
  const web = env.public.webOrigin.replace(/\/$/, "");
  if (provider !== "claude" && provider !== "cursor") {
    return c.text("Unknown provider", 404);
  }
  const token = c.req.query("token");
  const q = new URLSearchParams({ provider });
  if (token) q.set("token", token);
  return c.redirect(`${web}/providers?${q.toString()}`);
});

app.route("/providers", createProviderRoutes(requireSession));
app.route("/workspaces", createWorkspaceRoutes(requireSession));
app.route("/", createSessionChatRoutes(requireSession));

async function resolveWsUserId(c: {
  req: { query: (k: string) => string | undefined; raw: Request };
}): Promise<string | null> {
  const token = c.req.query("token");
  if (token) {
    const headers = new Headers(c.req.raw.headers);
    headers.set("Authorization", `Bearer ${token}`);
    const session = await auth.api.getSession({ headers });
    if (session?.user.id) return session.user.id;
  }
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  return session?.user.id ?? null;
}

app.get(
  "/ws",
  async (c, next) => {
    const userId = await resolveWsUserId(c);
    if (!userId) {
      return c.text(UNAUTHORIZED, 401);
    }
    c.set("wsUserId", userId);
    await next();
  },
  upgradeWebSocket((c) => {
    const userId = c.get("wsUserId");
    const connectionId = crypto.randomUUID();

    return {
      onOpen(_event, ws) {
        hub.add({
          connectionId,
          userId,
          workspaceId: null,
          ws,
        });
      },
      async onMessage(event, ws) {
        const text =
          typeof event.data === "string"
            ? event.data
            : new TextDecoder().decode(event.data as ArrayBuffer);
        const reply = await handleWsMessage(connectionId, userId, text);
        ws.send(JSON.stringify(reply));
      },
      onClose() {
        const conn = hub.get(connectionId);
        hub.remove(connectionId);
        if (conn?.workspaceId) {
          const next = hub.findDaemon(conn.userId, conn.workspaceId);
          hub.broadcastToUser(
            conn.userId,
            hub.pushEvent("daemon.presence", {
              workspaceId: conn.workspaceId,
              bound: Boolean(next),
              hostname: next?.hostname ?? null,
              path: next?.path ?? null,
              connectionId: next?.connectionId ?? null,
              role: next ? "primary" : null,
              reason: "disconnected",
            }),
          );
        }
      },
    };
  })
);

export default {
  port: env.public.listenPort,
  fetch: app.fetch,
  websocket,
};

console.log(
  `Chavez API listening on :${env.public.listenPort} (context ports: ${env.public.listenPorts.join(", ")}; Hono Bun WebSocket helper)`,
);
