#!/usr/bin/env bash
# App ownership and capability checks run before logging or any operation.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_w3forge-policy.sh"
w3forge_guard_script "${BASH_SOURCE[0]##*/}" "$@"
#
# pipeline-checkout-dev-branch-w3forge-ui.sh
#
# W3 Core v0.5.29 — Release Pipeline UI wrapper: Checkout Dev Branch.
#
# MEDIUM-risk. Checks out an existing remote dev/vX.Y.Z branch in
# /opt/w3forge-deploy.
#
# Safety:
#   - --branch <dev/vX.Y.Z> is REQUIRED and must match dev/vX.Y.Z exactly.
#   - 'main' is HARD-REFUSED.
#   - Working tree must be clean (no --allow-dirty escape hatch here:
#     switching branches with a dirty tree is operator-only).
#   - Branch must already exist on origin (verified via `git ls-remote
#     --exit-code --heads origin <branch>`).
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
#   previous_branch=<name>
#   head=<sha>
#   tracking=<remote/branch or "">
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
    help|-h|--help) echo "pipeline-checkout-dev-branch-w3forge-ui.sh --yes --request-id <id> --branch dev/vX.Y.Z"; exit 0 ;;
    *) pp_fail "Unknown argument: $1" 2 ;;
  esac
done
pp_require_yes
pp_require_deploy_dir
pp_validate_dev_branch "$BRANCH"

PREV_BRANCH="$(pp_current_branch)"
pp_info "request-id      : $PP_REQUEST_ID"
pp_info "source          : $PP_SOURCE_TAG"
pp_info "previous branch : $PREV_BRANCH"
pp_info "target branch   : $BRANCH"

# v0.5.38: same-branch idempotent fast-path.
#
# When the deploy clone is ALREADY on the requested dev/vX.Y.Z branch, the
# operator's "Step 2 Checkout Dev Branch" click is a no-op acknowledgment
# rather than a real branch switch. In that case there is no need to fetch,
# checkout, or refuse on a dirty working tree — nothing is going to be
# changed on disk. We emit status=success with an `already_on_branch=true`
# marker so the UI can render "Already on dev/v0.5.38 — no checkout
# required" and gate Step 3 open.
#
# Safety conditions (all required):
#   - PREV_BRANCH equals BRANCH exactly (no rename, no detached-HEAD, no
#     similarly-named branch).
#   - PREV_BRANCH matches the canonical dev/vX.Y.Z regex (main is already
#     hard-refused upstream by pp_validate_dev_branch).
# When BOTH conditions hold, the dirty-tree fence is skipped. On any real
# branch switch (target != current) the original fence below still applies.
if [[ "$PREV_BRANCH" == "$BRANCH" ]] && [[ "$PREV_BRANCH" =~ $PP_DEV_BRANCH_REGEX ]]; then
  HEAD="$(pp_head_short)"
  TRACK="$(pp_git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"
  pp_ok "already on $BRANCH @ $HEAD (no checkout required; tracking ${TRACK:-<none>})"
  pp_emit_success \
    "branch=${BRANCH}" \
    "previous_branch=${PREV_BRANCH}" \
    "head=${HEAD}" \
    "tracking=${TRACK}" \
    "duration_seconds=0" \
    "already_on_branch=true"
  if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
  exit 0
fi

# Dirty-tree fence — checkout is never permitted with uncommitted changes
# WHEN A REAL BRANCH SWITCH IS REQUIRED. The fast-path above covers the
# same-branch acknowledgment case.
if ! pp_working_tree_clean; then
  pp_warn "Working tree is dirty; refusing to checkout"
  pp_emit_blocked "Working tree is dirty. Reset or commit before switching branches." \
    "branch=${BRANCH}" "previous_branch=${PREV_BRANCH}"
  if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
  exit 1
fi

START=$(date +%s)

# Ensure remote-tracking ref exists. Refresh remotes only (no working-tree change).
set +e
GIT_TERMINAL_PROMPT=0 timeout 30s git -C "$PP_DEPLOY_DIR" fetch --prune origin "$BRANCH" >/dev/null 2>&1
FETCH_RC=$?
set -e
if [[ $FETCH_RC -ne 0 ]]; then
  pp_warn "Could not fetch refs for $BRANCH"
  pp_emit_failure "Could not fetch origin/$BRANCH (does it exist on the remote?)" \
    "branch=${BRANCH}" "previous_branch=${PREV_BRANCH}" \
    "duration_seconds=$(( $(date +%s) - START ))"
  if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
  exit 1
fi

# Verify the remote branch actually exists.
set +e
GIT_TERMINAL_PROMPT=0 timeout 15s git -C "$PP_DEPLOY_DIR" ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1
LSREMOTE_RC=$?
set -e
if [[ $LSREMOTE_RC -ne 0 ]]; then
  pp_emit_failure "Remote branch origin/${BRANCH} does not exist" \
    "branch=${BRANCH}" "previous_branch=${PREV_BRANCH}" \
    "duration_seconds=$(( $(date +%s) - START ))"
  if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
  exit 1
fi

# Checkout: prefer existing local branch; otherwise create from origin tracking.
if pp_git show-ref --verify --quiet "refs/heads/$BRANCH"; then
  set +e
  CO_OUT="$(GIT_TERMINAL_PROMPT=0 timeout 30s git -C "$PP_DEPLOY_DIR" checkout "$BRANCH" 2>&1)"
  CO_RC=$?
  set -e
else
  set +e
  CO_OUT="$(GIT_TERMINAL_PROMPT=0 timeout 30s git -C "$PP_DEPLOY_DIR" checkout -B "$BRANCH" --track "origin/$BRANCH" 2>&1)"
  CO_RC=$?
  set -e
fi
echo "$CO_OUT"

END=$(date +%s); DURATION=$(( END - START ))

if [[ $CO_RC -ne 0 ]]; then
  pp_emit_failure "git checkout failed" "branch=${BRANCH}" \
    "previous_branch=${PREV_BRANCH}" "duration_seconds=${DURATION}"
  if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
  exit 1
fi

HEAD="$(pp_head_short)"
TRACK="$(pp_git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"

pp_ok "now on $BRANCH @ $HEAD (tracking ${TRACK:-<none>}, ${DURATION}s)"
pp_emit_success "branch=${BRANCH}" "previous_branch=${PREV_BRANCH}" \
  "head=${HEAD}" "tracking=${TRACK}" "duration_seconds=${DURATION}"

if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
exit 0
