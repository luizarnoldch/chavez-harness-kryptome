#!/usr/bin/env bash
# Overnight: transform Gherkin → validated implementation.md → implement → commit.
# One command. Gate: implement NEVER runs without a valid plan with file paths.
#
#   ./scripts/run-overnight-plans.sh
#   nohup ./scripts/run-overnight-plans.sh > logs/plan-orchestrator/overnight.log 2>&1 &
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PLANS_DIR="${PLANS_DIR:-$REPO_ROOT/docs/superpowers/plans/2026-09-16}"
STATE_PATH="$PLANS_DIR/.orchestrator-state.json"
LOG_ROOT="$REPO_ROOT/logs/plan-orchestrator"

ORCH_FORCE=0
ORCH_DRY_RUN=0
ORCH_STOP_ON_ERROR=0   # overnight default: continue on error
ORCH_ONLY=""
ORCH_STATUS_ONLY=0
ORCH_AUTO_COMMIT=1
ORCH_TRANSFORM_ONLY=0
ORCH_IMPLEMENT_ONLY=0
ORCH_ALLOW_DIRTY=0
ORCH_PLAN_COMMIT=1     # commit implementation.md after successful transform
# Hard cap so agent/grok cannot hang forever on MCP children / stuck tools.
# Override: ORCH_CLI_TIMEOUT_SEC=7200 ./scripts/run-overnight-plans.sh ...
ORCH_CLI_TIMEOUT_SEC="${ORCH_CLI_TIMEOUT_SEC:-5400}"

LAST_EXIT=0
LAST_BACKEND=""
LAST_STDOUT=""
LAST_STDERR=""

log() { printf '%s\n' "$*"; }
err() { printf '%s\n' "$*" >&2; }
iso_now() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }

usage() {
  cat <<'EOF'
run-overnight-plans.sh — transform (write-mode) → validate → implement → commit

  ./scripts/run-overnight-plans.sh                 # overnight completo
  ./scripts/run-overnight-plans.sh --only <slug>
  ./scripts/run-overnight-plans.sh --transform-only  # solo crear/validar implementation.md
  ./scripts/run-overnight-plans.sh --implement-only  # solo implementar (exige plan válido)
  ./scripts/run-overnight-plans.sh --dry-run
  ./scripts/run-overnight-plans.sh --force
  ./scripts/run-overnight-plans.sh --stop-on-error
  ./scripts/run-overnight-plans.sh --allow-dirty     # no abortar por WIP ajeno
  ./scripts/run-overnight-plans.sh --no-plan-commit  # no commitear implementation.md tras transform
  ./scripts/run-overnight-plans.sh --status

Gate: implement refuses without a valid implementation.md (header, paths, tasks).
Transform usa write-mode (siempre --always-approve / -f); éxito = archivo válido.
Preflight: aborta si hay dirty real (salvo allowlist) antes de gastar tokens.
Env: PLAN_ORCHESTRATOR_FORCE_BACKEND=grok|agent

Rerun recomendado (2 fases):
  nohup ./scripts/run-overnight-plans.sh --transform-only --force > logs/plan-orchestrator/transform.log 2>&1 &
  nohup ./scripts/run-overnight-plans.sh --implement-only > logs/plan-orchestrator/implement.log 2>&1 &
EOF
}

# --- state -------------------------------------------------------------------

init_state() {
  mkdir -p "$PLANS_DIR" "$LOG_ROOT"
  if [[ ! -f "$STATE_PATH" ]] || [[ ! -s "$STATE_PATH" ]]; then
    printf '{"version":1,"plans":{}}\n' >"$STATE_PATH"
  fi
  # Recover corrupt/empty JSON
  if ! python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$STATE_PATH" 2>/dev/null; then
    err "[warn] state corrupto; reinicializando $STATE_PATH"
    printf '{"version":1,"plans":{}}\n' >"$STATE_PATH"
  fi
  local i=1 slug
  for slug in "${FEATURES[@]}"; do
    python3 - "$STATE_PATH" "$slug" "$i" <<'PY'
import json, sys
path, slug, order = sys.argv[1], sys.argv[2], int(sys.argv[3])
try:
    with open(path, encoding="utf-8") as f:
        raw = f.read().strip()
    state = json.loads(raw) if raw else {"version": 1, "plans": {}}
except Exception:
    state = {"version": 1, "plans": {}}
plans = state.setdefault("plans", {})
if slug not in plans:
    plans[slug] = {
        "order": order,
        "transformedAt": None,
        "implementedAt": None,
        "commitSha": None,
        "transformCli": None,
        "implementCli": None,
        "status": "pending",
        "lastError": None,
    }
else:
    plans[slug]["order"] = order
tmp = path + ".tmp"
with open(tmp, "w", encoding="utf-8") as f:
    json.dump(state, f, indent=2)
    f.write("\n")
import os
os.replace(tmp, path)
PY
    i=$((i + 1))
  done
}

