#!/usr/bin/env bash
# App ownership and capability checks run before logging or any operation.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_w3forge-policy.sh"
w3forge_guard_script "${BASH_SOURCE[0]##*/}" "$@"
#
# pipeline-package-dev-release-w3forge-ui.sh
#
# W3 Core v0.5.38 — Release Pipeline UI wrapper: Package Dev Release.
#
# HIGH-risk packaging step. Builds a canonical release tarball from the
# CURRENT dev branch checkout in /opt/w3forge-deploy and writes it to the
# canonical v0.5.38 layout:
#
#   /opt/w3forge-update-packages/dev/<version>/w3forge.tar.gz
#
# v0.5.38 changes vs prior:
#   - Output path is now /opt/w3forge-update-packages/dev/<version>/w3forge.tar.gz
#     (was /opt/w3forge-update-packages/dev/w3forge-<version>.tar.gz).
#   - Inner tarball root is now w3forge/ (was w3forge-<version>/), so the
#     extracted layout is stable across versions and aligned with the
#     deploy verifier (package-verify-w3forge.sh Check 2).
#   - Atomic write via .partial -> mv into the per-version directory.
#   - Emits both the legacy trailer and the v0.5.38 canonical trailer.
#
# Safety:
#   - Current branch MUST match dev/vX.Y.Z; main is HARD-REFUSED.
#   - --version <vX.Y.Z> MUST equal the embedded branch version AND must
#     equal the VERSION file at the repo root.
#   - Refuses to overwrite an existing dev/<version>/w3forge.tar.gz unless
#     --force is passed.
#   - Working tree must be clean.
#   - Never touches /opt/w3forge, the database, or the service.
#
# Argv:
#   --yes --request-id <id> [--source ui|api|cli] --version <vX.Y.Z>
#
# Output:
#   ===STRUCTURED-RESULT===
#   status=success|failed|blocked
#   request_id=<id>
#   branch=<name>
#   version=<vX.Y.Z>
#   head=<sha>
#   output_path=/opt/w3forge-update-packages/dev/w3forge-vX.Y.Z.tar.gz
#   bytes=<n>
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
DEV_PKG_DIR="${W3_DEV_UPDATE_DIR:-${UPDATE_DIR}/dev}"

VERSION=""
FORCE="false"
while [[ $# -gt 0 ]]; do
  if pp_consume_common_arg "$@"; then shift "$PP_CONSUMED"; continue; fi
  case "$1" in
    --version) [[ $# -ge 2 ]] || pp_fail "--version requires a value" 2
               VERSION="$2"; shift 2 ;;
    --force)   FORCE="true"; shift ;;
    help|-h|--help) echo "pipeline-package-dev-release-w3forge-ui.sh --yes --request-id <id> --version vX.Y.Z [--force]"; exit 0 ;;
    *) pp_fail "Unknown argument: $1" 2 ;;
  esac
done
pp_require_yes
pp_require_deploy_dir
pp_validate_tag "$VERSION"   # vX.Y.Z form

BRANCH="$(pp_current_branch)"
if [[ "$BRANCH" == "main" ]]; then
  pp_emit_blocked "Refusing to package from main." "branch=${BRANCH}"
  if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
  exit 1
fi
if ! [[ "$BRANCH" =~ $PP_DEV_BRANCH_REGEX ]]; then
  pp_emit_blocked "Current branch (${BRANCH}) does not match dev/vX.Y.Z" "branch=${BRANCH}"
  if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
  exit 1
fi

# Cross-check: --version must equal the dev branch version.
BRANCH_VER="${BRANCH#dev/}"  # dev/v0.5.29 -> v0.5.29
if [[ "$BRANCH_VER" != "$VERSION" ]]; then
  pp_emit_blocked "Version mismatch: --version=${VERSION} but branch is ${BRANCH}" \
    "branch=${BRANCH}" "version=${VERSION}"
  if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
  exit 1
fi

# Cross-check: VERSION file at deploy root must match (sans leading 'v').
WANT_VERSION_FILE="${VERSION#v}"
if [[ ! -f "$PP_DEPLOY_DIR/VERSION" ]]; then
  pp_emit_failure "VERSION file missing at $PP_DEPLOY_DIR/VERSION" \
    "branch=${BRANCH}" "version=${VERSION}"
  if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
  exit 1
fi
ACTUAL_VERSION_FILE="$(tr -d '[:space:]' < "$PP_DEPLOY_DIR/VERSION")"
if [[ "$ACTUAL_VERSION_FILE" != "$WANT_VERSION_FILE" ]]; then
  pp_emit_blocked "VERSION file ($ACTUAL_VERSION_FILE) does not match --version (${WANT_VERSION_FILE})" \
    "branch=${BRANCH}" "version=${VERSION}"
  if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
  exit 1
fi

# Working tree must be clean.
if ! pp_working_tree_clean; then
  pp_emit_blocked "Working tree is dirty; cannot package." "branch=${BRANCH}"
  if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
  exit 1
