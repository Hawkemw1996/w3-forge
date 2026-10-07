#!/usr/bin/env bash
# =============================================================================
# _w3forge-migration-ledger.sh — shared migration ledger helper.
# =============================================================================
#
# W3 Forge v0.3.0. Adapted from W3 Core v0.12.11
# (scripts/_w3core-migration-ledger.sh, commit 83e7750). Sourced, not
# executed, by:
#   * scripts/deploy-w3forge-noninteractive.sh (UI / pipeline)
#   * scripts/deploy-w3forge.sh                (interactive operator)
#   * scripts/migrate-w3forge.sh               (fresh install / local dev)
#
# Differences from the W3 Core helper (deliberate):
#   * No historical baseline step. W3 Forge has its own migration history
#     starting at 001; there is no pre-ledger schema to adopt. A ledger row
#     with a NULL checksum is therefore never legitimate here and fails closed.
#   * Each migration and its ledger row are applied in ONE transaction
#     (psql --single-transaction). A failed migration leaves neither schema
#     changes nor a ledger row behind.
#   * Migrations must be named NNN_snake_case.sql. Anything else in the
#     directory fails closed instead of being silently skipped or applied.
#
# Ledger table (same shape as W3 Core):
#   public.schema_migrations (migration_name TEXT PRIMARY KEY,
#                             checksum TEXT, applied_at TIMESTAMPTZ)
#
# Forward-only: there is no "down" migration. Rolling back application code
# does not roll back the database; restore a backup for that (see
# docs/DATABASE.md).
#
# Every function takes the psql connection arguments as trailing "$@"
# (for example: -h "$W3_DB_HOST" -U "$W3_DB_USER" -d "$W3_DB_NAME").
# =============================================================================

if [[ "${_W3LEDGER_SH_LOADED:-0}" == "1" ]]; then
  return 0
fi
_W3LEDGER_SH_LOADED=1

_w3ledger_info() { if declare -F info >/dev/null 2>&1; then info "$*"; else echo "  [INFO] $*"; fi }
_w3ledger_ok()   { if declare -F ok   >/dev/null 2>&1; then ok   "$*"; else echo "  [OK]   $*"; fi }
_w3ledger_warn() { if declare -F warn >/dev/null 2>&1; then warn "$*"; else echo "  [WARN] $*" >&2; fi }
_w3ledger_die()  {
  local msg="$1"
  if declare -F die >/dev/null 2>&1; then
    die "$msg" 1
  elif declare -F fail >/dev/null 2>&1; then
    fail "$msg"
  else
    echo "  [FAIL] $msg" >&2
    exit 1
  fi
}

# Refuse to run against the W3 Core database or any database other than the
# one W3 Forge owns (or an explicitly test-named database).
w3ledger_assert_target() {
  local db=""
  local prev=""
  for arg in "$@"; do
    if [[ "$prev" == "-d" ]]; then db="$arg"; fi
    prev="$arg"
  done
  case "$db" in
    w3forge|w3forge_*) [[ "$db" =~ ^w3forge(_[a-z0-9_]+)?$ ]] || _w3ledger_die "Invalid Forge database name." ;;
    "") _w3ledger_die "Migration target database not specified (-d)." ;;
    *) _w3ledger_die "Refusing to migrate database '${db}': W3 Forge only migrates w3forge (or w3forge_test*/w3forge_dev*)." ;;
  esac
}

w3ledger_ensure_table() {
  w3ledger_assert_target "$@"
  local ddl
  ddl="CREATE TABLE IF NOT EXISTS public.schema_migrations (
         migration_name TEXT PRIMARY KEY,
         checksum       TEXT,
         applied_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
       );"
  if ! psql "$@" -v ON_ERROR_STOP=1 -q -c "$ddl" >/dev/null; then
    _w3ledger_die "Ledger bootstrap failed (could not ensure public.schema_migrations exists)."
  fi
}

# Kept for call-site compatibility with the W3 Core deploy runners. W3 Forge
# has no pre-ledger history, so there is nothing to baseline.
w3ledger_bootstrap_baseline() {
  _w3ledger_info "Baseline: not applicable (W3 Forge has no pre-ledger migration history)."
}

