#!/usr/bin/env bash
# Detach overnight from the parent shell/process group so Cursor/agent
# tool sessions do not kill it when the wrapper exits.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
mkdir -p logs/plan-orchestrator

PHASE="${1:?usage: $0 transform|implement|full [extra args...]}"
shift || true

case "$PHASE" in
  transform)
    ARGS=(--transform-only --stop-on-error "$@")
    LOG=logs/plan-orchestrator/transform.log
    PIDF=logs/plan-orchestrator/transform.pid
    ;;
  implement)
    ARGS=(--implement-only --stop-on-error "$@")
    LOG=logs/plan-orchestrator/implement.log
    PIDF=logs/plan-orchestrator/implement.pid
    ;;
  full)
    ARGS=(--stop-on-error "$@")
    LOG=logs/plan-orchestrator/overnight.log
    PIDF=logs/plan-orchestrator/overnight.pid
    ;;
  *)
    echo "usage: $0 transform|implement|full [extra args...]" >&2
    exit 1
    ;;
esac

# Kill prior instance of this phase if still running
if [[ -f "$PIDF" ]]; then
  old="$(cat "$PIDF" || true)"
  if [[ -n "$old" ]] && kill -0 "$old" 2>/dev/null; then
    echo "Stopping prior PID $old"
    kill "$old" 2>/dev/null || true
    sleep 1
    kill -9 "$old" 2>/dev/null || true
  fi
fi

# New session + nohup + closed stdin — survives agent shell exit
setsid nohup "$ROOT/scripts/run-overnight-plans.sh" "${ARGS[@]}" \
  >>"$LOG" 2>&1 < /dev/null &
PID=$!
echo "$PID" >"$PIDF"
# Give bash a moment to exec
sleep 0.5
if kill -0 "$PID" 2>/dev/null; then
  echo "started phase=$PHASE pid=$PID log=$LOG"
else
  # setsid may make $! the setsid parent; find the real script
  REAL="$(pgrep -f "run-overnight-plans.sh.*${ARGS[0]}" | head -1 || true)"
  if [[ -n "$REAL" ]]; then
    echo "$REAL" >"$PIDF"
    echo "started phase=$PHASE pid=$REAL log=$LOG"
  else
    echo "failed to start; see $LOG" >&2
    exit 1
  fi
fi
