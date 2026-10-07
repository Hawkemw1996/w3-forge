#!/usr/bin/env bash
# App ownership and capability checks run before logging or any operation.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_w3forge-policy.sh"
w3forge_guard_script "${BASH_SOURCE[0]##*/}" "$@"
w3forge_database_env
# =============================================================================
# migrate-w3forge.sh — apply W3 Forge database migrations.
# =============================================================================
#
# Fresh install and upgrade use the same command: the ledger
# (public.schema_migrations) records each applied migration with its sha256
# checksum, so already-applied files are skipped and edited released files
# fail closed. Each migration runs in its own transaction together with its
# ledger row. Forward-only; there are no down migrations.
#
# This script never seeds data and never touches any database other than
# w3forge (or w3forge_test* / w3forge_dev*). It refuses w3core.
#
# Usage:
#   scripts/migrate-w3forge.sh [--verify-only] [-h HOST] [-p PORT] [-U USER] [-d DB]
# Defaults: -h "$W3_DB_HOST" -U "$W3_DB_USER" -d "$W3_DB_NAME". Authentication
# uses ~/.pgpass or PGPASSWORD from the caller's environment; the script
# never prints credentials.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$W3_FORGE_ROOT" && pwd)"
MIGRATIONS_DIR="${W3FORGE_MIGRATIONS_DIR:-$REPO_ROOT/database/migrations}"

info() { echo "  [INFO] $*"; }
ok()   { echo "  [OK]   $*"; }
warn() { echo "  [WARN] $*" >&2; }
die()  { echo "  [FAIL] $1" >&2; exit "${2:-1}"; }

# shellcheck source=_w3forge-migration-ledger.sh
source "$SCRIPT_DIR/_w3forge-migration-ledger.sh"

HOST="$W3_DB_HOST"; PORT="${PGPORT:-}"; USER_NAME="$W3_DB_USER"; DB="$W3_DB_NAME"; VERIFY_ONLY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h) HOST="$2"; shift 2 ;;
    -p) PORT="$2"; shift 2 ;;
    -U) USER_NAME="$2"; shift 2 ;;
    -d) DB="$2"; shift 2 ;;
    --verify-only) VERIFY_ONLY=1; shift ;;
    --help) sed -n '2,20p' "$0"; exit 0 ;;
    *) die "Unknown argument: $1" 2 ;;
  esac
done

command -v psql >/dev/null 2>&1 || die "psql is not installed." 3
conn=(-h "$HOST" -U "$USER_NAME" -d "$DB")
[[ -n "$PORT" ]] && conn=(-h "$HOST" -p "$PORT" -U "$USER_NAME" -d "$DB")

w3ledger_assert_target "${conn[@]}"
info "Target: database ${DB} on ${HOST}${PORT:+:$PORT} as ${USER_NAME}"
if [[ $VERIFY_ONLY -eq 0 ]]; then
  w3ledger_ensure_table "${conn[@]}"
  w3ledger_apply_migrations "$MIGRATIONS_DIR" "${conn[@]}"
fi
w3ledger_verify_required_tables "${conn[@]}"
ok "W3 Forge database is at the current schema."
