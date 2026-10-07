#!/usr/bin/env bash
# App ownership and capability checks run before logging or any operation.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_w3forge-policy.sh"
w3forge_guard_script "${BASH_SOURCE[0]##*/}" "$@"
#
# backup-w3forge-ui.sh
#
# W3 Core v0.5.18 — Non-interactive UI wrapper around backup-w3forge.sh.
#
# Called only by the W3 Forge Admin Controls backend
# (POST /api/admin/controls/backup-create/run) after action-lock acquisition,
# server-side validation, and the explicit `confirmCreate` checkbox.
# NEVER interactive. NEVER reads stdin. NEVER touches /opt/w3forge runtime,
# the systemd service, the production PostgreSQL data (pg_dump is read-only),
# or any other restricted surface beyond the existing backup behavior.
#
# Behavior:
#   - Accepts --yes (REQUIRED), --request-id <id>, --source <ui|api|cli>
#   - --yes is REQUIRED. Refuses to run without it.
#   - Closes stdin (`< /dev/null`) when invoking the delegate so a
#     misbehaving delegate cannot wait on input.
#   - Delegates the actual backup to scripts/backup-w3forge.sh (or
#     /opt/w3forge-scripts/backup-w3forge.sh on the live host). The delegate is
#     UNMODIFIED — this wrapper only invokes it and parses its existing
#     stdout for the app + db backup paths and the rsync result.
#   - Tags every log line with [request-id] for the safe action runner.
#   - On success: prints a `===STRUCTURED-RESULT===` trailer the backend
#     can parse, including app/db backup paths and remote-sync status.
#   - On failure: clean non-zero exit with a clear reason. Never hangs.
#
# Output (structured trailer, parsed by the safe action runner):
#   ===STRUCTURED-RESULT===
#   status=success|failed
#   request_id=<id>
#   output_path=/opt/backups/w3forge/w3forge_app_<TS>.tar.gz
#   db_path=/opt/backups/w3forge/w3forge_db_<TS>.sql
#   app_bytes=<size>
#   db_bytes=<size>
#   duration_seconds=<n>
#   remote_sync=true|false|unknown
#   reason=<text>
#   ===END===
#
# Exit codes:
#   0   success
#   1   delegate (backup-w3forge.sh) failed
#   2   invalid arguments or missing --yes
#   3   pre-flight failure (delegate not executable, backup dir not writable)
#
# Logs to /opt/logs/w3forge/backup/ (same category as the delegate).

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
if declare -F w3log_init >/dev/null 2>&1; then w3log_init "backup"; fi

# --- Config ----------------------------------------------------------------
BACKUP_DIR="${W3_BACKUPS_DIR:-/opt/backups/w3forge}"
DELEGATE="${W3_BACKUP_SCRIPT:-$SCRIPT_DIR/backup-w3forge.sh}"
if [[ ! -x "$DELEGATE" && -x "${W3_SCRIPTS_DIR}/backup-w3forge.sh" ]]; then
  DELEGATE="${W3_SCRIPTS_DIR}/backup-w3forge.sh"
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
  backup-w3forge-ui.sh --yes [--request-id <id>] [--source ui|api|cli]
  backup-w3forge-ui.sh help

Required:
  --yes              Non-interactive acknowledgment from the calling runner.

Optional:
  --request-id <id>  Caller-supplied id propagated through logs.
  --source <s>       One of: ui, api, cli (recorded in logs only).

Notes:
  This wrapper invokes scripts/backup-w3forge.sh unmodified. The delegate
  creates a fresh app tarball + pg_dump pair under /opt/backups/w3forge and rsyncs
  the pair to the configured remote backup target. This wrapper only adds
  a non-interactive frame, captures the delegate's stdout, and emits a
  structured result trailer for the W3 Forge Admin Controls runner.
EOF
}

YES=""
REQUEST_ID=""
SOURCE_TAG="cli"

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
  REQUEST_ID="bc-$(date +%Y%m%d-%H%M%S)-$$"
fi

# --- Pre-flight ------------------------------------------------------------
if [[ ! -x "$DELEGATE" ]]; then
  emit_failure "Delegate script not executable: $DELEGATE"
  echo "===STRUCTURED-RESULT==="
  echo "status=failed"
  echo "request_id=${REQUEST_ID}"
  echo "duration_seconds=0"
  echo "remote_sync=unknown"
  echo "reason=delegate not executable: ${DELEGATE}"
  echo "===END==="
  exit 3
fi

mkdir -p "$BACKUP_DIR" 2>/dev/null || true
if [[ ! -d "$BACKUP_DIR" || ! -w "$BACKUP_DIR" ]]; then
  emit_failure "Backup directory missing or not writable: $BACKUP_DIR"
  echo "===STRUCTURED-RESULT==="
  echo "status=failed"
  echo "request_id=${REQUEST_ID}"
  echo "duration_seconds=0"
  echo "remote_sync=unknown"
  echo "reason=backup dir not writable: ${BACKUP_DIR}"
  echo "===END==="
  exit 3
fi

info "request-id : $REQUEST_ID"
info "source     : $SOURCE_TAG"
info "delegate   : $DELEGATE"
info "backup-dir : $BACKUP_DIR"

