#!/usr/bin/env bash
# App ownership and capability checks run before logging or any operation.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_w3forge-policy.sh"
w3forge_guard_script "${BASH_SOURCE[0]##*/}" "$@"
set -euo pipefail

# Installs the approved W3 Forge operational scripts into /opt/w3forge-scripts.
# Source of truth is the repo's scripts/ directory; this is invoked by
# deploy-w3forge.sh during a normal release. v0.4.4 adds the hard reset
# data script, logs helper, and shared logging helper. No legacy helper
# scripts are installed unless explicitly approved here.

TARGET_DIR="${W3_SCRIPTS_DIR:-/opt/w3forge-scripts}"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mkdir -p "$TARGET_DIR"
install -m 755 "$SOURCE_DIR/migrate-w3forge.sh" "$TARGET_DIR/migrate-w3forge.sh"
install -m 755 "$SOURCE_DIR/verify-w3forge-db.sh" "$TARGET_DIR/verify-w3forge-db.sh"
install -m 644 "$SOURCE_DIR/_w3forge-policy.sh" "$TARGET_DIR/_w3forge-policy.sh"
install -m 644 "$SOURCE_DIR/_w3forge-policy.cjs" "$TARGET_DIR/_w3forge-policy.cjs"

# Shared logging helper (sourced by all operational scripts at runtime).
install -m 644 "$SOURCE_DIR/_w3forge-log.sh"        "$TARGET_DIR/_w3forge-log.sh"

# v0.12.11: shared migration ledger helper. Sourced at runtime by
#   scripts/deploy-w3forge.sh              (interactive operator path)
#   scripts/deploy-w3forge-noninteractive.sh  (UI / pipeline path)
# Both deploy scripts hard-fail if this helper is not resolvable from
# either $SCRIPT_DIR or /opt/w3forge-scripts, so it MUST be installed into
# /opt/w3forge-scripts whenever the deploy scripts are refreshed. A regression
# test asserts this install line is present.
install -m 644 "$SOURCE_DIR/_w3forge-migration-ledger.sh" \
                                                   "$TARGET_DIR/_w3forge-migration-ledger.sh"

# Primary lifecycle scripts.
install -m 755 "$SOURCE_DIR/deploy-w3forge.sh"      "$TARGET_DIR/deploy-w3forge.sh"
install -m 755 "$SOURCE_DIR/backup-w3forge.sh"      "$TARGET_DIR/backup-w3forge.sh"
install -m 755 "$SOURCE_DIR/restore-w3forge.sh"     "$TARGET_DIR/restore-w3forge.sh"

# Utility scripts.
install -m 755 "$SOURCE_DIR/status-w3forge.sh"      "$TARGET_DIR/status-w3forge.sh"

# Logs viewer. (W3 Forge ships no data hard-reset script: estimate
# history must never be bulk-deleted.)
install -m 755 "$SOURCE_DIR/logs-w3forge.sh"           "$TARGET_DIR/logs-w3forge.sh"

# v0.4.6: package + release operations toolkit (system-architect tooling).
# All four are non-destructive of app/db state. release-current-w3forge.sh
# only writes a new tarball to /opt/w3forge-update-packages/. doctor-w3forge.sh is
# fully read-only. None of these are called by deploy.
install -m 755 "$SOURCE_DIR/package-list-w3forge.sh"   "$TARGET_DIR/package-list-w3forge.sh"
install -m 755 "$SOURCE_DIR/package-verify-w3forge.sh" "$TARGET_DIR/package-verify-w3forge.sh"
install -m 755 "$SOURCE_DIR/release-current-w3forge.sh" "$TARGET_DIR/release-current-w3forge.sh"
install -m 755 "$SOURCE_DIR/doctor-w3forge.sh"         "$TARGET_DIR/doctor-w3forge.sh"