state_get() {
  jq -r --arg s "$1" --arg f "$2" '.plans[$s][$f] // empty' "$STATE_PATH"
}

state_set() {
  local slug="$1"
  shift
  python3 - "$STATE_PATH" "$slug" "$@" <<'PY'
import json, sys, os
path, slug = sys.argv[1], sys.argv[2]
try:
    with open(path, encoding="utf-8") as f:
        raw = f.read().strip()
    state = json.loads(raw) if raw else {"version": 1, "plans": {}}
except Exception:
    state = {"version": 1, "plans": {}}
entry = state.setdefault("plans", {}).setdefault(slug, {
    "order": 0, "transformedAt": None, "implementedAt": None,
    "commitSha": None, "transformCli": None, "implementCli": None,
    "status": "pending", "lastError": None,
})
for pair in sys.argv[3:]:
    key, _, val = pair.partition("=")
    entry[key] = None if val == "null" else val
tmp = path + ".tmp"
with open(tmp, "w", encoding="utf-8") as f:
    json.dump(state, f, indent=2)
    f.write("\n")
os.replace(tmp, path)
PY
}

# --- discovery ---------------------------------------------------------------

discover_features() {
  python3 - "$PLANS_DIR" <<'PY'
import os, re, sys
plans_dir = sys.argv[1]
readme = os.path.join(plans_dir, "README.md")
order = []
if os.path.isfile(readme):
    text = open(readme, encoding="utf-8").read()
    m = re.search(
        r"## Orden de entrega sugerido[\s\S]*?(?=\n## |\n---\n\nCada paso|$)",
        text,
    )
    section = m.group(0) if m else ""
    seen = set()
    for slug in re.findall(r"\]\(\./([^/)]+)/plan\.md\)", section):
        if slug not in seen:
            seen.add(slug)
            order.append(slug)
on_disk = sorted(
    d for d in os.listdir(plans_dir)
    if os.path.isdir(os.path.join(plans_dir, d))
    and os.path.isfile(os.path.join(plans_dir, d, "plan.md"))
)
final = [s for s in order if s in on_disk]
final += [s for s in on_disk if s not in final]
print("\n".join(final))
PY
}

# --- validation gate (HARD) --------------------------------------------------

# Returns 0 if implementation.md is a real implementable plan with file paths.
validate_plan() {
  local file="$1"
  python3 - "$file" <<'PY'
import os, re, sys
path = sys.argv[1]
if not os.path.isfile(path):
    print("missing file", file=sys.stderr)
    sys.exit(1)
text = open(path, encoding="utf-8", errors="replace").read()
if len(text) < 500:
    print(f"too short ({len(text)} bytes)", file=sys.stderr)
    sys.exit(1)
if not re.search(r"(?m)^#\s+.+\s+Implementation Plan", text):
    print("missing '# ... Implementation Plan' header", file=sys.stderr)
    sys.exit(1)
if not re.search(r"`(?:api|cli|tui|web)/[^`]+`", text):
    print("no code paths (api|cli|tui|web)/...", file=sys.stderr)
    sys.exit(1)
if not (re.search(r"(?m)^###\s+Task\b", text) or re.search(r"(?m)^-\s+\[[ xX]\]", text)):
    print("no tasks (### Task or - [ ] checkboxes)", file=sys.stderr)
    sys.exit(1)
# Reject near-copies of pure Gherkin product plans
gherkinish = text.count("```gherkin") + text.count("Característica:")
has_files = "Files:" in text or "**Files:**" in text or "Create:" in text or "Modify:" in text
if gherkinish >= 2 and not has_files:
    print("looks like Gherkin-only; need Files:/Create:/Modify: sections", file=sys.stderr)
    sys.exit(1)
sys.exit(0)
PY
}

