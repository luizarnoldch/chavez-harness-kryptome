import { eq } from "drizzle-orm";
import { db } from "../db";
import { providerCredentials, userPreferences } from "../db/schema";
import { hub } from "../ws/hub";
import { PROVIDER_CATALOGS } from "../llm/catalog";
import {
  applyOnboardingAction,
  deriveOnboarding,
  parseOnboardingStatus,
  type OnboardingAction,
  type OnboardingSnapshot,
} from "./status";

export type OnboardingPublic = OnboardingSnapshot & {
  nextHint: string | null;
  daemon: {
    workspaceId: string;
    path: string | null;
    hostname: string | null;
  } | null;
};

function runnableIds(): Set<string> {
  return new Set(
    PROVIDER_CATALOGS.filter((p) => p.runnable).map((p) => p.id),
  );
}

export async function factsForUser(userId: string) {
  const creds = await db
    .select({ provider: providerCredentials.provider })
    .from(providerCredentials)
    .where(eq(providerCredentials.userId, userId));
  const linked = new Set(creds.map((r) => r.provider));
  const runnable = runnableIds();
  const runnableLinked = [...linked].some((id) => runnable.has(id));
  const cursorLinkedOnly = linked.has("cursor") && !runnableLinked;
  const daemon = hub.findAnyDaemon(userId);
  const prefs = await db
    .select()
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1);
  return {
    persistedStatus: parseOnboardingStatus(prefs[0]?.onboardingStatus),
    runnableLinked,
    daemonBound: Boolean(daemon),
    cursorLinkedOnly,
    daemon,
    prefsRow: prefs[0] ?? null,
  };
}

export async function buildOnboarding(userId: string): Promise<OnboardingPublic> {
  const facts = await factsForUser(userId);
  const snap = deriveOnboarding(facts);
  const d = facts.daemon;
  return {
    ...snap,
    nextHint: snap.cursorLinkedOnly
      ? "Cursor está vinculado pero no ejecuta turns. Para el primer turn: chavez provider link claude"
      : snap.nextCommand,
    daemon: d
      ? {
          workspaceId: d.workspaceId!,
          path: d.path,
          hostname: d.hostname ?? null,
        }
      : null,
  };
}

export async function persistOnboardingAction(
  userId: string,
  action: OnboardingAction,
): Promise<OnboardingPublic> {
  const facts = await factsForUser(userId);
  const next = applyOnboardingAction(facts.persistedStatus, action);
  const now = new Date();
  const completedAt =
    next === "completed"
      ? now
      : (facts.prefsRow?.onboardingCompletedAt ?? null);
  if (!facts.prefsRow) {
    await db.insert(userPreferences).values({
      userId,
      onboardingStatus: next,
      onboardingCompletedAt: next === "completed" ? now : null,
      updatedAt: now,
    });
  } else {
    await db
      .update(userPreferences)
      .set({
        onboardingStatus: next,
        onboardingCompletedAt: completedAt,
        updatedAt: now,
      })
      .where(eq(userPreferences.userId, userId));
  }
  return buildOnboarding(userId);
}

export async function markOnboardingComplete(
  userId: string,
): Promise<OnboardingPublic> {
  return persistOnboardingAction(userId, "complete");
}