# v0.4.8: restore confidence + backup verification toolkit.
# All three are read-only with respect to production:
#   - backup-list-w3forge.sh inventories local + remote backups
#   - backup-verify-w3forge.sh pre-flight checks a backup pair (no extract, no DB)
#   - restore-test-w3forge.sh extracts to /tmp and restores into a temp DB only
# None modifies /opt/w3forge, /opt/w3forge-deploy, /opt/backups/w3forge, or production DB.
install -m 755 "$SOURCE_DIR/backup-list-w3forge.sh"     "$TARGET_DIR/backup-list-w3forge.sh"
install -m 755 "$SOURCE_DIR/backup-verify-w3forge.sh"   "$TARGET_DIR/backup-verify-w3forge.sh"
install -m 755 "$SOURCE_DIR/restore-test-w3forge.sh"    "$TARGET_DIR/restore-test-w3forge.sh"

# v0.4.12: patch update workflow tooling. Operator-invoked only. Never on the
# deploy path. Never touch /opt/w3forge (runtime) or /opt/w3forge-scripts (installed
# operator scripts). Targets /opt/w3forge-deploy only.
#   - patch-verify-w3forge.sh is fully read-only (policy gate).
#   - patch-apply-w3forge.sh is dry-run by default; requires typed PATCH
#     confirmation; writes a pre-patch snapshot under /opt/logs/w3forge/patch/.
#   - changed-files-w3forge.sh is fully read-only (inspector).
# None of these are called by deploy.
install -m 755 "$SOURCE_DIR/patch-verify-w3forge.sh"   "$TARGET_DIR/patch-verify-w3forge.sh"
install -m 755 "$SOURCE_DIR/patch-apply-w3forge.sh"    "$TARGET_DIR/patch-apply-w3forge.sh"
install -m 755 "$SOURCE_DIR/changed-files-w3forge.sh"  "$TARGET_DIR/changed-files-w3forge.sh"

# v0.5.14: Admin Controls non-interactive UI wrappers.
#   - package-verify-w3forge-ui.sh adds clean no_package_found semantics around
#     the read-only verifier so the Controls tab does not show a failed
#     command when no package is staged.
#   - release-current-w3forge-ui.sh wraps the existing repackage script with
#     --yes + --request-id + --source so the safe action runner can drive it
#     non-interactively.
#   - restart-w3forge-service.sh is installed for visibility, but is NOT WIRED
#     to the UI in v0.5.14; it will be wired in v0.5.15 once the safe action
#     runner (action lock + audit trail + live output) lands.
install -m 755 "$SOURCE_DIR/package-verify-w3forge-ui.sh" "$TARGET_DIR/package-verify-w3forge-ui.sh"
install -m 755 "$SOURCE_DIR/release-current-w3forge-ui.sh" "$TARGET_DIR/release-current-w3forge-ui.sh"
install -m 755 "$SOURCE_DIR/restart-w3forge-service.sh"   "$TARGET_DIR/restart-w3forge-service.sh"

# v0.5.18: Admin Controls non-interactive UI wrapper for backup-create.
#   - backup-w3forge-ui.sh wraps scripts/backup-w3forge.sh non-interactively for
#     the safe action runner. It enforces --yes + --request-id + --source ui,
#     closes stdin when invoking the delegate, captures stdout to surface the
#     app + DB backup paths, infers remote_sync from the delegate's exit code
#     and stdout, and emits a ===STRUCTURED-RESULT=== trailer. The underlying
#     scripts/backup-w3forge.sh delegate is UNMODIFIED. This install line is
#     the v0.5.19 operational fix: in v0.5.18 the wrapper shipped in the repo
#     and was wired to backup-create as UI_READY, but it was not enumerated
#     here, so the first UI invocation failed until the wrapper was manually
#     copied to /opt/w3forge-scripts. v0.5.19 ensures the wrapper installs into
#     /opt/w3forge-scripts automatically during the normal deploy flow.
install -m 755 "$SOURCE_DIR/backup-w3forge-ui.sh"         "$TARGET_DIR/backup-w3forge-ui.sh"