write_impl_from_stdout() {
  local stdout_file="$1"
  local out_path="$2"
  python3 - "$stdout_file" "$out_path" <<'PY'
import re, sys
src, dest = sys.argv[1], sys.argv[2]
text = open(src, encoding="utf-8", errors="replace").read()
m = re.search(r"(?m)^#\s+.+\s+Implementation Plan[\s\S]*", text)
if not m:
    m2 = re.search(r"```(?:markdown|md)?\n([\s\S]*?)```", text)
    if m2 and "Implementation Plan" in m2.group(1):
        content = m2.group(1).strip() + "\n"
    else:
        sys.exit(1)
else:
    content = m.group(0).strip() + "\n"
open(dest, "w", encoding="utf-8").write(content)
PY
}

# --- CLI probe / invoke ------------------------------------------------------

is_token_exhaustion() {
  printf '%s' "${1:-}" | grep -qiE \
    'out of tokens|token limit|quota|rate limit|usage limit|insufficient.*(credit|balance|quota)|billing|payment required|\b429\b|resource_exhausted|tokens? (exhausted|exceeded)|exceeded.*tokens?'
}

probe_grok() {
  command -v grok >/dev/null 2>&1 && grok version >/dev/null 2>&1
}

probe_agent() {
  command -v agent >/dev/null 2>&1 && agent status >/dev/null 2>&1
}

pick_backend() {
  local force="${PLAN_ORCHESTRATOR_FORCE_BACKEND:-}"
  if [[ "$force" == "grok" || "$force" == "agent" ]]; then
    printf '%s\n' "$force"
    return 0
  fi
  if probe_grok; then
    printf 'grok\n'
    return 0
  fi
  if probe_agent; then
    printf 'agent\n'
    return 0
  fi
  err "Ningún CLI disponible. Ejecuta: grok login  o  agent login"
  return 1
}

run_backend_once() {
  local backend="$1" phase="$2" prompt_file="$3" slug="$4"
  local log_dir="$LOG_ROOT/$slug"
  mkdir -p "$log_dir"

  local -a cmd=()
  local prompt_inline=""

  # Both phases use write-mode (no --permission-mode plan / --plan):
  # transform must be able to create implementation.md on disk.
  if [[ "$backend" == "grok" ]]; then
    cmd=(
      grok
      --cwd "$REPO_ROOT"
      -m grok-4.6
      --output-format plain
      --prompt-file "$prompt_file"
      --always-approve
    )
  else
    prompt_inline="$(cat "$prompt_file")"
    cmd=(
      agent
      --workspace "$REPO_ROOT"
      -p
      --output-format text
      --model auto
      -f
      --trust
      "$prompt_inline"
    )
  fi

  LAST_BACKEND="$backend"
  local stdout_f="$log_dir/${phase}-${backend}-stdout.txt"
  local stderr_f="$log_dir/${phase}-${backend}-stderr.txt"

  if [[ "$ORCH_DRY_RUN" == "1" ]]; then
    if [[ "$backend" == "agent" ]]; then
      log "[dry-run] ${cmd[*]:0:$((${#cmd[@]} - 1))} \"<prompt ${#prompt_inline} chars>\""
    else
      log "[dry-run] ${cmd[*]}"
    fi
    LAST_EXIT=0
    LAST_STDOUT=""
    LAST_STDERR=""
    : >"$stdout_f"
    : >"$stderr_f"
    return 0
  fi

  set +e
  if command -v timeout >/dev/null 2>&1 && (( ORCH_CLI_TIMEOUT_SEC > 0 )); then
    # --kill-after: reap hung MCP/tool children after SIGTERM
    timeout --kill-after=30s "$ORCH_CLI_TIMEOUT_SEC" "${cmd[@]}" >"$stdout_f" 2>"$stderr_f"
  else
    "${cmd[@]}" >"$stdout_f" 2>"$stderr_f"
  fi
  LAST_EXIT=$?
  set -e
  LAST_STDOUT="$(cat "$stdout_f")"
  LAST_STDERR="$(cat "$stderr_f")"
  if (( LAST_EXIT == 124 )); then
    LAST_STDERR+=$'\n'"[overnight] CLI timeout after ${ORCH_CLI_TIMEOUT_SEC}s"
    err "[overnight] ${backend} timeout after ${ORCH_CLI_TIMEOUT_SEC}s ($phase/$slug)"
  fi
  cp "$stdout_f" "$log_dir/${phase}-stdout.txt"
  cp "$stderr_f" "$log_dir/${phase}-stderr.txt"
  printf '%s\n' "${cmd[*]}" >"$log_dir/${phase}-cmd.txt"
}

