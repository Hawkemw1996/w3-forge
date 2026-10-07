#!/usr/bin/env bash
# App ownership and capability checks run before logging or any operation.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_w3forge-policy.sh"
w3forge_guard_script "${BASH_SOURCE[0]##*/}" "$@"
#
# pipeline-deploy-dev-package-w3forge-ui.sh
#
# W3 Core v0.5.38 — Release Pipeline UI wrapper: Deploy Dev/Main Release.
#
# HIGH-risk operation. Delegates the actual deploy to
# deploy-w3forge-noninteractive.sh. Under v0.5.38 the canonical package
# location is:
#
#   /opt/w3forge-update-packages/<channel>/<version>/w3forge.tar.gz
#
# where <channel> is dev | main | installed. Legacy locations
# (/opt/w3forge-update-packages/<channel>/w3forge-<v>.tar.gz and the flat
# /opt/w3forge-update-packages/w3forge-<v>.tar.gz) remain resolvable via the
# pipeline-common resolver for backward compatibility.
#
# This wrapper does NOT touch /opt/w3forge, the DB, the service, or
# release tags directly. It validates inputs, confirms the package
# exists in the requested channel, then shells out to the delegate.
#
# v0.5.38 changes vs prior:
#   - Accepts --channel dev|main|installed (default: dev).
#   - --package is optional (the channel+version path is the source of
#     truth). When provided, the basename is still validated.
#   - The deprecated "stage into flat /opt/w3forge-update-packages/" step has
#     been removed. The delegate reads directly from the channel dir.
#   - The delegate is invoked with the correct non-interactive flags
#     (--non-interactive --yes-i-understand-this-replaces-runtime),
#     fixing a pre-v0.5.38 bug where the delegate refused all UI
#     dev-package deploys due to missing required flags.
#   - Emits BOTH the legacy STRUCTURED-RESULT trailer (for backward
#     compatibility with existing parsers) AND the v0.5.38 canonical
#     trailer via pp_emit_result.
#
# Argv:
#   --yes --request-id <id> [--source ui|api|cli]
#   --version <vX.Y.Z>
#   [--channel dev|main|installed]    (default: dev)
#   [--package <basename>]            (optional legacy basename hint)
#
# Output (legacy trailer; kept for backward compat):
#   ===STRUCTURED-RESULT===
#   status=success|failed|blocked
#   request_id=<id>
#   package=<basename-or-canonical>
#   version=<vX.Y.Z>
#   channel=<dev|main|installed>
#   package_path=<resolved-path>
#   delegate_exit_code=<n>
#   verified=true|false
#   duration_seconds=<n>
#   ===END===
#
# Plus the v0.5.38 canonical trailer emitted by pp_emit_result.
#
# v0.5.39 changes vs v0.5.38:
#   - Permanent fix for Step 7 deploy runtime issue: the wrapper used
#     to resolve the delegate from /opt/w3forge-scripts/, which is populated
#     only when an operator manually runs install-server-scripts.sh.
#     On a dev iteration the /opt/w3forge-scripts/ copy can lag behind the
#     freshly-checked-out source by many commits, so source-level
#     fixes (e.g. the [4b] build phase) never executed even though
#     they were merged.
#   - Step 2 (Checkout Dev Branch) refreshes the dev tree at
#     ${PP_DEPLOY_DIR:-/opt/w3forge-deploy} on every run, which means
#     the freshest delegate copy is at
#       ${PP_DEPLOY_DIR}/scripts/deploy-w3forge-noninteractive.sh
#     The DELEGATE resolver below now prefers that copy, falling back
#     to /opt/w3forge-scripts/ and finally to SCRIPT_DIR for safety.
#   - W3_DEPLOY_NONI_SCRIPT remains an explicit operator/test override
#     and short-circuits the priority chain.
#
# v0.12.5 incident fix vs v0.5.39:
#   - The `systemd-run` invocation below was missing `--no-block`. Per
#     `systemd-run --help`: "--no-block  Do not wait until operation
#     finished" -- without it, systemd-run's default behavior is to
#     synchronously wait for the transient unit's start job to
#     complete. For a Type=oneshot service (used here), the start job
#     does not complete until the ExecStart process itself exits --
#     i.e. until the ENTIRE delegate deploy (including the
#     `systemctl stop w3forge.service` step) has finished. That is
#     precisely the pre-v0.5.38 synchronous-wait bug this wrapper was
#     built to eliminate: this wrapper (and its caller) stayed blocked
#     inside the deploy for its full duration instead of returning
#     immediately after launch, contradicting the "CONTRACT" comment
#     above the systemd-run call below ("Wrapper exits 0 IMMEDIATELY
#     after the transient unit is launched"). Discovered during
#     production recovery from the v0.12.5 DB-hang regression, when
#     the release pipeline's own deploy launcher was found to hang the
#     caller instead of returning promptly. Fix: add `--no-block`,
#     which makes systemd-run return as soon as the transient unit's
#     start job is queued/accepted, matching every other assumption
#     already made by this wrapper's post-launch code (LAUNCH_RC is
#     treated purely as "did the launch succeed", never as the
#     delegate's own outcome; actual deploy success/failure is
#     confirmed separately via /health + /version recovery and the
#     ExecStopPost trailer file). No other systemd-run flag, property,
#     or downstream behavior changes.

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
# Re-export so pp_resolve_package_path sees the same root.
export PP_UPDATE_DIR="$UPDATE_DIR"