# v0.5.19: Release-Candidate Testing + Rollback Foundation (terminal-only).
#   - review-w3forge-branch.sh fetches a Perplexity dev/vX.Y.Z branch into a
#     local review checkout and runs verification (no deploy, no /opt/w3forge
#     change, no DB change). Logs under /opt/logs/w3forge/release-candidate/.
#   - package-w3forge-review.sh builds a repo-shaped review tarball from the
#     current dev/vX.Y.Z checkout into /opt/w3forge-update-packages/ with a
#     '-review-<TS>' suffix so it cannot be confused with an official
#     versioned release package. Excludes .git/node_modules/dist/.env. No
#     deploy, no service touch.
#   - smoke-test-w3forge.sh is fully read-only with respect to the runtime:
#     systemctl status (status-only), HTTP GET /health, /version,
#     /api/admin/controls, with optional --expect-version and
#     --expect-buckets assertions. Never restarts the service.
#   - mark-w3forge-stable.sh requires --yes and writes a single metadata
#     file to /opt/w3forge-stable/current-stable.json describing the
#     currently running runtime as the known-good rollback point. Does NOT
#     copy packages, restart the service, or touch the database.
#   - rollback-w3forge-stable.sh is heavily guarded: defaults to dry-run,
#     refuses any mutation without --yes --confirm ROLLBACK --apply. When
#     applied it invokes the UNMODIFIED scripts/backup-w3forge.sh delegate
#     for a pre-rollback backup, stops the service, rsyncs the stable
#     package's repo tree over /opt/w3forge (preserving .git, excluding
#     node_modules + dist), runs npm install + build, restarts the
#     service, and polls /health + /version. EXPLICITLY DOES NOT touch the
#     database (no migration, no DB restore), /opt/w3forge-scripts, systemd unit
#     files, secrets, or env files. NOT WIRED to the Admin Controls UI in
#     v0.5.19; future UI exposure requires a separate approved proposal.
#   None of these new scripts are called by deploy. They are operator-
#   invoked only. They log under /opt/logs/w3forge/release-candidate/ and
#   /opt/logs/w3forge/rollback/ (categories added below).
install -m 755 "$SOURCE_DIR/review-w3forge-branch.sh"     "$TARGET_DIR/review-w3forge-branch.sh"
install -m 755 "$SOURCE_DIR/package-w3forge-review.sh"    "$TARGET_DIR/package-w3forge-review.sh"
install -m 755 "$SOURCE_DIR/smoke-test-w3forge.sh"        "$TARGET_DIR/smoke-test-w3forge.sh"
install -m 755 "$SOURCE_DIR/mark-w3forge-stable.sh"       "$TARGET_DIR/mark-w3forge-stable.sh"
install -m 755 "$SOURCE_DIR/rollback-w3forge-stable.sh"   "$TARGET_DIR/rollback-w3forge-stable.sh"

# v0.5.20: Admin Controls non-interactive UI wrapper for restore-test (Test
# Backup Restore). This is the approved Proposal C wiring.
#   - restore-test-w3forge-ui.sh wraps scripts/restore-test-w3forge.sh
#     non-interactively for the safe action runner. It enforces
#     --yes + --request-id + --source ui, never reads stdin, closes stdin when
#     invoking the delegate (</dev/null), and captures the delegate's stdout to
#     surface the app + DB backup paths and the temporary database name.
#     The wrapper additionally re-asserts (defense-in-depth) that the parsed
#     temp_db_name is NOT the production database name (default w3forge, from
#     $W3_DB_NAME) before declaring success, and emits a
#     ===STRUCTURED-RESULT=== trailer with status, request_id, app_path,
#     db_path, temp_db_name, restore_seconds, duration_seconds,
#     production_db_untouched, cleanup_ok, and reason. The underlying
#     scripts/restore-test-w3forge.sh delegate is UNMODIFIED. The delegate
#     itself extracts to /tmp and restores into a NEW TEMPORARY PostgreSQL
#     database only; it never touches /opt/w3forge, /opt/w3forge-deploy,
#     /opt/backups/w3forge, or the production w3forge database.
install -m 755 "$SOURCE_DIR/restore-test-w3forge-ui.sh"   "$TARGET_DIR/restore-test-w3forge-ui.sh"