# After a CLI run: try to materialize/validate implementation.md for transform.
# Returns 0 if artifact is valid.
ensure_transform_artifact() {
  local slug="$1"
  local impl="$PLANS_DIR/$slug/implementation.md"
  local stdout_f="$LOG_ROOT/$slug/transform-stdout.txt"

  if validate_plan "$impl" 2>/dev/null; then
    return 0
  fi
  if [[ -f "$stdout_f" ]] && write_impl_from_stdout "$stdout_f" "$impl" 2>/dev/null; then
    if validate_plan "$impl" 2>/dev/null; then
      log "[info] $slug: implementation.md extraído de stdout"
      return 0
    fi
  fi
  local size=0
  if [[ -f "$stdout_f" ]]; then
    size=$(wc -c <"$stdout_f" | tr -d ' ')
  fi
  if (( size < 1000 )) || ! grep -q 'Implementation Plan' "$stdout_f" 2>/dev/null; then
    err "[warn] $slug: transform produjo chat sin plan válido (stdout=${size}B); forzando fallback"
  fi
  return 1
}

run_with_fallback() {
  local phase="$1" prompt_file="$2" slug="$3"
  local primary
  primary="$(pick_backend)" || return 1

  run_backend_once "$primary" "$phase" "$prompt_file" "$slug"
  local combined="${LAST_STDOUT}"$'\n'"${LAST_STDERR}"

  # Transform success = valid artifact, not merely exit 0
  if [[ "$phase" == "transform" && "$ORCH_DRY_RUN" != "1" ]]; then
    if ensure_transform_artifact "$slug"; then
      return 0
    fi
    # exit 0 without artifact → treat as failure; try other backend
    if [[ "$LAST_BACKEND" == "grok" ]] && probe_agent; then
      err "[overnight] grok no dejó implementation.md válido; reintentando con agent"
      run_backend_once "agent" "$phase" "$prompt_file" "$slug"
      ensure_transform_artifact "$slug" && return 0
    elif [[ "$LAST_BACKEND" == "agent" ]] && probe_grok; then
      err "[overnight] agent no dejó implementation.md válido; reintentando con grok"
      run_backend_once "grok" "$phase" "$prompt_file" "$slug"
      ensure_transform_artifact "$slug" && return 0
    fi
    return 1
  fi

  if [[ "$primary" == "grok" ]] && { (( LAST_EXIT != 0 )) || is_token_exhaustion "$combined"; }; then
    if probe_agent; then
      err "[overnight] grok falló (exit=$LAST_EXIT); reintentando con agent"
      is_token_exhaustion "$combined" && err "[overnight] motivo: tokens/cuota"
      run_backend_once "agent" "$phase" "$prompt_file" "$slug"
    fi
  fi

  if [[ "$LAST_BACKEND" == "grok" ]] && is_token_exhaustion "${LAST_STDOUT}"$'\n'"${LAST_STDERR}"; then
    if probe_agent; then
      err "[overnight] grok tokens/cuota; cambiando a agent"
      run_backend_once "agent" "$phase" "$prompt_file" "$slug"
    fi
  fi

  (( LAST_EXIT == 0 ))
}

# --- prompts (embedded) ------------------------------------------------------

build_transform_prompt() {
  local slug="$1" out="$2"
  local plan_file="$PLANS_DIR/$slug/plan.md"
  local invariants rel_plan rel_out
  rel_plan="docs/superpowers/plans/2026-09-16/${slug}/plan.md"
  rel_out="docs/superpowers/plans/2026-09-16/${slug}/implementation.md"
  invariants="$(python3 - "$PLANS_DIR/README.md" <<'PY'
import sys
try:
    text = open(sys.argv[1], encoding="utf-8").read()
except FileNotFoundError:
    raise SystemExit(0)
start = text.find("## Contexto de producto")
end = text.find("## Orden de entrega sugerido")
print(text[start:end if end != -1 else None].strip() if start != -1 else text[:4000])
PY
)"
  local plan_content
  plan_content="$(cat "$plan_file")"

  cat >"$out" <<EOF
