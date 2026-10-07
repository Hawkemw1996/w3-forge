#!/usr/bin/env bash
# App ownership and capability checks run before logging or any operation.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_w3forge-policy.sh"
w3forge_guard_script "${BASH_SOURCE[0]##*/}" "$@"
#
# pipeline-delete-tag-w3forge-ui.sh
#
# W3 Core v0.5.29 — Release Pipeline UI wrapper: Delete Tag.
#
# HIGH-risk. Deletes a tag locally (in /opt/w3forge-deploy) AND on origin.
#
# Safety:
#   - --tag <vX.Y.Z> is REQUIRED and must match vX.Y.Z exactly.
#   - --confirm DELETE-TAG is REQUIRED (typed phrase) in addition to --yes.
#     This is a destructive remote operation, so we require an explicit
#     confirmation token that can ONLY come from a deliberate caller.
#   - Never operates on the LATEST PRODUCTION tag without --allow-prod, and
#     this wrapper deliberately omits --allow-prod (force the operator to
#     fall back to terminal for that edge case).
#   - Never touches /opt/w3forge (runtime).
#
# Argv:
#   --yes --request-id <id> [--source ui|api|cli]
#   --tag <vX.Y.Z> --confirm DELETE-TAG
#
# Output:
#   ===STRUCTURED-RESULT===
#   status=success|failed|blocked
#   request_id=<id>
#   tag=<vX.Y.Z>
#   deleted_local=true|false
#   deleted_remote=true|false
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

TAG=""
CONFIRM=""
while [[ $# -gt 0 ]]; do
  if pp_consume_common_arg "$@"; then shift "$PP_CONSUMED"; continue; fi
  case "$1" in
    --tag)     [[ $# -ge 2 ]] || pp_fail "--tag requires a value" 2
               TAG="$2"; shift 2 ;;
    --confirm) [[ $# -ge 2 ]] || pp_fail "--confirm requires a value" 2
               CONFIRM="$2"; shift 2 ;;
    help|-h|--help) echo "pipeline-delete-tag-w3forge-ui.sh --yes --request-id <id> --tag vX.Y.Z --confirm DELETE-TAG"; exit 0 ;;
    *) pp_fail "Unknown argument: $1" 2 ;;
  esac
done
pp_require_yes
pp_require_deploy_dir
pp_validate_tag "$TAG"

if [[ "$CONFIRM" != "DELETE-TAG" ]]; then
  pp_emit_blocked "Refusing to delete tag without --confirm DELETE-TAG" \
    "tag=${TAG}" "deleted_local=false" "deleted_remote=false"
  if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
  exit 1
fi

pp_info "request-id      : $PP_REQUEST_ID"
pp_info "source          : $PP_SOURCE_TAG"
pp_info "tag             : $TAG"

START=$(date +%s)

# Refresh tag state from origin.
set +e
GIT_TERMINAL_PROMPT=0 timeout 30s git -C "$PP_DEPLOY_DIR" fetch --prune --tags origin >/dev/null 2>&1
set -e

LOCAL_EXISTS=0
REMOTE_EXISTS=0
if pp_git show-ref --verify --quiet "refs/tags/${TAG}"; then LOCAL_EXISTS=1; fi
set +e
GIT_TERMINAL_PROMPT=0 timeout 15s git -C "$PP_DEPLOY_DIR" ls-remote --exit-code --tags origin "refs/tags/${TAG}" >/dev/null 2>&1
[[ $? -eq 0 ]] && REMOTE_EXISTS=1
set -e

if [[ $LOCAL_EXISTS -eq 0 && $REMOTE_EXISTS -eq 0 ]]; then
  pp_emit_blocked "Tag ${TAG} does not exist locally or on origin — nothing to delete" \
    "tag=${TAG}" "deleted_local=false" "deleted_remote=false" \
    "duration_seconds=$(( $(date +%s) - START ))"
  if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
  exit 1
fi

DELETED_LOCAL=false
DELETED_REMOTE=false

# Delete local tag (if present).
if [[ $LOCAL_EXISTS -eq 1 ]]; then
  set +e
  TAG_OUT="$(GIT_TERMINAL_PROMPT=0 timeout 15s git -C "$PP_DEPLOY_DIR" tag -d "$TAG" 2>&1)"
  TAG_RC=$?
  set -e
  echo "$TAG_OUT"
  if [[ $TAG_RC -ne 0 ]]; then
    pp_emit_failure "git tag -d ${TAG} failed" \
      "tag=${TAG}" "deleted_local=false" "deleted_remote=false" \
      "duration_seconds=$(( $(date +%s) - START ))"
    if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
    exit 1
  fi
  DELETED_LOCAL=true
fi

# Delete remote tag (if present).
if [[ $REMOTE_EXISTS -eq 1 ]]; then
  set +e
  PUSH_OUT="$(GIT_TERMINAL_PROMPT=0 timeout 60s git -C "$PP_DEPLOY_DIR" push origin ":refs/tags/${TAG}" 2>&1)"
  PUSH_RC=$?
  set -e
  echo "$PUSH_OUT"
  if [[ $PUSH_RC -ne 0 ]]; then
    pp_emit_failure "git push origin :refs/tags/${TAG} failed" \
      "tag=${TAG}" "deleted_local=${DELETED_LOCAL}" "deleted_remote=false" \
      "duration_seconds=$(( $(date +%s) - START ))"
    if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
    exit 1
  fi
  DELETED_REMOTE=true
fi

END=$(date +%s); DURATION=$(( END - START ))

pp_ok "deleted tag $TAG (local=$DELETED_LOCAL, remote=$DELETED_REMOTE, ${DURATION}s)"
pp_emit_success "tag=${TAG}" "deleted_local=${DELETED_LOCAL}" \
  "deleted_remote=${DELETED_REMOTE}" "duration_seconds=${DURATION}"

if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
exit 0