fi

HEAD="$(pp_head_short)"
# v0.5.38 canonical layout: dev/<version>/w3forge.tar.gz
OUT_NAME="$PP_CANONICAL_PACKAGE_NAME"        # w3forge.tar.gz
# Validate canonical basename (now accepts both legacy and canonical names).
pp_validate_package "$OUT_NAME"
VERSION_DIR="${DEV_PKG_DIR}/${VERSION}"
mkdir -p "$VERSION_DIR"
OUT_PATH="${VERSION_DIR}/${OUT_NAME}"

if [[ -e "$OUT_PATH" && "$FORCE" != "true" ]]; then
  pp_emit_blocked "Refusing to overwrite existing ${OUT_PATH} (pass --force to override)" \
    "branch=${BRANCH}" "version=${VERSION}" "channel=dev" "output_path=${OUT_PATH}"
  if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
  exit 1
fi

pp_info "request-id  : $PP_REQUEST_ID"
pp_info "source      : $PP_SOURCE_TAG"
pp_info "branch      : $BRANCH @ $HEAD"
pp_info "version     : $VERSION"
pp_info "channel     : dev"
pp_info "output-path : $OUT_PATH (v0.5.38 canonical layout)"

START=$(date +%s)

# Archive the committed app tree plus checksum-verified pinned console source.
# No private repository access is needed on the deployment target. Output goes to a
# temp file first; we rename on success so a partial tarball never appears.
TMP_PATH="${OUT_PATH}.partial.$$"
trap 'rm -f "$TMP_PATH" 2>/dev/null || true' EXIT

# v0.5.38: inner tarball root is now the stable w3forge/ (was w3forge-${VERSION}/).
set +e
node "$PP_DEPLOY_DIR/scripts/admin-console.cjs" archive --root "$PP_DEPLOY_DIR" --prefix "w3forge/" --output "$TMP_PATH"
RC=$?
set -e
if [[ $RC -ne 0 ]]; then
  pp_emit_failure "Verified shared-console source archive failed (rc=$RC)" \
    "branch=${BRANCH}" "version=${VERSION}" "head=${HEAD}" \
    "duration_seconds=$(( $(date +%s) - START ))"
  if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
  exit 1
fi

# Sanity check: tarball is non-empty.
BYTES="$(stat -c%s "$TMP_PATH" 2>/dev/null || wc -c < "$TMP_PATH")"
if [[ -z "$BYTES" || "$BYTES" -lt 1024 ]]; then
  pp_emit_failure "Generated tarball is suspiciously small (${BYTES} bytes)" \
    "branch=${BRANCH}" "version=${VERSION}" "head=${HEAD}" \
    "duration_seconds=$(( $(date +%s) - START ))"
  if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
  exit 1
fi

mv -f "$TMP_PATH" "$OUT_PATH"
trap - EXIT

DURATION=$(( $(date +%s) - START ))
pp_ok "packaged ${OUT_NAME} (${BYTES} bytes, ${DURATION}s) at ${OUT_PATH}"
pp_emit_success "branch=${BRANCH}" "version=${VERSION}" "channel=dev" "head=${HEAD}" \
  "output_path=${OUT_PATH}" "package_path=${OUT_PATH}" \
  "bytes=${BYTES}" "duration_seconds=${DURATION}"

# Populate canonical-trailer state for pp_emit_result.
PP_RES_SOURCE="$PP_SOURCE_TAG"
PP_RES_CHANNEL="dev"
PP_RES_VERSION="$VERSION"
PP_RES_PACKAGE_PATH="$OUT_PATH"
PP_RES_VERIFICATION="skipped"
PP_RES_VERIFICATION_REASON="packaging step; verification runs separately"
PP_RES_DURATION_SECONDS="$DURATION"
if declare -F pp_emit_result >/dev/null 2>&1; then
  # v0.5.38 structured-trailer compatibility: pp_emit_result emits the
  # canonical block (package_path=...) but the backend artifact gate for
  # pipeline-package-dev keys on output_path (see
  # backend/src/admin/controls/safeRunner.ts ARTIFACT_GATES rule). Without
  # output_path the parser reads only the LAST structured block (the
  # canonical one from pp_emit_result), drops the earlier output_path
  # emitted by pp_emit_success, and rejects the run with
  # "Refusing Success: wrapper did not emit output_path...".
  # Pass output_path as an extra key=value so the canonical block carries
  # BOTH output_path and package_path (same value, canonical layout). This
  # is a trailer-shape fix only; verify/deploy/promote/installed-detail
  # behaviour is unchanged and the artifact gate still enforces the
  # approved /opt/w3forge-update-packages/dev/<v>/ root.
  pp_emit_result "success" "packaged ${OUT_NAME}" \
    "branch=${BRANCH}" "head=${HEAD}" "bytes=${BYTES}" \
    "output_path=${OUT_PATH}"
fi

if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
exit 0
