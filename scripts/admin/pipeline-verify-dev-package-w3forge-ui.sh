#!/usr/bin/env bash
# App ownership and capability checks run before logging or any operation.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_w3forge-policy.sh"
w3forge_guard_script "${BASH_SOURCE[0]##*/}" "$@"
#
# pipeline-verify-dev-package-w3forge-ui.sh
#
# W3 Core v0.5.38 — Release Pipeline UI wrapper: Verify Channel Package.
#
# MEDIUM-risk read-mostly verification step. Locates a tarball under
# /opt/w3forge-update-packages/<channel>/<version>/w3forge.tar.gz (canonical) or
# legacy fallbacks, extracts to a private temp dir, and runs structural
# checks:
#   - tarball is gzipped and extractable
#   - it contains a single top-level directory named exactly w3forge/
#     (aligned with package-verify-w3forge.sh Check 2 — inner root must
#     be w3forge/, NOT w3forge-vX.Y.Z/)
#   - the directory contains VERSION matching ${version#v}
#   - the directory contains package.json with the same version
#   - the directory contains backend/ and frontend/ subdirectories
#   - the directory contains scripts/ and a CHANGELOG.md or RELEASE_NOTES.md
#
# v0.5.38 changes vs prior:
#   - Accepts --channel <dev|main|installed> (default: dev).
#   - Resolves the package via pp_resolve_package_path (3-tier fallback).
#   - Inner root expectation aligned to w3forge/ (was w3forge-${version}/).
#   - --package remains accepted for backward compatibility, but is now
#     optional. When omitted, channel+version path is the source of truth.
#
# Safety:
#   - Extracts to a private mktemp -d under $TMPDIR (default /tmp) and
#     removes it on exit. Never modifies /opt/w3forge, /opt/w3forge-deploy,
#     the database, or the service.
#   - Only reads from /opt/w3forge-update-packages/dev/. The package basename is
#     re-validated against the canonical regex.
#
# Argv:
#   --yes --request-id <id> [--source ui|api|cli]
#   --version <vX.Y.Z>
#   [--channel dev|main|installed]   (default: dev)
#   [--package <basename>]           (optional legacy basename hint)
#
# Output:
#   ===STRUCTURED-RESULT===
#   status=success|failed|no_package_found|blocked
#   request_id=<id>
#   package=<basename>
#   version=<vX.Y.Z>
#   bytes=<n>
#   has_version_file=true|false
#   has_root_package_json=true|false
#   has_backend=true|false
#   has_frontend=true|false
#   has_scripts=true|false
#   has_changelog=true|false
#   verified=true|false
#   duration_seconds=<n>
#   ===END===

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if   [[ -f "$SCRIPT_DIR/_w3forge-log.sh" ]]; then . "$SCRIPT_DIR/_w3forge-log.sh"
elif [[ -f "${W3_SCRIPTS_DIR}/_w3forge-log.sh" ]];  then . "${W3_SCRIPTS_DIR}/_w3forge-log.sh"
fi
if declare -F w3log_init >/dev/null 2>&1; then w3log_init "pipeline"; fi

if   [[ -f "$SCRIPT_DIR/_w3forge-pipeline-common.sh" ]]; then . "$SCRIPT_DIR/_w3forge-pipeline-common.sh"
elif [[ -f "${W3_SCRIPTS_DIR}/_w3forge-pipeline-common.sh" ]];  then . "${W3_SCRIPTS_DIR}/_w3forge-pipeline-common.sh"
else
  echo "[FAIL] _w3forge-pipeline-common.sh not found" >&2
  exit 3
fi

UPDATE_DIR="${W3_UPDATE_DIR:-/opt/w3forge-update-packages}"
export PP_UPDATE_DIR="$UPDATE_DIR"