# v0.5.39 delegate resolution order (most-fresh first):
#   1. W3_DEPLOY_NONI_SCRIPT env override (operator / test).
#   2. ${PP_DEPLOY_DIR}/scripts/deploy-w3forge-noninteractive.sh --
#      the delegate copy that lives in the active dev checkout.
#      Reflects whatever commit Step 2 (Checkout Dev Branch) just
#      checked out, so source-level fixes land here as soon as they
#      are pulled. PREFERRED.
#   3. /opt/w3forge-scripts/deploy-w3forge-noninteractive.sh -- operator-
#      installed system copy. May be stale until operator runs
#      install-server-scripts.sh; kept as a fallback for hosts that
#      do not have the dev checkout populated.
#   4. $SCRIPT_DIR/deploy-w3forge-noninteractive.sh -- last-resort
#      fallback for the case where this wrapper itself is being
#      executed out-of-tree from a release bundle.
# PP_DEPLOY_DIR is loaded by _w3forge-pipeline-common.sh (sourced
# above) and defaults to /opt/w3forge-deploy.
_NONI_DEPLOY_DIR="${PP_DEPLOY_DIR:-${W3_DEPLOY_DIR:-/opt/w3forge-deploy}}"
DELEGATE="${W3_DEPLOY_NONI_SCRIPT:-}"
if [[ -z "$DELEGATE" ]]; then
  if   [[ -x "$_NONI_DEPLOY_DIR/scripts/deploy-w3forge-noninteractive.sh" ]]; then
    DELEGATE="$_NONI_DEPLOY_DIR/scripts/deploy-w3forge-noninteractive.sh"
  elif [[ -x "${W3_SCRIPTS_DIR}/deploy-w3forge-noninteractive.sh" ]]; then
    DELEGATE="${W3_SCRIPTS_DIR}/deploy-w3forge-noninteractive.sh"
  elif [[ -x "$SCRIPT_DIR/deploy-w3forge-noninteractive.sh" ]]; then
    DELEGATE="$SCRIPT_DIR/deploy-w3forge-noninteractive.sh"
  else
    # Preserve historical default path so downstream error message
    # ("DELEGATE not executable: /opt/w3forge-scripts/...") stays familiar to
    # operators when nothing is installed yet.
    DELEGATE="${W3_SCRIPTS_DIR}/deploy-w3forge-noninteractive.sh"
  fi
