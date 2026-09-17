import { formatLastSeen } from "../lib/last-seen";

export const NO_DAEMON_ERROR =
  "No daemon bound for this workspace. Run: chavez headless workspace open";
export const NO_RUNNER_LABEL = "sin runner";

export function DaemonPresence(props: {
  bound?: boolean;
  hostname?: string | null;
  path?: string | null;
  lastSeen?: string | null;
  error?: string | null;
}) {
  if (!props.bound) {
    return (
      <p className="error" data-testid="runner-status">
        {NO_RUNNER_LABEL} — {props.error || NO_DAEMON_ERROR}
      </p>
    );
  }
  return (
    <p data-testid="runner-status">
      <span className="badge ok">daemon</span>{" "}
      <code>
        {props.hostname || "daemon"} · {props.path || "—"}
      </code>
      {" · last-seen "}
      {formatLastSeen(props.lastSeen)}
    </p>
  );
}
