import {
  CLIENT_BIND_HINT,
  CURSOR_NOT_RUNNABLE_HINT,
  EMPTY_WORKSPACE_COPY,
  SKIP_LABEL,
  STEP_CHAT_LABEL,
  STEP_DAEMON_LABEL,
  STEP_PROVIDER_LABEL,
  WIZARD_TITLE,
  type OnboardingPublic,
} from "../lib/onboarding";
import { useOnboardingAction } from "../lib/hooks";

export function OnboardingWizard({
  snap,
}: {
  snap: OnboardingPublic;
}) {
  const skip = useOnboardingAction();
  if (!snap.wizardVisible) return null;

  const items: Array<{
    done: boolean;
    label: string;
    href?: string;
    detail: string;
  }> = [
    {
      done: snap.steps.providerLinked,
      label: STEP_PROVIDER_LABEL,
      href: "/providers",
      detail: "chavez provider link claude",
    },
    {
      done: snap.steps.daemonBound,
      label: STEP_DAEMON_LABEL,
      detail: EMPTY_WORKSPACE_COPY,
    },
    {
      done: snap.steps.firstTurn,
      label: STEP_CHAT_LABEL,
      href: snap.daemon
        ? `/workspaces/${snap.daemon.workspaceId}`
        : "/workspaces",
      detail: snap.daemon
        ? `${snap.daemon.hostname ? snap.daemon.hostname + " · " : ""}${snap.daemon.path ?? ""}`
        : "Cuando el daemon esté bound, abre un chat y envía el primer prompt.",
    },
  ];

  return (
    <section
      className="panel onboarding-wizard"
      data-testid="onboarding-wizard"
    >
      <h2>{WIZARD_TITLE}</h2>
      <ol className="onboarding-steps">
        {items.map((it) => (
          <li key={it.label} className={it.done ? "ok" : ""}>
            <span className="badge">{it.done ? "hecho" : "pendiente"}</span>{" "}
            {it.href && !it.done ? <a href={it.href}>{it.label}</a> : it.label}
            <p
              className="muted"
              style={{ margin: "0.25rem 0 0", fontSize: "0.85rem" }}
            >
              {it.detail}
            </p>
          </li>
        ))}
      </ol>
      {snap.cursorLinkedOnly && (
        <p className="muted">{CURSOR_NOT_RUNNABLE_HINT}</p>
      )}
      {snap.daemon && (
        <p className="ok">
          Daemon:{" "}
          <code>
            {snap.daemon.hostname ? `${snap.daemon.hostname} · ` : ""}
            {snap.daemon.path}
          </code>
        </p>
      )}
      {!snap.steps.daemonBound && (
        <p className="muted">{CLIENT_BIND_HINT}</p>
      )}
      <button
        type="button"
        className="secondary"
        disabled={skip.isPending}
        onClick={() => void skip.mutateAsync("skip")}
      >
        {skip.isPending ? "…" : SKIP_LABEL}
      </button>
    </section>
  );
}
