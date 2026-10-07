#!/usr/bin/env bash
# _w3forge-pipeline-common.sh
#
# Shared helpers for the v0.5.29 Release Pipeline scripts. Sourced (not
# executed) by every pipeline-* UI wrapper under /opt/w3forge-scripts.
#
# Provides:
#   pp_parse_common_args  -- parses --yes --request-id <id> --source <s>
#                            and exposes YES, REQUEST_ID, SOURCE_TAG.
#   pp_require_yes        -- exits 2 unless --yes was supplied.
#   pp_validate_dev_branch <branch>
#                         -- exits 2 unless branch matches dev/vX.Y.Z exactly.
#                            Hard-rejects 'main', leading '-', '/', '..',
#                            and any other shape.
#   pp_validate_tag <tag>
#                         -- exits 2 unless tag matches vX.Y.Z exactly.
#   pp_validate_package <basename>
#                         -- exits 2 unless basename matches w3forge-vX.Y.Z.tar.gz.
#   pp_emit_success / pp_emit_failure
#                         -- prints the structured result trailer.
#
# These helpers exist so every pipeline script enforces an identical safety
# fence and so the registry/safe-runner can rely on the SAME server-side
# regexes appearing here as defence-in-depth. The regexes in this file MUST
# stay in lockstep with backend/src/admin/controls/safeRunner.ts and
# backend/src/admin/routes/controlsRoutes.ts.

# Intentionally do not set strict mode here. Callers manage their own
# set -euo pipefail. This file is sourced.

# Hard-coded regexes. Mirrored by the backend route + safeRunner layers.
PP_DEV_BRANCH_REGEX='^dev/v[0-9]+\.[0-9]+\.[0-9]+$'
PP_TAG_REGEX='^v[0-9]+\.[0-9]+\.[0-9]+$'
PP_PACKAGE_REGEX='^w3forge-v[0-9]+\.[0-9]+\.[0-9]+\.tar\.gz$'

# v0.5.38: canonical package model.
# - Version belongs in the folder path.
# - Tarball filename is the stable PP_CANONICAL_PACKAGE_NAME.
# - Inner tar root is always exactly w3forge/.
PP_CANONICAL_PACKAGE_NAME='w3forge.tar.gz'
PP_UPDATE_DIR="${W3_UPDATE_DIR:-/opt/w3forge-update-packages}"
PP_INSTALLED_DIR="${W3_INSTALLED_DIR:-${PP_UPDATE_DIR}/installed}"

# Color helpers (re-declared for callers that don't define them).
if [[ -z "${PP_NC:-}" ]]; then
  PP_RED='\033[0;31m'
  PP_GREEN='\033[0;32m'
  PP_YELLOW='\033[1;33m'
  PP_BLUE='\033[0;34m'
  PP_NC='\033[0m'
fi
pp_info() { echo -e "${PP_BLUE}[INFO]${PP_NC} $*"; }
pp_ok()   { echo -e "${PP_GREEN}[OK]${PP_NC}   $*"; }
pp_warn() { echo -e "${PP_YELLOW}[WARN]${PP_NC} $*"; }
pp_fail() { echo -e "${PP_RED}[FAIL]${PP_NC} $*" >&2; exit "${2:-1}"; }

# ---- arg parsing --------------------------------------------------------
PP_YES=""
PP_REQUEST_ID=""
PP_SOURCE_TAG="cli"

pp_consume_common_arg() {
  # Returns 0 if it consumed the current argv[0] (callers should shift),
  # 1 otherwise. Usage:
  #   while [[ $# -gt 0 ]]; do
  #     case "$1" in ...) ;; esac
  #     if pp_consume_common_arg "$@"; then shift "$PP_CONSUMED"; continue; fi
  PP_CONSUMED=0
  case "${1:-}" in
    --yes)
      PP_YES="1"
      PP_CONSUMED=1
      return 0
      ;;
    --request-id)
      [[ $# -ge 2 ]] || pp_fail "--request-id requires a value" 2
      PP_REQUEST_ID="$2"
      PP_CONSUMED=2
      return 0
      ;;
    --source)
      [[ $# -ge 2 ]] || pp_fail "--source requires a value" 2
      case "$2" in
        ui|api|cli) PP_SOURCE_TAG="$2" ;;
        *) pp_fail "--source must be one of: ui, api, cli (got: $2)" 2 ;;
      esac
      PP_CONSUMED=2
      return 0
      ;;
  esac
  return 1
}

