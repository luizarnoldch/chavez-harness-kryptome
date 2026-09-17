#!/usr/bin/env bash
# Detach overnight via systemd --user so agent/Cursor shells cannot kill it.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
mkdir -p logs/plan-orchestrator

PHASE="${1:?usage: $0 transform|implement|full [extra args...]}"
shift || true

case "$PHASE" in
  transform)
    ARGS=(--transform-only --stop-on-error "$@")
    UNIT=chavez-plans-transform
    LOG=logs/plan-orchestrator/transform.log
    ;;
  implement)
    ARGS=(--implement-only --stop-on-error "$@")
    UNIT=chavez-plans-implement
    LOG=logs/plan-orchestrator/implement.log
    ;;
  full)
    ARGS=(--stop-on-error "$@")
    UNIT=chavez-plans-overnight
    LOG=logs/plan-orchestrator/overnight.log
    ;;
  *)
    echo "usage: $0 transform|implement|full [extra args...]" >&2
    exit 1
    ;;
esac

systemctl --user stop "${UNIT}.service" 2>/dev/null || true
systemctl --user reset-failed "${UNIT}.service" 2>/dev/null || true
printf '\n===== launch %s %s =====\n' "$PHASE" "$(date -Is)" >>"$LOG"

systemd-run --user \
  --unit="$UNIT" \
  --working-directory="$ROOT" \
  --property=StandardOutput=append:"$ROOT/$LOG" \
  --property=StandardError=append:"$ROOT/$LOG" \
  "$ROOT/scripts/run-overnight-plans.sh" "${ARGS[@]}"

MAINPID="$(systemctl --user show -p MainPID --value "${UNIT}.service")"
echo "$MAINPID" >"logs/plan-orchestrator/${PHASE}.pid"
echo "started phase=$PHASE unit=${UNIT}.service pid=$MAINPID log=$LOG"
systemctl --user --no-pager status "${UNIT}.service" | head -12
