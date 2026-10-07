#!/usr/bin/env bash
# App ownership and capability checks run before logging or any operation.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_w3forge-policy.sh"
w3forge_guard_script "${BASH_SOURCE[0]##*/}" "$@"
#
# package-list-w3forge.sh
#
# Read-only listing of W3 Forge release packages.
#
# v0.5.38 — Canonical layout:
#   /opt/w3forge-update-packages/dev/<vX.Y.Z>/w3forge.tar.gz
#   /opt/w3forge-update-packages/main/<vX.Y.Z>/w3forge.tar.gz
#   /opt/w3forge-update-packages/installed/<vX.Y.Z>/w3forge.tar.gz
#
# Legacy layouts still surfaced (during transition):
#   /opt/w3forge-update-packages/w3forge-<version>.tar.gz            (flat staged)
#   /opt/w3forge-update-packages/installed/w3forge-<version>.tar.gz  (flat installed)
#
# For each package, prints:
#   - channel (dev / main / installed / staged-legacy)
#   - embedded VERSION (peeked from inside the tarball if possible)
#   - mtime
#   - human size
#   - file path (relative to UPDATE_DIR)
#
# Commands:
#   package-list-w3forge.sh                  List everything (default)
#   package-list-w3forge.sh staged           List only legacy flat staged
#   package-list-w3forge.sh installed        List installed (canonical + legacy)
#   package-list-w3forge.sh dev              List dev channel (canonical only)
#   package-list-w3forge.sh main             List main channel (canonical only)
#   package-list-w3forge.sh help             Show help
#
# Logs to /opt/logs/w3forge/package/.
# Read-only: this script never moves, renames, or modifies any file.

set -euo pipefail

# --- Logging ---------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SCRIPT_DIR/_w3forge-log.sh" ]]; then
  # shellcheck disable=SC1091
  . "$SCRIPT_DIR/_w3forge-log.sh"
elif [[ -f "${W3_SCRIPTS_DIR}/_w3forge-log.sh" ]]; then
  # shellcheck disable=SC1091
  . "${W3_SCRIPTS_DIR}/_w3forge-log.sh"
fi
if declare -F w3log_init >/dev/null 2>&1; then w3log_init "package"; fi

# --- Config ----------------------------------------------------------------
UPDATE_DIR="${W3_UPDATE_DIR:-/opt/w3forge-update-packages}"
INSTALLED_DIR="${W3_INSTALLED_DIR:-$UPDATE_DIR/installed}"
DEV_DIR="${W3_DEV_DIR:-$UPDATE_DIR/dev}"
MAIN_DIR="${W3_MAIN_DIR:-$UPDATE_DIR/main}"

usage() {
  cat <<'EOF'
Usage:
  package-list-w3forge.sh             List everything (default)
  package-list-w3forge.sh staged      List only legacy flat staged at /opt/w3forge-update-packages/
  package-list-w3forge.sh installed   List installed (canonical + legacy)
  package-list-w3forge.sh dev         List dev channel (canonical only)
  package-list-w3forge.sh main        List main channel (canonical only)
  package-list-w3forge.sh help        Show this help

Environment overrides:
  W3_UPDATE_DIR     Override staging directory (default /opt/w3forge-update-packages)
  W3_INSTALLED_DIR  Override installed archive directory
  W3_DEV_DIR        Override dev channel directory
  W3_MAIN_DIR       Override main channel directory

Read-only. Never moves, renames, or modifies any file.
EOF
}

# Peek the embedded VERSION. Tries canonical inner root w3forge/VERSION
# first, then any legacy w3forge-*/VERSION. Echo '?' on any read failure.
peek_version() {
  local pkg="$1"
  local v
  # Canonical inner root
  if v="$(tar -xzOf "$pkg" w3forge/VERSION 2>/dev/null | tr -d '[:space:]')"; then
    if [[ -n "$v" ]]; then
      echo "$v"
      return
    fi
  fi
  # Legacy inner root w3forge-<ver>/VERSION — discover member name first.
  local member
  member="$(tar -tzf "$pkg" 2>/dev/null | awk -F/ '/^w3forge-[^\/]+\/VERSION$/ {print; exit}')"
  if [[ -n "$member" ]]; then
    if v="$(tar -xzOf "$pkg" "$member" 2>/dev/null | tr -d '[:space:]')"; then
      if [[ -n "$v" ]]; then
        echo "$v"
        return
      fi
    fi
  fi
  echo "?"
}