pp_require_yes() {
  if [[ -z "$PP_YES" ]]; then
    pp_fail "Refusing to run without --yes (non-interactive acknowledgment required)" 2
  fi
  if [[ -z "$PP_REQUEST_ID" ]]; then
    PP_REQUEST_ID="pp-$(date +%Y%m%d-%H%M%S)-$$"
  fi
}

# ---- validators ---------------------------------------------------------
pp_validate_dev_branch() {
  local b="${1:-}"
  if [[ -z "$b" ]]; then
    pp_fail "Dev branch is required" 2
  fi
  if [[ "$b" == "main" ]]; then
    pp_fail "Refusing to operate on main. Only dev/vX.Y.Z branches are permitted." 2
  fi
  if [[ "$b" == -* ]]; then
    pp_fail "Dev branch may not start with '-'" 2
  fi
  if [[ "$b" == *".."* ]]; then
    pp_fail "Dev branch may not contain '..'" 2
  fi
  if ! [[ "$b" =~ $PP_DEV_BRANCH_REGEX ]]; then
    pp_fail "Dev branch must match dev/vX.Y.Z (got: $b)" 2
  fi
}

pp_validate_tag() {
  local t="${1:-}"
  if [[ -z "$t" ]]; then
    pp_fail "Tag is required" 2
  fi
  if [[ "$t" == -* ]]; then
    pp_fail "Tag may not start with '-'" 2
  fi
  if [[ "$t" == *"/"* || "$t" == *".."* ]]; then
    pp_fail "Tag may not contain '/' or '..'" 2
  fi
  if ! [[ "$t" =~ $PP_TAG_REGEX ]]; then
    pp_fail "Tag must match vX.Y.Z (got: $t)" 2
  fi
}

pp_validate_package() {
  local p="${1:-}"
  if [[ -z "$p" ]]; then
    pp_fail "Package basename is required" 2
  fi
  if [[ "$p" == -* ]]; then
    pp_fail "Package basename may not start with '-'" 2
  fi
  if [[ "$p" == *"/"* || "$p" == *".."* ]]; then
    pp_fail "Package basename may not contain '/' or '..'" 2
  fi
  # v0.5.38: accept either the legacy versioned name or the stable canonical name.
  if [[ "$p" == "$PP_CANONICAL_PACKAGE_NAME" ]]; then
    return 0
  fi
  if ! [[ "$p" =~ $PP_PACKAGE_REGEX ]]; then
    pp_fail "Package basename must match w3forge-vX.Y.Z.tar.gz or w3forge.tar.gz (got: $p)" 2
  fi
}

# v0.5.38: channel validator (dev|main|installed).
pp_validate_channel() {
  local c="${1:-}"
  case "$c" in
    dev|main|installed) return 0 ;;
    '') pp_fail "--channel is required (one of: dev, main, installed)" 2 ;;
    *) pp_fail "--channel must be one of: dev, main, installed (got: $c)" 2 ;;
  esac
}

