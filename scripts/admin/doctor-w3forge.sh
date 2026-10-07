#!/usr/bin/env bash
# App ownership and capability checks run before logging or any operation.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_w3forge-policy.sh"
w3forge_guard_script "${BASH_SOURCE[0]##*/}" "$@"
w3forge_database_env
#
# doctor-w3forge.sh
#
# Read-only deep health diagnostic. Safe to run at any time.
# Reports OK / WARN / FAIL on each invariant and prints a summary.
#
# Checks:
#   1. Required directories exist
#   2. /opt/w3forge-deploy is a Git checkout (branch + commit)
#   3. w3forge.service is enabled and active
#   4. /health and /version respond (curl --max-time 5)
#   5. Version drift across /opt/w3forge/VERSION, /opt/w3forge-deploy/VERSION, /version
#   6. Approved scripts installed under /opt/w3forge-scripts/ with bash -n clean
#   7. Disk usage on /opt and /var/log
#   8. PostgreSQL connectivity (SELECT 1, SELECT version()) - no sudo (v0.4.7)
#   9. Hard-reset allowlist tables exist in the database
#  10. Recent log activity per /opt/logs/w3forge/<category>/
#
# Usage:
#   doctor-w3forge.sh                 Run all checks (default)
#   doctor-w3forge.sh --counts        Also print row counts for the allowlist tables
#   doctor-w3forge.sh help
#
# 100% read-only. Never modifies files, database rows, services, or Git.
# Logs to /opt/logs/w3forge/doctor/.

set -uo pipefail
# Note: we do NOT use 'set -e' here. doctor is intentionally a *report* of
# health; one failing check should not abort the rest of the report. Each
# check uses local exit-code handling and contributes to the OK/WARN/FAIL
# counters surfaced in the final summary.

# --- Logging ---------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SCRIPT_DIR/_w3forge-log.sh" ]]; then
  # shellcheck disable=SC1091
  . "$SCRIPT_DIR/_w3forge-log.sh"
elif [[ -f "${W3_SCRIPTS_DIR}/_w3forge-log.sh" ]]; then
  # shellcheck disable=SC1091
  . "${W3_SCRIPTS_DIR}/_w3forge-log.sh"
fi
if declare -F w3log_init >/dev/null 2>&1; then w3log_init "doctor"; fi

# --- Config ----------------------------------------------------------------
APP_DIR="${W3_APP_DIR:-/opt/w3forge}"
DEPLOY_DIR="${W3_DEPLOY_DIR:-/opt/w3forge-deploy}"
SCRIPTS_DIR="${W3_SCRIPTS_DIR:-/opt/w3forge-scripts}"
UPDATE_DIR="${W3_UPDATE_DIR:-/opt/w3forge-update-packages}"
INSTALLED_DIR="${W3_INSTALLED_DIR:-$UPDATE_DIR/installed}"
BACKUP_DIR="${W3_BACKUPS_DIR:-/opt/backups/w3forge}"
LOG_ROOT="${W3LOG_ROOT:-/opt/logs/w3forge}"
SERVICE_NAME="${W3_SERVICE_NAME:-w3forge-admin.service}"
HEALTH_URL="${W3_HEALTH_URL:-http://localhost:8765/health}"
VERSION_URL="${W3_VERSION_URL:-http://localhost:8765/version}"
ENV_FILE="/etc/w3forge/admin.env"
DB_HOST_DEFAULT="${W3_DB_HOST:-127.0.0.1}"
DB_NAME_DEFAULT="${W3_DB_NAME:-w3forge}"
DB_USER_DEFAULT="${W3_DB_USER:-w3forge_user}"
CURL_MAX_TIME="${W3_CURL_MAX_TIME:-5}"

# Approved scripts (must match install-server-scripts.sh).
APPROVED_SCRIPTS_755=(
  deploy-w3forge.sh
  backup-w3forge.sh
  restore-w3forge.sh
  status-w3forge.sh
  logs-w3forge.sh
  package-list-w3forge.sh
  package-verify-w3forge.sh
  release-current-w3forge.sh
  doctor-w3forge.sh
  backup-list-w3forge.sh
  backup-verify-w3forge.sh
  restore-test-w3forge.sh
  patch-verify-w3forge.sh
  patch-apply-w3forge.sh
  changed-files-w3forge.sh
)
APPROVED_SCRIPTS_644=(
  _w3forge-log.sh
)

# v0.4.12 adds the 'patch' log category used by patch-verify-w3forge.sh,
# patch-apply-w3forge.sh, and changed-files-w3forge.sh (snapshots + run logs).
LOG_CATEGORIES=(deploy backup restore status release package doctor patch)