human_size() {
  local pkg="$1"
  if command -v du >/dev/null 2>&1; then
    du -h "$pkg" 2>/dev/null | awk '{print $1}'
  else
    wc -c < "$pkg" | awk '{print $1"B"}'
  fi
}

mtime_str() {
  local pkg="$1"
  if stat -c '%y' "$pkg" >/dev/null 2>&1; then
    stat -c '%y' "$pkg" | cut -d'.' -f1
  elif stat -f '%Sm' -t '%Y-%m-%d %H:%M:%S' "$pkg" >/dev/null 2>&1; then
    stat -f '%Sm' -t '%Y-%m-%d %H:%M:%S' "$pkg"
  else
    date -r "$pkg" '+%Y-%m-%d %H:%M:%S' 2>/dev/null || echo '?'
  fi
}

print_header() {
  printf '    %-10s  %-9s  %-19s  %-9s  %s\n' "CHANNEL" "VERSION" "MTIME" "SIZE" "FILE"
}

print_row() {
  local channel="$1" file="$2"
  local v s m rel
  v="$(peek_version "$file")"
  s="$(human_size "$file")"
  m="$(mtime_str "$file")"
  rel="${file#"$UPDATE_DIR"/}"
  printf '    %-10s  %-9s  %-19s  %-9s  %s\n' "$channel" "$v" "$m" "$s" "$rel"
}

# Canonical layout list: <channel_root>/<vX.Y.Z>/w3forge.tar.gz
list_canonical_channel() {
  local channel="$1" channel_root="$2"
  echo ""
  echo "==> Channel: $channel"
  echo "    path: $channel_root"
  if [[ ! -d "$channel_root" ]]; then
    echo "    (directory does not exist)"
    return 0
  fi
  local found=0
  print_header
  local f
  while IFS= read -r f; do
    [[ -f "$f" ]] || continue
    print_row "$channel" "$f"
    found=1
  done < <(find "$channel_root" -mindepth 2 -maxdepth 2 -type f -name 'w3forge.tar.gz' -printf '%T@ %p\n' 2>/dev/null \
           | sort -nr | cut -d' ' -f2-)
  [[ "$found" -eq 0 ]] && echo "    (no canonical packages)"
}

# Legacy flat list: directly under <dir>/w3forge-<ver>.tar.gz
list_legacy_flat() {
  local channel="$1" dir="$2"
  echo ""
  echo "==> Legacy flat: $channel"
  echo "    path: $dir"
  if [[ ! -d "$dir" ]]; then
    echo "    (directory does not exist)"
    return 0
  fi
  local files=()
  while IFS= read -r f; do
    [[ -n "$f" ]] && files+=("$f")
  done < <(find "$dir" -maxdepth 1 -type f -name 'w3forge-*.tar.gz' -printf '%T@ %p\n' 2>/dev/null \
           | sort -nr | cut -d' ' -f2-)
  if [[ ${#files[@]} -eq 0 ]]; then
    echo "    (no legacy flat packages)"
    return 0
  fi
  print_header
  local f
  for f in "${files[@]}"; do
    print_row "$channel" "$f"
  done
}

# --- Dispatch --------------------------------------------------------------
cmd="${1:-all}"
case "$cmd" in
  help|-h|--help)
    usage
    ;;
  staged)
    # Legacy "staged" semantics: flat files directly under UPDATE_DIR
    list_legacy_flat "staged-legacy" "$UPDATE_DIR"
    ;;
  installed)
    list_canonical_channel "installed" "$INSTALLED_DIR"
    list_legacy_flat "installed-legacy" "$INSTALLED_DIR"
    ;;
  dev)
    list_canonical_channel "dev" "$DEV_DIR"
    ;;
  main)
    list_canonical_channel "main" "$MAIN_DIR"
    ;;
  all|"")
    list_canonical_channel "dev" "$DEV_DIR"
    list_canonical_channel "main" "$MAIN_DIR"
    list_canonical_channel "installed" "$INSTALLED_DIR"
    list_legacy_flat "staged-legacy" "$UPDATE_DIR"
    list_legacy_flat "installed-legacy" "$INSTALLED_DIR"
    ;;
  *)
    echo "Unknown command: $cmd" >&2
    usage
    exit 2
    ;;
esac

if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
