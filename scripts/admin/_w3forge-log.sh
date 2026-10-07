#!/usr/bin/env bash
# _w3forge-log.sh
#
# Shared logging helper for W3 Forge operational scripts.
# Sourced (not executed) by other scripts in /opt/w3forge-scripts.
#
# Usage:
#   . "$(dirname "$0")/_w3forge-log.sh"          # when located next to caller
#   . "${W3_SCRIPTS_DIR}/_w3forge-log.sh"             # when installed
#   w3log_init <category>                       # categories: deploy|backup|restore|status|release|package|doctor
#   ... normal script output ...
#   echo "Done"
#
# After w3log_init runs, stdout and stderr of the calling script are
# tee'd into a timestamped log file under /opt/logs/w3forge/<category>/.
# Console output is preserved exactly as before; this helper is additive.
#
# Functions provided:
#   w3log_init <category>     start logging for the current script
#   w3log_path                print the active log file path
#   w3log_done                print a friendly final-log-path footer
#
# Environment overrides:
#   W3LOG_ROOT  override the log root (default /opt/logs/w3forge)
#   W3LOG_DISABLE=1  skip logging entirely (still prints to console)

# Intentionally do not set strict mode here. Callers manage their own
# set -euo pipefail. This file is sourced.

W3LOG_ROOT="${W3LOG_ROOT:-/opt/logs/w3forge}"
W3LOG_CATEGORY=""
W3LOG_FILE=""

w3log_init() {
  local category="${1:-}"
  if [[ -z "$category" ]]; then
    echo "[w3log] w3log_init requires a category" >&2
    return 1
  fi
  W3LOG_CATEGORY="$category"

  if [[ "${W3LOG_DISABLE:-0}" == "1" ]]; then
    W3LOG_FILE=""
    return 0
  fi

  local dir="$W3LOG_ROOT/$category"
  if ! mkdir -p "$dir" 2>/dev/null; then
    echo "[w3log] WARN: could not create log dir $dir; continuing without file logging" >&2
    W3LOG_FILE=""
    return 0
  fi

  local script_name
  script_name="$(basename "${BASH_SOURCE[1]:-$0}" .sh)"
  local stamp
  stamp="$(date +%Y-%m-%d_%H-%M-%S)"
  W3LOG_FILE="$dir/${script_name}_${stamp}.log"

  # Redirect both stdout and stderr through tee so console output is
  # preserved exactly while the same bytes are appended to the log.
  exec > >(tee -a "$W3LOG_FILE") 2>&1

  echo "[w3log] ===== $script_name started $(date '+%Y-%m-%d %H:%M:%S') ====="
  echo "[w3log] log file: $W3LOG_FILE"
}

w3log_path() {
  echo "$W3LOG_FILE"
}

w3log_done() {
  if [[ -n "$W3LOG_FILE" ]]; then
    echo ""
    echo "[w3log] full log: $W3LOG_FILE"
  fi
}