# W3 Forge required tables (must match backend/src/db/requiredSchema.ts and
# W3FORGE_REQUIRED_TABLES in _w3forge-migration-ledger.sh).
REQUIRED_TABLES=(
  schema_migrations audit_events platform_config production_cutover_record
)

# --- Colors / counters -----------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'
OK_COUNT=0
WARN_COUNT=0
FAIL_COUNT=0

ok()   { echo -e "${GREEN}[OK]${NC}   $*";   OK_COUNT=$((OK_COUNT+1)); }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; WARN_COUNT=$((WARN_COUNT+1)); }
bad()  { echo -e "${RED}[FAIL]${NC} $*";    FAIL_COUNT=$((FAIL_COUNT+1)); }
hdr()  { echo ""; echo -e "${BLUE}== $* ==${NC}"; }

usage() {
  cat <<'EOF'
Usage:
  doctor-w3forge.sh             Run all checks
  doctor-w3forge.sh --counts    Also print row counts for the hard-reset allowlist tables
  doctor-w3forge.sh help        Show this help

Exit codes:
  0  no FAIL checks (WARN allowed)
  1  one or more FAIL checks
EOF
}

WITH_COUNTS=0
case "${1:-}" in
  help|-h|--help) usage; exit 0 ;;
  --counts) WITH_COUNTS=1 ;;
  "") ;;
  *) echo "Unknown argument: $1" >&2; usage; exit 2 ;;
esac

# --- Helper: source the app .env safely to read DB_* values ----------------
# We intentionally only export DB_* keys to avoid bleeding the app env.
DB_HOST="$DB_HOST_DEFAULT"
DB_NAME="$DB_NAME_DEFAULT"
DB_USER="$DB_USER_DEFAULT"
DB_PASSWORD="${PGPASSWORD:-}"
ENV_SOURCE="validated Forge database configuration"

# --- Header ----------------------------------------------------------------
echo "=============================="
echo " W3 Forge doctor"
echo "=============================="
echo "Time     : $(date)"
echo "Host     : $(hostname 2>/dev/null || echo '?')"
echo "App dir  : $APP_DIR"
echo "Deploy   : $DEPLOY_DIR"
echo "Scripts  : $SCRIPTS_DIR"
echo "Logs     : $LOG_ROOT"
echo "Service  : ${SERVICE_NAME}.service"
echo "DB env   : $ENV_SOURCE"
echo "DB target: $DB_USER@$DB_HOST/$DB_NAME"

# === 1. Required directories ===============================================
hdr "1. Required directories"
for d in "$APP_DIR" "$DEPLOY_DIR" "$SCRIPTS_DIR" "$UPDATE_DIR" "$INSTALLED_DIR" "$BACKUP_DIR" "$LOG_ROOT"; do
  if [[ -d "$d" ]]; then
    ok "exists: $d"
  else
    bad "missing: $d"
  fi
done
for c in "${LOG_CATEGORIES[@]}"; do
  if [[ -d "$LOG_ROOT/$c" ]]; then
    ok "log dir exists: $LOG_ROOT/$c"
  else
    warn "log dir missing: $LOG_ROOT/$c"
  fi
done

# === 2. Git checkout =======================================================
hdr "2. /opt/w3forge-deploy Git checkout"
if [[ -d "$DEPLOY_DIR/.git" ]]; then
  branch="$(git -C "$DEPLOY_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
  commit="$(git -C "$DEPLOY_DIR" rev-parse --short HEAD 2>/dev/null || echo '?')"
  ok "git checkout present (branch: $branch, commit: $commit)"
else
  bad "$DEPLOY_DIR is not a git checkout (.git missing)"
fi

# === 3. systemd service ====================================================
hdr "3. systemd service"
if command -v systemctl >/dev/null 2>&1; then
  if systemctl is-enabled --quiet "$SERVICE_NAME" 2>/dev/null; then
    ok "${SERVICE_NAME}.service is enabled"
  else
    warn "${SERVICE_NAME}.service is NOT enabled (or systemctl unavailable)"
  fi
  if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
    ok "${SERVICE_NAME}.service is active"
  else
    bad "${SERVICE_NAME}.service is NOT active"
  fi
else
  warn "systemctl not available; service state not checked"
fi

# === 4. HTTP endpoints =====================================================
hdr "4. HTTP endpoints (curl --max-time $CURL_MAX_TIME)"
if command -v curl >/dev/null 2>&1; then
  if HEALTH_BODY="$(curl -fsS --max-time "$CURL_MAX_TIME" "$HEALTH_URL" 2>/dev/null)"; then
    ok "GET $HEALTH_URL responded: $HEALTH_BODY"
  else
    bad "GET $HEALTH_URL did not respond"
  fi
  if VERSION_BODY="$(curl -fsS --max-time "$CURL_MAX_TIME" "$VERSION_URL" 2>/dev/null)"; then
    ok "GET $VERSION_URL responded: $VERSION_BODY"
  else
    bad "GET $VERSION_URL did not respond"
  fi
