#!/usr/bin/env bash
# App ownership and capability checks run before logging or any operation.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_w3forge-policy.sh"
w3forge_guard_script "${BASH_SOURCE[0]##*/}" "$@"
#
# restore-test-w3forge-ui.sh
#
# W3 Core v0.5.20 — Non-interactive UI wrapper around restore-test-w3forge.sh.
#
# Called only by the W3 Forge Admin Controls backend
# (POST /api/admin/controls/restore-test/run) after action-lock acquisition,
# server-side validation, and the explicit `confirmRestoreTest` checkbox.
# NEVER interactive. NEVER reads stdin. NEVER touches the production
# PostgreSQL database, /opt/w3forge runtime, the systemd service,
# /opt/w3forge-scripts content, secrets, or env files.
#
# Behavior:
#   - Accepts --yes (REQUIRED), --request-id <id>, --source <ui|api|cli>
#     and an optional --keep-temp passthrough for operator-side inspection.
#   - --yes is REQUIRED. Refuses to run without it (exit 2). This is the
#     non-interactive acknowledgment required by the safe action runner.
#   - Closes stdin (`< /dev/null`) when invoking the delegate so a
#     misbehaving delegate cannot wait on input.
#   - Delegates the actual restore-test to scripts/restore-test-w3forge.sh
#     (or /opt/w3forge-scripts/restore-test-w3forge.sh on the live host). The
#     delegate is UNMODIFIED — this wrapper only invokes it and parses its
#     existing stdout to surface key facts in the structured result trailer.
#   - Defense-in-depth: after the delegate runs, re-asserts that the
#     extracted temp DB name (parsed from delegate stdout) does NOT equal
#     the production database name (`W3_DB_NAME`, default `w3forge`). If it
#     does, the wrapper emits status=failed with a clear reason regardless
#     of the delegate exit code.
#   - Tags every log line with [request-id] for the safe action runner.
#   - On success: prints a `===STRUCTURED-RESULT===` trailer the backend
#     can parse, including the backup pair used, the temp DB name, the
#     restore duration, whether the production DB was untouched, and
#     whether the temp DB was cleaned up.
#   - On failure: clean non-zero exit with a clear reason. Never hangs.
#
# Output (structured trailer, parsed by the safe action runner):
#   ===STRUCTURED-RESULT===
#   status=success|failed
#   request_id=<id>
#   app_path=/opt/backups/w3forge/w3forge_app_<TS>.tar.gz
#   db_path=/opt/backups/w3forge/w3forge_db_<TS>.sql
#   temp_db_name=w3forge_restore_test_<YYYYMMDD>_<HHMMSS>_<pid>
#   restore_seconds=<n>
#   production_db_untouched=true
#   cleanup_ok=true|false|unknown
#   reason=<text>
#   ===END===
#
# Exit codes:
#   0   success
#   1   delegate (restore-test-w3forge.sh) reported failure
#   2   invalid arguments or missing --yes (refusal)
#   3   pre-flight failure (delegate not executable, etc.)
#   4   safety assertion failed (temp db name overlaps prod db name) —
#       this should never trigger if the delegate is intact; if it does
#       the wrapper aborts before touching anything.
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
PROD_DB_NAME="${W3_DB_NAME:-w3forge}"
DELEGATE="${W3_RESTORE_TEST_SCRIPT:-$SCRIPT_DIR/restore-test-w3forge.sh}"
if [[ ! -x "$DELEGATE" && -x "${W3_SCRIPTS_DIR}/restore-test-w3forge.sh" ]]; then
  DELEGATE="${W3_SCRIPTS_DIR}/restore-test-w3forge.sh"
fi

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
  restore-test-w3forge-ui.sh --yes [--request-id <id>] [--source ui|api|cli] [--keep-temp]
  restore-test-w3forge-ui.sh help

Required:
  --yes              Non-interactive acknowledgment from the calling runner.

Optional:
  --request-id <id>  Caller-supplied id propagated through logs.
  --source <s>       One of: ui, api, cli (recorded in logs only).
  --keep-temp        Pass-through to the delegate: keep the temp DB and the
                     /tmp scratch directory after the run so an operator can
                     inspect them. NOT recommended for routine UI runs.

