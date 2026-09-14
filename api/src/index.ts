import { Hono } from "hono";
import { cors } from "hono/cors";
import { upgradeWebSocket, websocket } from "hono/bun";
import { auth } from "./auth";
import { createProviderRoutes } from "./routes/providers";
import {
  createSessionChatRoutes,
  createWorkspaceRoutes,
} from "./routes/workspaces";
import {
  deviceApprovePage,
  devicePage,
  linkProviderPage,
  signInPage,
  signInSentPage,
} from "./pages/html";
import { hub } from "./ws/hub";
import { handleWsMessage } from "./ws/handlers";

type Variables = {
  wsUserId: string;
};

const app = new Hono<{ Variables: Variables }>();

const corsMiddleware = cors({
  origin: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
  credentials: true,
});

// CORS only on HTTP routes — not on /ws (upgrade headers)
app.use("/api/*", corsMiddleware);
app.use("/me", corsMiddleware);
app.use("/providers/*", corsMiddleware);
app.use("/workspaces/*", corsMiddleware);
app.use("/sessions/*", corsMiddleware);
app.use("/chats/*", corsMiddleware);
app.use("/connections", corsMiddleware);
app.use("/health", corsMiddleware);
app.use("/sign-in", corsMiddleware);
app.use("/device", corsMiddleware);
app.use("/device/*", corsMiddleware);

async function requireSession(c: { req: { raw: Request } }) {
  return auth.api.getSession({ headers: c.req.raw.headers });
}

app.get("/health", (c) => c.json({ ok: true }));

app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

app.get("/me", async (c) => {
  const session = await requireSession(c);
  if (!session) return c.json({ error: "Unauthorized" }, 401);
  return c.json({
    user: {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
    },
  });
});

app.get("/sign-in", (c) => {
  const redirect = c.req.query("redirect") || "/device";
  return c.html(signInPage(redirect));
});

app.post("/sign-in", async (c) => {
  const body = await c.req.parseBody();
  const email = String(body.email || "");
  const redirect = String(body.redirect || "/device");
  if (!email) return c.html(signInPage(redirect), 400);

  await auth.api.signInMagicLink({
    body: {
      email,
      callbackURL: redirect,
      name: email.split("@")[0] || "Chavez user",
    },
    headers: c.req.raw.headers,
  });

  return c.html(signInSentPage(email, redirect));
});

app.get("/device", (c) => {
  const userCode = c.req.query("user_code") || "";
  return c.html(devicePage(userCode));
});

app.get("/device/approve", (c) => {
  const userCode = (c.req.query("user_code") || "").replace(/-/g, "").toUpperCase();
  if (!userCode) return c.redirect("/device");
  return c.html(deviceApprovePage(userCode));
});

app.get("/providers/link", (c) => {
  const provider = c.req.query("provider") || "claude";
  if (provider !== "claude" && provider !== "cursor") {
    return c.text("Unknown provider", 404);
  }
  return c.html(linkProviderPage(provider));
});

app.route("/providers", createProviderRoutes(requireSession));
app.route("/workspaces", createWorkspaceRoutes(requireSession));
app.route("/", createSessionChatRoutes(requireSession));

async function resolveWsUserId(c: {
  req: { query: (k: string) => string | undefined; raw: Request };
}): Promise<string | null> {
  const token = c.req.query("token");
  if (!token) return null;
  const headers = new Headers(c.req.raw.headers);
  headers.set("Authorization", `Bearer ${token}`);
  const session = await auth.api.getSession({ headers });
  return session?.user.id ?? null;
}

app.get(
  "/ws",
  async (c, next) => {
    const userId = await resolveWsUserId(c);
    if (!userId) {
      return c.text("Unauthorized", 401);
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
        hub.remove(connectionId);
      },
    };
  })
);

const port = Number(process.env.PORT || 3000);

export default {
  port,
  fetch: app.fetch,
  websocket,
};

console.log(`Chavez API listening on :${port} (Hono Bun WebSocket helper)`);