# v0.5.24: Admin Controls non-interactive UI wrapper for restore-w3forge
# (Recovery Center - Restore From Backup). This is the approved
# Recovery-Center wiring; restore-w3forge moves from DANGEROUS_DISABLED to
# UI_READY through the dedicated safe-recovery execution path. The existing
# safe-wrapper HIGH/CRITICAL refusal fence is preserved - only this control
# id is whitelisted to safe-recovery (see CRITICAL_RECOVERY_IDS in
# backend/src/admin/controls/safeRunner.ts).
#   - restore-w3forge-ui.sh enforces --yes; accepts --app <basename>,
#     --db <basename>, --request-id, and --source ui. It NEVER reads stdin,
#     closes stdin when invoking the delegate (</dev/null), and refuses any
#     argument that contains '/' or '..' - the UI may only submit basenames
#     resolving inside the approved backup directory. The wrapper also
#     re-asserts the strict basename regex (w3forge_app_*.tar.gz /
#     w3forge_db_*.sql) before invoking the delegate.
#   - The delegate scripts/restore-w3forge.sh now accepts a non-interactive
#     apply mode (--non-interactive --app --db
#     --yes-i-understand-this-replaces-production --request-id) IN ADDITION
#     to its existing interactive and --dry-run modes. Interactive behavior
#     is byte-for-byte preserved for operator host use. In non-interactive
#     mode the delegate verifies the selected pair via the unmodified
#     backup-verify-w3forge.sh, performs a MANDATORY fresh pre-restore backup
#     via the unmodified backup-w3forge.sh, then stops the w3forge service,
#     replaces the runtime, drops and restores the production DB, restarts
#     the service, and probes /health and /version. On failure it emits
#     status=failed with a clear reason and exits non-zero.
#   - The route layer (controlsRoutes.ts) re-validates input basenames and
#     confirmations BEFORE the action lock is acquired, holds the global
#     action lock for the duration of the run, audits
#     refused/admitted/completed phases, and dispatches to runSafeRecovery.
install -m 755 "$SOURCE_DIR/restore-w3forge-ui.sh"        "$TARGET_DIR/restore-w3forge-ui.sh"

# v0.5.25: Deploy Release Package UI wrapper + parallel non-interactive
# deploy delegate.
#
# Rationale (Deploy Release Package goes UI_READY via safe-deploy)
#   - deploy-w3forge was the last HIGH-risk control still bucketed as
#     NEEDS_WRAPPER. v0.5.25 adds a dedicated `safe-deploy` execution path
#     that mirrors v0.5.24's `safe-recovery`. The route layer accepts
#     deploy-w3forge ONLY through this whitelisted path; every other
#     HIGH/CRITICAL control still trips the existing risk fence and is
#     refused. The fence itself is unchanged.
#   - deploy-w3forge-ui.sh enforces --yes; accepts --package <basename>,
#     --version <vX.Y.Z>, --request-id, and --source ui. It NEVER reads
#     stdin, closes stdin when invoking the delegate (</dev/null), and
#     refuses any --package value that contains '/' or '..' or starts with
#     '-'. It cross-checks `w3forge-${version}.tar.gz == package` so a
#     mis-typed version cannot deploy a different package.
#   - deploy-w3forge-noninteractive.sh is a PARALLEL non-interactive
#     delegate. The existing operator-only scripts/deploy-w3forge.sh is
#     UNCHANGED and remains the only path that creates a git tag and
#     pushes main. The non-interactive delegate does NOT create tags, does
#     NOT commit, does NOT push, and does NOT move the package into
#     /opt/w3forge-update-packages/installed (operator-managed). It DOES verify
#     the package via the unmodified package-verify-w3forge.sh, take a
#     mandatory pre-deploy backup via the unmodified backup-w3forge.sh,
#     stop the service, extract the package, run DB migrations, rsync the
#     runtime, restart the service, and probe /health and /version.
#   - The route layer (controlsRoutes.ts) re-validates --package basename,
#     --version, and the cross-check BEFORE the action lock is acquired,
#     holds the global action lock for the duration of the run, audits
#     refused/admitted/completed phases, and dispatches to runSafeDeploy.
install -m 755 "$SOURCE_DIR/deploy-w3forge-ui.sh"              "$TARGET_DIR/deploy-w3forge-ui.sh"
install -m 755 "$SOURCE_DIR/deploy-w3forge-noninteractive.sh"  "$TARGET_DIR/deploy-w3forge-noninteractive.sh"

