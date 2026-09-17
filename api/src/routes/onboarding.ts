import { Hono } from "hono";
import type { Session } from "../auth";
import {
  INVALID_ONBOARDING_ACTION,
  isOnboardingAction,
  ONBOARDING_EVENT,
} from "../onboarding/status";
import {
  buildOnboarding,
  persistOnboardingAction,
} from "../onboarding/build";
import { hub } from "../ws/hub";

export function createOnboardingRoutes(
  requireSession: (c: { req: { raw: Request } }) => Promise<Session | null>,
) {
  const app = new Hono();

  app.get("/onboarding", async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    const body = await buildOnboarding(session.user.id);
    return c.json(body);
  });

  app.put("/onboarding", async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    const body = await c.req.json<{ action?: unknown }>().catch(() => ({}));
    if (!isOnboardingAction(body.action)) {
      return c.json({ error: INVALID_ONBOARDING_ACTION }, 400);
    }
    const snap = await persistOnboardingAction(session.user.id, body.action);
    hub.broadcastToUser(
      session.user.id,
      hub.pushEvent(ONBOARDING_EVENT, snap),
    );
    return c.json(snap);
  });

  return app;
}