else
  warn "curl not available; HTTP checks skipped"
fi

# === 5. Version drift ======================================================
hdr "5. Version drift"
V_APP=""; V_DEPLOY=""; V_RUNTIME=""
[[ -f "$APP_DIR/VERSION" ]]    && V_APP="$(tr -d '[:space:]' < "$APP_DIR/VERSION")"
[[ -f "$DEPLOY_DIR/VERSION" ]] && V_DEPLOY="$(tr -d '[:space:]' < "$DEPLOY_DIR/VERSION")"
if command -v curl >/dev/null 2>&1; then
  V_RUNTIME="$(curl -fsS --max-time "$CURL_MAX_TIME" "$VERSION_URL" 2>/dev/null | python3 -c "import json,sys
try:
  d=json.load(sys.stdin); print(d.get('version','').strip())
except Exception:
  pass" 2>/dev/null || true)"
fi
echo "  $APP_DIR/VERSION    : ${V_APP:-?}"
echo "  $DEPLOY_DIR/VERSION : ${V_DEPLOY:-?}"
echo "  /version (runtime)  : ${V_RUNTIME:-?}"
if [[ -n "$V_APP" && -n "$V_DEPLOY" && "$V_APP" == "$V_DEPLOY" ]]; then
  ok "app dir VERSION matches deploy dir VERSION ($V_APP)"
else
  bad "app dir VERSION vs deploy dir VERSION differ (or missing)"
fi
if [[ -n "$V_RUNTIME" ]]; then
  if [[ "$V_RUNTIME" == "$V_APP" ]]; then
    ok "runtime /version matches VERSION ($V_RUNTIME)"
  else
    warn "runtime /version ($V_RUNTIME) differs from VERSION ($V_APP); service may need restart"
  fi
fi

# === 6. Installed scripts inventory ========================================
hdr "6. Installed scripts in $SCRIPTS_DIR"
for s in "${APPROVED_SCRIPTS_755[@]}"; do
  path="$SCRIPTS_DIR/$s"
  if [[ -f "$path" ]]; then
    if [[ -x "$path" ]]; then
      if bash -n "$path" 2>/dev/null; then
        ok "$s (755, syntax OK)"
      else
        bad "$s (syntax error)"
      fi
    else
      bad "$s exists but is NOT executable"
    fi
  else
    bad "$s missing in $SCRIPTS_DIR"
  fi
done
for s in "${APPROVED_SCRIPTS_644[@]}"; do
  path="$SCRIPTS_DIR/$s"
  if [[ -f "$path" ]]; then
    if bash -n "$path" 2>/dev/null; then
      ok "$s (helper, syntax OK)"
    else
      bad "$s (syntax error)"
    fi
  else
    bad "$s missing in $SCRIPTS_DIR"
  fi
done

# === 7. Disk usage =========================================================
hdr "7. Disk usage"
if command -v df >/dev/null 2>&1; then
  df -h /opt    2>/dev/null | sed 's/^/  /' || warn "df /opt failed"
  df -h /var/log 2>/dev/null | sed 's/^/  /' || warn "df /var/log failed"
  ok "disk usage reported above"
else
  warn "df not available"
fi

