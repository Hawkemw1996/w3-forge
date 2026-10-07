#!/usr/bin/env bash
# App ownership and capability checks run before logging or any operation.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_w3forge-policy.sh"
w3forge_guard_script "${BASH_SOURCE[0]##*/}" "$@"
#
# backup-verify-w3forge.sh
#
# 100% read-only pre-flight verifier for a W3 Forge backup pair.
# Does NOT extract files, does NOT touch any database, does NOT
# modify production. The hard work (extraction + DB restore against a
# temporary database) lives in restore-test-w3forge.sh.
#
# Filename convention (locked to backup-w3forge.sh, v0.4.4+):
#   w3forge_app_YYYY-MM-DD_HH-MM-SS.tar.gz
#   w3forge_db_YYYY-MM-DD_HH-MM-SS.sql
#
# Usage:
#   backup-verify-w3forge.sh                       Verify newest local pair
#   backup-verify-w3forge.sh <app.tar.gz>          Verify the named app backup + auto-resolve its db
#   backup-verify-w3forge.sh <app.tar.gz> <db.sql> Verify explicit pair (5-min tolerance)
#   backup-verify-w3forge.sh help
#
# Seven checks (each OK / WARN / FAIL):
#   1. App tarball readable and non-empty
#   2. App tarball lists cleanly (tar -tzf)
#   3. DB backup exists, non-empty, looks like plain pg_dump SQL
#   4. Timestamp alignment (exact match for auto-pair; <= 5 min drift for explicit)
#   5. File sizes are sane (>= 1 KiB hard floor; <10 KiB triggers WARN)
#   6. No forbidden paths inside app tarball (.env, .git/, node_modules/,
#      nested opt/w3forge/backups/, backend/dist/, frontend/admin/dist/)
#   7. App tarball contains expected runtime layout (opt/w3forge/VERSION etc.)
#
# Exit codes:
#   0 on PASS, 1 on any FAIL.
#
# Logs to /opt/logs/w3forge/backup/.

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
PAIR_TOLERANCE_SECONDS="${W3_PAIR_TOLERANCE_SECONDS:-300}"  # 5 minutes
SIZE_FLOOR_BYTES=1024            # below this = FAIL
SIZE_WARN_BYTES=10240            # below this = WARN

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
  sed -n '3,32p' "${BASH_SOURCE[0]}" | sed 's/^# //; s/^#//'
}

# --- Filename pattern + helpers --------------------------------------------
RE_TOKEN='[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{2}-[0-9]{2}-[0-9]{2}'

extract_token() {
  local base; base="$(basename "$1")"
  if [[ "$base" =~ ^w3forge_(app|db)_(${RE_TOKEN}) ]]; then
    echo "${BASH_REMATCH[2]}"
  fi
}

token_to_epoch() {
  # YYYY-MM-DD_HH-MM-SS -> YYYY-MM-DD HH:MM:SS
  local t="$1"
  local d="${t%_*}"
  local h="${t#*_}"
  h="${h//-/:}"
  date -d "$d $h" +%s 2>/dev/null
}

# --- Pair resolution -------------------------------------------------------
APP_BACKUP=""
DB_BACKUP=""
PAIR_MODE=""  # "auto" | "explicit-app" | "explicit-pair"

resolve_pair() {
  local a="${1:-}" b="${2:-}"
  if [[ -z "$a" && -z "$b" ]]; then
    PAIR_MODE="auto"
    if [[ ! -d "$BACKUP_DIR" ]]; then
      bad "$BACKUP_DIR does not exist; cannot auto-resolve pair"; return 1
    fi
    # Build map: token -> app, token -> db; pick newest token with both
    declare -A AMAP=() DMAP=()
    local f base token type
    shopt -s nullglob
    for f in "$BACKUP_DIR"/w3forge_app_*.tar.gz "$BACKUP_DIR"/w3forge_db_*.sql; do
      base="$(basename "$f")"
      token="$(extract_token "$base")"
      [[ -z "$token" ]] && continue
      if [[ "$base" =~ ^w3forge_app_ ]]; then AMAP[$token]="$f"; else DMAP[$token]="$f"; fi
    done
    shopt -u nullglob
    local newest=""
    for k in "${!AMAP[@]}"; do
      [[ -n "${DMAP[$k]:-}" ]] || continue
      [[ -z "$newest" || "$k" > "$newest" ]] && newest="$k"
    done
    if [[ -z "$newest" ]]; then
      bad "no complete app+db backup pair found in $BACKUP_DIR"
      return 1
    fi
    APP_BACKUP="${AMAP[$newest]}"
    DB_BACKUP="${DMAP[$newest]}"
    return 0
  fi
  if [[ -n "$a" && -z "$b" ]]; then
    PAIR_MODE="explicit-app"
    APP_BACKUP="$a"
    local atoken; atoken="$(extract_token "$a")"
    if [[ -z "$atoken" ]]; then
      bad "cannot extract timestamp token from app filename: $(basename "$a")"
      return 1
    fi
    # Auto-find db partner in same directory
    local adir; adir="$(dirname "$a")"
    DB_BACKUP="$adir/w3forge_db_${atoken}.sql"
    if [[ ! -f "$DB_BACKUP" ]]; then
      bad "no db partner found for token $atoken (looked for $DB_BACKUP)"
      return 1
    fi
    return 0
  fi
  # Both provided
  PAIR_MODE="explicit-pair"
  APP_BACKUP="$a"; DB_BACKUP="$b"
  return 0
}

