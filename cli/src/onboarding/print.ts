import type { OnboardingSnapshot } from "./status";
import {
  CURSOR_NOT_RUNNABLE_HINT,
  HINT_LOGIN_HEADER,
  STEP_CHAT_LABEL,
  STEP_DAEMON_LABEL,
  STEP_PROVIDER_LABEL,
} from "./status";

export type OnboardingPrintable = Pick<
  OnboardingSnapshot,
  "status" | "wizardVisible" | "steps" | "nextCommand" | "cursorLinkedOnly"
>;

export function formatOnboardingHint(snap: OnboardingPrintable): string {
  if (!snap.wizardVisible) return "";
  const box = (ok: boolean) => (ok ? "[x]" : "[ ]");
  const lines = [
    HINT_LOGIN_HEADER,
    `  ${box(snap.steps.providerLinked)} ${STEP_PROVIDER_LABEL}`,
    `      chavez provider link claude`,
    `  ${box(snap.steps.daemonBound)} ${STEP_DAEMON_LABEL}`,
    `      chavez tui   (o: chavez headless workspace open)`,
    `  ${box(snap.steps.firstTurn)} ${STEP_CHAT_LABEL}`,
    `      chavez headless chat ask <chatId> <prompt>`,
  ];
  if (snap.cursorLinkedOnly) lines.push(`  ${CURSOR_NOT_RUNNABLE_HINT}`);
  if (snap.nextCommand) lines.push(`  → ${snap.nextCommand}`);
  return lines.join("\n");
}
