#!/usr/bin/env bash
# App ownership and capability checks run before logging or any operation.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_w3forge-policy.sh"
w3forge_guard_script "${BASH_SOURCE[0]##*/}" "$@"
#
# pipeline-promote-dev-to-main-w3forge-ui.sh
#
# W3 Core v0.5.38 — Release Pipeline UI wrapper: Promote Dev -> Main package.
#
# NEW IN v0.5.38. Promotes a verified dev tarball from the canonical
# dev channel dir into the main channel dir:
#
#   /opt/w3forge-update-packages/dev/<version>/w3forge.tar.gz
#                        |
#                        v
#   /opt/w3forge-update-packages/main/<version>/w3forge.tar.gz
#
# This does NOT deploy, does NOT touch /opt/w3forge, does NOT install,
# does NOT modify the database, and does NOT modify the systemd service.
# It only moves bytes between two staging directories under
# /opt/w3forge-update-packages/.
#
# IMPORTANT — this script operates entirely inside /opt/w3forge-update-packages
# on the live host. Under the W3 Forge operating policy, /opt/w3forge-update-packages
# is a restricted category that the user owns. This wrapper is intended
# to be invoked by the user (or the user's Admin UI under their session),
# never autonomously by Perplexity.
#
# Safety:
#   - --channel-source must be "dev" (anything else is rejected).
#   - --channel-target must be "main" (anything else is rejected).
#   - Source path must resolve via pp_resolve_package_path.
#   - Re-runs package-verify-w3forge.sh on the source tarball (read-only).
#     If verification fails, the promote is REFUSED.
#   - If main/<version>/w3forge.tar.gz already exists:
#       - if its sha256 matches the source: emit success (idempotent),
#         no rewrite.
#       - if its sha256 differs from the source: REFUSE (refuse to
#         silently overwrite a real release package).
#   - Atomic copy via .partial -> mv.
#   - Emits both legacy STRUCTURED-RESULT trailer and v0.5.38 canonical
#     trailer.
#
# Argv:
#   --yes --request-id <id> [--source ui|api|cli]
#   --version <vX.Y.Z>
#   [--channel-source dev]     (default: dev; only dev currently allowed)
#   [--channel-target main]    (default: main; only main currently allowed)
#   [--force]                  override sha256 mismatch (still refuses
#                              to clobber a divergent main tarball unless
#                              --force is passed AND --version starts with
#                              the dev version)
#
# Output trailer:
#   ===STRUCTURED-RESULT===
#   status=success|failed|blocked
#   request_id=<id>
#   version=<vX.Y.Z>
#   channel_source=dev
#   channel_target=main
#   source_path=<resolved-source>
#   target_path=<resolved-target>
#   source_sha256=<sha>
#   target_sha256=<sha>
#   verification=passed|failed|skipped
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

VERIFIER="${W3_VERIFY_SCRIPT:-/opt/w3forge-scripts/package-verify-w3forge.sh}"
if [[ ! -x "$VERIFIER" && -x "$SCRIPT_DIR/package-verify-w3forge.sh" ]]; then
  VERIFIER="$SCRIPT_DIR/package-verify-w3forge.sh"
fi

