// =============================================================================
// W3 Core v0.5.26 - Admin Control Registry data.
// =============================================================================
//
// v0.5.26: Release-readiness UI/text polish only. Card-facing `description`
// fields were rewritten in the standard operator template (what this does /
// when to use it / what it affects / required confirmations and inputs).
// The verbose release-history and implementation paragraphs were moved into
// the per-control `notes` field, which the Admin Console renders inside a
// collapsed Technical Details section on each card.
//
// IMPORTANT: This release does not change any control's id, status, enabled
// flag, runStrategy, riskLevel, effectiveStatus, inputSchema,
// confirmationSchema, timeoutSeconds, allowedRoles, or logCategory. The
// four-bucket counter remains UI_READY 15 / NEEDS_WRAPPER 0 / TERMINAL_ONLY 3
// / DISABLED 1, identical to v0.5.25.
//
// =============================================================================
// (Historical preamble for v0.5.13 - v0.5.25 follows.)
//
// One row per audited operational script. This file is the source of truth
// the v0.5.13 Admin Controls UI renders from. Every field maps directly to
// what the Controls tab needs to show, including:
//
//   - button state (status + enabled + runStrategy)
//   - risk badge
//   - input form (inputSchema)
//   - confirmation step (confirmationSchema)
//   - safety notes / "why disabled" copy (notes)
//
// EVERY entry below was verified against the v0.5.12 source tree under
// /scripts/. See docs/ADMIN_CONTROLS_SCRIPT_AUDIT.md for the full audit.
//
// IMPORTANT: in v0.5.13 only LOW-risk, fully-non-interactive, read-only
// scripts may carry `runStrategy: 'safe-direct'`. Everything else is
// either NEEDS_WRAPPER, TERMINAL_ONLY, or DANGEROUS_DISABLED. The
// validation + run endpoints enforce this server-side.

import path from 'node:path';
import { SCRIPTS_DIR } from '../paths';
import type {
  AdminControl,
  AdminControlPublic,
  ControlCategory,
  EffectiveStatus
} from './types';

// Helper: build the expected installed path for a script.
function installed(scriptName: string): string {
  return path.join(SCRIPTS_DIR, scriptName);
}

// =============================================================================
// Category metadata (used by the controls endpoint to group + label).
// =============================================================================

export const CATEGORY_META: Record<
  ControlCategory,
  { label: string; description: string; order: number }
> = {
  'system-health': {
    label: 'System / Health',
    description: 'Read-only health and status checks. Safe to run any time.',
    order: 1
  },
  'logs-diagnostics': {
    label: 'Logs / Diagnostics',
    description: 'Read-only inspection of operational logs and recent activity.',
    order: 2
  },
  'backups': {
    label: 'Backups',
    description:
      'Backup creation, listing, verification, and rehearsal-restore tooling.',
    order: 3
  },
  'packages-deploy': {
    label: 'Packages / Deploy',
    description:
      'Release packages, package verification, current-state repackaging, and deploys.',
    order: 4
  },
  'service-controls': {
    label: 'Service Controls',
    description:
      'Service-affecting operations. Disabled in v0.5.13 pending non-interactive wrappers.',
    order: 5
  },
  'dangerous-controls': {
    label: 'Dangerous Controls',
    description:
      'Destructive or operator-only actions. Remain disabled or terminal-only.',
    order: 6
  }
};

// =============================================================================
// Registry - every audited script.
// =============================================================================