# v0.5.38: resolve a canonical package path with legacy fallback.
# Args:
#   $1 channel  (dev|main|installed)
#   $2 version  (vX.Y.Z, with leading 'v')
# Echoes the first existing path found. Returns 0 if found, 1 if not.
# Lookup order:
#   1. ${PP_UPDATE_DIR}/<channel>/<version>/w3forge.tar.gz   (canonical)
#   2. ${PP_UPDATE_DIR}/<channel>/w3forge-<version>.tar.gz   (legacy, dev/main)
#   3. ${PP_UPDATE_DIR}/w3forge-<version>.tar.gz             (legacy flat root)
# When both canonical and legacy exist for the same channel+version, a WARN
# is emitted on stderr and the canonical path wins.
pp_resolve_package_path() {
  local channel="$1"
  local version="$2"
  local canonical legacy_chan legacy_flat
  canonical="$(pp_channel_version_dir "$channel" "$version")/${PP_CANONICAL_PACKAGE_NAME}"
  legacy_chan="${PP_UPDATE_DIR}/${channel}/w3forge-${version}.tar.gz"
  legacy_flat="${PP_UPDATE_DIR}/w3forge-${version}.tar.gz"

  if [[ -f "$canonical" ]]; then
    if [[ -f "$legacy_chan" || ( "$channel" != "installed" && -f "$legacy_flat" ) ]]; then
      pp_warn "Both canonical and legacy package paths exist for ${channel} ${version}; using canonical: $canonical" >&2
    fi
    echo "$canonical"
    return 0
  fi
  if [[ -f "$legacy_chan" ]]; then
    echo "$legacy_chan"
    return 0
  fi
  if [[ "$channel" != "installed" && -f "$legacy_flat" ]]; then
    echo "$legacy_flat"
    return 0
  fi
  return 1
}

# v0.5.38: canonical channel directory (for writers).
pp_channel_version_dir() {
  local channel="$1"
  local version="$2"
  case "$channel" in
    dev) echo "${W3_DEV_UPDATE_DIR:-${PP_UPDATE_DIR}/dev}/${version}" ;;
    main) echo "${W3_MAIN_UPDATE_DIR:-${PP_UPDATE_DIR}/main}/${version}" ;;
    installed) echo "${PP_INSTALLED_DIR}/${version}" ;;
    *) pp_fail "Invalid package channel" 2 ;;
  esac
}

# v0.5.38: canonical installed-version directory (for writers).
pp_installed_version_dir() {
  local version="$1"
  echo "${PP_INSTALLED_DIR}/${version}"
}

# v0.5.38: compute sha256 of a file (best-effort; empty on failure).
pp_sha256() {
  local f="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$f" 2>/dev/null | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$f" 2>/dev/null | awk '{print $1}'
  else
    echo ""
  fi
}

# v0.5.38: write installed/<v>/ metadata after a successful deploy.
# Args:
#   $1 version    (vX.Y.Z)
#   $2 src_pkg    absolute path to the verified package that was deployed
#   $3 source_tag dev|main|installed (where the deploy was initiated)
#   $4 request_id
#   $5 log_path
pp_write_installed_metadata() {
  local version="$1"
  local src_pkg="$2"
  local source_tag="$3"
  local request_id="$4"
  local log_path="$5"
  local dir
  dir="$(pp_installed_version_dir "$version")"
  mkdir -p "$dir"
  # Copy (do not move) so the source channel still has the verified tarball.
  cp -p "$src_pkg" "${dir}/${PP_CANONICAL_PACKAGE_NAME}.tmp"
  mv -f "${dir}/${PP_CANONICAL_PACKAGE_NAME}.tmp" "${dir}/${PP_CANONICAL_PACKAGE_NAME}"
  date -u +'%Y-%m-%dT%H:%M:%SZ' > "${dir}/deployed-at.txt"
  printf '%s\n' "$source_tag"  > "${dir}/source.txt"
  printf '%s\n' "$request_id"  > "${dir}/request-id.txt"
  printf '%s\n' "$log_path"    > "${dir}/log-path.txt"
  pp_sha256 "${dir}/${PP_CANONICAL_PACKAGE_NAME}" > "${dir}/sha256.txt"
  echo "$dir"
}

# ---- safe git wrapper ---------------------------------------------------
# Run git against /opt/w3forge-deploy with terminal prompts disabled and no
# optional locks. NEVER touches /opt/w3forge (the runtime).
PP_DEPLOY_DIR="${W3_DEPLOY_DIR:-/opt/w3forge-deploy}"
pp_git() {
  GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0 git -C "$PP_DEPLOY_DIR" "$@"
}