# --- Main ------------------------------------------------------------------
case "${1:-}" in
  help|-h|--help) usage; exit 0 ;;
esac

echo "${C_INFO}backup-verify-w3forge.sh${C_RST}"
echo "BACKUP_DIR: $BACKUP_DIR"

if ! resolve_pair "${1:-}" "${2:-}"; then
  echo ""
  echo "Summary: OK=$COUNT_OK  WARN=$COUNT_WARN  FAIL=$COUNT_FAIL"
  exit 1
fi

echo "Pair mode: $PAIR_MODE"
echo "App backup: $APP_BACKUP"
echo "DB backup:  $DB_BACKUP"

# === Check 1: app tarball readable + non-empty =============================
hdr "Check 1: app tarball readable and non-empty"
if [[ ! -f "$APP_BACKUP" ]]; then
  bad "app backup not found: $APP_BACKUP"
elif [[ ! -r "$APP_BACKUP" ]]; then
  bad "app backup not readable: $APP_BACKUP"
elif [[ ! -s "$APP_BACKUP" ]]; then
  bad "app backup is empty: $APP_BACKUP"
else
  ok "app backup exists and is non-empty"
fi

# === Check 2: tar -tzf clean ===============================================
hdr "Check 2: app tarball lists cleanly"
APP_LIST=""
if [[ -s "$APP_BACKUP" ]]; then
  if APP_LIST="$(tar -tzf "$APP_BACKUP" 2>/dev/null)"; then
    local_count=$(echo "$APP_LIST" | wc -l)
    ok "tar -tzf succeeded ($local_count entries)"
  else
    bad "tar -tzf failed; archive is corrupt or not gzipped"
  fi
else
  warn "skipping (Check 1 failed)"
fi

# === Check 3: db backup exists + looks like plain SQL ======================
hdr "Check 3: db backup exists, non-empty, looks like plain pg_dump SQL"
if [[ ! -f "$DB_BACKUP" ]]; then
  bad "db backup not found: $DB_BACKUP"
elif [[ ! -r "$DB_BACKUP" ]]; then
  bad "db backup not readable: $DB_BACKUP"
elif [[ ! -s "$DB_BACKUP" ]]; then
  bad "db backup is empty: $DB_BACKUP"
else
  # First 4 KiB sniff
  head_bytes="$(head -c 4096 "$DB_BACKUP" 2>/dev/null || true)"
  if   grep -q '^-- PostgreSQL database dump' <<<"$head_bytes"; then
    ok "db backup is plain pg_dump SQL (header detected)"
  elif grep -q '^SET '                       <<<"$head_bytes"; then
    ok "db backup looks like plain SQL (SET ... lines detected)"
  elif grep -q '^\\connect'                  <<<"$head_bytes"; then
    ok "db backup looks like plain SQL (\\connect detected)"
  elif printf '%s' "$head_bytes" | head -c 5 | grep -q '^PGDMP'; then
    bad "db backup is pg_dump custom format (-Fc) but backup-w3forge.sh emits plain SQL; format mismatch"
  else
    warn "db backup does not match known plain-SQL signatures; restore may still work"
  fi
fi

# === Check 4: timestamp alignment ==========================================
hdr "Check 4: timestamp alignment"
ATOKEN="$(extract_token "$APP_BACKUP")"
DTOKEN="$(extract_token "$DB_BACKUP")"
if [[ -z "$ATOKEN" || -z "$DTOKEN" ]]; then
  bad "cannot extract timestamp tokens (app=$ATOKEN db=$DTOKEN)"
elif [[ "$ATOKEN" == "$DTOKEN" ]]; then
  ok "exact timestamp match: $ATOKEN"
