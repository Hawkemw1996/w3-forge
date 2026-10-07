#!/usr/bin/env bash
# App ownership and capability checks run before logging or any operation.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_w3forge-policy.sh"
w3forge_guard_script "${BASH_SOURCE[0]##*/}" "$@"
#
# logs-w3forge.sh
#
# Browse W3 Forge operational logs under /opt/logs/w3forge/.
#
# Commands:
#   logs-w3forge.sh list                       # list all categories with counts
#   logs-w3forge.sh list <category>            # list log files in a category
#   logs-w3forge.sh latest <category>          # cat the newest log in a category
#   logs-w3forge.sh tail <category>            # tail -f the newest log
#   logs-w3forge.sh cat <category> <filename>  # cat a specific log file
#   logs-w3forge.sh help
#
# Categories: deploy backup restore status release package doctor patch

set -euo pipefail

LOG_ROOT="${W3LOG_ROOT:-/opt/logs/w3forge}"
CATEGORIES=(deploy backup restore status release package doctor patch)

usage() {
  cat <<'EOF'
Usage:
  logs-w3forge.sh list                       List all categories with file counts
  logs-w3forge.sh list <category>            List log files in a category (newest last)
  logs-w3forge.sh latest <category>          Print the newest log in a category
  logs-w3forge.sh tail <category>            tail -f the newest log in a category
  logs-w3forge.sh cat <category> <filename>  Print a specific log file
  logs-w3forge.sh help                       Show this help

Categories: deploy backup restore status release package doctor patch
Log root:   /opt/logs/w3forge (override with W3LOG_ROOT)
EOF
}

is_valid_category() {
  local c="$1"
  local v
  for v in "${CATEGORIES[@]}"; do
    [[ "$v" == "$c" ]] && return 0
  done
  return 1
}

ensure_root() {
  if [[ ! -d "$LOG_ROOT" ]]; then
    echo "Log root not found: $LOG_ROOT" >&2
    echo "Run an operational script first or create the directory." >&2
    exit 1
  fi
}

newest_file() {
  local dir="$1"
  ls -1t "$dir" 2>/dev/null | grep -v '^$' | head -n 1 || true
}

cmd_list_all() {
  ensure_root
  printf '%-12s %-7s %s\n' "CATEGORY" "FILES" "PATH"
  local c dir count
  for c in "${CATEGORIES[@]}"; do
    dir="$LOG_ROOT/$c"
    if [[ -d "$dir" ]]; then
      count="$(find "$dir" -maxdepth 1 -type f -name '*.log' 2>/dev/null | wc -l | tr -d ' ')"
    else
      count="0"
    fi
    printf '%-12s %-7s %s\n' "$c" "$count" "$dir"
  done
}

cmd_list_category() {
  local cat="$1"
  if ! is_valid_category "$cat"; then
    echo "Unknown category: $cat" >&2
    echo "Valid: ${CATEGORIES[*]}" >&2
    exit 2
  fi
  ensure_root
  local dir="$LOG_ROOT/$cat"
  if [[ ! -d "$dir" ]]; then
    echo "No logs yet in $dir"
    return 0
  fi
  ls -1tr "$dir" 2>/dev/null | grep -E '\.log$' || echo "(empty)"
}

cmd_latest() {
  local cat="$1"
  if ! is_valid_category "$cat"; then
    echo "Unknown category: $cat" >&2
    exit 2
  fi
  ensure_root
  local dir="$LOG_ROOT/$cat"
  local file
  file="$(newest_file "$dir")"
  if [[ -z "$file" ]]; then
    echo "No logs found in $dir" >&2
    exit 1
  fi
  echo "==> $dir/$file"
  cat "$dir/$file"
}

cmd_tail() {
  local cat="$1"
  if ! is_valid_category "$cat"; then
    echo "Unknown category: $cat" >&2
    exit 2
  fi
  ensure_root
  local dir="$LOG_ROOT/$cat"
  local file
  file="$(newest_file "$dir")"
  if [[ -z "$file" ]]; then
    echo "No logs found in $dir" >&2
    exit 1
  fi
  echo "==> tail -f $dir/$file"
  exec tail -n 50 -F "$dir/$file"
}

cmd_cat() {
  local cat="$1"
  local fname="$2"
  if ! is_valid_category "$cat"; then
    echo "Unknown category: $cat" >&2
    exit 2
  fi
  ensure_root
  local path="$LOG_ROOT/$cat/$fname"
  if [[ ! -f "$path" ]]; then
    echo "File not found: $path" >&2
    exit 1
  fi
  echo "==> $path"
  cat "$path"
}

# --- Dispatch ---------------------------------------------------------------
if [[ $# -lt 1 ]]; then
  usage
  exit 0
fi

case "$1" in
  help|-h|--help)
    usage
    ;;
  list)
    if [[ $# -ge 2 ]]; then
      cmd_list_category "$2"
    else
      cmd_list_all
    fi
    ;;
  latest)
    [[ $# -ge 2 ]] || { echo "latest requires a category" >&2; exit 2; }
    cmd_latest "$2"
    ;;
  tail)
    [[ $# -ge 2 ]] || { echo "tail requires a category" >&2; exit 2; }
    cmd_tail "$2"
    ;;
  cat)
    [[ $# -ge 3 ]] || { echo "cat requires a category and filename" >&2; exit 2; }
    cmd_cat "$2" "$3"
    ;;
  *)
    echo "Unknown command: $1" >&2
    usage
    exit 2
    ;;
esac
