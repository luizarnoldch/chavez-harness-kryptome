/**
 * Smoke Gherkin plan 21 — sin LLM.
 * Need: API up, chavez login (CHAVEZ_ACCESS_TOKEN or ~/.chavez/config.json).
 *
 * A) GET /me/onboarding 200, wizardVisible boolean
 * B) PUT action=yolo → 400 action must be skip or complete
 * C) PUT skip → wizardVisible false; GET /providers 200; GET /workspaces 200
 * D) PUT complete → status completed
 * E) chat ask preflight strings (unit already); here: GET snapshot steps
 */
import { apiFetch, ApiError } from "../src/api-client";
import { loadConfig } from "../src/config";
import {
  INVALID_ONBOARDING_ACTION,
  type OnboardingSnapshot,
} from "../src/onboarding/status";

const config = loadConfig();
const token = process.env.CHAVEZ_ACCESS_TOKEN || config.accessToken;
if (!token) {
  console.error("Need login");
  process.exit(1);
}

const snap = await apiFetch<OnboardingSnapshot>("/me/onboarding");
console.log("A) GET", snap.status, "wizardVisible=", snap.wizardVisible);
if (typeof snap.wizardVisible !== "boolean") {
  throw new Error("wizardVisible missing");
}
if (!snap.steps || typeof snap.steps.providerLinked !== "boolean") {
  throw new Error("steps missing");
}

try {
  await apiFetch("/me/onboarding", {
    method: "PUT",
    body: JSON.stringify({ action: "yolo" }),
  });
  throw new Error("yolo should 400");
} catch (err) {
  if (!(err instanceof ApiError) || err.status !== 400) throw err;
  const body = err.body as { error?: string } | undefined;
  const msg = body?.error || err.message;
  if (msg !== INVALID_ONBOARDING_ACTION) {
    throw new Error(`expected ${INVALID_ONBOARDING_ACTION}, got ${msg}`);
  }
  console.log("B) PUT yolo → 400", msg);
}

const skipped = await apiFetch<OnboardingSnapshot>("/me/onboarding", {
  method: "PUT",
  body: JSON.stringify({ action: "skip" }),
});
if (skipped.wizardVisible) throw new Error("skip must hide wizard");
console.log("C) skip wizardVisible=false");

const providers = await apiFetch<{ providers: unknown }>("/providers");
if (!providers.providers) throw new Error("GET /providers blocked after skip");
const workspaces = await apiFetch<{ workspaces: unknown[] }>("/workspaces");
if (!Array.isArray(workspaces.workspaces)) {
  throw new Error("GET /workspaces blocked after skip");
}
console.log("C) providers+workspaces still 200");

const completed = await apiFetch<OnboardingSnapshot>("/me/onboarding", {
  method: "PUT",
  body: JSON.stringify({ action: "complete" }),
});
if (completed.status !== "completed") {
  throw new Error("complete did not stick");
}
if (completed.wizardVisible) throw new Error("completed still visible");
console.log("D) complete", completed.status);

const again = await apiFetch<OnboardingSnapshot>("/me/onboarding", {
  method: "PUT",
  body: JSON.stringify({ action: "skip" }),
});
if (again.status !== "completed") {
  throw new Error("skip must not undo complete");
}
console.log("D) skip after complete stays completed");

console.log("onboarding-smoke ok");