export const ADMIN_CONTROLS: ReadonlyArray<AdminControl> = [
  // ---------------------------------------------------------------------------
  // System / Health (LOW risk, fully read-only)
  // ---------------------------------------------------------------------------
  {
    id: 'status-w3forge',
    label: 'Check W3 Forge Status',
    description:
      'Captures a quick status snapshot of the service, port, /health, /version, disk, git ref, and recent logs. Use this as the first triage step or to confirm the service is healthy. Affects: nothing - read-only.',
    category: 'system-health',
    scriptName: 'status-w3forge.sh',
    scriptSourcePath: 'scripts/admin/status-w3forge.sh',
    expectedInstalledPath: installed('status-w3forge.sh'),
    riskLevel: 'LOW',
    status: 'UI_READY',
    enabled: true,
    runStrategy: 'safe-direct',
    readOnly: true,
    writesToDisk: false,
    touchesDatabase: false,
    restartsService: false,
    destructive: false,
    requiresPreBackup: false,
    requiresInputs: false,
    requiresConfirmation: false,
    interactivePromptsToday: [],
    nonInteractiveToday: true,
    timeoutSeconds: 30,
    allowedRoles: ['admin'],
    logCategory: 'status',
    notes:
      'Pure read-only status script. Already runs cleanly without a TTY. Safe-direct execution allowed.'
  },
  {
    id: 'doctor-w3forge',
    label: 'Run System Health Check',
    description:
      'Runs the ten-section diagnostic across paths, service, /health, version drift, scripts, disk, PostgreSQL, allowlist tables, and recent logs. Use this when triaging an issue or before a high-risk action. Affects: nothing - read-only.',
    category: 'system-health',
    scriptName: 'doctor-w3forge.sh',
    scriptSourcePath: 'scripts/admin/doctor-w3forge.sh',
    expectedInstalledPath: installed('doctor-w3forge.sh'),
    riskLevel: 'LOW',
    status: 'UI_READY',
    enabled: true,
    runStrategy: 'safe-direct',
    readOnly: true,
    writesToDisk: false,
    touchesDatabase: false,
    restartsService: false,
    destructive: false,
    requiresPreBackup: false,
    requiresInputs: false,
    requiresConfirmation: false,
    interactivePromptsToday: [],
    nonInteractiveToday: true,
    timeoutSeconds: 60,
    allowedRoles: ['admin'],
    logCategory: 'doctor',
    notes:
      'Read-only. Documented as 100% non-mutating. Supports a `--counts` flag (not exposed in v0.5.13). Safe-direct execution allowed.'
  },

  // ---------------------------------------------------------------------------
  // Logs / Diagnostics
  // ---------------------------------------------------------------------------
  {
    id: 'logs-list',
    label: 'View Available Logs',
    description:
      'Lists the operational log categories under /opt/logs/w3forge/ and how many files each contains. Use this to find which category to inspect next. Affects: nothing - read-only.',
    category: 'logs-diagnostics',
    scriptName: 'logs-w3forge.sh',
    scriptSourcePath: 'scripts/admin/logs-w3forge.sh',
    expectedInstalledPath: installed('logs-w3forge.sh'),
    riskLevel: 'LOW',
    status: 'UI_READY',
    enabled: true,
    runStrategy: 'safe-direct',
    readOnly: true,
    writesToDisk: false,
    touchesDatabase: false,
    restartsService: false,
    destructive: false,
    requiresPreBackup: false,
    requiresInputs: false,
    requiresConfirmation: false,
    interactivePromptsToday: [],
    nonInteractiveToday: true,
    timeoutSeconds: 15,
    allowedRoles: ['admin'],
    logCategory: 'status',
    notes:
      'Runs `logs-w3forge.sh list` with no further arguments. Tail/cat subcommands are not exposed in v0.5.13.'
  },
  {
    id: 'changed-files',
    label: 'Review Pending File Changes',
    description:
      'Reports committed-since-ref and dirty files in the /opt/w3forge-deploy git working tree. Use this to see what has changed on disk relative to a known commit. Affects: nothing - read-only.',
    category: 'logs-diagnostics',
    scriptName: 'changed-files-w3forge.sh',
    scriptSourcePath: 'scripts/admin/changed-files-w3forge.sh',
    expectedInstalledPath: installed('changed-files-w3forge.sh'),
    riskLevel: 'LOW',
    status: 'UI_READY',
    enabled: true,
    runStrategy: 'safe-direct',
    readOnly: true,
    writesToDisk: false,
    touchesDatabase: false,
    restartsService: false,
    destructive: false,
    requiresPreBackup: false,
    requiresInputs: false,
    requiresConfirmation: false,
    interactivePromptsToday: [],
    nonInteractiveToday: true,
    timeoutSeconds: 20,
    allowedRoles: ['admin'],
    logCategory: 'patch',
    notes:
      'Runs with default args (no --since, no --target override). --json mode reserved for a future "machine output" toggle.'
  },

  // ---------------------------------------------------------------------------
  // Backups
  // ---------------------------------------------------------------------------
  {
    id: 'backup-list',
    label: 'View Available Backups',
    description:
      'Lists the local and remote w3forge backups as paired app and database archives. Use this to confirm a recent backup exists or to pick a candidate for restore-test or restore. Affects: nothing - read-only.',
    category: 'backups',
    scriptName: 'backup-list-w3forge.sh',
    scriptSourcePath: 'scripts/admin/backup-list-w3forge.sh',
    expectedInstalledPath: installed('backup-list-w3forge.sh'),
    riskLevel: 'LOW',
    status: 'UI_READY',
    enabled: true,
    runStrategy: 'safe-direct',
    readOnly: true,
    writesToDisk: false,
    touchesDatabase: false,
    restartsService: false,
    destructive: false,
    requiresPreBackup: false,
    requiresInputs: false,
    requiresConfirmation: false,
    interactivePromptsToday: [],
    nonInteractiveToday: true,
    timeoutSeconds: 30,
    allowedRoles: ['admin'],
    logCategory: 'backup',
    notes:
      'Default subcommand only (local + remote + pairs). Remote SSH timeout is bounded by the script.'
  },
  {
    id: 'backup-verify-latest',
    label: 'Verify Latest Backup',
    description:
      'Runs a pre-flight check on the newest local backup pair: tar integrity, paired timestamps, and no forbidden paths inside the archives. Use this to confirm the latest backup is structurally sound. Affects: nothing - read-only.',
    category: 'backups',
    scriptName: 'backup-verify-w3forge.sh',
    scriptSourcePath: 'scripts/admin/backup-verify-w3forge.sh',
    expectedInstalledPath: installed('backup-verify-w3forge.sh'),
    riskLevel: 'LOW',
    status: 'UI_READY',
    enabled: true,
    runStrategy: 'safe-direct',
    readOnly: true,
    writesToDisk: false,
    touchesDatabase: false,
    restartsService: false,
    destructive: false,
    requiresPreBackup: false,
    requiresInputs: false,
    requiresConfirmation: false,
    interactivePromptsToday: [],
    nonInteractiveToday: true,
    timeoutSeconds: 60,
    allowedRoles: ['admin'],
    logCategory: 'backup',
    notes:
      'Runs with no args (newest local pair). Specific-pair verification is reserved for v0.5.17 (Backup Browser Controls).'
  },
  {
    id: 'backup-create',
    label: 'Create New Backup',
    description:
      'Writes a fresh paired app and database backup to /opt/backups/w3forge and syncs it to the remote backup target. Use this before any change that affects the runtime or database, and whenever you want a clean point-in-time pair on disk. Affects: /opt/backups/w3forge and the remote backup target. Holds the global admin action lock for the duration of the run.',
    category: 'backups',
    // v0.5.18: wired via backup-w3forge-ui.sh (approved Proposal B).
    // The wrapper enforces --yes + --request-id + --source ui, closes stdin
    // when invoking the delegate, captures stdout to surface the app + DB
    // backup paths, infers remote_sync from the delegate's exit code and
    // stdout, and emits a ===STRUCTURED-RESULT=== trailer. The delegate
    // scripts/backup-w3forge.sh is UNMODIFIED in this version. The risk
    // fence on the safe-wrapper path forbids HIGH/CRITICAL, so the
    // control's risk level is held at MEDIUM. The wall-clock timeout
    // remains 1800s - the same bound the underlying script already had.
    scriptName: 'backup-w3forge-ui.sh',
    scriptSourcePath: 'scripts/admin/backup-w3forge-ui.sh',
    expectedInstalledPath: installed('backup-w3forge-ui.sh'),
    riskLevel: 'MEDIUM',
    status: 'UI_READY',
    enabled: true,
    runStrategy: 'safe-wrapper',
    readOnly: false,
    writesToDisk: true,
    touchesDatabase: false,           // pg_dump reads only
    restartsService: false,
    destructive: false,
    requiresPreBackup: false,
    requiresInputs: false,
    requiresConfirmation: true,
    confirmationSchema: {
      checkboxes: [
        {
          key: 'confirmCreate',
          label: 'I understand this will write a new app+db backup pair to /opt/backups/w3forge.',
          mustBeTrue: true
        }
      ],
      typedPhrases: []
    },
    interactivePromptsToday: [],
    nonInteractiveToday: true,
    timeoutSeconds: 1800,
    allowedRoles: ['admin'],
    logCategory: 'backup',
    notes:
      'v0.5.18: wired via backup-w3forge-ui.sh (Proposal B). Non-interactive wrapper, refuses without --yes, never reads stdin, invokes scripts/backup-w3forge.sh unmodified, and emits a ===STRUCTURED-RESULT=== trailer with app/db backup paths, byte counts, duration_seconds, and remote_sync (true/false/unknown inferred from the delegate). Requires action lock + checkbox confirmation `confirmCreate`. Risk level held at MEDIUM to satisfy the safe-wrapper risk fence; pg_dump reads only and the underlying backup behavior (excludes, 7-day prune, rsync target) is unchanged from prior releases.'
  },
  {
    id: 'restore-test',
    label: 'Test Backup Restore',
    description:
      'Rehearses a restore of the newest backup pair into a brand-new temporary PostgreSQL database. Use this to confirm the latest backup is actually restorable without touching production. Affects: a temp database in /tmp and a temporary PostgreSQL database name (never the live w3forge database). Holds the global admin action lock for the duration of the run.',
    category: 'backups',
    // v0.5.20: wired via restore-test-w3forge-ui.sh (approved Proposal C).
    // The wrapper enforces --yes + --request-id + --source ui, closes
    // stdin when invoking the delegate, captures stdout to surface the
    // resolved backup pair + temp DB name + restore duration, re-asserts
    // (defense in depth) that the parsed temp DB name does not equal the
    // production DB name, and emits a ===STRUCTURED-RESULT=== trailer.
    // The delegate scripts/restore-test-w3forge.sh is UNMODIFIED in this
    // version. The risk fence on the safe-wrapper path forbids HIGH /
    // CRITICAL, so the control's risk level is held at MEDIUM. The
    // wall-clock timeout remains 600s - the same bound the underlying
    // script already had.
    scriptName: 'restore-test-w3forge-ui.sh',
    scriptSourcePath: 'scripts/admin/restore-test-w3forge-ui.sh',
    expectedInstalledPath: installed('restore-test-w3forge-ui.sh'),
    riskLevel: 'MEDIUM',
    status: 'UI_READY',
    enabled: true,
    runStrategy: 'safe-wrapper',
    readOnly: false,
    writesToDisk: true,
    touchesDatabase: true,           // creates and drops a TEMP DB only
    restartsService: false,
    destructive: false,
    requiresPreBackup: false,
    requiresInputs: false,
    requiresConfirmation: true,
    confirmationSchema: {
      checkboxes: [
        {
          key: 'confirmRestoreTest',
          label:
            'I understand this restores the newest backup into a NEW TEMPORARY PostgreSQL database. The production w3forge database is never touched.',
          mustBeTrue: true
        }
      ],
      typedPhrases: []
    },
    interactivePromptsToday: [],
    nonInteractiveToday: true,
    timeoutSeconds: 600,
    allowedRoles: ['admin'],
    logCategory: 'restore',
    notes:
      'v0.5.20: wired via restore-test-w3forge-ui.sh (Proposal C). Non-interactive wrapper, refuses without --yes, never reads stdin, closes stdin to the delegate (`</dev/null`), invokes scripts/restore-test-w3forge.sh unmodified, and emits a ===STRUCTURED-RESULT=== trailer with app_path, db_path, temp_db_name, restore_seconds, production_db_untouched, and cleanup_ok. Requires action lock + checkbox confirmation `confirmRestoreTest`. Risk level held at MEDIUM to satisfy the safe-wrapper risk fence. The delegate already asserts the temp DB name pattern /^w3forge_restore_test_<TS>_<pid>$/ and refuses to drop anything matching the production DB name; the wrapper re-asserts the prod-name guard before declaring success.'
  },

  // ---------------------------------------------------------------------------
  // Packages / Deploy
  // ---------------------------------------------------------------------------
  {
    id: 'package-list',
    label: 'View Release Packages',
    description:
      'Lists the release tarballs currently staged in /opt/w3forge-update-packages and the ones already installed, including the VERSION embedded in each. Use this to see what is available to deploy or to confirm an installed release. Affects: nothing - read-only.',
    category: 'packages-deploy',
    scriptName: 'package-list-w3forge.sh',
    scriptSourcePath: 'scripts/admin/package-list-w3forge.sh',
    expectedInstalledPath: installed('package-list-w3forge.sh'),
    riskLevel: 'LOW',
    status: 'UI_READY',
    enabled: true,
    runStrategy: 'safe-direct',
    readOnly: true,
    writesToDisk: false,
    touchesDatabase: false,
    restartsService: false,
    destructive: false,
    requiresPreBackup: false,
    requiresInputs: false,
    requiresConfirmation: false,
    interactivePromptsToday: [],
    nonInteractiveToday: true,
    timeoutSeconds: 30,
    allowedRoles: ['admin'],
    logCategory: 'package',
    notes:
      'Default subcommand (both staged + installed). Already covered by /api/admin/packages/* JSON endpoints - running this from Controls is informational only.'
  },
  {
    id: 'package-verify-latest',
    label: 'Verify Latest Release Package',
    description:
      'Reads the newest release tarball in /opt/w3forge-update-packages and runs the pre-flight verifier on it (structure, VERSION peek, no forbidden paths). Use this before deploying a release. Affects: nothing on the runtime - the tarball is extracted to a temp directory and removed.',
    category: 'packages-deploy',
    // v0.5.14: bound to the UI wrapper which adds a clean no_package_found
    // empty-state and emits a structured result trailer so the frontend can
    // render an accurate status pill instead of a misleading "Accepted" badge.
    scriptName: 'package-verify-w3forge-ui.sh',
    scriptSourcePath: 'scripts/admin/package-verify-w3forge-ui.sh',
    expectedInstalledPath: installed('package-verify-w3forge-ui.sh'),
    riskLevel: 'LOW',
    status: 'UI_READY',
    enabled: true,
    runStrategy: 'safe-wrapper',
    readOnly: true,
    writesToDisk: false,             // extracts to /tmp and removes
    touchesDatabase: false,
    restartsService: false,
    destructive: false,
    requiresPreBackup: false,
    requiresInputs: false,
    requiresConfirmation: false,
    interactivePromptsToday: [],
    nonInteractiveToday: true,
    timeoutSeconds: 60,
    allowedRoles: ['admin'],
    logCategory: 'package',
    notes:
      'v0.5.14: wired via package-verify-w3forge-ui.sh which returns no_package_found cleanly when /opt/w3forge-update-packages has no *.tar.gz. Extracts to /tmp/w3forge-verify.<pid>/ and cleans up on exit. No /opt/w3forge or DB mutation.'
  },
  {
    id: 'release-current',
    label: 'Package Current Version',
    description:
      'Re-packages whatever is currently installed at /opt/w3forge-deploy into a timestamped tarball under /opt/w3forge-update-packages and runs the package verifier on it. Use this to capture the current installed state for forensic review or as a rollback artifact - this is not a real release. Affects: a new tarball in /opt/w3forge-update-packages. Requires the listed confirmation and typing REPACKAGE CURRENT.',
    category: 'packages-deploy',
    // v0.5.14: flipped NEEDS_WRAPPER → UI_READY via the new safe-wrapper path.
    // The wrapper enforces --yes + --request-id + --source ui, captures the
    // delegate output, and emits a structured result trailer. Action lock +
    // confirmation block are both required by the backend.
    scriptName: 'release-current-w3forge-ui.sh',
    scriptSourcePath: 'scripts/admin/release-current-w3forge-ui.sh',
    expectedInstalledPath: installed('release-current-w3forge-ui.sh'),
    riskLevel: 'MEDIUM',
    status: 'UI_READY',
    enabled: true,
    runStrategy: 'safe-wrapper',
    readOnly: false,
    writesToDisk: true,
    touchesDatabase: false,
    restartsService: false,
    destructive: false,
    requiresPreBackup: false,
    requiresInputs: false,
    requiresConfirmation: true,
    confirmationSchema: {
      checkboxes: [
        {
          key: 'confirmWritePackage',
          label:
            'I understand this writes a new tarball to /opt/w3forge-update-packages and is NOT a real release.',
          mustBeTrue: true
        }
      ],
      typedPhrases: [
        {
          key: 'confirmPhrase',
          label: 'Type REPACKAGE CURRENT to confirm',
          expected: 'REPACKAGE CURRENT'
        }
      ]
    },
    interactivePromptsToday: [],
    nonInteractiveToday: true,
    timeoutSeconds: 600,
    allowedRoles: ['admin'],
    logCategory: 'release',
    notes:
      'v0.5.14: wired via release-current-w3forge-ui.sh. Non-interactive, writes a tarball to /opt/w3forge-update-packages, invokes package-verify, and emits a ===STRUCTURED-RESULT=== trailer. Requires action lock + typed confirmation "REPACKAGE CURRENT".'
  },
  {
    id: 'deploy-w3forge',
    label: 'Deploy Release Package',
    description:
      'Deploys a staged release package to the live runtime: takes a fresh pre-deploy backup, stops the service, extracts the package, runs database migrations, syncs the runtime, restarts the service, and probes /health and /version. Use this only when you intend to roll a new release to production. Affects: the running w3forge service, the /opt/w3forge runtime, and the w3forge PostgreSQL database (migrations). HIGH-risk; requires the package selection, the typed target version, the listed confirmations, and typing DEPLOY.',
    category: 'packages-deploy',
    scriptName: 'deploy-w3forge-ui.sh',
    scriptSourcePath: 'scripts/admin/deploy-w3forge-ui.sh',
    expectedInstalledPath: installed('deploy-w3forge-ui.sh'),
    riskLevel: 'HIGH',
    status: 'UI_READY',
    enabled: true,
    runStrategy: 'safe-deploy',
    readOnly: false,
    writesToDisk: true,
    touchesDatabase: true,             // runs migrations (approved restricted change)
    restartsService: true,
    destructive: false,
    requiresPreBackup: true,
    requiresInputs: true,
    inputSchema: {
      fields: [
        {
          key: 'packageName',
          label: 'Release Package',
          description:
            'Basename only of the staged tarball under the approved /opt/w3forge-update-packages directory (must match w3forge-vX.Y.Z.tar.gz). Paths and traversal are rejected.',
          required: true,
          type: 'select',
          optionsSource: 'packages.staged'
        },
        {
          key: 'targetVersion',
          label: 'Target Version',
          description:
            'Target version tag in vX.Y.Z form (e.g. v0.5.25). Must equal the version embedded in the selected package basename.',
          required: true,
          type: 'text',
          minLength: 6,
          maxLength: 32,
          pattern: '^v[0-9]+\\.[0-9]+\\.[0-9]+$'
        }
      ]
    },
    requiresConfirmation: true,
    confirmationSchema: {
      checkboxes: [
        {
          key: 'confirmBackup',
          label: 'Run a fresh pre-deploy backup before extracting the new package.',
          mustBeTrue: true
        },
        {
          key: 'confirmDeploy',
          label: 'I understand this stops and restarts w3forge.service and runs DB migrations.',
          mustBeTrue: true
        }
      ],
      typedPhrases: [
        {
          key: 'typedDeploy',
          label: 'Type DEPLOY to continue.',
          expected: 'DEPLOY'
        }
      ]
    },
    interactivePromptsToday: [],
    nonInteractiveToday: true,
    timeoutSeconds: 1800,
    allowedRoles: ['admin'],
    logCategory: 'deploy',
    notes:
      'HIGH. Wired to the Deploy Release Package action in v0.5.25 via the dedicated safe-deploy execution path. The UI wrapper (deploy-w3forge-ui.sh) accepts the package BASENAME only and the typed targetVersion, cross-checks that w3forge-${targetVersion}.tar.gz equals the basename, takes a mandatory fresh pre-deploy backup, stops the service, extracts the package, runs migrations, syncs the runtime, restarts the service, and probes /health and /version. It delegates to a parallel non-interactive deploy runner (deploy-w3forge-noninteractive.sh). The existing interactive scripts/deploy-w3forge.sh is UNCHANGED and remains the operator-only deploy path that creates the git tag and pushes main; the UI path does NOT create tags, commit, or push. The existing safe-wrapper HIGH/CRITICAL refusal fence is preserved - only this control id is whitelisted to the safe-deploy path.'
  },

  // ---------------------------------------------------------------------------
  // Service Controls
  // ---------------------------------------------------------------------------
  {
    id: 'service-restart',
    label: 'Restart W3 Forge Service',
    description:
      'Restarts the w3forge systemd service and waits for /health and /version to recover. Use this after a configuration change, after an admin action that needs a clean service state, or when the service is misbehaving. Affects: the running w3forge service (brief downtime). Requires the listed confirmation and typing RESTART. Holds the global admin action lock for the duration of the restart.',
    category: 'service-controls',
    // v0.5.17: wired via restart-w3forge-service.sh (approved Proposal A).
    // The wrapper enforces --yes + --request-id + --source ui, never reads
    // stdin, restarts only the w3forge systemd unit, polls /health and
    // /version with timeouts, and emits a ===STRUCTURED-RESULT=== trailer.
    // The risk fence on the safe-wrapper path forbids HIGH/CRITICAL, so the
    // control's risk level is recorded as MEDIUM. The wrapper itself bounds
    // /health + /version recovery to ~60s, and the runner timeout adds
    // headroom for the systemctl restart call.
    scriptName: 'restart-w3forge-service.sh',
    scriptSourcePath: 'scripts/admin/restart-w3forge-service.sh',
    expectedInstalledPath: installed('restart-w3forge-service.sh'),
    riskLevel: 'MEDIUM',
    status: 'UI_READY',
    enabled: true,
    runStrategy: 'safe-wrapper',
    readOnly: false,
    writesToDisk: false,
    touchesDatabase: false,
    restartsService: true,
    destructive: false,
    requiresPreBackup: false,
    requiresInputs: false,
    requiresConfirmation: true,
    confirmationSchema: {
      checkboxes: [
        {
          key: 'confirmRestart',
          label: 'I understand this restarts the running w3forge service.',
          mustBeTrue: true
        }
      ],
      typedPhrases: [
        {
          key: 'typedRestart',
          label: 'Type RESTART to continue.',
          expected: 'RESTART'
        }
      ]
    },
    interactivePromptsToday: [],
    nonInteractiveToday: true,
    timeoutSeconds: 120,
    allowedRoles: ['admin'],
    logCategory: 'service',
    notes:
      'v0.5.17: wired via restart-w3forge-service.sh (Proposal A). Non-interactive, refuses without --yes, restarts only the w3forge systemd unit, polls /health and /version, and emits a ===STRUCTURED-RESULT=== trailer. Requires action lock + checkbox confirmation + typed confirmation "RESTART". Risk level held at MEDIUM to satisfy the safe-wrapper risk fence; the underlying operation still restarts the running service and must only be invoked by an authorized admin.'
  },

  // ---------------------------------------------------------------------------
  // Dangerous Controls - never wired in v0.5.13
  // ---------------------------------------------------------------------------
  {
    id: 'patch-verify',
    label: 'Verify Patch File',
    description:
      'Runs the policy and structural gate on a unified git diff patch file. Use this only from the host terminal. Affects: nothing - the script itself is read-only, but patch handling is intentionally not exposed in the UI in v0.5.x.',
    category: 'dangerous-controls',
    scriptName: 'patch-verify-w3forge.sh',
    scriptSourcePath: 'scripts/admin/patch-verify-w3forge.sh',
    expectedInstalledPath: installed('patch-verify-w3forge.sh'),
    riskLevel: 'MEDIUM',
    status: 'TERMINAL_ONLY',
    enabled: false,
    runStrategy: 'terminal-only',
    readOnly: true,
    writesToDisk: false,
    touchesDatabase: false,
    restartsService: false,
    destructive: false,
    requiresPreBackup: false,
    requiresInputs: true,
    inputSchema: {
      fields: [
        {
          key: 'patchPath',
          label: 'Patch File Path',
          description: 'Absolute path inside the approved upload area (TBD).',
          required: true,
          type: 'text',
          pattern: '^/.+\\.patch$'
        }
      ]
    },
    requiresConfirmation: false,
    interactivePromptsToday: [],
    nonInteractiveToday: true,
    timeoutSeconds: 60,
    allowedRoles: ['admin'],
    logCategory: 'patch',
    notes:
      'Terminal-only in v0.5.13. Even though the script itself is read-only, file-upload + patch handling are out of scope until a dedicated patch workflow lands post-v0.6.0.'
  },
  {
    id: 'patch-apply',
    label: 'Apply Patch File',
    description:
      'Applies a unified git diff patch to the /opt/w3forge-deploy working tree (dry-run by default). Use this only from the host terminal with explicit operator intent. Affects: /opt/w3forge-deploy files. Patch handling is intentionally not exposed in the UI in v0.5.x.',
    category: 'dangerous-controls',
    scriptName: 'patch-apply-w3forge.sh',
    scriptSourcePath: 'scripts/admin/patch-apply-w3forge.sh',
    expectedInstalledPath: installed('patch-apply-w3forge.sh'),
    riskLevel: 'HIGH',
    status: 'TERMINAL_ONLY',
    enabled: false,
    runStrategy: 'terminal-only',
    readOnly: false,
    writesToDisk: true,
    touchesDatabase: false,
    restartsService: false,
    destructive: false,
    requiresPreBackup: true,
    requiresInputs: true,
    inputSchema: {
      fields: [
        {
          key: 'patchPath',
          label: 'Patch File Path',
          required: true,
          type: 'text',
          pattern: '^/.+\\.patch$'
        }
      ]
    },
    requiresConfirmation: true,
    confirmationSchema: {
      checkboxes: [
        {
          key: 'confirmDeployTreeOnly',
          label: 'I understand this only modifies /opt/w3forge-deploy and never /opt/w3forge.',
          mustBeTrue: true
        }
      ],
      typedPhrases: [
        { key: 'typedPatch', label: 'Type PATCH to continue.', expected: 'PATCH' }
      ]
    },
    interactivePromptsToday: ['Type PATCH to continue:'],
    nonInteractiveToday: false,
    timeoutSeconds: 300,
    allowedRoles: ['admin'],
    logCategory: 'patch',
    notes:
      'Terminal-only. Patch upload/apply is owner-only and not part of the v0.5.x UI scope.'
  },
  {
    id: 'restore-w3forge',
    label: 'Restore From Backup',
    description:
      'Restores the application runtime and the w3forge database from a chosen backup pair. Takes a fresh pre-restore backup, archives the current runtime, extracts the selected app backup, drops and reloads the w3forge database from the selected DB dump, restarts the service, and probes /health and /version. Use this only when recovering from a confirmed bad state. Affects: the running w3forge service, the /opt/w3forge runtime, and the w3forge PostgreSQL database (DROP and reload). CRITICAL; requires the paired backup selection, the listed confirmation, typing RESTORE, and typing the target database name w3forge.',
    category: 'dangerous-controls',
    scriptName: 'restore-w3forge-ui.sh',
    scriptSourcePath: 'scripts/admin/restore-w3forge-ui.sh',
    expectedInstalledPath: installed('restore-w3forge-ui.sh'),
    riskLevel: 'CRITICAL',
    status: 'UI_READY',
    enabled: true,
    runStrategy: 'safe-recovery',
    readOnly: false,
    writesToDisk: true,
    touchesDatabase: true,
    restartsService: true,
    destructive: true,
    requiresPreBackup: true,
    requiresInputs: true,
    inputSchema: {
      fields: [
        {
          key: 'appBackupFilename',
          label: 'App Backup Filename',
          description:
            'Basename only of the app archive under the approved backup directory (e.g. w3forge_app_2026-05-22_03-00-00.tar.gz). Paths and traversal are rejected.',
          required: true,
          type: 'select',
          optionsSource: 'backups.local'
        },
        {
          key: 'dbBackupFilename',
          label: 'DB Backup Filename',
          description:
            'Basename only of the matching .sql dump with a paired timestamp (e.g. w3forge_db_2026-05-22_03-00-00.sql). Paths and traversal are rejected.',
          required: true,
          type: 'select',
          optionsSource: 'backups.local'
        }
      ]
    },
    requiresConfirmation: true,
    confirmationSchema: {
      checkboxes: [
        {
          key: 'confirmReplace',
          label:
            'I understand this REPLACES the /opt/w3forge runtime and OVERWRITES the w3forge PostgreSQL database. A fresh pre-restore backup will be taken first.',
          mustBeTrue: true
        }
      ],
      typedPhrases: [
        { key: 'typedRestore', label: 'Type RESTORE to continue.', expected: 'RESTORE' },
        { key: 'typedDbName', label: 'Type the target database name (w3forge).', expected: 'w3forge' }
      ]
    },
    interactivePromptsToday: [],
    nonInteractiveToday: true,
    timeoutSeconds: 1800,
    allowedRoles: ['admin'],
    logCategory: 'restore',
    notes:
      'CRITICAL. Wired to the Recovery Center in v0.5.24 via the dedicated safe-recovery execution path. The UI wrapper (restore-w3forge-ui.sh) accepts basenames only, verifies the selected app/db pair, takes a mandatory fresh pre-restore backup, stops the service, replaces the runtime, drops/recreates the DB, restarts the service, and probes /health and /version. The existing safe-wrapper HIGH/CRITICAL refusal fence is preserved - only this control id is whitelisted to the safe-recovery path.'
  },

  // ---------------------------------------------------------------------------
  // v0.5.29 Release Pipeline controls (safe-pipeline strategy).
  //
  // These thirteen controls drive the operator-facing Release Pipeline UI
  // (Check Remote -> Pull -> Checkout dev -> Push dev -> Test -> Package ->
  // Verify -> Deploy -> Tag -> Rollback / Reset / Delete Tag). Every entry is
  // wired to a dedicated UI wrapper under scripts/ (pipeline-*-w3forge-ui.sh)
  // that targets the /opt/w3forge-deploy working tree only. The runtime path
  // /opt/w3forge is never touched by any pipeline-* control - deploy actions
  // stage release tarballs but do not extract them into the live runtime;
  // that path is owned by the existing deploy-w3forge control under the
  // separate safe-deploy whitelist.
  //
  // The pipeline-* whitelist is mirrored in safeRunner.PIPELINE_IDS and the
  // safe-pipeline dispatcher in controlsRoutes.ts. HIGH-risk pipeline entries
  // are admitted through the safe-pipeline path; every other HIGH/CRITICAL
  // control outside the pipeline whitelist remains refused by the existing
  // safe-wrapper risk fence.
  // ---------------------------------------------------------------------------
  {
    id: 'pipeline-check-remote',
    label: 'Check Remote Status',
    description:
      'Inspects origin/main, origin/dev/vX.Y.Z, and recent tags on the deploy clone without modifying anything. Use this as the first step of the Release Pipeline to confirm the remote is reachable and to see the current dev branch + latest tag. Affects: nothing - read-only.',
    category: 'packages-deploy',
    scriptName: 'pipeline-check-remote-w3forge-ui.sh',
    scriptSourcePath: 'scripts/admin/pipeline-check-remote-w3forge-ui.sh',
    expectedInstalledPath: installed('pipeline-check-remote-w3forge-ui.sh'),
    riskLevel: 'LOW',
    status: 'UI_READY',
    enabled: true,
    runStrategy: 'safe-pipeline',
    readOnly: true,
    writesToDisk: false,
    touchesDatabase: false,
    restartsService: false,
    destructive: false,
    requiresPreBackup: false,
    requiresInputs: false,
    requiresConfirmation: false,
    interactivePromptsToday: [],
    nonInteractiveToday: true,
    timeoutSeconds: 60,
    allowedRoles: ['admin'],
    logCategory: 'pipeline',
    notes:
      'LOW. Read-only pipeline probe. Runs git ls-remote + git fetch --dry-run against origin. Step 1 of the Release Pipeline.'
  },
  {
    id: 'pipeline-fetch-tags',
    label: 'Fetch Remote Tags',
    description:
      'Fetches all tags from origin into the deploy clone (git fetch --tags --prune-tags). Use this to refresh the local tag list before tagging or rolling back. Affects: the local /opt/w3forge-deploy git refs only - no working-tree changes.',
    category: 'packages-deploy',
    scriptName: 'pipeline-fetch-tags-w3forge-ui.sh',
    scriptSourcePath: 'scripts/admin/pipeline-fetch-tags-w3forge-ui.sh',
    expectedInstalledPath: installed('pipeline-fetch-tags-w3forge-ui.sh'),
    riskLevel: 'LOW',
    status: 'UI_READY',
    enabled: true,
    runStrategy: 'safe-pipeline',
    readOnly: true,
    writesToDisk: false,
    touchesDatabase: false,
    restartsService: false,
    destructive: false,
    requiresPreBackup: false,
    requiresInputs: false,
    requiresConfirmation: false,
    interactivePromptsToday: [],
    nonInteractiveToday: true,
    timeoutSeconds: 60,
    allowedRoles: ['admin'],
    logCategory: 'pipeline',
    notes:
      'LOW. Updates local tag refs only. No working tree mutation. Pairs with pipeline-check-remote at the top of the Release Pipeline.'
  },
  {
    id: 'pipeline-pull-latest',
    label: 'Pull Latest On Current Branch',
    description:
      'Runs git pull --ff-only on the currently checked-out branch of /opt/w3forge-deploy. Use this to bring the local dev/vX.Y.Z branch up to date before working. Affects: the deploy clone working tree only; refuses non-fast-forward updates.',
    category: 'packages-deploy',
    scriptName: 'pipeline-pull-latest-w3forge-ui.sh',
    scriptSourcePath: 'scripts/admin/pipeline-pull-latest-w3forge-ui.sh',
    expectedInstalledPath: installed('pipeline-pull-latest-w3forge-ui.sh'),
    riskLevel: 'MEDIUM',
    status: 'UI_READY',
    enabled: true,
    runStrategy: 'safe-pipeline',
    readOnly: false,
    writesToDisk: true,
    touchesDatabase: false,
    restartsService: false,
    destructive: false,
    requiresPreBackup: false,
    requiresInputs: true,
    inputSchema: {
      fields: [{
        key: 'allowDirty',
        label: 'Allow local changes in the deploy checkout',
        description: 'Continue past the clean-checkout check. The pull remains fast-forward-only; Git may still refuse changes that would conflict.',
        required: false,
        type: 'checkbox',
        mustBeTrue: false
      }]
    },
    requiresConfirmation: false,
    interactivePromptsToday: [],
    nonInteractiveToday: true,
    timeoutSeconds: 120,
    allowedRoles: ['admin'],
    logCategory: 'pipeline',
    notes:
      'MEDIUM. Fast-forward-only pull on the current dev/vX.Y.Z branch. Never touches main. Safe-pipeline path.'
  },
  {
    id: 'pipeline-checkout-dev',
    label: 'Checkout Dev Branch',
    description:
      'Checks out the supplied dev/vX.Y.Z branch in the deploy clone (creating a tracking branch from origin if needed). Use this to switch the Release Pipeline workspace to the active release branch. Affects: the deploy clone working tree only; refuses any branch name that is not dev/vX.Y.Z.',
    category: 'packages-deploy',
    scriptName: 'pipeline-checkout-dev-branch-w3forge-ui.sh',
    scriptSourcePath: 'scripts/admin/pipeline-checkout-dev-branch-w3forge-ui.sh',
    expectedInstalledPath: installed('pipeline-checkout-dev-branch-w3forge-ui.sh'),
    riskLevel: 'MEDIUM',
    status: 'UI_READY',
    enabled: true,
    runStrategy: 'safe-pipeline',
    readOnly: false,
    writesToDisk: true,
    touchesDatabase: false,
    restartsService: false,
    destructive: false,
    requiresPreBackup: false,
    requiresInputs: true,
    inputSchema: {
      fields: [
        {
          key: 'branch',
          label: 'Dev Branch',
          description:
            'Target dev branch in dev/vX.Y.Z form (e.g. dev/v0.5.29). Anything else is rejected by both the wrapper and the safe-pipeline runner.',
          required: true,
          type: 'text',
          minLength: 8,
          maxLength: 64,
          pattern: '^dev/v[0-9]+\\.[0-9]+\\.[0-9]+$'
        }
      ]
    },
    requiresConfirmation: false,
    interactivePromptsToday: [],
    nonInteractiveToday: true,
    timeoutSeconds: 120,
    allowedRoles: ['admin'],
    logCategory: 'pipeline',
    notes:
      'MEDIUM. Branch input is regex-fenced (^dev/v[0-9]+\\.[0-9]+\\.[0-9]+$) at the route, runner, and wrapper layers. Never checks out main.'
  },
  {
    id: 'pipeline-push-dev',
    label: 'Push Dev Branch',
    description:
      'Pushes the supplied dev/vX.Y.Z branch from the deploy clone to origin with explicit -u tracking. Use this to publish in-progress release work to the protected dev branch. Affects: origin/dev/vX.Y.Z only; refuses any branch name that is not dev/vX.Y.Z.',
    category: 'packages-deploy',
    scriptName: 'pipeline-push-dev-branch-w3forge-ui.sh',
    scriptSourcePath: 'scripts/admin/pipeline-push-dev-branch-w3forge-ui.sh',
    expectedInstalledPath: installed('pipeline-push-dev-branch-w3forge-ui.sh'),
    riskLevel: 'MEDIUM',
    status: 'UI_READY',
    enabled: true,
    runStrategy: 'safe-pipeline',
    readOnly: false,
    writesToDisk: false,
    touchesDatabase: false,
    restartsService: false,
    destructive: false,
    requiresPreBackup: false,
    requiresInputs: true,
    inputSchema: {
      fields: [
        {
          key: 'branch',
          label: 'Dev Branch',
          description:
            'Target dev branch in dev/vX.Y.Z form (e.g. dev/v0.5.29). Push is rejected for any other shape.',
          required: true,
          type: 'text',
          minLength: 8,
          maxLength: 64,
          pattern: '^dev/v[0-9]+\\.[0-9]+\\.[0-9]+$'
        }
      ]
    },
    requiresConfirmation: false,
    interactivePromptsToday: [],
    nonInteractiveToday: true,
    timeoutSeconds: 180,
    allowedRoles: ['admin'],
    logCategory: 'pipeline',
    notes:
      'MEDIUM. Only dev/vX.Y.Z branches may be pushed. Never pushes main or tags. main remains protected by the origin branch protection rule.'
  },
  {
    id: 'pipeline-test-dev',
    label: 'Test Dev Branch',
    description:
      'Runs the dev-branch test suite in the deploy clone (npm install + npm run build + npm run lint + npm test where present). Use this as the gate before packaging a release. Affects: the deploy clone build artifacts and node_modules only.',
    category: 'packages-deploy',
    scriptName: 'pipeline-test-dev-branch-w3forge-ui.sh',
    scriptSourcePath: 'scripts/admin/pipeline-test-dev-branch-w3forge-ui.sh',
    expectedInstalledPath: installed('pipeline-test-dev-branch-w3forge-ui.sh'),
    riskLevel: 'MEDIUM',
    status: 'UI_READY',
    enabled: true,
    runStrategy: 'safe-pipeline',
    readOnly: false,
    writesToDisk: true,
    touchesDatabase: false,
    restartsService: false,
    destructive: false,
    requiresPreBackup: false,
    requiresInputs: false,
    requiresConfirmation: false,
    interactivePromptsToday: [],
    nonInteractiveToday: true,
    timeoutSeconds: 900,
    allowedRoles: ['admin'],
    logCategory: 'pipeline',
    notes:
      'MEDIUM. Build + lint + test on the active dev branch. Does not modify git refs or touch the runtime.'
  },
  {
    id: 'pipeline-package-dev',
    label: 'Package Dev Release',
    description:
      'Builds the staged dev/<version>/w3forge.tar.gz release package from the active dev branch. Use this after a green Test step. Refuses an existing package unless replacement is selected. Affects: the staged packages directory only; never touches the runtime or pushes anything. HIGH-risk because the artifact is the deploy input.',
    category: 'packages-deploy',
    scriptName: 'pipeline-package-dev-release-w3forge-ui.sh',
    scriptSourcePath: 'scripts/admin/pipeline-package-dev-release-w3forge-ui.sh',
    expectedInstalledPath: installed('pipeline-package-dev-release-w3forge-ui.sh'),
    riskLevel: 'HIGH',
    status: 'UI_READY',
    enabled: true,
    runStrategy: 'safe-pipeline',
    readOnly: false,
    writesToDisk: true,
    touchesDatabase: false,
    restartsService: false,
    destructive: false,
    requiresPreBackup: false,
    requiresInputs: true,
    inputSchema: {
      fields: [
        {
          key: 'tag',
          label: 'Target Version Tag',
          description:
            'Target version in vX.Y.Z form. The package is staged as dev/<version>/w3forge.tar.gz.',
          required: true,
          type: 'text',
          minLength: 6,
          maxLength: 32,
          pattern: '^v[0-9]+\\.[0-9]+\\.[0-9]+$'
        },
        {
          key: 'force',
          label: 'Replace the existing dev package',
          description: 'Overwrite the package for this version if one already exists. Branch, version, and clean-checkout checks still apply.',
          required: false,
          type: 'checkbox',
          mustBeTrue: false
        }
      ]
    },
    requiresConfirmation: true,
    confirmationSchema: {
      checkboxes: [
        {
          key: 'confirmPackage',
          label: 'I understand this builds a staged release tarball that may later be deployed.',
          mustBeTrue: true
        }
      ],
      typedPhrases: [
        { key: 'typedPackage', label: 'Type PACKAGE to continue.', expected: 'PACKAGE' }
      ]
    },
    interactivePromptsToday: [],
    nonInteractiveToday: true,
    timeoutSeconds: 600,
    allowedRoles: ['admin'],
    logCategory: 'pipeline',
    notes:
      'HIGH. Builds w3forge-${tag}.tar.gz into /opt/w3forge-update-packages. Never extracts into the runtime. Cross-checked against the version embedded in the active dev branch by the wrapper.'
  },
  {
    id: 'pipeline-verify-dev-pkg',
    label: 'Verify Dev Package',
    description:
      'Verifies the integrity and contents of a staged release tarball under /opt/w3forge-update-packages without extracting it into the runtime. Use this between Package and Deploy as the pre-flight check. Affects: nothing - read-only against the staged tarball.',
    category: 'packages-deploy',
    scriptName: 'pipeline-verify-dev-package-w3forge-ui.sh',
    scriptSourcePath: 'scripts/admin/pipeline-verify-dev-package-w3forge-ui.sh',
    expectedInstalledPath: installed('pipeline-verify-dev-package-w3forge-ui.sh'),
    riskLevel: 'MEDIUM',
    status: 'UI_READY',
    enabled: true,
    runStrategy: 'safe-pipeline',
    readOnly: true,
    writesToDisk: false,
    touchesDatabase: false,
    restartsService: false,
    destructive: false,
    requiresPreBackup: false,
    requiresInputs: true,
    inputSchema: {
      fields: [
        {
          key: 'packageName',
          label: 'Staged Package',
          description:
            'Basename only of the staged tarball under /opt/w3forge-update-packages (must match w3forge-vX.Y.Z.tar.gz). Paths and traversal are rejected.',
          required: true,
          type: 'select',
          optionsSource: 'packages.staged'
        }
      ]
    },
    requiresConfirmation: false,
    interactivePromptsToday: [],
    nonInteractiveToday: true,
    timeoutSeconds: 300,
    allowedRoles: ['admin'],
    logCategory: 'pipeline',
    notes:
      'MEDIUM. Read-only verification of the staged tarball. No runtime mutation. Sits between Package and Deploy in the Release Pipeline.'
  },
  {
    id: 'pipeline-deploy-dev',
    label: 'Deploy Dev Package',
    description:
      'Deploys a previously staged dev release tarball through the safe-pipeline path. Use this only when Verify has passed. Affects: the deploy clone working tree and the staging area used by the existing deploy-w3forge control; never bypasses the live deploy-w3forge HIGH-risk fence. Requires typing DEPLOY-DEV.',
    category: 'packages-deploy',
    scriptName: 'pipeline-deploy-dev-package-w3forge-ui.sh',
    scriptSourcePath: 'scripts/admin/pipeline-deploy-dev-package-w3forge-ui.sh',
    expectedInstalledPath: installed('pipeline-deploy-dev-package-w3forge-ui.sh'),
    riskLevel: 'HIGH',
    status: 'UI_READY',
    enabled: true,
    runStrategy: 'safe-pipeline',
    readOnly: false,
    writesToDisk: true,
    touchesDatabase: false,
    // v0.5.38: metadata correction — the delegate
    // deploy-w3forge-noninteractive.sh performs `systemctl restart w3forge`
    // mid-run (backup / verify / stop / extract / migrate / restart /
    // probe). The original `restartsService: false` was an inaccurate
    // advertisement of that effect. Setting this to `true` lets the
    // ControlCard waiting-state logic enter "reconnecting after service
    // restart" mode instead of surfacing the unavoidable transient
    // TypeError: Failed to fetch as a generic failure. No script
    // behavior change — only the advertised effect chip + the
    // frontend's network-disconnect handling.
    restartsService: true,
    destructive: false,
    requiresPreBackup: true,
    requiresInputs: true,
    inputSchema: {
      fields: [
        {
          key: 'packageName',
          label: 'Staged Package',
          description:
            'Basename only of the staged tarball under /opt/w3forge-update-packages (must match w3forge-vX.Y.Z.tar.gz). Paths and traversal are rejected.',
          required: true,
          type: 'select',
          optionsSource: 'packages.staged'
        }
      ]
    },
    requiresConfirmation: true,
    confirmationSchema: {
      checkboxes: [
        {
          key: 'confirmDeployDev',
          label: 'I understand this prepares a release for the live runtime via the safe-pipeline path.',
          mustBeTrue: true
        }
      ],
      typedPhrases: [
        { key: 'typedDeployDev', label: 'Type DEPLOY-DEV to continue.', expected: 'DEPLOY-DEV' }
      ]
    },
    interactivePromptsToday: [],
    nonInteractiveToday: true,
    timeoutSeconds: 1800,
    allowedRoles: ['admin'],
    logCategory: 'pipeline',
    notes:
      'HIGH. Pipeline-side deploy action. Does NOT replace the existing deploy-w3forge safe-deploy control - the live runtime extract path is still owned by deploy-w3forge. The pipeline deploy action coordinates pipeline-side steps only.'
  },
  {
    id: 'pipeline-rollback',
    label: 'Rollback',
    description:
      'Rolls the deploy clone back to the last known-good state recorded by the Release Pipeline. Use this when a pipeline step left the deploy clone in a bad state. Affects: the deploy clone working tree and refs only; never modifies the live runtime. Requires typing ROLLBACK.',
    category: 'packages-deploy',
    scriptName: 'pipeline-rollback-w3forge-ui.sh',
    scriptSourcePath: 'scripts/admin/pipeline-rollback-w3forge-ui.sh',
    expectedInstalledPath: installed('pipeline-rollback-w3forge-ui.sh'),
    riskLevel: 'HIGH',
    status: 'UI_READY',
    enabled: true,
    runStrategy: 'safe-pipeline',
    readOnly: false,
    writesToDisk: true,
    touchesDatabase: false,
    restartsService: false,
    destructive: true,
    requiresPreBackup: false,
    requiresInputs: false,
    requiresConfirmation: true,
    confirmationSchema: {
      checkboxes: [
        {
          key: 'confirmRollback',
          label: 'I understand this discards uncommitted pipeline work in /opt/w3forge-deploy.',
          mustBeTrue: true
        }
      ],
      typedPhrases: [
        { key: 'typedRollback', label: 'Type ROLLBACK to continue.', expected: 'ROLLBACK' }
      ]
    },
    interactivePromptsToday: [],
    nonInteractiveToday: true,
    timeoutSeconds: 600,
    allowedRoles: ['admin'],
    logCategory: 'pipeline',
    notes:
      'HIGH. Pipeline rollback affects /opt/w3forge-deploy only. Never touches /opt/w3forge runtime, the database, or origin refs.'
  },
  {
    id: 'pipeline-reset-tree',
    label: 'Reset Working Tree',
    description:
      'Hard-resets the /opt/w3forge-deploy working tree to the current HEAD (git reset --hard HEAD + git clean -fd, restricted to that directory). Use this only when the pipeline workspace is wedged. Affects: the deploy clone working tree only; never touches origin or the runtime. Requires typing RESET-TREE.',
    category: 'packages-deploy',
    scriptName: 'pipeline-reset-working-tree-w3forge-ui.sh',
    scriptSourcePath: 'scripts/admin/pipeline-reset-working-tree-w3forge-ui.sh',
    expectedInstalledPath: installed('pipeline-reset-working-tree-w3forge-ui.sh'),
    riskLevel: 'HIGH',
    status: 'UI_READY',
    enabled: true,
    runStrategy: 'safe-pipeline',
    readOnly: false,
    writesToDisk: true,
    touchesDatabase: false,
    restartsService: false,
    destructive: true,
    requiresPreBackup: false,
    requiresInputs: false,
    requiresConfirmation: true,
    confirmationSchema: {
      checkboxes: [
        {
          key: 'confirmResetTree',
          label: 'I understand this discards all uncommitted changes in the deploy clone.',
          mustBeTrue: true
        }
      ],
      typedPhrases: [
        { key: 'typedResetTree', label: 'Type RESET-TREE to continue.', expected: 'RESET-TREE' }
      ]
    },
    interactivePromptsToday: [],
    nonInteractiveToday: true,
    timeoutSeconds: 300,
    allowedRoles: ['admin'],
    logCategory: 'pipeline',
    notes:
      'HIGH. Hard reset + clean restricted to /opt/w3forge-deploy. Never runs against the live runtime or any other path.'
  },
  {
    id: 'pipeline-create-tag',
    label: 'Create Release Tag',
    description:
      'Creates an annotated git tag vX.Y.Z on the deploy clone HEAD and pushes it to origin (after explicit confirmation). Use this to mark a release candidate. Affects: origin tags only; never touches main or the runtime. Requires typing CREATE-TAG.',
    category: 'packages-deploy',
    scriptName: 'pipeline-create-tag-w3forge-ui.sh',
    scriptSourcePath: 'scripts/admin/pipeline-create-tag-w3forge-ui.sh',
    expectedInstalledPath: installed('pipeline-create-tag-w3forge-ui.sh'),
    riskLevel: 'HIGH',
    status: 'UI_READY',
    enabled: true,
    runStrategy: 'safe-pipeline',
    readOnly: false,
    writesToDisk: false,
    touchesDatabase: false,
    restartsService: false,
    destructive: false,
    requiresPreBackup: false,
    requiresInputs: true,
    inputSchema: {
      fields: [
        {
          key: 'tag',
          label: 'Tag',
          description:
            'Target tag in vX.Y.Z form (e.g. v0.5.29). Anything else is rejected at the route, runner, and wrapper layers.',
          required: true,
          type: 'text',
          minLength: 6,
          maxLength: 32,
          pattern: '^v[0-9]+\\.[0-9]+\\.[0-9]+$'
        },
        {
          key: 'message',
          label: 'Tag Message (optional)',
          description:
            'Optional annotated tag message. If omitted the wrapper composes a default message that includes the tag name.',
          required: false,
          type: 'text',
          minLength: 1,
          maxLength: 256
        }
      ]
    },
    requiresConfirmation: true,
    confirmationSchema: {
      checkboxes: [
        {
          key: 'confirmCreateTag',
          label: 'I understand this pushes a permanent annotated tag to origin.',
          mustBeTrue: true
        }
      ],
      typedPhrases: [
        { key: 'typedCreateTag', label: 'Type CREATE-TAG to continue.', expected: 'CREATE-TAG' }
      ]
    },
    interactivePromptsToday: [],
    nonInteractiveToday: true,
    timeoutSeconds: 180,
    allowedRoles: ['admin'],
    logCategory: 'pipeline',
    notes:
      'HIGH. Creates and pushes vX.Y.Z annotated tag only. Refuses any other tag shape. Never pushes branches or main.'
  },
  {
    id: 'pipeline-delete-tag',
    label: 'Delete Release Tag',
    description:
      'Deletes a vX.Y.Z annotated tag locally and on origin. Use this only to clean up a mis-created release candidate tag. Affects: origin tags only; never touches main or the runtime. Requires typing DELETE-TAG into both the input confirm field and the confirmation prompt.',
    category: 'packages-deploy',
    scriptName: 'pipeline-delete-tag-w3forge-ui.sh',
    scriptSourcePath: 'scripts/admin/pipeline-delete-tag-w3forge-ui.sh',
    expectedInstalledPath: installed('pipeline-delete-tag-w3forge-ui.sh'),
    riskLevel: 'HIGH',
    status: 'UI_READY',
    enabled: true,
    runStrategy: 'safe-pipeline',
    readOnly: false,
    writesToDisk: false,
    touchesDatabase: false,
    restartsService: false,
    destructive: true,
    requiresPreBackup: false,
    requiresInputs: true,
    inputSchema: {
      fields: [
        {
          key: 'tag',
          label: 'Tag',
          description:
            'Target tag in vX.Y.Z form (e.g. v0.5.29). Only this exact shape is accepted.',
          required: true,
          type: 'text',
          minLength: 6,
          maxLength: 32,
          pattern: '^v[0-9]+\\.[0-9]+\\.[0-9]+$'
        },
        {
          key: 'confirmDeleteTag',
          label: 'Type DELETE-TAG to confirm tag deletion.',
          description:
            'Must literally equal DELETE-TAG. This is passed to the wrapper as --confirm DELETE-TAG and is checked again by the safe-pipeline runner.',
          required: true,
          type: 'text',
          minLength: 10,
          maxLength: 10,
          pattern: '^DELETE-TAG$'
        }
      ]
    },
    requiresConfirmation: true,
    confirmationSchema: {
      checkboxes: [
        {
          key: 'confirmDeleteTagBox',
          label: 'I understand this permanently deletes the tag locally and on origin.',
          mustBeTrue: true
        }
      ],
      typedPhrases: [
        { key: 'typedDeleteTag', label: 'Type DELETE-TAG to continue.', expected: 'DELETE-TAG' }
      ]
    },
    interactivePromptsToday: [],
    nonInteractiveToday: true,
    timeoutSeconds: 180,
    allowedRoles: ['admin'],
    logCategory: 'pipeline',
    notes:
      'HIGH. Refuses any tag shape other than vX.Y.Z. The literal DELETE-TAG confirmation is required at three layers (input, confirmation, wrapper --confirm).'
  },
  {
    // v0.5.38 NEW: Promote a verified dev/<v>/ package directory to
    // main/<v>/. This is the channel-flip step. It copies the canonical
    // tarball atomically (write-temp + rename) and refuses if main/<v>/
    // already holds a tarball with a different sha256 (collision). No
    // tags, no git pushes, no runtime touch.
    id: 'pipeline-promote-dev-to-main',
    label: 'Promote Dev to Main',
    description:
      'Promotes a previously packaged dev release (under /opt/w3forge-update-packages/dev/<version>/w3forge.tar.gz) into the main channel (/opt/w3forge-update-packages/main/<version>/w3forge.tar.gz). Idempotent and atomic: refuses a different existing package unless replacement is selected. Affects: /opt/w3forge-update-packages/main/ only; never touches the live runtime, the database, or origin refs. Requires typing PROMOTE.',
    category: 'packages-deploy',
    scriptName: 'pipeline-promote-dev-to-main-w3forge-ui.sh',
    scriptSourcePath: 'scripts/admin/pipeline-promote-dev-to-main-w3forge-ui.sh',
    expectedInstalledPath: installed('pipeline-promote-dev-to-main-w3forge-ui.sh'),
    riskLevel: 'HIGH',
    status: 'UI_READY',
    enabled: true,
    runStrategy: 'safe-pipeline',
    readOnly: false,
    writesToDisk: true,
    touchesDatabase: false,
    restartsService: false,
    destructive: false,
    requiresPreBackup: false,
    requiresInputs: true,
    inputSchema: {
      fields: [
        {
          key: 'version',
          label: 'Version',
          description:
            'Source version under /opt/w3forge-update-packages/dev/ to promote into main/. Must match vX.Y.Z exactly.',
          required: true,
          type: 'text',
          minLength: 6,
          maxLength: 32,
          pattern: '^v[0-9]+\\.[0-9]+\\.[0-9]+$'
        },
        {
          key: 'force',
          label: 'Replace a different package in the main channel',
          description: 'Overwrite the existing main-channel package for this version when its contents differ from the dev package. This does not deploy it.',
          required: false,
          type: 'checkbox',
          mustBeTrue: false
        }
      ]
    },
    requiresConfirmation: true,
    confirmationSchema: {
      checkboxes: [
        {
          key: 'confirmPromote',
          label: 'I understand this publishes the dev tarball into the main channel directory (no runtime touch, no git push).',
          mustBeTrue: true
        }
      ],
      typedPhrases: [
        { key: 'typedPromote', label: 'Type PROMOTE to continue.', expected: 'PROMOTE' }
      ]
    },
    interactivePromptsToday: [],
    nonInteractiveToday: true,
    timeoutSeconds: 300,
    allowedRoles: ['admin'],
    logCategory: 'pipeline',
    notes:
      'HIGH. Channel-flip only. Writes /opt/w3forge-update-packages/main/<version>/w3forge.tar.gz atomically (write-temp + rename). Refuses on sha256 collision unless replacement is selected. Never modifies the main branch, never deploys, never tags.'
  }
];

