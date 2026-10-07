#!/usr/bin/env bash
# App ownership and capability checks run before logging or any operation.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_w3forge-policy.sh"
w3forge_guard_script "${BASH_SOURCE[0]##*/}" "$@"
#
# pipeline-pull-latest-w3forge-ui.sh
#
# W3 Core v0.5.29 — Release Pipeline UI wrapper: Pull Latest.
#
# MEDIUM-risk. Pulls the latest commits for the CURRENTLY checked-out
# branch in /opt/w3forge-deploy with a fast-forward-only pull.
#
# Safety:
#   - HARD-REFUSE if current branch is 'main' (server-side enforced too).
#   - HARD-REFUSE if current branch does not match dev/vX.Y.Z.
#   - HARD-REFUSE if working tree is dirty unless --allow-dirty was passed
#     (only the safe-pipeline runner can pass --allow-dirty after explicit
#     reset confirmation; the UI does NOT expose --allow-dirty today).
#   - Uses `git pull --ff-only --no-tags --no-rebase` so it can never rewrite
#     history.
#   - Never touches /opt/w3forge (runtime).
#
# Argv contract:
#   --yes --request-id <id> [--source ui|api|cli] [--allow-dirty]
#
# Output:
#   ===STRUCTURED-RESULT===
#   status=success|failed|blocked
#   request_id=<id>
#   branch=<name>
#   head_before=<sha>
#   head_after=<sha>
#   commits_pulled=<n>
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

ALLOW_DIRTY=""
while [[ $# -gt 0 ]]; do
  if pp_consume_common_arg "$@"; then shift "$PP_CONSUMED"; continue; fi
  case "$1" in
    --allow-dirty) ALLOW_DIRTY="1"; shift ;;
    help|-h|--help) echo "pipeline-pull-latest-w3forge-ui.sh --yes --request-id <id>"; exit 0 ;;
    *) pp_fail "Unknown argument: $1" 2 ;;
  esac
done
pp_require_yes
pp_require_deploy_dir

BRANCH="$(pp_current_branch)"
pp_info "request-id    : $PP_REQUEST_ID"
pp_info "source        : $PP_SOURCE_TAG"
pp_info "current branch: $BRANCH"

# Hard branch fence.
if [[ "$BRANCH" == "main" ]]; then
  pp_warn "Refusing to pull on main"
  pp_emit_blocked "Refusing to pull on main. Only dev/vX.Y.Z branches are permitted." \
    "branch=${BRANCH}"
  if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
  exit 1
fi
# Use case-insensitive guard via the validator, but fall through gracefully
# rather than calling pp_fail so we can emit a structured blocked trailer.
if ! [[ "$BRANCH" =~ $PP_DEV_BRANCH_REGEX ]]; then
  pp_warn "Current branch does not match dev/vX.Y.Z"
  pp_emit_blocked "Refusing to pull: current branch (${BRANCH}) does not match dev/vX.Y.Z." \
    "branch=${BRANCH}"
  if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
  exit 1
fi

# Dirty-tree fence.
if ! pp_working_tree_clean; then
  if [[ -z "$ALLOW_DIRTY" ]]; then
    pp_warn "Working tree is dirty; refusing to pull"
    pp_emit_blocked "Working tree is dirty. Reset or commit before pulling, or pass --allow-dirty." \
      "branch=${BRANCH}"
    if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
    exit 1
  fi
  pp_warn "Working tree is dirty but --allow-dirty was supplied"
fi

HEAD_BEFORE="$(pp_head_short)"
START=$(date +%s)

# Step 1: fetch (metadata only)
set +e
FETCH_OUT="$(GIT_TERMINAL_PROMPT=0 timeout 30s git -C "$PP_DEPLOY_DIR" fetch --prune origin 2>&1)"
FETCH_RC=$?
set -e
if [[ $FETCH_RC -ne 0 ]]; then
  echo "$FETCH_OUT" | head -50
  pp_emit_failure "git fetch failed" "branch=${BRANCH}" "head_before=${HEAD_BEFORE}" \
    "head_after=${HEAD_BEFORE}" "commits_pulled=0" \
    "duration_seconds=$(( $(date +%s) - START ))"
  if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
  exit 1
fi

# Step 2: fast-forward-only pull
set +e
PULL_OUT="$(GIT_TERMINAL_PROMPT=0 timeout 60s git -C "$PP_DEPLOY_DIR" pull --ff-only --no-tags --no-rebase origin "$BRANCH" 2>&1)"
PULL_RC=$?
set -e
echo "$PULL_OUT"

END=$(date +%s); DURATION=$(( END - START ))
HEAD_AFTER="$(pp_head_short)"

if [[ $PULL_RC -ne 0 ]]; then
  pp_emit_failure "git pull --ff-only failed" "branch=${BRANCH}" \
    "head_before=${HEAD_BEFORE}" "head_after=${HEAD_AFTER}" "commits_pulled=0" \
    "duration_seconds=${DURATION}"
  if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
  exit 1
fi

# Count commits between before/after (defensive — if before==after, zero).
COMMITS=0
if [[ -n "$HEAD_BEFORE" && -n "$HEAD_AFTER" && "$HEAD_BEFORE" != "$HEAD_AFTER" ]]; then
  COMMITS=$(pp_git rev-list --count "${HEAD_BEFORE}..${HEAD_AFTER}" 2>/dev/null || echo 0)
fi

pp_ok "pull complete (${HEAD_BEFORE} -> ${HEAD_AFTER}, ${COMMITS} commits, ${DURATION}s)"
pp_emit_success "branch=${BRANCH}" "head_before=${HEAD_BEFORE}" \
  "head_after=${HEAD_AFTER}" "commits_pulled=${COMMITS}" \
  "duration_seconds=${DURATION}"

if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
exit 0
