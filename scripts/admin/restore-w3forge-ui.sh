#!/usr/bin/env bash
# App ownership and capability checks run before logging or any operation.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_w3forge-policy.sh"
w3forge_guard_script "${BASH_SOURCE[0]##*/}" "$@"
#
# restore-w3forge-ui.sh
#
# W3 Core v0.5.24 - Non-interactive UI wrapper around restore-w3forge.sh.
#
# Called ONLY by the W3 Forge Admin Controls backend
# (POST /api/admin/controls/restore-w3forge/run) after:
#   - action-lock acquisition,
#   - server-side validation,
#   - the explicit `confirmReplace` checkbox,
#   - the typed phrase `RESTORE`,
#   - the typed target database name `w3forge`,
#   - and admission via the dedicated `runSafeRecovery()` path.
#
# This wrapper:
#   - NEVER runs without --yes (refusal exit 2).
#   - NEVER reads stdin from the caller. Closes stdin (< /dev/null) when
#     invoking the delegate so a misbehaving delegate cannot block on a TTY.
#   - NEVER accepts or constructs arbitrary filesystem paths from the UI.
#     The --app and --db arguments MUST be basenames (no `/`, no `..`).
#     The delegate enforces a strict naming regex and resolves the canonical
#     path inside the approved backup directory only.
#   - Delegates the actual restore work to scripts/restore-w3forge.sh
#     (or /opt/w3forge-scripts/restore-w3forge.sh on the live host). The delegate is
#     invoked with its non-interactive flags:
#         --non-interactive
#         --app <basename>
#         --db  <basename>
#         --yes-i-understand-this-replaces-production
#         --request-id <id>
#   - Tags every log line with [request-id] and emits a
#     `===STRUCTURED-RESULT===` trailer the backend can parse.
#
# Output (structured trailer parsed by the safe action runner):
#   ===STRUCTURED-RESULT===
#   status=success|failed
#   request_id=<id>
#   app_backup=<basename>
#   db_backup=<basename>
#   pre_restore_backup_path=<path|>
#   restored_version=<semver|>
#   health_ok=<true|false|unknown>
#   duration_seconds=<n>
#   exit_code=<delegate_rc>
#   reason=<text>
#   ===END===
#
# Exit codes:
#   0   success (delegate reported success and emitted status=success)
#   1   delegate (restore-w3forge.sh) reported failure
#   2   invalid arguments or missing --yes (refusal - UI input rejected)
#   3   pre-flight failure (delegate not executable, etc.)
#
# Logs to /opt/logs/w3forge/restore/ (same category as the delegate).

set -uo pipefail

# --- Logging ---------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SCRIPT_DIR/_w3forge-log.sh" ]]; then
  # shellcheck disable=SC1091
  . "$SCRIPT_DIR/_w3forge-log.sh"
elif [[ -f "${W3_SCRIPTS_DIR}/_w3forge-log.sh" ]]; then
  # shellcheck disable=SC1091
  . "${W3_SCRIPTS_DIR}/_w3forge-log.sh"
fi
if declare -F w3log_init >/dev/null 2>&1; then w3log_init "restore"; fi

# --- Config ----------------------------------------------------------------
DELEGATE="${W3_RESTORE_SCRIPT:-$SCRIPT_DIR/restore-w3forge.sh}"
if [[ ! -x "$DELEGATE" && -x "${W3_SCRIPTS_DIR}/restore-w3forge.sh" ]]; then
  DELEGATE="${W3_SCRIPTS_DIR}/restore-w3forge.sh"
fi

# Basename validation regexes match the delegate exactly so we fail-fast
# before invoking the delegate at all. Defense-in-depth only - the delegate
# re-validates and is the source of truth.
APP_REGEX='^w3forge_app_[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{2}-[0-9]{2}-[0-9]{2}\.tar\.gz$'
DB_REGEX='^w3forge_db_[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{2}-[0-9]{2}-[0-9]{2}\.sql$'

BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'
info() { echo -e "${BLUE}[INFO]${NC} $*"; }
ok()   { echo -e "${GREEN}[OK]${NC}   $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
emit_failure() { echo -e "${RED}[FAIL]${NC} $*" >&2; }

usage() {
  cat <<'EOF'
Usage:
  restore-w3forge-ui.sh --yes --app <basename> --db <basename> \
                       [--request-id <id>] [--source ui|api|cli]
  restore-w3forge-ui.sh help

Required:
  --yes                Non-interactive acknowledgment from the calling runner.
  --app <basename>     App backup BASENAME only (no path, no '..').
                       Must match: w3forge_app_YYYY-MM-DD_HH-MM-SS.tar.gz
  --db  <basename>     DB backup BASENAME only (no path, no '..').
                       Must match: w3forge_db_YYYY-MM-DD_HH-MM-SS.sql

Optional:
  --request-id <id>    Caller-supplied id propagated through logs.
  --source <s>         One of: ui, api, cli (recorded in logs only).

Notes:
  This wrapper invokes scripts/restore-w3forge.sh in non-interactive apply
  mode. The delegate validates the basenames, resolves canonical paths
  inside the approved backup directory ONLY, verifies the selected
  app/db pair, takes a MANDATORY fresh pre-restore backup, then stops
  the w3forge service, replaces the runtime, drops & restores the DB,
  rebuilds, restarts the service, and probes /health and /version.

  This wrapper NEVER accepts arbitrary filesystem paths from the UI.
  Path components (`/`) and parent-directory traversal (`..`) are
  rejected here before the delegate is invoked.
EOF
}

# --- Arg parse -------------------------------------------------------------
YES=""
APP_BASENAME=""
DB_BASENAME=""
REQUEST_ID=""
SOURCE_TAG="cli"

while [[ $# -gt 0 ]]; do
  case "$1" in
    help|-h|--help) usage; exit 0 ;;
    --yes) YES="1"; shift ;;
    --app)
      [[ $# -ge 2 ]] || { emit_failure "--app requires a value"; exit 2; }
      APP_BASENAME="$2"; shift 2 ;;
    --db)
      [[ $# -ge 2 ]] || { emit_failure "--db requires a value"; exit 2; }
      DB_BASENAME="$2"; shift 2 ;;
    --request-id)
      [[ $# -ge 2 ]] || { emit_failure "--request-id requires a value"; exit 2; }
      REQUEST_ID="$2"; shift 2 ;;
    --source)
      [[ $# -ge 2 ]] || { emit_failure "--source requires a value"; exit 2; }
      SOURCE_TAG="$2"; shift 2 ;;
    *)
      emit_failure "Unknown argument: $1"
      usage
      exit 2
      ;;
  esac
done

if [[ -z "$YES" ]]; then
  emit_failure "Refusing to run without --yes (non-interactive acknowledgment required)"
  exit 2
fi

case "$SOURCE_TAG" in
  ui|api|cli) ;;
  *) emit_failure "--source must be one of: ui, api, cli (got: $SOURCE_TAG)"; exit 2 ;;
esac

if [[ -z "$REQUEST_ID" ]]; then
  REQUEST_ID="rw-$(date +%Y%m%d-%H%M%S)-$$"
fi

# --- Refuse arbitrary paths and bad basenames ------------------------------
if [[ -z "$APP_BASENAME" || -z "$DB_BASENAME" ]]; then
  emit_failure "Both --app <basename> and --db <basename> are required"
  echo "===STRUCTURED-RESULT==="
  echo "status=failed"
  echo "request_id=${REQUEST_ID}"
  echo "app_backup=${APP_BASENAME}"
  echo "db_backup=${DB_BASENAME}"
  echo "duration_seconds=0"
  echo "health_ok=unknown"
  echo "reason=Missing --app or --db argument."
  echo "===END==="
  exit 2
fi

# Reject path separators and traversal anywhere in either argument.
if [[ "$APP_BASENAME" == *"/"* || "$APP_BASENAME" == *".."* \
   || "$DB_BASENAME"  == *"/"* || "$DB_BASENAME"  == *".."* ]]; then
  emit_failure "Refusing arbitrary filesystem path. --app and --db must be BASENAMES only (no '/', no '..')."
  echo "===STRUCTURED-RESULT==="
  echo "status=failed"
  echo "request_id=${REQUEST_ID}"
  echo "app_backup=${APP_BASENAME}"
  echo "db_backup=${DB_BASENAME}"
  echo "duration_seconds=0"
  echo "health_ok=unknown"
  echo "reason=Arbitrary path or traversal in --app/--db rejected by UI wrapper."
  echo "===END==="
  exit 2
fi

# Strict regex match identical to the delegate's contract.
if [[ ! "$APP_BASENAME" =~ $APP_REGEX ]]; then
  emit_failure "Invalid --app basename: '${APP_BASENAME}' does not match required pattern"
  echo "===STRUCTURED-RESULT==="
  echo "status=failed"
  echo "request_id=${REQUEST_ID}"
  echo "app_backup=${APP_BASENAME}"
  echo "db_backup=${DB_BASENAME}"
  echo "duration_seconds=0"
  echo "health_ok=unknown"
  echo "reason=--app basename does not match the required w3forge app backup naming pattern."
  echo "===END==="
  exit 2
fi
if [[ ! "$DB_BASENAME" =~ $DB_REGEX ]]; then
  emit_failure "Invalid --db basename: '${DB_BASENAME}' does not match required pattern"
  echo "===STRUCTURED-RESULT==="
  echo "status=failed"
  echo "request_id=${REQUEST_ID}"
  echo "app_backup=${APP_BASENAME}"
  echo "db_backup=${DB_BASENAME}"
  echo "duration_seconds=0"
  echo "health_ok=unknown"
  echo "reason=--db basename does not match the required w3forge db backup naming pattern."
  echo "===END==="
  exit 2
fi

# --- Pre-flight ------------------------------------------------------------
if [[ ! -x "$DELEGATE" ]]; then
  emit_failure "Delegate script not executable: $DELEGATE"
  echo "===STRUCTURED-RESULT==="
  echo "status=failed"
  echo "request_id=${REQUEST_ID}"
  echo "app_backup=${APP_BASENAME}"
  echo "db_backup=${DB_BASENAME}"
  echo "duration_seconds=0"
  echo "health_ok=unknown"
  echo "reason=Delegate script not executable: ${DELEGATE}"
  echo "===END==="
  exit 3
fi

info "request-id : $REQUEST_ID"
info "source     : $SOURCE_TAG"
info "delegate   : $DELEGATE"
info "app backup : $APP_BASENAME"
info "db  backup : $DB_BASENAME"

# --- Delegate --------------------------------------------------------------
TMP_LOG="$(mktemp -t w3forge-restore-ui.XXXXXX.log)"
cleanup_tmplog() { rm -f "$TMP_LOG" 2>/dev/null || true; }
trap cleanup_tmplog EXIT

START_TS=$(date +%s)
set +e
"$DELEGATE" \
  --non-interactive \
  --app "$APP_BASENAME" \
  --db  "$DB_BASENAME" \
  --yes-i-understand-this-replaces-production \
  --request-id "$REQUEST_ID" \
  </dev/null 2>&1 | tee "$TMP_LOG"
DELEGATE_RC=${PIPESTATUS[0]}
set -e
END_TS=$(date +%s)
DURATION=$(( END_TS - START_TS ))

# --- Parse delegate stdout for the structured trailer ----------------------
# Strip ANSI codes defensively, then pull the LAST occurrence of each marker
# so we always reflect the current run rather than a stale prior log line.
STRIPPED="$(sed -E 's/\x1b\[[0-9;]*m//g' "$TMP_LOG" 2>/dev/null || cat "$TMP_LOG")"

extract_trailer_field() {
  # Args: <field_name>
  # Pulls the LAST `<field>=<value>` line from inside the STRUCTURED-RESULT
  # trailer that the delegate emits.
  local field="$1"
  printf '%s\n' "$STRIPPED" \
    | grep -aE "^${field}=" \
    | tail -n 1 \
    | sed -E "s/^${field}=//" \
    | tr -d '\r'
}

DEL_STATUS="$(extract_trailer_field 'status')"
DEL_APP="$(extract_trailer_field 'app_backup')"
DEL_DB="$(extract_trailer_field 'db_backup')"
DEL_PRE="$(extract_trailer_field 'pre_restore_backup_path')"
DEL_VER="$(extract_trailer_field 'restored_version')"
DEL_HEALTH="$(extract_trailer_field 'health_ok')"
DEL_DUR="$(extract_trailer_field 'duration_seconds')"
DEL_REASON="$(extract_trailer_field 'reason')"

# Fall back to safe defaults if the delegate didn't emit a trailer.
[[ -z "$DEL_APP"    ]] && DEL_APP="$APP_BASENAME"
[[ -z "$DEL_DB"     ]] && DEL_DB="$DB_BASENAME"
[[ -z "$DEL_HEALTH" ]] && DEL_HEALTH="unknown"
[[ -z "$DEL_DUR"    ]] && DEL_DUR="$DURATION"
[[ -z "$DEL_REASON" ]] && DEL_REASON="(no reason emitted by delegate)"

# --- Emit structured result trailer ---------------------------------------
if [[ $DELEGATE_RC -ne 0 || "$DEL_STATUS" == "failed" || -z "$DEL_STATUS" ]]; then
  warn "Delegate restore reported failure (rc=${DELEGATE_RC}, status=${DEL_STATUS})"
  REASON_FAIL="$DEL_REASON"
  if [[ -z "$DEL_STATUS" && $DELEGATE_RC -ne 0 ]]; then
    REASON_FAIL="restore-w3forge.sh exited non-zero (rc=${DELEGATE_RC}) without emitting a trailer."
  fi
  echo "===STRUCTURED-RESULT==="
  echo "status=failed"
  echo "request_id=${REQUEST_ID}"
  echo "app_backup=${DEL_APP}"
  echo "db_backup=${DEL_DB}"
  echo "pre_restore_backup_path=${DEL_PRE}"
  echo "restored_version=${DEL_VER}"
  echo "health_ok=${DEL_HEALTH}"
  echo "duration_seconds=${DEL_DUR}"
  echo "exit_code=${DELEGATE_RC}"
  echo "reason=${REASON_FAIL}"
  echo "===END==="
  exit 1
fi

ok "restore-w3forge-ui completed in ${DURATION}s"
echo "===STRUCTURED-RESULT==="
echo "status=success"
echo "request_id=${REQUEST_ID}"
echo "app_backup=${DEL_APP}"
echo "db_backup=${DEL_DB}"
echo "pre_restore_backup_path=${DEL_PRE}"
echo "restored_version=${DEL_VER}"
echo "health_ok=${DEL_HEALTH}"
echo "duration_seconds=${DEL_DUR}"
echo "exit_code=0"
echo "reason=${DEL_REASON}"
echo "===END==="

if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
exit 0
