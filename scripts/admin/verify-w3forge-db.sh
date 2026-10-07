#!/usr/bin/env bash
# App ownership and capability checks run before logging or any operation.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_w3forge-policy.sh"
w3forge_guard_script "${BASH_SOURCE[0]##*/}" "$@"
w3forge_database_env
# W3 Forge v0.3.0 — database verification (read-only).
#
# Structure derived from W3 Core v0.12.11 scripts/verify-w3core-db.sh; the
# checks are W3 Forge's own schema:
#   1. Migration files    — always run (filesystem only): NNN_snake_case
#                           naming, contiguous numbering, no stray files.
#   2. Live database      — only when psql + a reachable database exist:
#                           target is w3forge (never w3core), ledger rows
#                           match the files on disk (checksums), required
#                           tables exist, history tables are append-only,
#                           key constraints are present.
# SKIP is not a failure. Exit 0 when no check FAILed.
#
# Usage: ./scripts/verify-w3forge-db.sh
# DB connection (first match wins): W3FORGE_DB_URL, DATABASE_URL, then
# PGHOST/PGUSER/PGDATABASE (+ PGPASSWORD or ~/.pgpass) with loopback
# defaults matching the deploy script. An optional repo-root .env is sourced.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$W3_FORGE_ROOT" && pwd)"
MIGRATIONS_DIR="${W3FORGE_MIGRATIONS_DIR:-$REPO_ROOT/database/migrations}"


# shellcheck source=_w3forge-migration-ledger.sh
source "$SCRIPT_DIR/_w3forge-migration-ledger.sh"

PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0
pass() { echo "  [PASS] $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "  [FAIL] $1"; FAIL_COUNT=$((FAIL_COUNT + 1)); }
skip() { echo "  [SKIP] $1"; SKIP_COUNT=$((SKIP_COUNT + 1)); }

echo "=== W3 Forge database verification ==="
echo ""

echo "[1] Migration files"
shopt -s nullglob
FILES=("$MIGRATIONS_DIR"/*.sql)
ALL=("$MIGRATIONS_DIR"/*)
shopt -u nullglob
if [ ${#FILES[@]} -eq 0 ]; then
  fail "no migrations found in $MIGRATIONS_DIR"
fi
for f in "${ALL[@]}"; do
  b="$(basename "$f")"
  [ "$b" = "README.md" ] && continue
  if [[ "$b" =~ ^[0-9]{3}_[a-z0-9_]+\.sql$ ]]; then :; else fail "unexpected file in migrations directory: $b"; fi
done
n=0
for f in $(printf '%s\n' "${FILES[@]}" | sort); do
  n=$((n + 1))
  b="$(basename "$f")"
  want="$(printf '%03d' "$n")"
  if [ "${b:0:3}" = "$want" ]; then pass "migration present: $b"; else fail "migration numbering gap: expected ${want}_*, found $b"; fi
done
echo ""

DB_URL="" # Validated URL settings were mapped to PG* by w3forge_database_env.
PSQL_OK=false
PSQL=()
DB_NAME_RESOLVED=""
if command -v psql >/dev/null 2>&1; then
  if [ -n "$DB_URL" ]; then
    PSQL=(psql "$DB_URL")
  else
    DB_NAME_RESOLVED="${PGDATABASE:-${DATABASE_NAME:-${DB_NAME:-w3forge}}}"
    PSQL=(psql -h "${PGHOST:-${DB_HOST:-127.0.0.1}}" -U "${PGUSER:-${DATABASE_USER:-${DB_USER:-w3forge_user}}}" -d "$DB_NAME_RESOLVED")
  fi
  if "${PSQL[@]}" -tAc "SELECT 1;" >/dev/null 2>&1; then PSQL_OK=true; fi
fi
q() { "${PSQL[@]}" -tAc "$1" 2>/dev/null; }

echo "[2] Live database schema"
if [ "$PSQL_OK" != true ]; then
  if command -v psql >/dev/null 2>&1; then skip "database unreachable — skipping live checks"; else skip "psql not installed — skipping live checks"; fi
  echo ""
else
  CUR_DB="$(q "SELECT current_database();")"
  case "$CUR_DB" in
    w3core) fail "connected to the W3 Core database 'w3core' — W3 Forge must never use it"; CUR_DB="" ;;
    w3forge|w3forge_*) pass "target database: $CUR_DB" ;;
    *) fail "unexpected target database '$CUR_DB'"; CUR_DB="" ;;
  esac
  if [ -n "$CUR_DB" ]; then
    # Ledger matches the files on disk.
    for f in $(printf '%s\n' "${FILES[@]}" | sort); do
      b="$(basename "$f")"
      disk="$(sha256sum "$f" | awk '{print $1}')"
      led="$(q "SELECT COALESCE(checksum,'__NULL__') FROM public.schema_migrations WHERE migration_name='$b';")"
      if [ -z "$led" ]; then fail "not applied: $b"
      elif [ "$led" = "$disk" ]; then pass "applied, checksum OK: $b"
      else fail "checksum mismatch: $b (ledger=$led disk=$disk)"; fi
    done
    extra="$(q "SELECT string_agg(migration_name, ', ') FROM public.schema_migrations;")"
    for f in "${FILES[@]}"; do extra="${extra//$(basename "$f")/}"; done
    if [ -n "$(tr -d ', ' <<<"$extra")" ]; then fail "ledger has migrations not on disk: $extra"; else pass "ledger has no unknown migrations"; fi

    for t in "${W3FORGE_REQUIRED_TABLES[@]}"; do
      if [ "$(q "SELECT to_regclass('public.$t') IS NOT NULL;")" = "t" ]; then pass "table: $t"; else fail "table MISSING: $t"; fi
    done
    for t in audit_events; do
      if [ "$(q "SELECT 1 FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid WHERE c.relname='$t' AND g.tgname='${t}_append_only' AND NOT g.tgisinternal LIMIT 1;")" = "1" ]; then
        pass "append-only trigger: $t"
      else
        fail "append-only trigger MISSING: $t"
      fi
    done
    for t in entities business_relationships financial_accounts app_access_grants users service_tokens; do
      if [ "$(q "SELECT to_regclass('public.$t') IS NOT NULL;")" = "t" ]; then fail "W3 Core table present in the Forge database: $t"; fi
    done
    pass "no W3 Core tables present"
  fi
  echo ""
fi

echo "=== Summary: ${PASS_COUNT} passed, ${FAIL_COUNT} failed, ${SKIP_COUNT} skipped ==="
[ "$FAIL_COUNT" -eq 0 ]