fi

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
pipeline-deploy-dev-package-w3forge-ui.sh \
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

# --package is optional in v0.5.38. If provided, validate and cross-check.
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

# Resolve via 3-tier fallback (canonical channel/version dir, legacy
# channel-dir-with-versioned-name, flat root with versioned name).
PACKAGE_PATH=""
if PACKAGE_PATH="$(pp_resolve_package_path "$CHANNEL" "$VERSION" 2>/dev/null || true)"; [[ -z "$PACKAGE_PATH" ]]; then
  CANONICAL_HINT="${UPDATE_DIR}/${CHANNEL}/${VERSION}/${PP_CANONICAL_PACKAGE_NAME}"
  LEGACY_HINT1="${UPDATE_DIR}/${CHANNEL}/w3forge-${VERSION}.tar.gz"
  LEGACY_HINT2="${UPDATE_DIR}/w3forge-${VERSION}.tar.gz"
  pp_emit_failure "Package not found for channel=${CHANNEL} version=${VERSION}. Looked under: ${CANONICAL_HINT} ; ${LEGACY_HINT1} ; ${LEGACY_HINT2}" \
    "package=${PACKAGE:-${PP_CANONICAL_PACKAGE_NAME}}" "version=${VERSION}" "channel=${CHANNEL}"
  if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
  exit 1
fi

if [[ ! -x "$DELEGATE" ]]; then
  pp_emit_failure "Deploy delegate not executable: $DELEGATE" \
    "package=${PACKAGE:-${PP_CANONICAL_PACKAGE_NAME}}" "version=${VERSION}" \
    "channel=${CHANNEL}" "package_path=${PACKAGE_PATH}"
  if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
  exit 1
fi

RESOLVED_BASENAME="$(basename "$PACKAGE_PATH")"

pp_info "request-id   : $PP_REQUEST_ID"
pp_info "source       : $PP_SOURCE_TAG"
pp_info "channel      : $CHANNEL"
pp_info "version      : $VERSION"
pp_info "package      : ${PACKAGE:-(none; using channel/version path)}"
pp_info "package-path : $PACKAGE_PATH"
pp_info "delegate     : $DELEGATE"

START=$(date +%s)

# v0.5.38 Step 7: detached transient systemd unit launch.
#
# PROBLEM (pre-v0.5.38): this wrapper invoked the delegate synchronously
# in the same process tree as w3forge.service. The delegate calls
# `systemctl stop w3forge.service` mid-deploy, which kills the Node API
# AND every descendant of the service's cgroup -- including this wrapper
# script and the delegate itself. Result: deploy aborts at the stop
# step, runtime is half-replaced, /opt/w3forge is partially extracted,
# and there is no metadata write. cb87d02 added UI poll-on-reconnect
# scaffolding but that alone cannot save a deploy whose own process was
# killed before it could finish extract/migrate/restart.
#
# FIX: launch the delegate inside a TRANSIENT systemd unit via
# `systemd-run`. The transient unit is owned by systemd itself (PID 1)
# and lives in its own cgroup (`system.slice/w3forge-deploy-<id>.service`)
# completely outside `w3forge.service`'s cgroup. When the delegate stops
# w3forge.service, systemd removes only that service's cgroup; the
# transient unit continues running to completion and restarts
# w3forge.service from the new package.
#
# CONTRACT:
#   - Wrapper exits 0 IMMEDIATELY after the transient unit is launched.
#   - Trailer carries `runStatus=launched-detached`, `detached_unit=...`,
#     `trailer_path=...`, `log_path=...` so the UI/operator can poll the
#     transient unit's status, the delegate log file, and the trailer
#     file written by ExecStopPost.
#   - The registry entry for pipeline-deploy-dev has
#     `restartsService: true`, so ControlCard treats the inevitable
#     network disconnect (when the Node API restarts) as expected and
#     polls /health + /version for recovery (cb87d02 logic).
#   - The ACTUAL deploy success/failure is confirmed by
#     /health + /version recovery in the UI, plus the trailer file
#     written by ExecStopPost. Wrapper success means "launch succeeded",
#     not "deploy succeeded".
#
# SAFETY: systemd-run requires the caller to have privilege to start
# system units. This wrapper already runs under the same privilege used
# to invoke `systemctl stop w3forge.service` from the delegate, so no
# new privilege is being granted.