# v0.5.29: Release Pipeline UI wrappers (13 controls) + shared helper.
#
# Rationale (Release Pipeline goes UI_READY via safe-pipeline)
#   - v0.5.29 introduces the Release Pipeline tab in the Admin Console with
#     13 source-controlled wrappers under scripts/pipeline-*. Each wrapper
#     follows the same contract:
#       * MUST be invoked with --yes (non-interactive acknowledgment)
#       * MUST receive --request-id from the route layer for audit
#         correlation
#       * Accepts --source ui|api|cli (UI is the expected source)
#       * Hard-refuses 'main' and any branch/tag/package not matching the
#         server-side regexes mirrored in safeRunner.ts
#       * Emits a ===STRUCTURED-RESULT=== trailer the route layer parses
#   - All wrappers operate against /opt/w3forge-deploy ONLY. They never
#     touch /opt/w3forge (runtime), /opt/w3forge-scripts (operator scripts), or
#     production database state.
#   - Dev release packaging writes to /opt/w3forge-update-packages/dev/ (a
#     separate, dev-only directory). Dev deploy copies the dev tarball into
#     /opt/w3forge-update-packages/ and delegates to the UNMODIFIED
#     deploy-w3forge-noninteractive.sh, which performs the mandatory
#     pre-deploy backup, verify, extract, migrate, rsync, restart, and
#     /health + /version probe.
#   - Rollback delegates to the UNMODIFIED rollback-w3forge-stable.sh with
#     --yes --confirm ROLLBACK --apply. Reset-working-tree operates ONLY
#     against /opt/w3forge-deploy with explicit node_modules/dist excludes.
#   - create-tag and delete-tag enforce the strict vX.Y.Z regex,
#     re-validate the dev/vX.Y.Z branch numerically matches the tag
#     (create-tag), and never pass --force to git tag or git push.
#     delete-tag requires --confirm DELETE-TAG in addition to --yes.
#   - The shared helper _w3forge-pipeline-common.sh defines the regexes the
#     wrappers source. The same regexes are mirrored in
#     backend/src/admin/controls/safeRunner.ts and
#     backend/src/admin/routes/controlsRoutes.ts (defence in depth at all
#     three layers).
install -m 644 "$SOURCE_DIR/_w3forge-pipeline-common.sh"             "$TARGET_DIR/_w3forge-pipeline-common.sh"
install -m 755 "$SOURCE_DIR/pipeline-check-remote-w3forge-ui.sh"     "$TARGET_DIR/pipeline-check-remote-w3forge-ui.sh"
install -m 755 "$SOURCE_DIR/pipeline-fetch-tags-w3forge-ui.sh"       "$TARGET_DIR/pipeline-fetch-tags-w3forge-ui.sh"
install -m 755 "$SOURCE_DIR/pipeline-pull-latest-w3forge-ui.sh"      "$TARGET_DIR/pipeline-pull-latest-w3forge-ui.sh"
install -m 755 "$SOURCE_DIR/pipeline-checkout-dev-branch-w3forge-ui.sh" "$TARGET_DIR/pipeline-checkout-dev-branch-w3forge-ui.sh"
install -m 755 "$SOURCE_DIR/pipeline-push-dev-branch-w3forge-ui.sh"  "$TARGET_DIR/pipeline-push-dev-branch-w3forge-ui.sh"
install -m 755 "$SOURCE_DIR/pipeline-test-dev-branch-w3forge-ui.sh"  "$TARGET_DIR/pipeline-test-dev-branch-w3forge-ui.sh"
install -m 755 "$SOURCE_DIR/pipeline-package-dev-release-w3forge-ui.sh" "$TARGET_DIR/pipeline-package-dev-release-w3forge-ui.sh"
install -m 755 "$SOURCE_DIR/pipeline-verify-dev-package-w3forge-ui.sh"  "$TARGET_DIR/pipeline-verify-dev-package-w3forge-ui.sh"
install -m 755 "$SOURCE_DIR/pipeline-deploy-dev-package-w3forge-ui.sh"  "$TARGET_DIR/pipeline-deploy-dev-package-w3forge-ui.sh"
install -m 755 "$SOURCE_DIR/pipeline-rollback-w3forge-ui.sh"         "$TARGET_DIR/pipeline-rollback-w3forge-ui.sh"
install -m 755 "$SOURCE_DIR/pipeline-reset-working-tree-w3forge-ui.sh" "$TARGET_DIR/pipeline-reset-working-tree-w3forge-ui.sh"
install -m 755 "$SOURCE_DIR/pipeline-create-tag-w3forge-ui.sh"       "$TARGET_DIR/pipeline-create-tag-w3forge-ui.sh"
install -m 755 "$SOURCE_DIR/pipeline-delete-tag-w3forge-ui.sh"       "$TARGET_DIR/pipeline-delete-tag-w3forge-ui.sh"

