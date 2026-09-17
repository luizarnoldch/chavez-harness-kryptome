import { REPLAY_SECTION_ORDER } from "../lib/turn-replay";
import type { TurnReplay } from "../lib/turn-replay";

export function ReplayPanel({
  text,
  replay,
  error,
  onClose,
}: {
  text: string;
  replay?: TurnReplay | null;
  error?: string | null;
  onClose: () => void;
}) {
  return (
    <div className="panel replay-panel" data-testid="replay-panel">
      <p>
        <span className="badge ok">replay · read-only</span>
        {replay?.executionMode ? (
          <span className="badge">mode {replay.executionMode}</span>
        ) : null}
        {replay?.modelId ? (
          <span className="badge">model {replay.modelId}</span>
        ) : null}
        <button type="button" className="secondary" onClick={onClose}>
          Cerrar
        </button>
      </p>
      {error ? <p className="error">{error}</p> : null}
      <pre className="replay-text" style={{ whiteSpace: "pre-wrap" }}>
        {text}
      </pre>
      <p className="muted" data-testid="replay-section-order">
        {REPLAY_SECTION_ORDER.join(" → ")}
      </p>
    </div>
  );
}