# Sanitize PP_REQUEST_ID for use in a systemd unit name. Per
# _w3forge-pipeline-common.sh, PP_REQUEST_ID is generated as
# `pp-YYYYMMDD-HHMMSS-$$` and contains only [A-Za-z0-9-]; sanitize
# defensively in case an upstream caller supplies a different format.
UNIT_SLUG="${PP_REQUEST_ID//[^a-zA-Z0-9-]/-}"
UNIT_NAME="w3forge-deploy-${UNIT_SLUG}"

# Log + trailer directory. Use a path the deploy delegate user can
# write to. Falls back to a tmp dir if /var/log/w3forge is not creatable.
LOG_DIR="/var/log/w3forge"
if ! mkdir -p "$LOG_DIR" 2>/dev/null; then
  LOG_DIR="$(mktemp -d -t w3forge-deploy.XXXXXX)"
  pp_warn "could not create /var/log/w3forge; using fallback dir $LOG_DIR"
fi
LOG_PATH="${LOG_DIR}/deploy-${PP_REQUEST_ID}.log"
TRAILER_PATH="${LOG_DIR}/deploy-${PP_REQUEST_ID}.trailer"

# Pre-seed trailer with `status=running` so any poller that races the
# transient unit's first ExecStopPost write sees a sane state.
printf 'status=running\nrequest_id=%s\nunit=%s\nlaunched_at=%s\n' \
  "$PP_REQUEST_ID" "$UNIT_NAME" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  > "$TRAILER_PATH" 2>/dev/null || true

DELEGATE_ARGS=(
  --non-interactive
  --yes-i-understand-this-replaces-runtime
  --request-id "$PP_REQUEST_ID"
  --source    "$PP_SOURCE_TAG"
  --channel   "$CHANNEL"
  --version   "$VERSION"
)
if [[ -n "$PACKAGE" ]]; then
  DELEGATE_ARGS+=( --package "$PACKAGE" )
fi

# Require systemd-run. We deliberately do NOT provide a synchronous
# fallback -- the pre-v0.5.38 synchronous path is precisely the bug
# this commit fixes. If systemd-run is unavailable, fail loudly.
if ! command -v systemd-run >/dev/null 2>&1; then
  pp_emit_failure "systemd-run not available on PATH; cannot launch detached deploy unit" \
    "package=${RESOLVED_BASENAME}" "version=${VERSION}" "channel=${CHANNEL}" \
    "package_path=${PACKAGE_PATH}"
  if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
  exit 1
fi

# ExecStopPost writes the final trailer from systemd-supplied env vars
# SERVICE_RESULT (success|protocol|timeout|exit-code|signal|core-dump|
# watchdog|start-limit-hit|resources) and EXIT_STATUS (numeric exit code
# when EXIT_CODE=exited). The trailer is consumable by the UI/operator
# AFTER the Node API recovers.
EXEC_STOP_POST="/bin/sh -c 'printf \"status=%s\\nservice_result=%s\\nexit_code=%s\\nfinished_at=%s\\nrequest_id=%s\\nunit=%s\\n\" \"\$([ \"\${SERVICE_RESULT:-}\" = success ] && echo success || echo failed)\" \"\${SERVICE_RESULT:-unknown}\" \"\${EXIT_STATUS:-?}\" \"\$(date -u +%Y-%m-%dT%H:%M:%SZ)\" \"${PP_REQUEST_ID}\" \"${UNIT_NAME}\" > \"${TRAILER_PATH}\"'"

