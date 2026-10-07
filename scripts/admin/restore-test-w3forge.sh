#!/usr/bin/env bash
# App ownership and capability checks run before logging or any operation.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_w3forge-policy.sh"
w3forge_guard_script "${BASH_SOURCE[0]##*/}" "$@"
w3forge_database_env
#
# restore-test-w3forge.sh
#
# Test restore readiness WITHOUT touching production.
#
# What this DOES:
#   - Resolve a backup pair (newest local by default, or explicit args)
#   - Run backup-verify-w3forge.sh on the pair as a prerequisite
#   - Extract the app tarball into a freshly-created /tmp scratch dir
#   - Sanity-check the extracted tree (VERSION present; scripts/*.sh bash -n clean)
#   - Create a temp Postgres database with a generated name
#   - Restore the .sql dump into the temp database only
#   - Run read-only sanity queries (table counts, hard-reset allowlist presence)
#   - Drop the temp database and remove the scratch dir on exit
#
# What this NEVER does:
#   - Never stop, start, or restart any service (no systemctl invocations)
#   - Never write to /opt/w3forge
#   - Never write to /opt/w3forge-deploy
#   - Never write to /opt/backups/w3forge
#   - Never run any DDL/DML against the production w3forge database
#   - Never invoke sudo (the LXC has none)
#
# Filename convention (locked to backup-w3forge.sh, v0.4.4+):
#   w3forge_app_YYYY-MM-DD_HH-MM-SS.tar.gz
#   w3forge_db_YYYY-MM-DD_HH-MM-SS.sql
#
# Usage:
#   restore-test-w3forge.sh
#   restore-test-w3forge.sh <app.tar.gz> <db.sql>
#   restore-test-w3forge.sh --no-db                 Skip DB restore stage
#   restore-test-w3forge.sh --keep-temp             Do not drop temp DB / dir at end
#   restore-test-w3forge.sh --self-check            Run internal safety assertions and exit
#   restore-test-w3forge.sh help
#
# Exit codes:
#   0 on PASS, 1 on FAIL or aborted safety assertion.
#
# Logs to /opt/logs/w3forge/restore/.

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
BACKUP_DIR="${W3_BACKUPS_DIR:-/opt/backups/w3forge}"
APP_DIR_PROD="${W3_APP_DIR:-/opt/w3forge}"
DEPLOY_DIR_PROD="${W3_DEPLOY_DIR:-/opt/w3forge-deploy}"
ENV_FILE="/etc/w3forge/admin.env"
PROD_DB_NAME="${W3_DB_NAME:-w3forge}"
DB_HOST_DEFAULT="${W3_DB_HOST:-127.0.0.1}"
DB_USER_DEFAULT="${W3_DB_USER:-w3forge_user}"

# --- Colors / counters -----------------------------------------------------
if [[ -t 1 ]]; then
  C_OK=$'\033[0;32m'; C_WARN=$'\033[1;33m'; C_FAIL=$'\033[0;31m'; C_INFO=$'\033[0;34m'; C_RST=$'\033[0m'
else
  C_OK=""; C_WARN=""; C_FAIL=""; C_INFO=""; C_RST=""
fi
COUNT_OK=0; COUNT_WARN=0; COUNT_FAIL=0
ok()   { echo "  ${C_OK}[OK]${C_RST}   $*";   COUNT_OK=$((COUNT_OK+1)); }
warn() { echo "  ${C_WARN}[WARN]${C_RST} $*"; COUNT_WARN=$((COUNT_WARN+1)); }
bad()  { echo "  ${C_FAIL}[FAIL]${C_RST} $*"; COUNT_FAIL=$((COUNT_FAIL+1)); }
hdr()  { echo ""; echo "${C_INFO}== $* ==${C_RST}"; }

usage() {
  sed -n '3,40p' "${BASH_SOURCE[0]}" | sed 's/^# //; s/^#//'
}

# --- Filename helpers ------------------------------------------------------
RE_TOKEN='[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{2}-[0-9]{2}-[0-9]{2}'
extract_token() {
  local base; base="$(basename "$1")"
  if [[ "$base" =~ ^w3forge_(app|db)_(${RE_TOKEN}) ]]; then
    echo "${BASH_REMATCH[2]}"
  fi
}

