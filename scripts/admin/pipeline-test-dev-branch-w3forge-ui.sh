#!/usr/bin/env bash
# App ownership and capability checks run before logging or any operation.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_w3forge-policy.sh"
w3forge_guard_script "${BASH_SOURCE[0]##*/}" "$@"
#
# pipeline-test-dev-branch-w3forge-ui.sh
#
# W3 Core v0.5.29 — Release Pipeline UI wrapper: Test Dev Branch.
#
# MEDIUM-risk. Tests an exact, credential-free development snapshot as a
# separate build account. Uses one deterministic workspace install and a
# persistent installation-scoped npm content cache. Existing policy, branch,
# confirmation and logging checks run before the trusted supervisor.
#
# Argv:
#   --yes --request-id <id> [--source ui|api|cli]
#
# Output:
#   ===STRUCTURED-RESULT===
#   status=success|failed|blocked
#   request_id=<id>
#   branch=<name>
#   head=<sha>
#   install_ok=true|false
#   lint_ok=true|false
#   test_ok=true|false
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

while [[ $# -gt 0 ]]; do
  if pp_consume_common_arg "$@"; then shift "$PP_CONSUMED"; continue; fi
  case "$1" in
    help|-h|--help) echo "pipeline-test-dev-branch-w3forge-ui.sh --yes --request-id <id>"; exit 0 ;;
    *) pp_fail "Unknown argument: $1" 2 ;;
  esac
done
pp_require_yes
pp_require_deploy_dir

BRANCH="$(pp_current_branch)"
if [[ "$BRANCH" == "main" ]]; then
  pp_emit_blocked "Refusing to run tests on main. Only dev/vX.Y.Z branches." "branch=${BRANCH}"
  if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
  exit 1
fi
if ! [[ "$BRANCH" =~ $PP_DEV_BRANCH_REGEX ]]; then
  pp_emit_blocked "Current branch (${BRANCH}) does not match dev/vX.Y.Z" "branch=${BRANCH}"
  if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
  exit 1
fi

HEAD="$(pp_head_short)"
pp_info "request-id : $PP_REQUEST_ID"
pp_info "source     : $PP_SOURCE_TAG"
pp_info "branch     : $BRANCH @ $HEAD"

# The separately installed supervisor verifies source, drops privilege and delegates
# to the manifest-verified common worker. No install/test runs in this checkout.
set +e
/usr/bin/node "$SCRIPT_DIR/test-dev-host.cjs" w3forge "$PP_REQUEST_ID"
TEST_HOST_RC=$?
set -e
if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
exit "$TEST_HOST_RC"
