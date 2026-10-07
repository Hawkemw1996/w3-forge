#!/usr/bin/env bash
# App ownership and capability checks run before logging or any operation.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_w3forge-policy.sh"
w3forge_guard_script "${BASH_SOURCE[0]##*/}" "$@"
#
# backup-list-w3forge.sh
#
# 100% read-only inventory of W3 Forge backups (local + remote).
# Mirrors the v0.4.4 logging standard. Pairs app+db backups by the
# timestamp token in their filenames so the operator can see at a
# glance which backups are complete.
#
# Filename convention (locked to backup-w3forge.sh, v0.4.4+):
#   w3forge_app_YYYY-MM-DD_HH-MM-SS.tar.gz
#   w3forge_db_YYYY-MM-DD_HH-MM-SS.sql
#
# Subcommands:
#   backup-list-w3forge.sh             default: local + remote + pairs
#   backup-list-w3forge.sh local       local listing only
#   backup-list-w3forge.sh remote      remote listing only
#   backup-list-w3forge.sh pairs       paired view only
#   backup-list-w3forge.sh help
#
# Remote configuration (env-var only; defaults match backup-w3forge.sh):
#   W3_BACKUP_REMOTE_HOST   default: (not configured)
#   W3_BACKUP_REMOTE_PATH   default: (not configured)
#   W3_BACKUP_REMOTE_USER   default: backupuser
#
# Exit codes:
#   0  always, unless /opt/backups/w3forge exists but cannot be read.
#      (Empty /opt/backups/w3forge is reported as "no backups found", exit 0.)
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
REMOTE_HOST="${W3_BACKUP_REMOTE_HOST:-}"
REMOTE_PATH="${W3_BACKUP_REMOTE_PATH:-}"
REMOTE_USER="${W3_BACKUP_REMOTE_USER:-}"
SSH_TIMEOUT="${W3_SSH_CONNECT_TIMEOUT:-5}"

SUB="${1:-all}"

# --- Colors ----------------------------------------------------------------
if [[ -t 1 ]]; then
  C_OK=$'\033[0;32m'; C_WARN=$'\033[1;33m'; C_INFO=$'\033[0;34m'; C_DIM=$'\033[2m'; C_RST=$'\033[0m'
else
  C_OK=""; C_WARN=""; C_INFO=""; C_DIM=""; C_RST=""
fi

hdr() { echo ""; echo "${C_INFO}== $* ==${C_RST}"; }
info() { echo "  $*"; }
warn() { echo "  ${C_WARN}WARN${C_RST} $*"; }

usage() {
  sed -n '3,28p' "${BASH_SOURCE[0]}" | sed 's/^# //; s/^#//'
}

# --- Filename pattern + helpers --------------------------------------------
# Locked to: w3forge_(app|db)_YYYY-MM-DD_HH-MM-SS.(tar.gz|sql)
RE_TOKEN='[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{2}-[0-9]{2}-[0-9]{2}'

# Extract the timestamp token from a backup filename.
extract_token() {
  local fname="$1"
  if [[ "$fname" =~ ^w3forge_(app|db)_(${RE_TOKEN}) ]]; then
    echo "${BASH_REMATCH[2]}"
  fi
}
# Extract the type (app|db) from a backup filename.
extract_type() {
  local fname="$1"
  if [[ "$fname" =~ ^w3forge_(app|db)_${RE_TOKEN} ]]; then
    echo "${BASH_REMATCH[1]}"
  fi
}

human_size() {
  # Portable: prefer numfmt, fall back to ls -lh
  local bytes="$1"
  if command -v numfmt >/dev/null 2>&1; then
    numfmt --to=iec --suffix=B "$bytes" 2>/dev/null || echo "${bytes}B"
  else
    echo "${bytes}B"
  fi
}

age_of() {
  # human-readable age given epoch mtime
  local mtime="$1"
  local now; now=$(date +%s)
  local diff=$(( now - mtime ))
  if   (( diff < 60 ));      then echo "${diff}s ago"
  elif (( diff < 3600 ));    then echo "$(( diff/60 ))m ago"
  elif (( diff < 86400 ));   then echo "$(( diff/3600 ))h ago"
  else                            echo "$(( diff/86400 ))d ago"
  fi
}

# --- Local listing ---------------------------------------------------------
# Populates LOCAL_APPS, LOCAL_DBS as arrays of "token|filename|bytes|mtime"
declare -a LOCAL_APPS=()
declare -a LOCAL_DBS=()

