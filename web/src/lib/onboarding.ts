/** keep-in-sync: cli/src/onboarding/status.ts, api/src/onboarding/status.ts */

export const ONBOARDING_STATUSES = ["pending", "skipped", "completed"] as const;
export type OnboardingStatus = (typeof ONBOARDING_STATUSES)[number];
export const DEFAULT_ONBOARDING_STATUS: OnboardingStatus = "pending";

export const ONBOARDING_STEPS = ["provider", "daemon", "chat"] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export const NO_DAEMON_ERROR =
  "No daemon bound for this workspace. Run: chavez headless workspace open";
export const NO_PROVIDER_ASK =
  "No hay provider vinculado. Siguiente paso: chavez provider link claude";
export const NEXT_PROVIDER = "Siguiente paso: chavez provider link claude";
export const NEXT_DAEMON =
  "Siguiente paso: chavez tui   (o: chavez headless workspace open)";
export const NEXT_CHAT =
  "Siguiente paso: abre un chat en TUI/Web o: chavez headless chat ask <chatId> <prompt>";
export const HINT_LOGIN_HEADER = "Primer uso — tres pasos:";
export const STEP_PROVIDER_LABEL = "Vincular provider (Claude)";
export const STEP_DAEMON_LABEL = "Abrir un workspace con el daemon";
export const STEP_CHAT_LABEL = "Ir a un chat y enviar el primer prompt";
export const SKIP_LABEL = "Saltar";
export const WIZARD_TITLE = "Primer uso";
export const EMPTY_WORKSPACE_COPY =
  "El filesystem vive en la máquina del daemon, no en el navegador. En el cwd del proyecto corre: chavez tui   o   chavez headless workspace open";
export const NO_RUNNER_LABEL = "sin runner";
export const CLIENT_BIND_HINT =
  "El navegador no es el filesystem. Bind de cliente solo crea sessions/chats; los turns necesitan el daemon.";
export const CURSOR_NOT_RUNNABLE_HINT =
  "Cursor está vinculado pero no ejecuta turns. Para el primer turn: chavez provider link claude";
export const INVALID_ONBOARDING_ACTION = "action must be skip or complete";
export const ONBOARDING_EVENT = "onboarding.updated";

export type OnboardingAction = "skip" | "complete";

export type OnboardingFacts = {
  persistedStatus: OnboardingStatus | null | undefined;
  runnableLinked: boolean;
  daemonBound: boolean;
  cursorLinkedOnly?: boolean;
};

export type OnboardingSnapshot = {
  status: OnboardingStatus;
  wizardVisible: boolean;
  steps: {
    providerLinked: boolean;
    daemonBound: boolean;
    firstTurn: boolean;
  };
  nextStep: OnboardingStep | null;
  nextCommand: string | null;
  cursorLinkedOnly: boolean;
};

export function parseOnboardingStatus(v: unknown): OnboardingStatus {
  if (v == null || v === "") return DEFAULT_ONBOARDING_STATUS;
  if (v === "pending" || v === "skipped" || v === "completed") return v;
  return DEFAULT_ONBOARDING_STATUS;
}

export function isOnboardingAction(v: unknown): v is OnboardingAction {
  return v === "skip" || v === "complete";
}

export function wizardVisible(status: OnboardingStatus): boolean {
  return status === "pending";
}

export function deriveOnboarding(facts: OnboardingFacts): OnboardingSnapshot {
  const status = parseOnboardingStatus(facts.persistedStatus);
  const providerLinked = Boolean(facts.runnableLinked);
  const daemonBound = Boolean(facts.daemonBound);
  const firstTurn = status === "completed";
  let nextStep: OnboardingStep | null = null;
  if (!providerLinked) nextStep = "provider";
  else if (!daemonBound) nextStep = "daemon";
  else if (!firstTurn) nextStep = "chat";
  if (status === "completed") nextStep = null;
  return {
    status,
    wizardVisible: wizardVisible(status),
    steps: { providerLinked, daemonBound, firstTurn },
    nextStep,
    nextCommand: commandForStep(nextStep),
    cursorLinkedOnly: Boolean(facts.cursorLinkedOnly) && !providerLinked,
  };
}

export function commandForStep(step: OnboardingStep | null): string | null {
  if (step === "provider") return NEXT_PROVIDER;
  if (step === "daemon") return NEXT_DAEMON;
  if (step === "chat") return NEXT_CHAT;
  return null;
}

/** Preflight de ask/turn. Skip no relaja esto. */
export function askPreflightError(facts: {
  runnableLinked: boolean;
  daemonBound: boolean;
}): string | null {
  if (!facts.runnableLinked) return NO_PROVIDER_ASK;
  if (!facts.daemonBound) return NO_DAEMON_ERROR;
  return null;
}

export function applyOnboardingAction(
  current: OnboardingStatus,
  action: OnboardingAction,
): OnboardingStatus {
  if (action === "complete") return "completed";
  if (current === "completed") return "completed";
  return "skipped";
}

export type WorkspaceEmptyKind = "copy" | "sin_runner" | "ready";

export function workspaceEmptyKind(opts: {
  daemonBound: boolean;
  workspaceCount: number;
}): WorkspaceEmptyKind {
  if (opts.daemonBound) return "ready";
  if (opts.workspaceCount > 0) return "sin_runner";
  return "copy";
}