w3ledger_apply_migrations() {
  local migrations_dir="$1"
  shift
  local -a conn=("$@")
  w3ledger_assert_target "${conn[@]}"

  if [[ ! -d "$migrations_dir" ]]; then
    _w3ledger_die "No migrations directory at ${migrations_dir}"
  fi

  shopt -s nullglob
  local -a all_files=("$migrations_dir"/*)
  local -a migration_files=("$migrations_dir"/*.sql)
  shopt -u nullglob
  if [[ ${#migration_files[@]} -eq 0 ]]; then
    _w3ledger_die "No SQL migrations found in ${migrations_dir}"
  fi
  local f
  for f in "${all_files[@]}"; do
    local b
    b="$(basename "$f")"
    if [[ "$b" == "README.md" ]]; then continue; fi
    if [[ ! "$b" =~ ^[0-9]{3}_[a-z0-9_]+\.sql$ ]]; then
      _w3ledger_die "Unexpected file in migrations directory: ${b} (expected NNN_snake_case.sql)."
    fi
  done

  IFS=$'\n' migration_files=($(printf '%s\n' "${migration_files[@]}" | sort))
  unset IFS

  local applied=0 skipped=0
  local mig mig_name mig_name_sql ledger_row disk_sum
  for mig in "${migration_files[@]}"; do
    mig_name="$(basename "$mig")"
    mig_name_sql="${mig_name//\'/\'\'}"

    if ! ledger_row="$(psql "${conn[@]}" -v ON_ERROR_STOP=1 -tAc \
      "SELECT COALESCE(checksum,'__NULL__') FROM public.schema_migrations WHERE migration_name='${mig_name_sql}';")"; then
      _w3ledger_die "Could not read the migration ledger."
    fi
    disk_sum="$(sha256sum "$mig" | awk '{print $1}')"

    if [[ -n "$ledger_row" ]]; then
      if [[ "$ledger_row" == "__NULL__" ]]; then
        _w3ledger_die "Migration ${mig_name} has a NULL ledger checksum. W3 Forge always records checksums; refusing to proceed."
      fi
      if [[ "$ledger_row" != "$disk_sum" ]]; then
        _w3ledger_die "Migration ${mig_name} checksum mismatch: ledger=${ledger_row} disk=${disk_sum}. Released migrations are immutable; refusing to proceed."
      fi
      _w3ledger_info "Skipping ${mig_name} (already applied per schema_migrations ledger)."
      skipped=$((skipped + 1))
      continue
    fi

    _w3ledger_info "Running migration ${mig_name}"
    if ! psql "${conn[@]}" -v ON_ERROR_STOP=1 -q --single-transaction \
        -f "$mig" \
        -c "INSERT INTO public.schema_migrations (migration_name, checksum) VALUES ('${mig_name_sql}', '${disk_sum}');" >/dev/null; then
      _w3ledger_die "Migration failed: ${mig_name} (transaction rolled back; no ledger row written)."
    fi
    applied=$((applied + 1))
  done
  _w3ledger_ok "Migrations processed: applied=${applied}, skipped=${skipped} (ledger-aware)."
}

# Tables a migrated W3 Forge database must contain. Kept identical to
# backend/src/db/requiredSchema.ts REQUIRED_TABLES (a backend test enforces it).
W3FORGE_REQUIRED_TABLES=(
  schema_migrations audit_events platform_config production_cutover_record
)

# Post-migration check: every required Forge table exists.
w3ledger_verify_required_tables() {
  local -a conn=("$@")
  w3ledger_assert_target "${conn[@]}"
  local have
  if ! have="$(psql "${conn[@]}" -v ON_ERROR_STOP=1 -tAc "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY 1;")"; then
    _w3ledger_die "Schema verification query failed."
  fi
  local t missing=0
  for t in "${W3FORGE_REQUIRED_TABLES[@]}"; do
    if ! grep -qx "$t" <<<"$have"; then
      _w3ledger_warn "Missing required table: $t"
      missing=1
    fi
  done
  [[ $missing -eq 0 ]] || _w3ledger_die "Required schema verification failed."
  _w3ledger_ok "Required W3 Forge tables verified (${#W3FORGE_REQUIRED_TABLES[@]})."
}
