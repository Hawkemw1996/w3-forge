#!/usr/bin/env bash
# App ownership and capability checks run before logging or any operation.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_w3forge-policy.sh"
w3forge_guard_script "${BASH_SOURCE[0]##*/}" "$@"
#
# pipeline-push-dev-branch-w3forge-ui.sh
#
# W3 Core v0.5.29 — Release Pipeline UI wrapper: Push Dev Branch.
#
# MEDIUM-risk. Pushes the CURRENT branch (in /opt/w3forge-deploy) to origin.
#
# Safety:
#   - The CURRENT branch must match dev/vX.Y.Z exactly. 'main' is HARD-REFUSED.
#   - --branch <dev/vX.Y.Z> is REQUIRED and must equal the current branch
#     (defence-in-depth so the UI cannot push the "wrong" branch by accident).
#   - --set-upstream is always passed (-u) — this is a no-op once the branch
#     already tracks origin, and is required on first push.
#   - --force / --force-with-lease are NEVER passed; if origin already has the
#     branch and a fast-forward push is impossible, this script FAILS LOUDLY.
#   - Never touches /opt/w3forge (runtime).
#
# Argv:
#   --yes --request-id <id> [--source ui|api|cli] --branch <dev/vX.Y.Z>
#
# Output:
#   ===STRUCTURED-RESULT===
#   status=success|failed|blocked
#   request_id=<id>
#   branch=<name>
#   head=<sha>
#   pushed=true|false
#   tracking=<remote/branch>
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

BRANCH=""
while [[ $# -gt 0 ]]; do
  if pp_consume_common_arg "$@"; then shift "$PP_CONSUMED"; continue; fi
  case "$1" in
    --branch) [[ $# -ge 2 ]] || pp_fail "--branch requires a value" 2
              BRANCH="$2"; shift 2 ;;
    help|-h|--help) echo "pipeline-push-dev-branch-w3forge-ui.sh --yes --request-id <id> --branch dev/vX.Y.Z"; exit 0 ;;
    *) pp_fail "Unknown argument: $1" 2 ;;
  esac
done
pp_require_yes
pp_require_deploy_dir
pp_validate_dev_branch "$BRANCH"

CUR_BRANCH="$(pp_current_branch)"
pp_info "request-id      : $PP_REQUEST_ID"
pp_info "source          : $PP_SOURCE_TAG"
pp_info "current branch  : $CUR_BRANCH"
pp_info "requested branch: $BRANCH"

# Hard refuse main even if somehow set as current.
if [[ "$CUR_BRANCH" == "main" ]]; then
  pp_emit_blocked "Refusing to push: current branch is main" \
    "branch=${BRANCH}" "current_branch=${CUR_BRANCH}"
  if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
  exit 1
fi

# Defence-in-depth: requested branch MUST equal current branch.
if [[ "$CUR_BRANCH" != "$BRANCH" ]]; then
  pp_emit_blocked "Current branch (${CUR_BRANCH}) does not match requested branch (${BRANCH}). Checkout first." \
    "branch=${BRANCH}" "current_branch=${CUR_BRANCH}"
  if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
  exit 1
fi

HEAD="$(pp_head_short)"
pp_info "HEAD            : $HEAD"

START=$(date +%s)

# Use --set-upstream so first push works; idempotent on subsequent pushes.
# NEVER use --force / --force-with-lease.
set +e
PUSH_OUT="$(GIT_TERMINAL_PROMPT=0 timeout 60s git -C "$PP_DEPLOY_DIR" push --set-upstream origin "$BRANCH" 2>&1)"
PUSH_RC=$?
set -e
echo "$PUSH_OUT"

END=$(date +%s); DURATION=$(( END - START ))

if [[ $PUSH_RC -ne 0 ]]; then
  # Detect non-fast-forward explicitly so the UI can show a clear message.
  REASON="git push failed"
  if echo "$PUSH_OUT" | grep -qiE "non-fast-forward|rejected"; then
    REASON="Push rejected (non-fast-forward). Pull/rebase before retrying. Force-push is not supported."
  fi
  pp_emit_failure "$REASON" \
    "branch=${BRANCH}" "head=${HEAD}" "pushed=false" \
    "duration_seconds=${DURATION}"
  if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
  exit 1
fi

# Resolve final tracking (should be origin/<branch> after -u).
TRACK="$(pp_git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"

pp_ok "pushed $BRANCH @ $HEAD to origin (tracking ${TRACK:-<none>}, ${DURATION}s)"
pp_emit_success "branch=${BRANCH}" "head=${HEAD}" "pushed=true" \
  "tracking=${TRACK}" "duration_seconds=${DURATION}"

if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
exit 0