# === 8. PostgreSQL connectivity ============================================
# v0.4.7: do NOT depend on sudo. The W3 Forge LXC has no sudo installed.
# Auth strategy, in order:
#   (a) .env credentials via PGPASSWORD over 127.0.0.1
#   (b) direct psql -h "$W3_DB_HOST" -U "$W3_DB_USER" -d "$W3_DB_NAME" (uses ~/.pgpass,
#       trust auth, or PGPASSWORD already in env)
#   (c) su - postgres -c 'psql -d w3forge ...' (peer auth, no sudo)
hdr "8. PostgreSQL connectivity"
PSQL_OK=0
PSQL_AUTH=""  # one of: env | direct | su
if command -v psql >/dev/null 2>&1; then
  # (a) .env-derived credentials first.
  if [[ $PSQL_OK -eq 0 && -n "$DB_PASSWORD" ]]; then
    if PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -tAc 'SELECT 1' >/dev/null 2>&1; then
      ok "psql as $DB_USER@$DB_HOST/$DB_NAME (.env credentials) responded to SELECT 1"
      PSQL_OK=1; PSQL_AUTH="env"
    fi
  fi
  # (b) Direct psql with no password env (relies on ~/.pgpass / trust /
  #     externally-set PGPASSWORD). This matches the exact command the
  #     operator confirmed works on the W3 Forge LXC.
  if [[ $PSQL_OK -eq 0 ]]; then
    if psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -tAc 'SELECT 1' >/dev/null 2>&1; then
      ok "psql as $DB_USER@$DB_HOST/$DB_NAME (direct, no PGPASSWORD) responded to SELECT 1"
      PSQL_OK=1; PSQL_AUTH="direct"
    fi
  fi
  # (c) Fallback: su - postgres (peer auth on the local box). No sudo.
  if [[ $PSQL_OK -eq 0 ]] && command -v su >/dev/null 2>&1; then
    if su - postgres -c "psql -d \"$DB_NAME\" -tAc 'SELECT 1'" >/dev/null 2>&1; then
      ok "psql via 'su - postgres' fallback responded to SELECT 1"
      PSQL_OK=1; PSQL_AUTH="su"
    fi
  fi
  if [[ $PSQL_OK -eq 0 ]]; then
    bad "could not run SELECT 1 against $DB_NAME (tried .env, direct, su - postgres)"
  else
    # Print server version (informational).
    case "$PSQL_AUTH" in
      env)    PGV="$(PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -tAc 'SELECT version()' 2>/dev/null | head -1)" ;;
      direct) PGV="$(psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -tAc 'SELECT version()' 2>/dev/null | head -1)" ;;
      su)     PGV="$(su - postgres -c "psql -d \"$DB_NAME\" -tAc 'SELECT version()'" 2>/dev/null | head -1)" ;;
    esac
    [[ -n "$PGV" ]] && echo "  server: $PGV"
  fi
else
  warn "psql not available; database checks skipped"
fi

# Helper to run an arbitrary read-only psql query using whichever auth path
# worked above. Echoes nothing if no path is available.
psql_ro() {
  local sql="$1"
  case "$PSQL_AUTH" in
    env)    PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -tAc "$sql" 2>/dev/null ;;
    direct) psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -tAc "$sql" 2>/dev/null ;;
    su)     su - postgres -c "psql -d \"$DB_NAME\" -tAc \"$sql\"" 2>/dev/null ;;
  esac
}

# === 9. Approved-table presence ============================================
hdr "9. W3 Forge tables present"
if [[ $PSQL_OK -eq 1 ]]; then
  TABLE_IN_LIST="$(printf "'%s'," "${REQUIRED_TABLES[@]}")"
  TABLE_IN_LIST="${TABLE_IN_LIST%,}"
  EXISTING="$(psql_ro "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ($TABLE_IN_LIST) ORDER BY table_name")"
  declare -A FOUND=()
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    FOUND["$line"]=1
  done <<< "$EXISTING"
  for t in "${REQUIRED_TABLES[@]}"; do
    if [[ -n "${FOUND[$t]:-}" ]]; then
      ok "table exists: $t"
    else
      bad "table missing: $t"
    fi
  done
  if [[ $WITH_COUNTS -eq 1 ]]; then
    echo ""
    echo "  --counts requested:"
    for t in "${REQUIRED_TABLES[@]}"; do
      [[ -n "${FOUND[$t]:-}" ]] || continue
      c="$(psql_ro "SELECT COUNT(*) FROM $t")"
      echo "    $t: ${c:-?}"
    done
  fi
else
  warn "skipping table-presence check (no psql connectivity)"
fi

# === 10. Recent log activity ===============================================
hdr "10. Recent log activity per category"
if [[ -d "$LOG_ROOT" ]]; then
  for c in "${LOG_CATEGORIES[@]}"; do
    dir="$LOG_ROOT/$c"
    if [[ -d "$dir" ]]; then
      newest="$(ls -1t "$dir" 2>/dev/null | grep -E '\.log$' | head -n 1)"
      if [[ -n "$newest" ]]; then
        ok "$c: $newest"
      else
        warn "$c: (no logs yet)"
      fi
    else
      warn "$c: directory missing"
    fi
  done
else
  bad "log root $LOG_ROOT missing"
fi

# --- Summary ---------------------------------------------------------------
echo ""
echo "=============================="
echo " doctor summary"
echo "=============================="
echo -e "  ${GREEN}OK${NC}   : $OK_COUNT"
echo -e "  ${YELLOW}WARN${NC} : $WARN_COUNT"
echo -e "  ${RED}FAIL${NC} : $FAIL_COUNT"
echo ""

if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi

if [[ $FAIL_COUNT -gt 0 ]]; then
  exit 1
fi
exit 0