pp_require_deploy_dir() {
  [[ -d "$PP_DEPLOY_DIR" ]]          || pp_fail "Deploy dir not found: $PP_DEPLOY_DIR" 3
  [[ -d "$PP_DEPLOY_DIR/.git" ]]     || pp_fail "Not a git repo: $PP_DEPLOY_DIR" 3
}

pp_current_branch() {
  pp_git rev-parse --abbrev-ref HEAD 2>/dev/null || true
}

pp_head_short() {
  pp_git rev-parse --short HEAD 2>/dev/null || true
}

pp_working_tree_clean() {
  # Returns 0 if clean, 1 if dirty.
  local out
  out="$(pp_git status --porcelain 2>/dev/null || true)"
  [[ -z "$out" ]]
}

# ---- structured trailer -------------------------------------------------
pp_emit_success() {
  # Usage: pp_emit_success key=value key=value ...
  echo "===STRUCTURED-RESULT==="
  echo "status=success"
  echo "request_id=${PP_REQUEST_ID}"
  local kv
  for kv in "$@"; do
    echo "$kv"
  done
  echo "===END==="
}

pp_emit_failure() {
  # Usage: pp_emit_failure <reason> [extra=kv ...]
  local reason="${1:-failed}"
  shift || true
  echo "===STRUCTURED-RESULT==="
  echo "status=failed"
  echo "request_id=${PP_REQUEST_ID}"
  echo "reason=${reason}"
  local kv
  for kv in "$@"; do
    echo "$kv"
  done
  echo "===END==="
}

pp_emit_blocked() {
  local reason="${1:-blocked}"
  shift || true
  echo "===STRUCTURED-RESULT==="
  echo "status=blocked"
  echo "request_id=${PP_REQUEST_ID}"
  echo "reason=${reason}"
  local kv
  for kv in "$@"; do
    echo "$kv"
  done
  echo "===END==="
}

# v0.5.38: canonical structured-result trailer.
# Usage:
#   pp_emit_result <status> <reason> [extra=kv ...]
# Status is one of: success | failed | blocked.
# Standard keys (always emitted): status, request_id, source, channel,
# version, package_path, verification, verification_reason, delegate,
# delegate_exit_code, duration_seconds, log_path, reason.
# Each is read from the caller's locals (PP_RES_*) if set; otherwise
# empty. Extra key=value pairs follow.
PP_RES_SOURCE=""
PP_RES_CHANNEL=""
PP_RES_VERSION=""
PP_RES_PACKAGE_PATH=""
PP_RES_VERIFICATION="skipped"
PP_RES_VERIFICATION_REASON=""
PP_RES_DELEGATE=""
PP_RES_DELEGATE_EXIT_CODE=""
PP_RES_DURATION_SECONDS="0"
PP_RES_LOG_PATH=""

pp_emit_result() {
  local status="${1:-failed}"
  local reason="${2:-}"
  shift 2 2>/dev/null || true
  echo "===STRUCTURED-RESULT==="
  echo "status=${status}"
  echo "request_id=${PP_REQUEST_ID}"
  echo "source=${PP_RES_SOURCE:-${PP_SOURCE_TAG}}"
  echo "channel=${PP_RES_CHANNEL}"
  echo "version=${PP_RES_VERSION}"
  echo "package_path=${PP_RES_PACKAGE_PATH}"
  echo "verification=${PP_RES_VERIFICATION}"
  echo "verification_reason=${PP_RES_VERIFICATION_REASON}"
  echo "delegate=${PP_RES_DELEGATE}"
  echo "delegate_exit_code=${PP_RES_DELEGATE_EXIT_CODE}"
  echo "duration_seconds=${PP_RES_DURATION_SECONDS}"
  echo "log_path=${PP_RES_LOG_PATH}"
  echo "reason=${reason}"
  local kv
  for kv in "$@"; do
    echo "$kv"
  done
  echo "===END==="
}