scan_local() {
  LOCAL_APPS=(); LOCAL_DBS=()
  [[ -d "$BACKUP_DIR" ]] || return 0
  if ! [[ -r "$BACKUP_DIR" ]]; then
    echo "ERROR: $BACKUP_DIR exists but is not readable" >&2
    return 2
  fi
  local f base type token bytes mtime
  shopt -s nullglob
  for f in "$BACKUP_DIR"/w3forge_app_*.tar.gz "$BACKUP_DIR"/w3forge_db_*.sql; do
    [[ -f "$f" ]] || continue
    base="$(basename "$f")"
    type="$(extract_type "$base")"
    token="$(extract_token "$base")"
    [[ -z "$token" ]] && continue
    bytes="$(stat -c %s "$f" 2>/dev/null || echo 0)"
    mtime="$(stat -c %Y "$f" 2>/dev/null || echo 0)"
    case "$type" in
      app) LOCAL_APPS+=("$token|$base|$bytes|$mtime") ;;
      db)  LOCAL_DBS+=("$token|$base|$bytes|$mtime") ;;
    esac
  done
  shopt -u nullglob
  return 0
}

print_local() {
  hdr "Local backups: $BACKUP_DIR"
  if [[ ! -d "$BACKUP_DIR" ]]; then
    warn "$BACKUP_DIR does not exist"
    return 0
  fi
  local total=$(( ${#LOCAL_APPS[@]} + ${#LOCAL_DBS[@]} ))
  if (( total == 0 )); then
    info "${C_DIM}no local backups found${C_RST}"
    return 0
  fi
  printf "  %-4s  %-44s  %-10s  %-19s  %s\n" "TYPE" "FILENAME" "SIZE" "MODIFIED" "AGE"
  printf "  %-4s  %-44s  %-10s  %-19s  %s\n" "----" "--------" "----" "--------" "---"
  # Print newest first by mtime
  {
    for e in "${LOCAL_APPS[@]}" "${LOCAL_DBS[@]}"; do
      echo "$e"
    done
  } | sort -t'|' -k4,4nr | while IFS='|' read -r token base bytes mtime; do
    local type; type="$(extract_type "$base")"
    local human_mt; human_mt="$(date -d "@$mtime" '+%Y-%m-%d %H:%M:%S' 2>/dev/null || echo "?")"
    printf "  %-4s  %-44s  %-10s  %-19s  %s\n" \
      "$type" "$base" "$(human_size "$bytes")" "$human_mt" "$(age_of "$mtime")"
  done
}

# --- Remote listing --------------------------------------------------------
declare -a REMOTE_APPS=()
declare -a REMOTE_DBS=()
REMOTE_REACHABLE=0
REMOTE_ERR=""

scan_remote() {
  REMOTE_APPS=(); REMOTE_DBS=(); REMOTE_REACHABLE=0; REMOTE_ERR=""
  if [[ -z "$REMOTE_HOST" ]]; then
    REMOTE_ERR="not configured (set W3_BACKUP_REMOTE_HOST)"
    return 0
  fi
  if ! command -v ssh >/dev/null 2>&1; then
    REMOTE_ERR="ssh not installed on this host"
    return 0
  fi
  # Use BatchMode=yes so we never prompt for password/host-key.
  local out
  out="$(ssh -o BatchMode=yes -o ConnectTimeout="$SSH_TIMEOUT" \
    "$REMOTE_USER@$REMOTE_HOST" \
    "ls -l --time-style=+%s '$REMOTE_PATH' 2>/dev/null" 2>/dev/null)" || {
    REMOTE_ERR="unreachable or no key access to $REMOTE_USER@$REMOTE_HOST"
    return 0
  }
  REMOTE_REACHABLE=1
  # Parse `ls -l --time-style=+%s` lines: perms links owner group size epoch name
  local line bytes mtime base type token
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    # skip "total ..."
    [[ "$line" =~ ^total ]] && continue
    # awk-out the columns we need: size $5, mtime $6, name $7..end
    bytes=$(awk '{print $5}' <<<"$line")
    mtime=$(awk '{print $6}' <<<"$line")
    base=$(awk '{for(i=7;i<=NF;++i)printf "%s%s", $i, (i<NF?" ":"")}' <<<"$line")
    [[ -z "$base" ]] && continue
    type="$(extract_type "$base")"
    token="$(extract_token "$base")"
    [[ -z "$token" ]] && continue
    case "$type" in
      app) REMOTE_APPS+=("$token|$base|$bytes|$mtime") ;;
      db)  REMOTE_DBS+=("$token|$base|$bytes|$mtime") ;;
    esac
  done <<<"$out"
  return 0
}

print_remote() {
  hdr "Remote backups: $REMOTE_USER@$REMOTE_HOST:$REMOTE_PATH"
  if [[ $REMOTE_REACHABLE -eq 0 ]]; then
    warn "$REMOTE_ERR"
    return 0
  fi
  local total=$(( ${#REMOTE_APPS[@]} + ${#REMOTE_DBS[@]} ))
  if (( total == 0 )); then
    info "${C_DIM}no remote backups found${C_RST}"
    return 0
  fi
  printf "  %-4s  %-44s  %-10s  %-19s  %s\n" "TYPE" "FILENAME" "SIZE" "MODIFIED" "AGE"
  printf "  %-4s  %-44s  %-10s  %-19s  %s\n" "----" "--------" "----" "--------" "---"
  {
    for e in "${REMOTE_APPS[@]}" "${REMOTE_DBS[@]}"; do
      echo "$e"
    done
  } | sort -t'|' -k4,4nr | while IFS='|' read -r token base bytes mtime; do
    local type; type="$(extract_type "$base")"
    local human_mt; human_mt="$(date -d "@$mtime" '+%Y-%m-%d %H:%M:%S' 2>/dev/null || echo "?")"
    printf "  %-4s  %-44s  %-10s  %-19s  %s\n" \
      "$type" "$base" "$(human_size "$bytes")" "$human_mt" "$(age_of "$mtime")"
  done
}

# --- Pairs view ------------------------------------------------------------
print_pairs() {
  hdr "Paired backups (token = YYYY-MM-DD_HH-MM-SS)"
  # Collect all known tokens across local app+db
  declare -A APP_FOR=()  # token -> base
  declare -A DB_FOR=()
  declare -A APP_BYTES=()
  declare -A DB_BYTES=()
  local e token base bytes mtime
  for e in "${LOCAL_APPS[@]}"; do
    IFS='|' read -r token base bytes mtime <<<"$e"
    APP_FOR[$token]="$base"; APP_BYTES[$token]="$bytes"
  done
  for e in "${LOCAL_DBS[@]}"; do
    IFS='|' read -r token base bytes mtime <<<"$e"
    DB_FOR[$token]="$base"; DB_BYTES[$token]="$bytes"
  done
  local -a TOKENS=()
  for k in "${!APP_FOR[@]}"; do TOKENS+=("$k"); done
  for k in "${!DB_FOR[@]}";  do [[ -z "${APP_FOR[$k]:-}" ]] && TOKENS+=("$k"); done
  if (( ${#TOKENS[@]} == 0 )); then
    info "${C_DIM}no local backups to pair${C_RST}"
    return 0
  fi
  # Sort tokens descending (lexical works because zero-padded)
  IFS=$'\n' SORTED=($(printf '%s\n' "${TOKENS[@]}" | sort -r)); unset IFS
  printf "  %-20s  %-44s  %-44s  %s\n" "TIMESTAMP" "APP BACKUP" "DB BACKUP" "STATUS"
  printf "  %-20s  %-44s  %-44s  %s\n" "---------" "----------" "---------" "------"
  local newest_complete=""
  for t in "${SORTED[@]}"; do
    local a="${APP_FOR[$t]:-}"
    local d="${DB_FOR[$t]:-}"
    local status="COMPLETE"
    if [[ -z "$a" || -z "$d" ]]; then status="INCOMPLETE"; fi
    [[ -z "$a" ]] && a="${C_WARN}(missing app){RST}"
    [[ -z "$d" ]] && d="${C_WARN}(missing db){RST}"
    a="${a/\{RST\}/$C_RST}"; d="${d/\{RST\}/$C_RST}"
    printf "  %-20s  %-44s  %-44s  %s\n" "$t" "$a" "$d" "$status"
    if [[ -z "$newest_complete" && "$status" == "COMPLETE" ]]; then
      newest_complete="$t"
    fi
  done
  echo ""
  if [[ -n "$newest_complete" ]]; then
    info "${C_OK}newest complete pair: $newest_complete${C_RST}"
  else
    warn "no complete app+db pair found locally"
  fi
}

# --- Dispatch --------------------------------------------------------------
case "$SUB" in
  help|-h|--help)
    usage
    exit 0
    ;;
  local)
    scan_local || exit 1
    print_local
    ;;
  remote)
    scan_remote
    print_remote
    ;;
  pairs)
    scan_local || exit 1
    print_pairs
    ;;
  all|"")
    scan_local || exit 1
    scan_remote
    print_local
    print_remote
    print_pairs
    ;;
  *)
    echo "Unknown subcommand: $SUB" >&2
    usage
    exit 1
    ;;
esac

if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
exit 0