// =============================================================================
// Lookup helpers.
// =============================================================================

export function getControl(id: string): AdminControl | undefined {
  return ADMIN_CONTROLS.find((c) => c.id === id);
}

// =============================================================================
// v0.5.14 canonical Admin Controls four-bucket classification.
// =============================================================================
//
// The granular registry `status` field stays untouched (it carries the same
// six values the v0.5.13 audit shipped with). The Admin Controls v0.5.14
// policy says every control must be reportable as one of exactly four
// operator-facing buckets:
//
//   UI_READY        - enabled today on the UI execution path.
//   NEEDS_WRAPPER   - wrapper required before UI execution can be wired.
//   TERMINAL_ONLY   - operator-only; never run from the UI.
//   DISABLED        - explicitly disabled in v0.5.x; never run from the UI.
//
// Collapse rules, in order (v0.5.16 - 'wrapper' check moved above the
// enabled/disabled check so that controls awaiting a safe wrapper are
// reported as NEEDS_WRAPPER even while enabled === false):
//   1. runStrategy === 'terminal-only'                          => TERMINAL_ONLY
//   2. runStrategy === 'wrapper'                                => NEEDS_WRAPPER
//      - wrapper-pending controls always surface as NEEDS_WRAPPER on the
//        operator-facing bucket counter regardless of enabled flag. The
//        enabled flag still gates UI execution at the route layer; this
//        only affects the four-bucket classification.
//   3. runStrategy === 'disabled' || !enabled                   => DISABLED
//      - explicit disabled strategy or a non-wrapper control that is not
//        enabled lands in DISABLED.
//   4. runStrategy === 'safe-direct'|'safe-wrapper'|'safe-recovery'|'safe-deploy'|'safe-pipeline'
//        && enabled                                              => UI_READY
//      - v0.5.24 adds 'safe-recovery' as a third UI-executable strategy
//        dedicated to the Recovery Center (restore-w3forge only).
//      - v0.5.25 adds 'safe-deploy' as a fourth UI-executable strategy
//        dedicated to the Deploy Release Package action (deploy-w3forge only).
//      - v0.5.29 adds 'safe-pipeline' as a fifth UI-executable strategy
//        dedicated to the Release Pipeline controls (pipeline-* whitelist).
//        The route layer enforces the per-id whitelist for all of them; this
//        collapse only affects the four-bucket counter so the operator-facing
//        summary reflects that the pipeline controls are now UI_READY.
//   5. Anything else                                            => DISABLED (defense-in-depth)
export function deriveEffectiveStatus(c: AdminControl): EffectiveStatus {
  if (c.runStrategy === 'terminal-only') return 'TERMINAL_ONLY';
  if (c.runStrategy === 'wrapper') return 'NEEDS_WRAPPER';
  if (!c.enabled || c.runStrategy === 'disabled') return 'DISABLED';
  if (
    c.enabled &&
    (c.runStrategy === 'safe-direct' ||
      c.runStrategy === 'safe-wrapper' ||
      c.runStrategy === 'safe-recovery' ||
      c.runStrategy === 'safe-deploy' ||
      c.runStrategy === 'safe-pipeline')
  ) {
    return 'UI_READY';
  }
  return 'DISABLED';
}

// Strip non-serializable fields, replace `undefined` schemas with `null`,
// and attach the v0.5.14 derived effectiveStatus so the wire response is
// predictable and self-describing.
export function toPublic(control: AdminControl): AdminControlPublic {
  return {
    ...control,
    inputSchema: control.inputSchema ?? null,
    confirmationSchema: control.confirmationSchema ?? null,
    effectiveStatus: deriveEffectiveStatus(control)
  };
}