PACKAGE=""
VERSION=""
CHANNEL="dev"
while [[ $# -gt 0 ]]; do
  if pp_consume_common_arg "$@"; then shift "$PP_CONSUMED"; continue; fi
  case "$1" in
    --package) [[ $# -ge 2 ]] || pp_fail "--package requires a value" 2
               PACKAGE="$2"; shift 2 ;;
    --version) [[ $# -ge 2 ]] || pp_fail "--version requires a value" 2
               VERSION="$2"; shift 2 ;;
    --channel) [[ $# -ge 2 ]] || pp_fail "--channel requires a value" 2
               CHANNEL="$2"; shift 2 ;;
    help|-h|--help)
      cat <<'USAGE'
pipeline-verify-dev-package-w3forge-ui.sh \
  --yes --request-id <id> [--source ui|api|cli] \
  --version vX.Y.Z \
  [--channel dev|main|installed] \
  [--package <basename>]
USAGE
      exit 0 ;;
    *) pp_fail "Unknown argument: $1" 2 ;;
  esac
done
pp_require_yes
pp_validate_tag "$VERSION"
pp_validate_channel "$CHANNEL"

# --package optional. If supplied, validate basename + cross-check version.
if [[ -n "$PACKAGE" ]]; then
  pp_validate_package "$PACKAGE"
  EXPECTED_LEGACY="w3forge-${VERSION}.tar.gz"
  if [[ "$PACKAGE" != "$EXPECTED_LEGACY" && "$PACKAGE" != "$PP_CANONICAL_PACKAGE_NAME" ]]; then
    pp_emit_blocked "package basename (${PACKAGE}) does not match version (${VERSION}); expected ${EXPECTED_LEGACY} or ${PP_CANONICAL_PACKAGE_NAME}" \
      "package=${PACKAGE}" "version=${VERSION}" "channel=${CHANNEL}"
    if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
    exit 1
  fi
fi

# Resolve via 3-tier fallback.
PKG_PATH="$(pp_resolve_package_path "$CHANNEL" "$VERSION" 2>/dev/null || true)"
if [[ -z "$PKG_PATH" || ! -f "$PKG_PATH" ]]; then
  pp_emit_failure "no package found for channel=${CHANNEL} version=${VERSION}" \
    "package=${PACKAGE:-${PP_CANONICAL_PACKAGE_NAME}}" "version=${VERSION}" "channel=${CHANNEL}"
  echo "===STRUCTURED-RESULT==="
  echo "status=no_package_found"
  echo "request_id=${PP_REQUEST_ID}"
  echo "package=${PACKAGE:-${PP_CANONICAL_PACKAGE_NAME}}"
  echo "version=${VERSION}"
  echo "channel=${CHANNEL}"
  echo "===END==="
  if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
  exit 1
fi
RESOLVED_BASENAME="$(basename "$PKG_PATH")"
if [[ -z "$PACKAGE" ]]; then PACKAGE="$RESOLVED_BASENAME"; fi

BYTES="$(stat -c%s "$PKG_PATH" 2>/dev/null || wc -c < "$PKG_PATH")"
pp_info "request-id : $PP_REQUEST_ID"
pp_info "source     : $PP_SOURCE_TAG"
pp_info "channel    : $CHANNEL"
pp_info "package    : $PKG_PATH ($BYTES bytes)"
pp_info "version    : $VERSION"

START=$(date +%s)
EXTRACT_DIR="$(mktemp -d -t w3forge-verify.XXXXXX)"
cleanup() { rm -rf "$EXTRACT_DIR" 2>/dev/null || true; }
trap cleanup EXIT

set +e
tar -tzf "$PKG_PATH" >/dev/null 2>&1
TAR_RC=$?
set -e
if [[ $TAR_RC -ne 0 ]]; then
  pp_emit_failure "tarball is not a valid gzipped tar" \
    "package=${PACKAGE}" "version=${VERSION}" "bytes=${BYTES}" \
    "verified=false" "duration_seconds=$(( $(date +%s) - START ))"
  if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
  exit 1
fi

# Extract into the temp dir.
w3forge_verify_archive "$PKG_PATH" || exit 3
tar -xzf "$PKG_PATH" -C "$EXTRACT_DIR"

# Expect exactly one top-level dir.
TOP_DIR_COUNT="$(find "$EXTRACT_DIR" -maxdepth 1 -mindepth 1 -type d | wc -l)"
if [[ "$TOP_DIR_COUNT" -ne 1 ]]; then
  pp_emit_failure "tarball must contain exactly one top-level directory (found ${TOP_DIR_COUNT})" \
    "package=${PACKAGE}" "version=${VERSION}" "bytes=${BYTES}" \
    "verified=false" "duration_seconds=$(( $(date +%s) - START ))"
  if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
  exit 1
fi
ROOT="$(find "$EXTRACT_DIR" -maxdepth 1 -mindepth 1 -type d)"
# v0.5.38 canonical: inner root MUST be exactly w3forge/. We accept the
# legacy w3forge-${VERSION}/ name as well so older packages keep verifying
# while the canonical layout rolls out, but the canonical form is the
# expected forward-going shape.
ROOT_BASENAME="$(basename "$ROOT")"
CANONICAL_ROOT_NAME="w3forge"
LEGACY_ROOT_NAME="w3forge-${VERSION}"
if [[ "$ROOT_BASENAME" != "$CANONICAL_ROOT_NAME" && "$ROOT_BASENAME" != "$LEGACY_ROOT_NAME" ]]; then
  pp_emit_failure "top-level dir is ${ROOT_BASENAME}; expected ${CANONICAL_ROOT_NAME} (v0.5.38) or ${LEGACY_ROOT_NAME} (legacy)" \
    "package=${PACKAGE}" "version=${VERSION}" "channel=${CHANNEL}" "bytes=${BYTES}" \
    "verified=false" "duration_seconds=$(( $(date +%s) - START ))"
  if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
  exit 1
fi

# Structural checks.
HAS_VERSION="false"; HAS_ROOT_PKG="false"
HAS_BACKEND="false"; HAS_FRONTEND="false"
HAS_SCRIPTS="false"; HAS_CHANGELOG="false"
WANT_VER="${VERSION#v}"

if [[ -f "$ROOT/VERSION" ]] && grep -qE "^${WANT_VER}$" "$ROOT/VERSION" 2>/dev/null; then HAS_VERSION="true"; fi
if [[ -f "$ROOT/package.json" ]] && grep -qE "\"version\"[[:space:]]*:[[:space:]]*\"${WANT_VER}\"" "$ROOT/package.json" 2>/dev/null; then HAS_ROOT_PKG="true"; fi
[[ -d "$ROOT/backend"  ]] && HAS_BACKEND="true"
[[ -d "$ROOT/frontend" ]] && HAS_FRONTEND="true"
[[ -d "$ROOT/scripts"  ]] && HAS_SCRIPTS="true"
{ [[ -f "$ROOT/CHANGELOG.md" ]] || [[ -f "$ROOT/RELEASE_NOTES.md" ]]; } && HAS_CHANGELOG="true"

VERIFIED="false"
if [[ "$HAS_VERSION" == "true" \
   && "$HAS_ROOT_PKG" == "true" \
   && "$HAS_BACKEND" == "true" \
   && "$HAS_FRONTEND" == "true" \
   && "$HAS_SCRIPTS" == "true" \
   && "$HAS_CHANGELOG" == "true" ]]; then
  VERIFIED="true"
fi

DURATION=$(( $(date +%s) - START ))

# Populate canonical-trailer state for pp_emit_result.
PP_RES_SOURCE="$PP_SOURCE_TAG"
PP_RES_CHANNEL="$CHANNEL"
PP_RES_VERSION="$VERSION"
PP_RES_PACKAGE_PATH="$PKG_PATH"
PP_RES_DURATION_SECONDS="$DURATION"

if [[ "$VERIFIED" == "true" ]]; then
  pp_ok "Verification PASSED (${DURATION}s)"
  pp_emit_success "package=${PACKAGE}" "version=${VERSION}" "channel=${CHANNEL}" \
    "package_path=${PKG_PATH}" "bytes=${BYTES}" \
    "has_version_file=${HAS_VERSION}" "has_root_package_json=${HAS_ROOT_PKG}" \
    "has_backend=${HAS_BACKEND}" "has_frontend=${HAS_FRONTEND}" \
    "has_scripts=${HAS_SCRIPTS}" "has_changelog=${HAS_CHANGELOG}" \
    "verified=true" "duration_seconds=${DURATION}"
  PP_RES_VERIFICATION="passed"
  if declare -F pp_emit_result >/dev/null 2>&1; then
    pp_emit_result "success" "structural verification passed" \
      "package=${PACKAGE}"
  fi
else
  pp_warn "Verification FAILED — one or more structural checks did not pass"
  pp_emit_failure "structural verification failed" \
    "package=${PACKAGE}" "version=${VERSION}" "channel=${CHANNEL}" \
    "package_path=${PKG_PATH}" "bytes=${BYTES}" \
    "has_version_file=${HAS_VERSION}" "has_root_package_json=${HAS_ROOT_PKG}" \
    "has_backend=${HAS_BACKEND}" "has_frontend=${HAS_FRONTEND}" \
    "has_scripts=${HAS_SCRIPTS}" "has_changelog=${HAS_CHANGELOG}" \
    "verified=false" "duration_seconds=${DURATION}"
  PP_RES_VERIFICATION="failed"
  PP_RES_VERIFICATION_REASON="one or more structural checks did not pass"
  if declare -F pp_emit_result >/dev/null 2>&1; then
    pp_emit_result "failed" "structural verification failed" \
      "package=${PACKAGE}"
  fi
  if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
  exit 1
fi

if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
exit 0