# Launch the transient unit. --collect lets systemd garbage-collect the
# unit after it exits. service-type=oneshot + TimeoutStartSec=900 give
# the delegate up to 15 minutes (backup + extract + migrate + restart +
# probe should complete well under 5 min). We pin StandardOutput/Error
# to append:LOG_PATH so the operator has a real log file to inspect.
set +e
systemd-run \
  --no-block \
  --unit="$UNIT_NAME" \
  --collect \
  --service-type=oneshot \
  --property=TimeoutStartSec=900 \
  --property="StandardOutput=append:${LOG_PATH}" \
  --property="StandardError=append:${LOG_PATH}" \
  --property="ExecStopPost=${EXEC_STOP_POST}" \
  --setenv="W3_REQUEST_ID=${PP_REQUEST_ID}" \
  --setenv="W3_SOURCE=${PP_SOURCE_TAG}" \
  -- "$DELEGATE" "${DELEGATE_ARGS[@]}" </dev/null
LAUNCH_RC=$?
set -e

DURATION=$(( $(date +%s) - START ))

if [[ $LAUNCH_RC -ne 0 ]]; then
  pp_warn "systemd-run failed to launch transient unit (rc=$LAUNCH_RC)"
  printf 'status=launch_failed\nlaunch_rc=%s\nfinished_at=%s\n' \
    "$LAUNCH_RC" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    >> "$TRAILER_PATH" 2>/dev/null || true
  pp_emit_failure "systemd-run failed to launch deploy unit ${UNIT_NAME} (rc=${LAUNCH_RC})" \
    "package=${RESOLVED_BASENAME}" "version=${VERSION}" "channel=${CHANNEL}" \
    "package_path=${PACKAGE_PATH}" "launch_exit_code=${LAUNCH_RC}" \
    "detached_unit=${UNIT_NAME}" "log_path=${LOG_PATH}" \
    "trailer_path=${TRAILER_PATH}" "duration_seconds=${DURATION}"
  if declare -F pp_emit_result >/dev/null 2>&1; then
    pp_emit_result "failed" "systemd-run launch failed (rc=${LAUNCH_RC})" \
      "package=${RESOLVED_BASENAME}"
  fi
  if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
  exit 1
fi

pp_ok "Detached deploy unit launched: ${UNIT_NAME} (log=${LOG_PATH})"
pp_info "trailer-path : ${TRAILER_PATH}"
pp_info "runStatus    : launched-detached (deploy continues outside w3forge.service cgroup)"

# Populate canonical-trailer state for pp_emit_result. verified=unknown
# because the deploy is still running; the UI poll-on-reconnect path
# (cb87d02) will confirm via /health + /version recovery.
PP_RES_SOURCE="$PP_SOURCE_TAG"
PP_RES_CHANNEL="$CHANNEL"
PP_RES_VERSION="$VERSION"
PP_RES_PACKAGE_PATH="$PACKAGE_PATH"
PP_RES_VERIFICATION="unknown"
PP_RES_DELEGATE="$DELEGATE"
PP_RES_DELEGATE_EXIT_CODE="0"
PP_RES_DURATION_SECONDS="$DURATION"
PP_RES_LOG_PATH="$LOG_PATH"

pp_emit_success "package=${RESOLVED_BASENAME}" "version=${VERSION}" \
  "channel=${CHANNEL}" "package_path=${PACKAGE_PATH}" \
  "runStatus=launched-detached" "detached_unit=${UNIT_NAME}" \
  "trailer_path=${TRAILER_PATH}" "log_path=${LOG_PATH}" \
  "delegate_exit_code=0" "verified=unknown" \
  "duration_seconds=${DURATION}"

if declare -F pp_emit_result >/dev/null 2>&1; then
  pp_emit_result "success" "deploy launched in detached transient unit ${UNIT_NAME}" \
    "package=${RESOLVED_BASENAME}"
fi

if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
exit 0