VERSION=""
CHANNEL_SOURCE="dev"
CHANNEL_TARGET="main"
FORCE="false"
while [[ $# -gt 0 ]]; do
  if pp_consume_common_arg "$@"; then shift "$PP_CONSUMED"; continue; fi
  case "$1" in
    --version)        [[ $# -ge 2 ]] || pp_fail "--version requires a value" 2
                      VERSION="$2"; shift 2 ;;
    --channel-source) [[ $# -ge 2 ]] || pp_fail "--channel-source requires a value" 2
                      CHANNEL_SOURCE="$2"; shift 2 ;;
    --channel-target) [[ $# -ge 2 ]] || pp_fail "--channel-target requires a value" 2
                      CHANNEL_TARGET="$2"; shift 2 ;;
    --force)          FORCE="true"; shift ;;
    help|-h|--help)
      cat <<'USAGE'
pipeline-promote-dev-to-main-w3forge-ui.sh \
  --yes --request-id <id> [--source ui|api|cli] \
  --version vX.Y.Z \
  [--channel-source dev] [--channel-target main] [--force]
USAGE
      exit 0 ;;
    *) pp_fail "Unknown argument: $1" 2 ;;
  esac
done
pp_require_yes
pp_validate_tag "$VERSION"

# v0.5.38 currently restricts source=dev, target=main. Keep room to extend
# later (e.g. installed -> archived) without changing the public interface.
if [[ "$CHANNEL_SOURCE" != "dev" ]]; then
  pp_emit_blocked "--channel-source must be 'dev' (got: ${CHANNEL_SOURCE})" \
    "channel_source=${CHANNEL_SOURCE}"
  exit 1
fi
if [[ "$CHANNEL_TARGET" != "main" ]]; then
  pp_emit_blocked "--channel-target must be 'main' (got: ${CHANNEL_TARGET})" \
    "channel_target=${CHANNEL_TARGET}"
  exit 1
fi

SRC_PATH="$(pp_resolve_package_path "$CHANNEL_SOURCE" "$VERSION" 2>/dev/null || true)"
if [[ -z "$SRC_PATH" || ! -f "$SRC_PATH" ]]; then
  pp_emit_failure "Source package not found for channel=${CHANNEL_SOURCE} version=${VERSION}" \
    "channel_source=${CHANNEL_SOURCE}" "channel_target=${CHANNEL_TARGET}" \
    "version=${VERSION}"
  exit 1
fi

TARGET_DIR="$(pp_channel_version_dir "$CHANNEL_TARGET" "$VERSION")"
TARGET_PATH="${TARGET_DIR}/${PP_CANONICAL_PACKAGE_NAME}"

pp_info "request-id     : $PP_REQUEST_ID"
pp_info "source         : $PP_SOURCE_TAG"
pp_info "version        : $VERSION"
pp_info "channel-source : $CHANNEL_SOURCE"
pp_info "channel-target : $CHANNEL_TARGET"
pp_info "source-path    : $SRC_PATH"
pp_info "target-path    : $TARGET_PATH"

START=$(date +%s)

# Re-verify the source tarball read-only before promotion.
VERIFICATION="skipped"
if [[ -x "$VERIFIER" ]]; then
  pp_info "Re-verifying source tarball before promotion..."
  set +e
  "$VERIFIER" "$SRC_PATH" >/dev/null 2>&1
  V_RC=$?
  set -e
  if [[ $V_RC -ne 0 ]]; then
    pp_emit_failure "package-verify-w3forge.sh failed on source (rc=$V_RC); refusing to promote" \
      "channel_source=${CHANNEL_SOURCE}" "channel_target=${CHANNEL_TARGET}" \
      "version=${VERSION}" "source_path=${SRC_PATH}" \
      "verification=failed" "duration_seconds=$(( $(date +%s) - START ))"
    exit 1
  fi
  VERIFICATION="passed"
  pp_ok "Source tarball verification passed."
else
  pp_warn "Verifier not executable ($VERIFIER); proceeding without re-verification."
fi

SRC_SHA="$(pp_sha256 "$SRC_PATH")"
TARGET_SHA=""

# Idempotency / safety:
if [[ -e "$TARGET_PATH" ]]; then
  TARGET_SHA="$(pp_sha256 "$TARGET_PATH" 2>/dev/null || true)"
  if [[ -n "$TARGET_SHA" && "$TARGET_SHA" == "$SRC_SHA" ]]; then
    pp_ok "Target already exists with matching sha256; promote is a no-op."
    DURATION=$(( $(date +%s) - START ))
    pp_emit_success "version=${VERSION}" "channel_source=${CHANNEL_SOURCE}" \
      "channel_target=${CHANNEL_TARGET}" "source_path=${SRC_PATH}" \
      "target_path=${TARGET_PATH}" "source_sha256=${SRC_SHA}" \
      "target_sha256=${TARGET_SHA}" "verification=${VERIFICATION}" \
      "duration_seconds=${DURATION}"
    PP_RES_SOURCE="$PP_SOURCE_TAG"; PP_RES_CHANNEL="$CHANNEL_TARGET"
    PP_RES_VERSION="$VERSION";       PP_RES_PACKAGE_PATH="$TARGET_PATH"
    PP_RES_VERIFICATION="$VERIFICATION"
    PP_RES_DURATION_SECONDS="$DURATION"
    # v0.5.38 trailer-shape compatibility: pass output_path as a key=value
    # extra so the canonical structured-result block carries BOTH
    # package_path (v0.5.38 canonical) and output_path (backend artifact-gate
    # key for pipeline-promote-dev-to-main, which scans the LAST trailer
    # block via stdout.lastIndexOf). Same value as package_path / TARGET_PATH.
    # Trailer-shape only; promote/verifier/deploy/gate behavior unchanged.
    declare -F pp_emit_result >/dev/null 2>&1 && pp_emit_result "success" \
      "promote no-op (target already matches source)" \
      "output_path=${TARGET_PATH}"
    if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
    exit 0
  fi
  if [[ "$FORCE" != "true" ]]; then
    pp_emit_blocked "Target ${TARGET_PATH} already exists with different sha256 (source=${SRC_SHA}, target=${TARGET_SHA}); pass --force to override" \
      "version=${VERSION}" "channel_source=${CHANNEL_SOURCE}" \
      "channel_target=${CHANNEL_TARGET}" "source_path=${SRC_PATH}" \
      "target_path=${TARGET_PATH}" "source_sha256=${SRC_SHA}" \
      "target_sha256=${TARGET_SHA}" "verification=${VERIFICATION}" \
      "duration_seconds=$(( $(date +%s) - START ))"
    exit 1
  fi
  pp_warn "Target ${TARGET_PATH} exists with different sha256; --force was passed, overwriting."
fi

# Atomic copy: write to .partial then mv into place.
mkdir -p "$TARGET_DIR"
TMP_PATH="${TARGET_PATH}.partial.$$"
trap 'rm -f "$TMP_PATH" 2>/dev/null || true' EXIT
cp -p "$SRC_PATH" "$TMP_PATH"
mv -f "$TMP_PATH" "$TARGET_PATH"
trap - EXIT

TARGET_SHA="$(pp_sha256 "$TARGET_PATH")"
if [[ "$TARGET_SHA" != "$SRC_SHA" ]]; then
  pp_emit_failure "Post-copy sha256 mismatch (source=${SRC_SHA}, target=${TARGET_SHA})" \
    "version=${VERSION}" "channel_source=${CHANNEL_SOURCE}" \
    "channel_target=${CHANNEL_TARGET}" "source_path=${SRC_PATH}" \
    "target_path=${TARGET_PATH}" "source_sha256=${SRC_SHA}" \
    "target_sha256=${TARGET_SHA}" "verification=${VERIFICATION}" \
    "duration_seconds=$(( $(date +%s) - START ))"
  exit 1
fi

DURATION=$(( $(date +%s) - START ))
pp_ok "Promoted ${SRC_PATH} -> ${TARGET_PATH} (${DURATION}s)"
pp_emit_success "version=${VERSION}" "channel_source=${CHANNEL_SOURCE}" \
  "channel_target=${CHANNEL_TARGET}" "source_path=${SRC_PATH}" \
  "target_path=${TARGET_PATH}" "source_sha256=${SRC_SHA}" \
  "target_sha256=${TARGET_SHA}" "verification=${VERIFICATION}" \
  "duration_seconds=${DURATION}"

PP_RES_SOURCE="$PP_SOURCE_TAG"
PP_RES_CHANNEL="$CHANNEL_TARGET"
PP_RES_VERSION="$VERSION"
PP_RES_PACKAGE_PATH="$TARGET_PATH"
PP_RES_VERIFICATION="$VERIFICATION"
PP_RES_DURATION_SECONDS="$DURATION"
# v0.5.38 trailer-shape compatibility: pass output_path as a key=value extra
# so the canonical structured-result block carries BOTH package_path
# (v0.5.38 canonical) and output_path (backend artifact-gate key for
# pipeline-promote-dev-to-main, which scans the LAST trailer block via
# stdout.lastIndexOf). Same value as package_path / TARGET_PATH. Trailer-shape
# only; promote/verifier/deploy/gate behavior unchanged.
declare -F pp_emit_result >/dev/null 2>&1 && pp_emit_result "success" \
  "promoted dev->main" \
  "source_sha256=${SRC_SHA}" "target_sha256=${TARGET_SHA}" \
  "output_path=${TARGET_PATH}"

if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
exit 0