# --- Delegate --------------------------------------------------------------
# Capture delegate output so we can extract the app + db backup paths from
# the delegate's existing stdout markers ("App backup: ..." / "DB backup: ...")
# without modifying the delegate. tee to stdout so the live runner still sees
# progress in real time. stdin is explicitly closed to guarantee the delegate
# can never block on a TTY read.
TMP_LOG="$(mktemp -t w3forge-backup-ui.XXXXXX.log)"
cleanup_tmplog() { rm -f "$TMP_LOG" 2>/dev/null || true; }
trap cleanup_tmplog EXIT

START_TS=$(date +%s)
set +e
"$DELEGATE" </dev/null 2>&1 | tee "$TMP_LOG"
DELEGATE_RC=${PIPESTATUS[0]}
set -e
END_TS=$(date +%s)
DURATION=$(( END_TS - START_TS ))

# --- Parse delegate stdout for paths + rsync result -------------------------
# Strip ANSI codes defensively, then pull the LAST occurrence of each marker
# so we always reflect the current run rather than a stale prior log line.
STRIPPED="$(sed -E 's/\x1b\[[0-9;]*m//g' "$TMP_LOG" 2>/dev/null || cat "$TMP_LOG")"
APP_PATH="$(printf '%s\n' "$STRIPPED" | grep -aE 'App backup:' | tail -n 1 | sed -E 's/.*App backup:[[:space:]]+//' | tr -d '\r')"
DB_PATH="$(printf '%s\n' "$STRIPPED" | grep -aE 'DB backup:' | tail -n 1 | sed -E 's/.*DB backup:[[:space:]]+//' | tr -d '\r')"

# Remote sync result: the delegate uses `rsync -av` for both files. We do not
# have a single "rsync OK" line, so we approximate from the delegate's exit
# code and the presence of rsync error keywords in the captured stream.
REMOTE_SYNC="unknown"
if [[ $DELEGATE_RC -eq 0 ]]; then
  if printf '%s\n' "$STRIPPED" | grep -aqE 'rsync:.*(error|failed)|connection (closed|refused|timed out)|Permission denied \(publickey'; then
    REMOTE_SYNC="false"
  else
    REMOTE_SYNC="true"
  fi
else
  if printf '%s\n' "$STRIPPED" | grep -aqE 'rsync:.*(error|failed)|connection (closed|refused|timed out)'; then
    REMOTE_SYNC="false"
  fi
fi

APP_BYTES="0"
DB_BYTES="0"
if [[ -n "$APP_PATH" && -f "$APP_PATH" ]]; then
  APP_BYTES="$(stat -c%s "$APP_PATH" 2>/dev/null || wc -c < "$APP_PATH" 2>/dev/null || echo 0)"
fi
if [[ -n "$DB_PATH" && -f "$DB_PATH" ]]; then
  DB_BYTES="$(stat -c%s "$DB_PATH" 2>/dev/null || wc -c < "$DB_PATH" 2>/dev/null || echo 0)"
fi

if [[ $DELEGATE_RC -ne 0 ]]; then
  warn "Delegate exited non-zero ($DELEGATE_RC)"
  echo "===STRUCTURED-RESULT==="
  echo "status=failed"
  echo "request_id=${REQUEST_ID}"
  echo "output_path=${APP_PATH}"
  echo "db_path=${DB_PATH}"
  echo "app_bytes=${APP_BYTES}"
  echo "db_bytes=${DB_BYTES}"
  echo "duration_seconds=${DURATION}"
  echo "remote_sync=${REMOTE_SYNC}"
  echo "exit_code=${DELEGATE_RC}"
  echo "reason=backup-w3forge.sh exited non-zero (rc=${DELEGATE_RC})"
  echo "===END==="
  exit 1
fi

# Sanity check that the delegate actually produced both files we expect.
if [[ -z "$APP_PATH" || ! -f "$APP_PATH" || -z "$DB_PATH" || ! -f "$DB_PATH" ]]; then
  warn "Could not locate one or both backup artifacts after a delegate exit-0 run"
  echo "===STRUCTURED-RESULT==="
  echo "status=failed"
  echo "request_id=${REQUEST_ID}"
  echo "output_path=${APP_PATH}"
  echo "db_path=${DB_PATH}"
  echo "app_bytes=${APP_BYTES}"
  echo "db_bytes=${DB_BYTES}"
  echo "duration_seconds=${DURATION}"
  echo "remote_sync=${REMOTE_SYNC}"
  echo "reason=backup artifacts not located after delegate success"
  echo "===END==="
  exit 1
fi

ok "backup-w3forge-ui completed in ${DURATION}s"
echo "===STRUCTURED-RESULT==="
echo "status=success"
echo "request_id=${REQUEST_ID}"
echo "output_path=${APP_PATH}"
echo "db_path=${DB_PATH}"
echo "app_bytes=${APP_BYTES}"
echo "db_bytes=${DB_BYTES}"
echo "duration_seconds=${DURATION}"
echo "remote_sync=${REMOTE_SYNC}"
echo "reason=App + DB backup pair created under ${BACKUP_DIR}; remote_sync=${REMOTE_SYNC}."
echo "===END==="

if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
exit 0