# v0.5.38: Promote-dev-to-main pipeline wrapper.
#
# Rationale
#   - Codifies the dev -> main package promotion as a structured-result
#     pipeline step that verifies the source dev tarball before copying it
#     into the canonical main channel directory.
#   - Source : /opt/w3forge-update-packages/dev/<vX.Y.Z>/w3forge.tar.gz
#     Target : /opt/w3forge-update-packages/main/<vX.Y.Z>/w3forge.tar.gz
#   - Refuses to overwrite a divergent sha256 unless --force is supplied.
#     No-ops (succeeds) when the target already matches the source sha256.
#   - Operates entirely on package archives. Does NOT touch /opt/w3forge
#     (runtime), /opt/w3forge-deploy, /opt/w3forge-scripts, systemd, the database,
#     or git remotes / tags. Never creates a git tag and never pushes.
#   - Emits a v0.5.38 canonical ===STRUCTURED-RESULT=== trailer.
install -m 755 "$SOURCE_DIR/pipeline-promote-dev-to-main-w3forge-ui.sh" "$TARGET_DIR/pipeline-promote-dev-to-main-w3forge-ui.sh"

# scripts/legacy/* are deliberately NOT installed. They live in the repo for
# historical reference only. See scripts/legacy/README.md.

# Ensure the standard log directory structure exists on first install.
# v0.4.10 adds the 'cleanup' category.
# v0.4.12 adds the 'patch' category (patch verify/apply snapshots and logs).
# v0.5.19 adds the 'release-candidate' category (review/package/smoke-test/
# mark-stable share this log directory) and the 'rollback' category (used
# exclusively by rollback-w3forge-stable.sh).
for category in deploy backup restore status release package doctor patch service release-candidate rollback pipeline; do
  mkdir -p "$W3_LOG_ROOT/$category"
done

echo "Installed W3 Forge operational scripts into $TARGET_DIR"
echo "Log directories ensured under /opt/logs/w3forge/"