Eres un ingeniero senior que convierte specs Gherkin en un plan de implementación ejecutable.

## ÚNICO objetivo de éxito
Crear el archivo (obligatorio, en disco):
  ${rel_out}

Si ese archivo no existe al terminar, has FALLADO.

## Qué puedes hacer
1. Leer/explorar el repo (read, grep, glob) en api/, cli/, tui/, web/, docs/.
2. Escribir/sobrescribir SOLO ${rel_out}.

## Qué NO puedes hacer
- NO modifiques plan.md ni otros plans.
- NO implementes features de producto.
- NO crees/edites archivos en api/, cli/, tui/, web/ (solo lectura).
- NO te detengas tras "voy a explorar"; debes ENTREGAR el markdown completo en el archivo.

## Formato obligatorio del archivo
- Header: \`# … Implementation Plan\`
- Goal, Architecture, Tech Stack, Global Constraints
- Tasks con **Files:** Create/Modify/Test y paths exactos en backticks (\`api/...\`, \`cli/...\`, \`tui/...\`, \`web/...\`)
- Steps \`- [ ]\` con código/comandos concretos; sin TBD/TODO
- Commit step al final de cada task

## Contexto de producto (invariantes)
${invariants}

## Feature
- Slug: ${slug}
- Plan Gherkin: ${rel_plan}
- Output OBLIGATORIO: ${rel_out}

## Plan Gherkin
${plan_content}

## Entrega
Escribe ${rel_out} ahora. Confirma la ruta al final.
EOF
  mkdir -p "$LOG_ROOT/$slug"
  cp "$out" "$LOG_ROOT/$slug/transform-prompt.txt"
}

build_implement_prompt() {
  local slug="$1" out="$2"
  local impl="$PLANS_DIR/$slug/implementation.md"
  local rel_impl="docs/superpowers/plans/2026-09-16/${slug}/implementation.md"
  local content
  content="$(cat "$impl")"
  cat >"$out" <<EOF
Eres un ingeniero senior implementando un plan de código en Chavez Harness.

## Tarea
Ejecuta TODAS las tareas del plan de implementación validado adjunto, en orden.

## Reglas
1. Sigue el plan paso a paso (TDD donde indique).
2. No modifiques otros planes ni el plan.md Gherkin.
3. Corre tests/linter del plan.
4. Al terminar: git add de archivos del feature y git commit -m "feat(${slug}): <resumen>"
5. No mezcles otros features.

## Feature
- Slug: ${slug}
- Plan: ${rel_impl}

## Plan de implementación (VALIDADO)
${content}

## Entrega
Implementa, verifica, commitea, informa el SHA.
EOF
  mkdir -p "$LOG_ROOT/$slug"
  cp "$out" "$LOG_ROOT/$slug/implement-prompt.txt"
}

# --- transform / implement ---------------------------------------------------

transform_one() {
  local slug="$1"
  local impl="$PLANS_DIR/$slug/implementation.md"

  if [[ "$ORCH_FORCE" != "1" ]] && validate_plan "$impl" 2>/dev/null; then
    log "[skip-transform] $slug: implementation.md ya válido"
    state_set "$slug" "status=transformed" "lastError=null"
    return 0
  fi

  log "[transform] $slug (write-mode → solo implementation.md)"
  local prompt_file
  prompt_file="$(mktemp)"
  build_transform_prompt "$slug" "$prompt_file"

  if [[ "$ORCH_DRY_RUN" == "1" ]]; then
    run_with_fallback transform "$prompt_file" "$slug" || true
    rm -f "$prompt_file"
    return 0
  fi

  if ! run_with_fallback transform "$prompt_file" "$slug"; then
    local msg="refuse: no valid implementation plan after transform"
    if (( LAST_EXIT != 0 )); then
      msg="transform exit ${LAST_EXIT}: ${LAST_STDERR:0:300}"
    fi
    state_set "$slug" "status=failed" "lastError=$msg"
    err "[fail] $slug: $msg"
    rm -f "$prompt_file"
    return 1
  fi
  rm -f "$prompt_file"

  # run_with_fallback already ensured artifact for transform; double-check gate
  if ! validate_plan "$impl"; then
    local msg="refuse: no valid implementation plan after transform"
    state_set "$slug" "status=failed" "lastError=$msg"
    err "[fail] $slug: $msg"
    return 1
  fi

  state_set "$slug" \
    "status=transformed" \
    "transformedAt=$(iso_now)" \
    "transformCli=$LAST_BACKEND" \
    "lastError=null"
  log "[ok] $slug: plan validado (${LAST_BACKEND})"
  commit_implementation_plan "$slug" || true
  return 0
}

ensure_clean_tree() {
  [[ "$ORCH_DRY_RUN" == "1" ]] && return 0
  [[ "$ORCH_ALLOW_DIRTY" == "1" ]] && return 0
  local filtered
  filtered="$(real_dirty_files)"
  if [[ -n "$filtered" ]]; then
    err "Working tree sucio (fuera del allowlist overnight):"
    err "$filtered"
    err "Commitea/stash el WIP, o usa --allow-dirty."
    return 1
  fi
}

# Paths the overnight itself creates/updates — not "real" dirty.
is_allowlisted_dirty_path() {
  local path="$1"
  # Normalize leading ./ and trailing /
  path="${path#./}"
  path="${path%/}"
  case "$path" in
    logs|logs/*) return 0 ;;
    docs/superpowers/plans/*/.orchestrator-state.json) return 0 ;;
    docs/superpowers/plans/*/implementation.md) return 0 ;;
    .superpowers|.superpowers/*) return 0 ;;
    */.superpowers|*/.superpowers/*) return 0 ;;
  esac
  [[ "$(basename "$path")" == ".orchestrator-state.json" ]] && return 0
  if [[ "$(basename "$path")" == "implementation.md" && "$path" == docs/superpowers/plans/*/* ]]; then
    return 0
  fi
  return 1
}

# Print porcelain lines that are NOT allowlisted (real WIP).
real_dirty_files() {
  local line status path
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    # porcelain v1: XY PATH or XY ORIG -> PATH
    status="${line:0:2}"
    path="${line:3}"
    if [[ "$path" == *" -> "* ]]; then
      path="${path##* -> }"
    fi
    if is_allowlisted_dirty_path "$path"; then
      continue
    fi
    printf '%s\n' "$line"
  done < <(git -C "$REPO_ROOT" status --porcelain)
}

preflight_clean_tree() {
  [[ "$ORCH_DRY_RUN" == "1" ]] && return 0
  [[ "$ORCH_ALLOW_DIRTY" == "1" ]] && return 0
  [[ "$ORCH_STATUS_ONLY" == "1" ]] && return 0
  local filtered
  filtered="$(real_dirty_files)"
  if [[ -n "$filtered" ]]; then
    err "Preflight: working tree sucio — abortando ANTES de gastar tokens."
    err "$filtered"
    err ""
    err "Opciones: commit/stash el WIP, o relanza con --allow-dirty."
    return 1
  fi
  return 0
}

commit_implementation_plan() {
  local slug="$1"
  local rel="docs/superpowers/plans/2026-09-16/${slug}/implementation.md"
  [[ "$ORCH_PLAN_COMMIT" == "1" ]] || return 0
  [[ "$ORCH_DRY_RUN" == "1" ]] && { log "[dry-run] git commit docs(plan): add ${slug} implementation.md"; return 0; }
  [[ -f "$REPO_ROOT/$rel" ]] || return 0
  git -C "$REPO_ROOT" add -- "$rel"
  if git -C "$REPO_ROOT" diff --cached --quiet; then
    return 0
  fi
  git -C "$REPO_ROOT" commit -m "docs(plan): add ${slug} implementation.md"
  log "[ok] $slug: committed plan artifact"
}

fallback_commit() {
  local slug="$1"
  local msg="feat(${slug}): implement plan ${slug}"
  [[ "$ORCH_DRY_RUN" == "1" ]] && { log "[dry-run] git commit -m \"$msg\""; return 0; }
  git -C "$REPO_ROOT" add -u
  git -C "$REPO_ROOT" add -- "docs/superpowers/plans/2026-09-16/${slug}/implementation.md" 2>/dev/null || true
  if git -C "$REPO_ROOT" diff --cached --quiet; then
    return 1
  fi
  git -C "$REPO_ROOT" commit -m "$msg"
}

# HARD GATE: never implement without validated plan
implement_one() {
  local slug="$1"
  local impl="$PLANS_DIR/$slug/implementation.md"
  local status
  status="$(state_get "$slug" status)"

  if [[ "$status" == "committed" && "$ORCH_FORCE" != "1" ]]; then
    log "[skip] $slug: ya committed"
    return 0
  fi

  if ! validate_plan "$impl" 2>/dev/null; then
    err "[refuse] $slug: implementation without a real plan shouldn't work"
    err "[refuse] $slug: falta implementation.md válido (header + paths + tasks)"
    state_set "$slug" "status=failed" "lastError=refuse: no valid implementation plan"
    return 1
  fi

  if ! ensure_clean_tree; then
    state_set "$slug" "status=failed" "lastError=working tree sucio"
    return 1
  fi

  log "[implement] $slug (plan validado)"
  local head_before
  head_before="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || true)"

  local prompt_file
  prompt_file="$(mktemp)"
  build_implement_prompt "$slug" "$prompt_file"

  local cli_ok=1
  if ! run_with_fallback implement "$prompt_file" "$slug"; then
    cli_ok=0
  fi
  rm -f "$prompt_file"

  if [[ "$ORCH_DRY_RUN" == "1" ]]; then
    return 0
  fi

  local head_after
  head_after="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || true)"

  # CLI may hang after landing commits (MCP children). If HEAD advanced, treat as success.
  if (( cli_ok == 0 )); then
    if [[ -n "$head_after" && "$head_after" != "$head_before" ]]; then
      err "[overnight] $slug: CLI exit=${LAST_EXIT} pero HEAD avanzó → committed"
      state_set "$slug" \
        "status=committed" \
        "implementedAt=$(iso_now)" \
        "implementCli=$LAST_BACKEND" \
        "commitSha=$head_after" \
        "lastError=null"
      log "[ok] $slug: committed ${head_after:0:8} (${LAST_BACKEND}, post-hang)"
      return 0
    fi
    local msg="implement exit ${LAST_EXIT}: ${LAST_STDERR:0:400}"
    state_set "$slug" "status=failed" "lastError=$msg"
    err "[fail] $slug: $msg"
    return 1
  fi

  state_set "$slug" \
    "status=implemented" \
    "implementedAt=$(iso_now)" \
    "implementCli=$LAST_BACKEND" \
    "lastError=null"

  if [[ "$head_after" == "$head_before" && "$ORCH_AUTO_COMMIT" == "1" ]]; then
    if [[ -n "$(git -C "$REPO_ROOT" status --porcelain)" ]]; then
      fallback_commit "$slug" || true
      head_after="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || true)"
    fi
  fi

  if [[ -n "$head_after" && "$head_after" != "$head_before" ]]; then
    state_set "$slug" "status=committed" "commitSha=$head_after"
    log "[ok] $slug: committed ${head_after:0:8} (${LAST_BACKEND})"
  else
    log "[ok] $slug: implementado (${LAST_BACKEND})"
  fi
  return 0
}

# --- process one feature: transform → validate → implement -------------------

process_one() {
  local slug="$1"

  if [[ "$(state_get "$slug" status)" == "committed" && "$ORCH_FORCE" != "1" ]]; then
    log "[skip] $slug: committed"
    return 0
  fi

  local impl="$PLANS_DIR/$slug/implementation.md"

  if [[ "$ORCH_IMPLEMENT_ONLY" == "1" ]]; then
    if ! validate_plan "$impl" 2>/dev/null; then
      err "[refuse] $slug: --implement-only requiere implementation.md válido"
      state_set "$slug" "status=failed" "lastError=refuse: no valid implementation plan"
      return 1
    fi
    implement_one "$slug"
    return $?
  fi

  # Transform if no valid plan yet (or --force)
  if [[ "$ORCH_FORCE" == "1" ]] || ! validate_plan "$impl" 2>/dev/null; then
    if ! transform_one "$slug"; then
      return 1
    fi
    if [[ "$ORCH_DRY_RUN" == "1" ]]; then
      log "[dry-run] $slug: write-mode transform (artifact required)"
      return 0
    fi
  fi

  if [[ "$ORCH_TRANSFORM_ONLY" == "1" ]]; then
    if validate_plan "$impl" 2>/dev/null; then
      log "[transform-only] $slug: OK"
      return 0
    fi
    err "[transform-only] $slug: plan aún inválido"
    return 1
  fi

  # HARD GATE before implement
  if ! validate_plan "$impl"; then
    err "[refuse] $slug: no valid plan — skipping implement"
    state_set "$slug" "status=failed" "lastError=refuse: no valid implementation plan"
    return 1
  fi

  implement_one "$slug"
}

cmd_status() {
  log "Plans dir: $PLANS_DIR"
  log "Features: ${#FEATURES[@]}"
  log ""
  printf '%-5s  %-25s %-12s %-9s %-9s\n' "Order" "Slug" "Status" "Transform" "Implement"
  printf '%-5s  %-25s %-12s %-9s %-9s\n' "-----" "-------------------------" "------------" "---------" "---------"
  local slug i=0 status tcli icli err_msg
  for slug in "${FEATURES[@]}"; do
    i=$((i + 1))
    status="$(state_get "$slug" status)"
    tcli="$(state_get "$slug" transformCli)"; [[ -n "$tcli" ]] || tcli="-"
    icli="$(state_get "$slug" implementCli)"; [[ -n "$icli" ]] || icli="-"
    printf '%-5s  %-25s %-12s %-9s %-9s\n' "$(state_get "$slug" order)" "$slug" "$status" "$tcli" "$icli"
    err_msg="$(state_get "$slug" lastError)"
    if [[ -n "$err_msg" && "$err_msg" != "null" ]]; then
      log "       error: ${err_msg:0:120}"
    fi
  done
}

cmd_overnight() {
  local -a targets=()
  local slug
  if [[ -n "$ORCH_ONLY" ]]; then
    targets=("$ORCH_ONLY")
    local found=0
    for slug in "${FEATURES[@]}"; do
      [[ "$slug" == "$ORCH_ONLY" ]] && found=1
    done
    if [[ "$found" != "1" ]]; then
      err "Feature no encontrado: $ORCH_ONLY"
      return 1
    fi
  else
    targets=("${FEATURES[@]}")
  fi

  if ! preflight_clean_tree; then
    return 1
  fi

  mkdir -p "$LOG_ROOT"
  local failures=0
  for slug in "${targets[@]}"; do
    log "======== $slug ========"
    if ! process_one "$slug"; then
      failures=$((failures + 1))
      if [[ "$ORCH_STOP_ON_ERROR" == "1" ]]; then
        err "Stop on error ($slug)."
        return 1
      fi
      err "[continue] $slug falló; siguiendo overnight…"
    fi
  done
  log "======== done (failures=$failures) ========"
  (( failures == 0 ))
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --only) ORCH_ONLY="$2"; shift 2 ;;
      --force) ORCH_FORCE=1; shift ;;
      --dry-run) ORCH_DRY_RUN=1; shift ;;
      --stop-on-error) ORCH_STOP_ON_ERROR=1; shift ;;
      --status) ORCH_STATUS_ONLY=1; shift ;;
      --no-auto-commit) ORCH_AUTO_COMMIT=0; shift ;;
      --transform-only) ORCH_TRANSFORM_ONLY=1; shift ;;
      --implement-only) ORCH_IMPLEMENT_ONLY=1; shift ;;
      --allow-dirty) ORCH_ALLOW_DIRTY=1; shift ;;
      --no-plan-commit) ORCH_PLAN_COMMIT=0; shift ;;
      -h|--help) usage; exit 0 ;;
      *) err "Flag desconocido: $1"; usage; exit 1 ;;
    esac
  done
  if [[ "$ORCH_TRANSFORM_ONLY" == "1" && "$ORCH_IMPLEMENT_ONLY" == "1" ]]; then
    err "No combines --transform-only y --implement-only"
    exit 1
  fi
}

main() {
  parse_args "$@"
  mapfile -t FEATURES < <(discover_features)
  if [[ ${#FEATURES[@]} -eq 0 ]]; then
    err "No features en $PLANS_DIR"
    exit 1
  fi
  init_state

  if [[ "$ORCH_STATUS_ONLY" == "1" ]]; then
    cmd_status
    exit 0
  fi

  cmd_overnight
}

main "$@"