# --- W3 Forge required tables (match backend/src/db/requiredSchema.ts) ---
REQUIRED_TABLES=(
  schema_migrations audit_events platform_config production_cutover_record
)
EXPECTED_TABLE_COUNT=${#REQUIRED_TABLES[@]}

# --- Arg parsing -----------------------------------------------------------
ARG_APP=""
ARG_DB=""
NO_DB=0
KEEP_TEMP=0
SELF_CHECK=0
for a in "$@"; do
  case "$a" in
    --no-db)      NO_DB=1 ;;
    --keep-temp)  KEEP_TEMP=1 ;;
    --self-check) SELF_CHECK=1 ;;
    help|-h|--help) usage; exit 0 ;;
    --*) bad "unknown flag: $a"; usage; exit 1 ;;
    *)
      if   [[ -z "$ARG_APP" ]]; then ARG_APP="$a"
      elif [[ -z "$ARG_DB"  ]]; then ARG_DB="$a"
      else bad "too many positional args"; usage; exit 1
      fi
      ;;
  esac
done

# === Safety assertions =====================================================
# Each is called *before* any mutation. If any fails, exit 1 immediately.
# The --self-check mode exercises all of these with synthetic inputs.

assert_temp_dir_safe() {
  local d="$1"
  [[ -n "$d" ]]                 || { echo "ASSERT FAIL: temp dir empty";          return 1; }
  [[ "$d" == /tmp/* ]]          || { echo "ASSERT FAIL: temp dir not under /tmp"; return 1; }
  [[ "$d" != "$APP_DIR_PROD"* ]]    || { echo "ASSERT FAIL: temp dir overlaps APP_DIR_PROD";    return 1; }
  [[ "$d" != "$DEPLOY_DIR_PROD"* ]] || { echo "ASSERT FAIL: temp dir overlaps DEPLOY_DIR_PROD"; return 1; }
  [[ "$d" != "$BACKUP_DIR"* ]]      || { echo "ASSERT FAIL: temp dir overlaps BACKUP_DIR";      return 1; }
  return 0
}

assert_temp_db_safe() {
  local n="$1"
  [[ -n "$n" ]] || { echo "ASSERT FAIL: temp db name empty"; return 1; }
  [[ "$n" =~ ^w3forge_restore_test_[0-9]{8}_[0-9]{6}_[0-9]+$ ]] || {
    echo "ASSERT FAIL: temp db name does not match required pattern: $n"; return 1; }
  [[ "$n" != "$PROD_DB_NAME" ]] || { echo "ASSERT FAIL: temp db name equals prod db name"; return 1; }
  return 0
}

# === --self-check ==========================================================
if [[ $SELF_CHECK -eq 1 ]]; then
  echo "${C_INFO}restore-test-w3forge.sh --self-check${C_RST}"
  echo ""
  echo "[1] assert_temp_dir_safe must accept valid input"
  if assert_temp_dir_safe "/tmp/w3forge-restoretest-aaa"; then ok "accepted /tmp/w3forge-restoretest-aaa"; else bad "should have accepted"; fi
  echo "[2] assert_temp_dir_safe must reject paths outside /tmp"
  if ! assert_temp_dir_safe "/opt/w3forge/bad" >/dev/null 2>&1; then ok "rejected /opt/w3forge/bad"; else bad "should have rejected"; fi
  if ! assert_temp_dir_safe "/var/tmp/bad"   >/dev/null 2>&1; then ok "rejected /var/tmp/bad";   else bad "should have rejected"; fi
  if ! assert_temp_dir_safe ""               >/dev/null 2>&1; then ok "rejected empty";         else bad "should have rejected"; fi
  echo "[3] assert_temp_db_safe must accept valid pattern"
  if assert_temp_db_safe "w3forge_restore_test_20260521_113000_12345"; then ok "accepted well-formed name"; else bad "should have accepted"; fi
  echo "[4] assert_temp_db_safe must reject prod db name"
  if ! assert_temp_db_safe "w3forge" >/dev/null 2>&1;       then ok "rejected 'w3forge'"; else bad "should have rejected"; fi
  echo "[5] assert_temp_db_safe must reject malformed names"
  if ! assert_temp_db_safe "w3forge_test" >/dev/null 2>&1;            then ok "rejected 'w3forge_test'";   else bad "should have rejected"; fi
  if ! assert_temp_db_safe "w3forge_restore_test_xyz" >/dev/null 2>&1; then ok "rejected non-numeric";    else bad "should have rejected"; fi
  if ! assert_temp_db_safe "" >/dev/null 2>&1;                        then ok "rejected empty";          else bad "should have rejected"; fi
  echo "[6] script must contain zero systemctl invocations"
  if grep -nE '^[[:space:]]*systemctl' "${BASH_SOURCE[0]}" >/dev/null; then
    bad "found a systemctl invocation"
  else
    ok "no systemctl invocations"
  fi
  echo "[7] script must contain zero sudo invocations"
  if grep -nE '^[[:space:]]*sudo[[:space:]]' "${BASH_SOURCE[0]}" >/dev/null; then
    bad "found a sudo invocation"
  else
    ok "no sudo invocations"
  fi
  echo "[8] script must not rm production paths"
  if grep -nE 'rm[[:space:]]+-r[fr]?[[:space:]]+(/opt/w3forge|/opt/w3forge-deploy|/opt/backups/w3forge)([[:space:]]|$)' "${BASH_SOURCE[0]}" >/dev/null; then
    bad "found rm targeting production paths"
  else
    ok "no rm against production paths"
  fi
  echo ""
  echo "Summary: OK=$COUNT_OK  WARN=$COUNT_WARN  FAIL=$COUNT_FAIL"
  if (( COUNT_FAIL > 0 )); then exit 1; fi
  exit 0
fi

# --- Resolve pair (auto or explicit) ---------------------------------------
APP_BACKUP=""; DB_BACKUP=""
if [[ -z "$ARG_APP" && -z "$ARG_DB" ]]; then
  if [[ ! -d "$BACKUP_DIR" ]]; then
    bad "$BACKUP_DIR does not exist; no pair to test"
    echo ""; echo "Summary: OK=$COUNT_OK  WARN=$COUNT_WARN  FAIL=$COUNT_FAIL"; exit 1
  fi
  declare -A AMAP=() DMAP=()
  shopt -s nullglob
  for f in "$BACKUP_DIR"/w3forge_app_*.tar.gz "$BACKUP_DIR"/w3forge_db_*.sql; do
    base="$(basename "$f")"
    token="$(extract_token "$base")"
    [[ -z "$token" ]] && continue
    if [[ "$base" =~ ^w3forge_app_ ]]; then AMAP[$token]="$f"; else DMAP[$token]="$f"; fi
  done
  shopt -u nullglob
  newest=""
  for k in "${!AMAP[@]}"; do
    [[ -n "${DMAP[$k]:-}" ]] || continue
    [[ -z "$newest" || "$k" > "$newest" ]] && newest="$k"
  done
  if [[ -z "$newest" ]]; then
    bad "no complete app+db backup pair found in $BACKUP_DIR"
    echo ""; echo "Summary: OK=$COUNT_OK  WARN=$COUNT_WARN  FAIL=$COUNT_FAIL"; exit 1
  fi
  APP_BACKUP="${AMAP[$newest]}"
  DB_BACKUP="${DMAP[$newest]}"
elif [[ -n "$ARG_APP" && -n "$ARG_DB" ]]; then
  APP_BACKUP="$ARG_APP"; DB_BACKUP="$ARG_DB"
else
  bad "must provide both <app> <db> or neither (got app=$ARG_APP db=$ARG_DB)"
  echo ""; echo "Summary: OK=$COUNT_OK  WARN=$COUNT_WARN  FAIL=$COUNT_FAIL"; exit 1
fi

echo "${C_INFO}restore-test-w3forge.sh${C_RST}"
echo "App backup: $APP_BACKUP"
echo "DB backup:  $DB_BACKUP"
echo "No-DB mode: $([[ $NO_DB -eq 1 ]] && echo yes || echo no)"
echo "Keep temp:  $([[ $KEEP_TEMP -eq 1 ]] && echo yes || echo no)"

# === Stage 1: backup-verify (prerequisite) =================================
hdr "Stage 1: backup-verify-w3forge.sh prerequisite"
VERIFY=""
if [[ -x "$SCRIPT_DIR/backup-verify-w3forge.sh" ]]; then
  VERIFY="$SCRIPT_DIR/backup-verify-w3forge.sh"
elif [[ -x "${W3_SCRIPTS_DIR}/backup-verify-w3forge.sh" ]]; then
  VERIFY="${W3_SCRIPTS_DIR}/backup-verify-w3forge.sh"
fi
if [[ -n "$VERIFY" ]]; then
  if "$VERIFY" "$APP_BACKUP" "$DB_BACKUP" >/dev/null 2>&1; then
    ok "backup-verify PASSED"
  else
    bad "backup-verify FAILED (re-run '$VERIFY $APP_BACKUP $DB_BACKUP' for details)"
    echo ""; echo "Summary: OK=$COUNT_OK  WARN=$COUNT_WARN  FAIL=$COUNT_FAIL"; exit 1
  fi
else
  warn "backup-verify-w3forge.sh not found alongside this script; skipping prerequisite"
fi

# === Stage 2: scratch dir ==================================================
hdr "Stage 2: scratch directory"
TEST_DIR="$(mktemp -d -t w3forge-restoretest-XXXXXX 2>/dev/null || mktemp -d "/tmp/w3forge-restoretest-XXXXXX")"
if ! assert_temp_dir_safe "$TEST_DIR"; then
  bad "scratch directory failed safety assertion: $TEST_DIR"
  echo ""; echo "Summary: OK=$COUNT_OK  WARN=$COUNT_WARN  FAIL=$COUNT_FAIL"; exit 1
fi
ok "scratch directory created: $TEST_DIR"

# Disk-space pre-check (warn only)
if command -v df >/dev/null 2>&1; then
  ASIZE=$(stat -c %s "$APP_BACKUP" 2>/dev/null || echo 0)
  DSIZE=$(stat -c %s "$DB_BACKUP"  2>/dev/null || echo 0)
  NEED=$(( (ASIZE + DSIZE) * 2 / 1024 ))  # KB
  AVAIL=$(df -kP /tmp 2>/dev/null | awk 'NR==2 {print $4}')
  if [[ -n "$AVAIL" && "$AVAIL" -gt 0 && "$NEED" -gt 0 ]]; then
    if (( AVAIL < NEED )); then
      warn "tight on /tmp space: avail=${AVAIL}KB, need~${NEED}KB"
    else
      ok "disk space OK (avail=${AVAIL}KB on /tmp, need~${NEED}KB)"
    fi
  fi
fi

# Set up cleanup trap now that we have a scratch dir.
TEMP_DB_NAME=""
PSQL_AUTH=""
cleanup() {
  set +e
  if [[ $KEEP_TEMP -eq 0 ]]; then
    if [[ -n "$TEMP_DB_NAME" && -n "$PSQL_AUTH" ]]; then
      drop_temp_db || true
    fi
    if [[ -n "$TEST_DIR" && -d "$TEST_DIR" ]]; then
      # Final sanity: refuse rm -rf unless still under /tmp/
      case "$TEST_DIR" in
        /tmp/*) rm -rf "$TEST_DIR" ;;
        *) echo "[cleanup] refusing to rm $TEST_DIR (not under /tmp)" >&2 ;;
      esac
    fi
  else
    echo "[cleanup] --keep-temp: leaving $TEST_DIR and DB $TEMP_DB_NAME in place"
  fi
}
trap cleanup EXIT

# === Stage 3: app extract + sanity =========================================
hdr "Stage 3: app tarball extract + sanity"
mkdir -p "$TEST_DIR/app"
w3forge_verify_archive "$APP_BACKUP" || exit 3
if tar -xzf "$APP_BACKUP" -C "$TEST_DIR/app" >/dev/null 2>&1; then
  ok "extracted app tarball into $TEST_DIR/app"
else
  bad "failed to extract $APP_BACKUP"
  echo ""; echo "Summary: OK=$COUNT_OK  WARN=$COUNT_WARN  FAIL=$COUNT_FAIL"; exit 1
fi

# Locate VERSION inside the extracted tree (runtime layout: opt/w3forge/VERSION)
VERSION_FILE=""
for candidate in \
  "$TEST_DIR/app/opt/w3forge/VERSION" \
  "$TEST_DIR/app/w3forge/VERSION" \
  "$TEST_DIR/app/VERSION"; do
  if [[ -f "$candidate" ]]; then VERSION_FILE="$candidate"; break; fi
done
if [[ -n "$VERSION_FILE" ]]; then
  V="$(tr -d '[:space:]' < "$VERSION_FILE")"
  ok "VERSION found: $V ($VERSION_FILE)"
else
  bad "no VERSION file found in extracted tree"
fi

# Locate scripts/ dir and bash -n all .sh files
SCRIPTS_TREE=""
for candidate in \
  "$TEST_DIR/app/opt/w3forge/scripts" \
  "$TEST_DIR/app/w3forge/scripts" \
  "$TEST_DIR/app/scripts"; do
  if [[ -d "$candidate" ]]; then SCRIPTS_TREE="$candidate"; break; fi
done
if [[ -n "$SCRIPTS_TREE" ]]; then
  fail=0
  for f in "$SCRIPTS_TREE"/*.sh; do
    [[ -f "$f" ]] || continue
    bash -n "$f" 2>/dev/null || { bad "syntax error in extracted script: $(basename "$f")"; fail=1; }
  done
  (( fail == 0 )) && ok "all extracted scripts/*.sh parse cleanly"
else
  warn "no scripts/ dir found in extracted tree"
fi

# === Stage 4: DB restore into temp DB ======================================
hdr "Stage 4: DB restore into temporary database"
if [[ $NO_DB -eq 1 ]]; then
  warn "--no-db requested; skipping DB stage"
else
  # Reuse v0.4.7 auth chain: env -> direct -> su - postgres
  DB_HOST="$DB_HOST_DEFAULT"; DB_USER="$DB_USER_DEFAULT"; DB_PASSWORD="${PGPASSWORD:-}"

  # Probe an auth path that can actually run SQL against a placeholder DB.
  # We use 'postgres' as the probe target (always exists). The PROD w3forge
  # database is NEVER touched by this script.
  PSQL_AUTH=""
  if [[ -n "$DB_PASSWORD" ]] && PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -U "$DB_USER" -d postgres -tAc 'SELECT 1' >/dev/null 2>&1; then
    PSQL_AUTH="env"
  elif psql -h "$DB_HOST" -U "$DB_USER" -d postgres -tAc 'SELECT 1' >/dev/null 2>&1; then
    PSQL_AUTH="direct"
  elif command -v su >/dev/null 2>&1 && su - postgres -c 'psql -d postgres -tAc "SELECT 1"' >/dev/null 2>&1; then
    PSQL_AUTH="su"
  fi
  if [[ -z "$PSQL_AUTH" ]]; then
    warn "no working psql auth path (.env/direct/su); skipping DB stage"
  else
    ok "psql auth path: $PSQL_AUTH"
    psql_admin() {
      # Run SQL against the 'postgres' db (used to CREATE/DROP the temp db).
      local sql="$1"
      case "$PSQL_AUTH" in
        env)    PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -U "$DB_USER" -d postgres -v ON_ERROR_STOP=1 -tAc "$sql" 2>&1 ;;
        direct) psql -h "$DB_HOST" -U "$DB_USER" -d postgres -v ON_ERROR_STOP=1 -tAc "$sql" 2>&1 ;;
        su)     su - postgres -c "psql -d postgres -v ON_ERROR_STOP=1 -tAc \"$sql\"" 2>&1 ;;
      esac
    }
    psql_temp_query() {
      # Read-only query against the temp DB by name.
      local sql="$1"
      case "$PSQL_AUTH" in
        env)    PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -U "$DB_USER" -d "$TEMP_DB_NAME" -tAc "$sql" 2>/dev/null ;;
        direct) psql -h "$DB_HOST" -U "$DB_USER" -d "$TEMP_DB_NAME" -tAc "$sql" 2>/dev/null ;;
        su)     su - postgres -c "psql -d \"$TEMP_DB_NAME\" -tAc \"$sql\"" 2>/dev/null ;;
      esac
    }
    psql_temp_restore() {
      # Run the dump against the temp DB.
      local dump="$1"
      case "$PSQL_AUTH" in
        env)    PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -U "$DB_USER" -d "$TEMP_DB_NAME" -v ON_ERROR_STOP=1 -f "$dump" 2>&1 ;;
        direct) psql -h "$DB_HOST" -U "$DB_USER" -d "$TEMP_DB_NAME" -v ON_ERROR_STOP=1 -f "$dump" 2>&1 ;;
        su)     # su path: pipe the dump through stdin since postgres user may not be able to read /opt/backups/w3forge
                cat "$dump" | su - postgres -c "psql -d \"$TEMP_DB_NAME\" -v ON_ERROR_STOP=1" 2>&1 ;;
      esac
    }
    drop_temp_db() {
      [[ -n "$TEMP_DB_NAME" ]] || return 0
      assert_temp_db_safe "$TEMP_DB_NAME" >/dev/null || { echo "REFUSE drop $TEMP_DB_NAME"; return 1; }
      psql_admin "DROP DATABASE IF EXISTS \"$TEMP_DB_NAME\"" >/dev/null 2>&1 || true
    }

    # Generate temp DB name and assert safe.
    TEMP_DB_NAME="w3forge_restore_test_$(date -u +%Y%m%d_%H%M%S)_$$"
    if ! assert_temp_db_safe "$TEMP_DB_NAME"; then
      bad "temp db name failed safety assertion: $TEMP_DB_NAME"
      TEMP_DB_NAME=""
    else
      ok "temp db name: $TEMP_DB_NAME"

      # Attempt to create.
      create_out="$(psql_admin "CREATE DATABASE \"$TEMP_DB_NAME\" TEMPLATE template0 ENCODING 'UTF8'" 2>&1 || true)"
      if grep -q 'permission denied\|must be owner\|CREATEDB' <<<"$create_out"; then
        warn "role lacks CREATEDB privilege; skipping DB restore stage"
        TEMP_DB_NAME=""
      elif grep -qiE 'error|fatal' <<<"$create_out"; then
        bad "failed to create temp DB: $create_out"
        TEMP_DB_NAME=""
      else
        ok "created temp database"

        # Restore dump.
        restore_out="$(psql_temp_restore "$DB_BACKUP" 2>&1 || true)"
        if grep -qiE 'error|fatal' <<<"$restore_out"; then
          # Show first 5 problem lines
          bad "errors during dump restore:"
          grep -iE 'error|fatal' <<<"$restore_out" | head -5 | sed 's/^/      /'
        else
          ok "restored dump into temp DB"
        fi

        # Sanity queries.
        tcount="$(psql_temp_query "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public'")"
        tcount="${tcount// /}"
        if [[ "$tcount" =~ ^[0-9]+$ ]]; then
          if (( tcount >= EXPECTED_TABLE_COUNT )); then
            ok "public schema has $tcount tables (>= $EXPECTED_TABLE_COUNT expected)"
          else
            warn "public schema has only $tcount tables (expected >= $EXPECTED_TABLE_COUNT)"
          fi
        else
          warn "could not count tables in temp DB (got: '$tcount')"
        fi

        TABLE_IN_LIST="$(printf "'%s'," "${REQUIRED_TABLES[@]}")"
        TABLE_IN_LIST="${TABLE_IN_LIST%,}"
        existing_list="$(psql_temp_query "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ($TABLE_IN_LIST) ORDER BY table_name")"
        declare -A found=()
        while IFS= read -r ln; do
          ln="${ln// /}"; [[ -z "$ln" ]] && continue
          found[$ln]=1
        done <<<"$existing_list"
        miss=0
        for t in "${REQUIRED_TABLES[@]}"; do
          if [[ -z "${found[$t]:-}" ]]; then miss=$((miss+1)); fi
        done
        if (( miss == 0 )); then
          ok "all ${EXPECTED_TABLE_COUNT} W3 Forge tables present in restored temp DB"
        else
          bad "$miss of ${EXPECTED_TABLE_COUNT} W3 Forge tables missing in restored temp DB"
        fi

        pgv="$(psql_temp_query 'SELECT version()' | head -1 | tr -d '\n')"
        [[ -n "$pgv" ]] && echo "  server: $pgv"
      fi
    fi
  fi
fi

# --- Summary ---------------------------------------------------------------
echo ""
echo "${C_INFO}== Summary ==${C_RST}"
echo "  OK   : $COUNT_OK"
echo "  WARN : $COUNT_WARN"
echo "  FAIL : $COUNT_FAIL"

if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi

if (( COUNT_FAIL > 0 )); then
  echo ""
  echo "${C_FAIL}[FAIL]${C_RST} Restore test FAILED"
  exit 1
fi
echo ""
echo "${C_OK}[OK]${C_RST}   Restore test PASSED"
exit 0