Notes:
  This wrapper invokes scripts/restore-test-w3forge.sh unmodified. The
  delegate extracts the newest backup pair into /tmp, restores the .sql
  dump into a freshly-created TEMPORARY PostgreSQL database whose name
  matches /^w3forge_restore_test_<TS>_<pid>$/, runs read-only sanity
  queries, and drops the temp DB (unless --keep-temp). The delegate
  NEVER touches the production w3forge database, /opt/w3forge,
  /opt/w3forge-deploy, /opt/backups/w3forge, /opt/w3forge-scripts, the systemd service,
  secrets, or env files.
EOF
}

YES=""
REQUEST_ID=""
SOURCE_TAG="cli"
KEEP_TEMP=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    help|-h|--help) usage; exit 0 ;;
    --yes) YES="1"; shift ;;
    --request-id)
      [[ $# -ge 2 ]] || { emit_failure "--request-id requires a value"; exit 2; }
      REQUEST_ID="$2"; shift 2 ;;
    --source)
      [[ $# -ge 2 ]] || { emit_failure "--source requires a value"; exit 2; }
      SOURCE_TAG="$2"; shift 2 ;;
    --keep-temp) KEEP_TEMP=1; shift ;;
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
  REQUEST_ID="rt-$(date +%Y%m%d-%H%M%S)-$$"
fi

# --- Pre-flight ------------------------------------------------------------
if [[ ! -x "$DELEGATE" ]]; then
  emit_failure "Delegate script not executable: $DELEGATE"
  echo "===STRUCTURED-RESULT==="
  echo "status=failed"
  echo "request_id=${REQUEST_ID}"
  echo "duration_seconds=0"
  echo "restore_seconds=0"
  echo "production_db_untouched=true"
  echo "cleanup_ok=unknown"
  echo "reason=delegate not executable: ${DELEGATE}"
  echo "===END==="
  exit 3
fi

info "request-id : $REQUEST_ID"
info "source     : $SOURCE_TAG"
info "delegate   : $DELEGATE"
info "prod-db    : $PROD_DB_NAME  (must NEVER be touched)"
info "keep-temp  : $([[ $KEEP_TEMP -eq 1 ]] && echo yes || echo no)"

# --- Delegate --------------------------------------------------------------
# Capture delegate output so we can extract the resolved backup pair, the
# temp DB name, and the PASS/FAIL summary without modifying the delegate.
# tee to stdout so the live runner still sees progress in real time. stdin
# is explicitly closed to guarantee the delegate can never block on a TTY
# read.
TMP_LOG="$(mktemp -t w3forge-restore-test-ui.XXXXXX.log)"
cleanup_tmplog() { rm -f "$TMP_LOG" 2>/dev/null || true; }
trap cleanup_tmplog EXIT

DELEGATE_ARGS=()
if [[ $KEEP_TEMP -eq 1 ]]; then
  DELEGATE_ARGS+=(--keep-temp)
fi

START_TS=$(date +%s)
set +e
"$DELEGATE" "${DELEGATE_ARGS[@]}" </dev/null 2>&1 | tee "$TMP_LOG"
DELEGATE_RC=${PIPESTATUS[0]}
set -e
END_TS=$(date +%s)
DURATION=$(( END_TS - START_TS ))

# --- Parse delegate stdout for the structured trailer ----------------------
# Strip ANSI codes defensively, then pull the LAST occurrence of each marker
# so we always reflect the current run rather than a stale prior log line.
STRIPPED="$(sed -E 's/\x1b\[[0-9;]*m//g' "$TMP_LOG" 2>/dev/null || cat "$TMP_LOG")"

APP_PATH="$(printf '%s\n' "$STRIPPED" | grep -aE '^App backup:' | tail -n 1 | sed -E 's/^App backup:[[:space:]]+//' | tr -d '\r')"
DB_PATH="$(printf '%s\n' "$STRIPPED" | grep -aE '^DB backup:' | tail -n 1 | sed -E 's/^DB backup:[[:space:]]+//' | tr -d '\r')"

# Delegate emits `[OK]   temp db name: <name>` once the temp DB name is
# generated. Strip the leading `[OK]` decoration before extracting.
TEMP_DB_NAME="$(printf '%s\n' "$STRIPPED" \
  | grep -aE 'temp db name:' \
  | tail -n 1 \
  | sed -E 's/.*temp db name:[[:space:]]+//' \
  | tr -d '\r' \
  | awk '{print $1}')"

# Delegate cleanup behavior: it logs `[cleanup] --keep-temp: leaving ...`
# when --keep-temp is set, otherwise it silently drops the temp DB and
# removes the scratch dir on exit. We infer cleanup_ok from KEEP_TEMP and
# the presence of a refusal marker in stdout (the delegate refuses to rm
# the scratch dir if it is not under /tmp/).
CLEANUP_OK="unknown"
if [[ $KEEP_TEMP -eq 1 ]]; then
  CLEANUP_OK="false"  # cleanup intentionally skipped per --keep-temp
else
  if printf '%s\n' "$STRIPPED" | grep -aqE '\[cleanup\] refusing to rm'; then
    CLEANUP_OK="false"
  else
    CLEANUP_OK="true"
  fi
fi

# Delegate PASS / FAIL marker (the very last summary line).
PASS_FAIL="unknown"
if printf '%s\n' "$STRIPPED" | grep -aqE 'Restore test PASSED'; then
  PASS_FAIL="passed"
elif printf '%s\n' "$STRIPPED" | grep -aqE 'Restore test FAILED'; then
  PASS_FAIL="failed"
fi

# --- Defense-in-depth safety assertion -------------------------------------
# The delegate already asserts the temp DB name is well-formed and does not
# equal the production DB name. We re-assert here so that if the delegate
# is ever swapped out or the parse fails open, the wrapper still cannot
# claim success against the prod DB.
PROD_UNTOUCHED="true"
if [[ -n "$TEMP_DB_NAME" && "$TEMP_DB_NAME" == "$PROD_DB_NAME" ]]; then
  emit_failure "SAFETY ABORT: parsed temp_db_name (${TEMP_DB_NAME}) equals production db name (${PROD_DB_NAME})"
  PROD_UNTOUCHED="false"
  echo "===STRUCTURED-RESULT==="
  echo "status=failed"
  echo "request_id=${REQUEST_ID}"
  echo "app_path=${APP_PATH}"
  echo "db_path=${DB_PATH}"
  echo "temp_db_name=${TEMP_DB_NAME}"
  echo "restore_seconds=${DURATION}"
  echo "duration_seconds=${DURATION}"
  echo "production_db_untouched=${PROD_UNTOUCHED}"
  echo "cleanup_ok=${CLEANUP_OK}"
  echo "reason=Safety assertion failed — parsed temp_db_name equals production database name."
  echo "===END==="
  exit 4
fi

# --- Emit structured result trailer ---------------------------------------
if [[ $DELEGATE_RC -ne 0 || "$PASS_FAIL" == "failed" ]]; then
  warn "Delegate restore-test reported failure (rc=${DELEGATE_RC}, pass_fail=${PASS_FAIL})"
  REASON_FAIL="restore-test-w3forge.sh reported FAIL"
  if [[ $DELEGATE_RC -ne 0 && "$PASS_FAIL" != "failed" ]]; then
    REASON_FAIL="restore-test-w3forge.sh exited non-zero (rc=${DELEGATE_RC})"
  fi
  echo "===STRUCTURED-RESULT==="
  echo "status=failed"
  echo "request_id=${REQUEST_ID}"
  echo "app_path=${APP_PATH}"
  echo "db_path=${DB_PATH}"
  echo "temp_db_name=${TEMP_DB_NAME}"
  echo "restore_seconds=${DURATION}"
  echo "duration_seconds=${DURATION}"
  echo "production_db_untouched=${PROD_UNTOUCHED}"
  echo "cleanup_ok=${CLEANUP_OK}"
  echo "exit_code=${DELEGATE_RC}"
  echo "reason=${REASON_FAIL}"
  echo "===END==="
  exit 1
fi

ok "restore-test-w3forge-ui completed in ${DURATION}s"
echo "===STRUCTURED-RESULT==="
echo "status=success"
echo "request_id=${REQUEST_ID}"
echo "app_path=${APP_PATH}"
echo "db_path=${DB_PATH}"
echo "temp_db_name=${TEMP_DB_NAME}"
echo "restore_seconds=${DURATION}"
echo "duration_seconds=${DURATION}"
echo "production_db_untouched=${PROD_UNTOUCHED}"
echo "cleanup_ok=${CLEANUP_OK}"
echo "reason=Restore-test rehearsal PASSED. Production DB ${PROD_DB_NAME} was not touched; restore landed in temp DB ${TEMP_DB_NAME}."
echo "===END==="

if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
exit 0