else
  AE=$(token_to_epoch "$ATOKEN" 2>/dev/null || echo "")
  DE=$(token_to_epoch "$DTOKEN" 2>/dev/null || echo "")
  if [[ -z "$AE" || -z "$DE" ]]; then
    bad "cannot parse tokens to epoch (app=$ATOKEN db=$DTOKEN)"
  else
    DRIFT=$(( AE - DE )); DRIFT=${DRIFT#-}
    if (( DRIFT <= PAIR_TOLERANCE_SECONDS )); then
      if [[ "$PAIR_MODE" == "explicit-pair" ]]; then
        ok "timestamps within tolerance: drift=${DRIFT}s, tolerance=${PAIR_TOLERANCE_SECONDS}s"
      else
        warn "timestamps differ by ${DRIFT}s (auto-resolved should be exact)"
      fi
    else
      bad "timestamps differ by ${DRIFT}s (> ${PAIR_TOLERANCE_SECONDS}s tolerance)"
    fi
  fi
fi

# === Check 5: file-size sanity =============================================
hdr "Check 5: file-size sanity"
ASIZE=0; DSIZE=0
[[ -f "$APP_BACKUP" ]] && ASIZE=$(stat -c %s "$APP_BACKUP")
[[ -f "$DB_BACKUP"  ]] && DSIZE=$(stat -c %s "$DB_BACKUP")
for pair in "app:$ASIZE:$APP_BACKUP" "db:$DSIZE:$DB_BACKUP"; do
  IFS=':' read -r kind sz path <<<"$pair"
  base="$(basename "$path")"
  if (( sz < SIZE_FLOOR_BYTES )); then
    bad "$kind backup is suspiciously tiny: $base ($sz bytes < $SIZE_FLOOR_BYTES)"
  elif (( sz < SIZE_WARN_BYTES )); then
    warn "$kind backup is small: $base ($sz bytes < $SIZE_WARN_BYTES)"
  else
    ok "$kind backup size OK: $base ($sz bytes)"
  fi
done

# === Check 6: forbidden paths in app tarball ===============================
# v0.4.9: explicitly rejects opt/w3forge/backups/ as a regression guard against
# the pre-v0.4.9 unfiltered tar that produced recursive in-tree backup history.
# Also rejects backend/dist/ and frontend/admin/dist/ which the v0.4.9 producer now
# excludes. The producer (backup-w3forge.sh) and verifier MUST agree on this
# list.
hdr "Check 6: no forbidden paths in app tarball"
if [[ -n "$APP_LIST" ]]; then
  forbidden_hits="$(grep -E '(^|/)\.env(/|$)|(^|/)\.git(/|$)|(^|/)node_modules/|(^|/)opt/w3forge/backups(/|$)|(^|/)backend/dist(/|$)|(^|/)frontend/admin/dist(/|$)' <<<"$APP_LIST" || true)"
  if [[ -n "$forbidden_hits" ]]; then
    bad "forbidden paths inside app tarball:"
    echo "$forbidden_hits" | head -5 | sed 's/^/      /'
    extra=$(echo "$forbidden_hits" | wc -l)
    if (( extra > 5 )); then echo "      ... and $(( extra - 5 )) more"; fi
  else
    ok "no .env / .git / node_modules / nested backups / dist entries inside app tarball"
  fi
else
  warn "skipping (no app listing available)"
fi

# === Check 7: expected runtime layout ======================================
hdr "Check 7: app tarball contains expected runtime layout"
if [[ -n "$APP_LIST" ]]; then
  # backup-w3forge.sh runs `tar -czf ... /opt/w3forge`, so entries are under `opt/w3forge/`.
  EXPECT=(
    "opt/w3forge/VERSION"
    "opt/w3forge/package.json"
    "opt/w3forge/scripts/"
  )
  for needed in "${EXPECT[@]}"; do
    # Accept both with-slash and without-slash directory entries
    if grep -qE "(^|/)${needed//\//\\/}$" <<<"$APP_LIST" || grep -qE "(^|/)${needed%/}\$" <<<"$APP_LIST"; then
      ok "found: $needed"
    else
      warn "expected entry not found: $needed"
    fi
  done
else
  warn "skipping (no app listing available)"
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
  echo "${C_FAIL}[FAIL]${C_RST} Backup verification FAILED for pair $(basename "$APP_BACKUP") + $(basename "$DB_BACKUP")"
  exit 1
fi
echo ""
echo "${C_OK}[OK]${C_RST}   Backup verification PASSED for pair $(basename "$APP_BACKUP") + $(basename "$DB_BACKUP")"
exit 0
