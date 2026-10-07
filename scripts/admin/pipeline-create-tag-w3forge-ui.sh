#!/usr/bin/env bash
# App ownership and capability checks run before logging or any operation.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_w3forge-policy.sh"
w3forge_guard_script "${BASH_SOURCE[0]##*/}" "$@"
#
# pipeline-create-tag-w3forge-ui.sh
#
# W3 Core v0.5.29 — Release Pipeline UI wrapper: Create Tag.
#
# HIGH-risk. Creates a SIGNED-INTENT annotated tag (-a) on HEAD of the
# CURRENT branch in /opt/w3forge-deploy, then pushes it to origin.
#
# Safety:
#   - --tag <vX.Y.Z> is REQUIRED and must match vX.Y.Z exactly.
#   - The current branch MUST be a dev/vX.Y.Z branch matching the tag
#     numerically. (Tag vA.B.C → branch must be dev/vA.B.C.) This is the
#     core release-engineering invariant: tags are only minted from the
#     dev/vX.Y.Z branch that produced them.
#   - 'main' is HARD-REFUSED (defence-in-depth — pp_validate_dev_branch
#     would already reject 'main').
#   - Working tree must be clean (no tagging dirty trees).
#   - Tag must NOT already exist locally OR on origin. Force-replace tags
#     is NEVER supported by this wrapper.
#   - --force is NEVER passed to git tag or git push.
#   - Never touches /opt/w3forge (runtime).
#
# Argv:
#   --yes --request-id <id> [--source ui|api|cli] --tag <vX.Y.Z> [--message <msg>]
#
# Output:
#   ===STRUCTURED-RESULT===
#   status=success|failed|blocked
#   request_id=<id>
#   tag=<vX.Y.Z>
#   branch=<dev/vX.Y.Z>
#   head=<sha>
#   pushed=true|false
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
MESSAGE=""
while [[ $# -gt 0 ]]; do
  if pp_consume_common_arg "$@"; then shift "$PP_CONSUMED"; continue; fi
  case "$1" in
    --tag)     [[ $# -ge 2 ]] || pp_fail "--tag requires a value" 2
               TAG="$2"; shift 2 ;;
    --message) [[ $# -ge 2 ]] || pp_fail "--message requires a value" 2
               MESSAGE="$2"; shift 2 ;;
    help|-h|--help) echo "pipeline-create-tag-w3forge-ui.sh --yes --request-id <id> --tag vX.Y.Z [--message <msg>]"; exit 0 ;;
    *) pp_fail "Unknown argument: $1" 2 ;;
  esac
done
pp_require_yes
pp_require_deploy_dir
pp_validate_tag "$TAG"

# Default annotation message.
if [[ -z "$MESSAGE" ]]; then
  MESSAGE="W3 Forge ${TAG}"
fi

# Reject overly long / multi-line messages defensively.
if [[ ${#MESSAGE} -gt 200 ]]; then
  pp_fail "--message is too long (max 200 chars)" 2
fi
if [[ "$MESSAGE" == *$'\n'* ]]; then
  pp_fail "--message may not contain newlines" 2
fi

CUR_BRANCH="$(pp_current_branch)"
pp_info "request-id      : $PP_REQUEST_ID"
pp_info "source          : $PP_SOURCE_TAG"
pp_info "tag             : $TAG"
pp_info "current branch  : $CUR_BRANCH"

# Hard refuse main.
if [[ "$CUR_BRANCH" == "main" ]]; then
  pp_emit_blocked "Refusing to create tag: current branch is main" \
    "tag=${TAG}" "branch=${CUR_BRANCH}"
  if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
  exit 1
fi

# Current branch must be a dev/vX.Y.Z branch — and must match the tag.
if ! [[ "$CUR_BRANCH" =~ $PP_DEV_BRANCH_REGEX ]]; then
  pp_emit_blocked "Current branch (${CUR_BRANCH}) is not a dev/vX.Y.Z branch. Tags may only be cut from dev branches." \
    "tag=${TAG}" "branch=${CUR_BRANCH}"
  if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
  exit 1
fi

EXPECTED_BRANCH="dev/${TAG}"
if [[ "$CUR_BRANCH" != "$EXPECTED_BRANCH" ]]; then
  pp_emit_blocked "Tag ${TAG} may only be cut from ${EXPECTED_BRANCH}, but current branch is ${CUR_BRANCH}" \
    "tag=${TAG}" "branch=${CUR_BRANCH}"
  if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
  exit 1
fi

# Working tree must be clean — never tag dirty state.
if ! pp_working_tree_clean; then
  pp_warn "Working tree is dirty; refusing to create tag"
  pp_emit_blocked "Working tree is dirty. Commit or reset before tagging." \
    "tag=${TAG}" "branch=${CUR_BRANCH}"
  if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
  exit 1
fi

START=$(date +%s)

# Refresh tags from origin so we know the up-to-date remote state.
set +e
GIT_TERMINAL_PROMPT=0 timeout 30s git -C "$PP_DEPLOY_DIR" fetch --prune --tags origin >/dev/null 2>&1
set -e

# Refuse if tag already exists locally.
if pp_git show-ref --verify --quiet "refs/tags/${TAG}"; then
  pp_emit_blocked "Tag ${TAG} already exists locally. Force-replace is not supported." \
    "tag=${TAG}" "branch=${CUR_BRANCH}" \
    "duration_seconds=$(( $(date +%s) - START ))"
  if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
  exit 1
fi

# Refuse if tag already exists on origin.
set +e
GIT_TERMINAL_PROMPT=0 timeout 15s git -C "$PP_DEPLOY_DIR" ls-remote --exit-code --tags origin "refs/tags/${TAG}" >/dev/null 2>&1
LSR_RC=$?
set -e
if [[ $LSR_RC -eq 0 ]]; then
  pp_emit_blocked "Tag ${TAG} already exists on origin. Force-replace is not supported." \
    "tag=${TAG}" "branch=${CUR_BRANCH}" \
    "duration_seconds=$(( $(date +%s) - START ))"
  if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
  exit 1
fi

HEAD="$(pp_head_short)"
pp_info "HEAD            : $HEAD"

# Create annotated tag at HEAD (no --force).
set +e
TAG_OUT="$(GIT_TERMINAL_PROMPT=0 timeout 15s git -C "$PP_DEPLOY_DIR" tag -a "$TAG" -m "$MESSAGE" HEAD 2>&1)"
TAG_RC=$?
set -e
echo "$TAG_OUT"

if [[ $TAG_RC -ne 0 ]]; then
  pp_emit_failure "git tag failed" \
    "tag=${TAG}" "branch=${CUR_BRANCH}" "head=${HEAD}" "pushed=false" \
    "duration_seconds=$(( $(date +%s) - START ))"
  if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
  exit 1
fi

# Push the tag (and ONLY the tag) to origin. No --force.
set +e
PUSH_OUT="$(GIT_TERMINAL_PROMPT=0 timeout 60s git -C "$PP_DEPLOY_DIR" push origin "refs/tags/${TAG}" 2>&1)"
PUSH_RC=$?
set -e
echo "$PUSH_OUT"

END=$(date +%s); DURATION=$(( END - START ))

if [[ $PUSH_RC -ne 0 ]]; then
  # Tag exists locally now; surface that the push failed so the operator
  # can decide whether to retry-push or delete-local.
  pp_emit_failure "git push of tag ${TAG} failed (tag exists LOCALLY only; delete-tag may be needed)" \
    "tag=${TAG}" "branch=${CUR_BRANCH}" "head=${HEAD}" "pushed=false" \
    "duration_seconds=${DURATION}"
  if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
  exit 1
fi

pp_ok "created and pushed tag $TAG @ $HEAD (${DURATION}s)"
pp_emit_success "tag=${TAG}" "branch=${CUR_BRANCH}" "head=${HEAD}" "pushed=true" \
  "duration_seconds=${DURATION}"

if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
exit 0
