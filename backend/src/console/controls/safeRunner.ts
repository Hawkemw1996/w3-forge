import { controlEnvironment } from './controlEnvironment';
import { controlPolicyReason } from './controlPolicy';
import path from 'node:path';
import { UPDATE_PACKAGES_DEV_DIR, UPDATE_PACKAGES_MAIN_DIR } from '../paths';
// =============================================================================
// W3 Core v0.5.25 - Safe runner
// (safe-direct + safe-wrapper + safe-recovery + safe-deploy).
// =============================================================================
//
// Four execution modes are permitted here. Everything else is refused.
//
//   safe-direct
//     - LOW risk + readOnly only.
//     - Fixed argv per control id (ARGV_TABLE_DIRECT). No stdin, no shell.
//     - This is the same surface as v0.5.13.
//
//   safe-wrapper (v0.5.14)
//     - MEDIUM risk allowed when the control is bound to an installed
//       non-interactive UI wrapper (e.g. release-current-w3forge-ui.sh,
//       package-verify-w3forge-ui.sh) that:
//         * accepts --yes
//         * accepts --request-id <opaque>
//         * never reads from stdin
//         * emits a `===STRUCTURED-RESULT===` JSON trailer on stdout
//     - HIGH and CRITICAL are still refused regardless of wrapper presence.
//       *** This refusal fence is INTENTIONAL and MUST NOT be weakened. ***
//
//   safe-recovery (v0.5.24)
//     - Dedicated CRITICAL-recovery execution path. It exists exclusively so
//       restore-w3forge can become UI_READY without weakening the safe-wrapper
//       HIGH/CRITICAL refusal fence above.
//     - Whitelisted to a FIXED SET of recovery control ids via
//       CRITICAL_RECOVERY_IDS. Today the whitelist contains exactly one id:
//       'restore-w3forge'. Adding more ids requires an explicit design
//       review.
//     - The bound wrapper must:
//         * require --yes
//         * accept --request-id <opaque>
//         * accept --app <BASENAME> and --db <BASENAME> (no paths)
//         * never read from stdin
//         * delegate to a non-interactive script that performs a MANDATORY
//           fresh pre-restore backup before any mutation
//         * emit a `===STRUCTURED-RESULT===` trailer
//     - The route layer validates input basenames and confirmations BEFORE
//       dispatching here. This runner re-checks the whitelist and re-validates
//       basenames defensively.
//
//   safe-deploy (NEW in v0.5.25)
//     - Dedicated HIGH-risk deploy execution path. It exists exclusively so
//       deploy-w3forge can become UI_READY without weakening the safe-wrapper
//       HIGH/CRITICAL refusal fence above.
//     - Whitelisted to a FIXED SET of deploy control ids via
//       DEPLOY_PACKAGE_IDS. Today the whitelist contains exactly one id:
//       'deploy-w3forge'. Adding more ids requires an explicit design
//       review.
//     - The bound wrapper must:
//         * require --yes
//         * accept --request-id <opaque>
//         * accept --package <BASENAME> (no paths) referencing a tarball
//           inside /opt/w3forge-update-packages only
//         * accept --version <vX.Y.Z>
//         * never read from stdin
//         * delegate to a non-interactive script that performs a MANDATORY
//           fresh pre-deploy backup before any mutation
//         * verify the package before deploy
//         * stop / restart the service through the EXISTING deploy behavior
//         * probe /health and /version after deploy
//         * emit a `===STRUCTURED-RESULT===` trailer
//     - The route layer validates the package basename, the version, and all
//       confirmations BEFORE dispatching here. This runner re-checks the
//       whitelist and re-validates the package + version defensively.
//     - The existing scripts/deploy-w3forge.sh (terminal-only operator flow
//       with git tag + git push) is NOT modified. The wrapper invokes a
//       parallel non-interactive deploy script that performs ONLY the
//       deploy steps (verify / backup / stop / extract / migrate / restart /
//       probe). git tag, git commit and git push remain user-only.
//
// Belt-and-suspenders: the routes already gate everything; the runner re-checks
// before it ever spawns a child process. execFile is used in all modes - never
// a shell. stdin is closed.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fsp } from 'node:fs';
import type { AdminControl, RunResponse, RunStatus } from './types';
import { pipelineOverrideError, PipelineOverrides } from './pipelineOverrides';

// -----------------------------------------------------------------------------
// v0.5.24 critical-recovery whitelist.
//
// The safe-recovery path is only ever permitted for the control ids listed
// here. Every other CRITICAL control continues to be refused by the
// safe-wrapper HIGH/CRITICAL fence above. Keep this list as small as humanly
// possible. Adding an id REQUIRES an explicit Recovery Center design review.
// -----------------------------------------------------------------------------
export const CRITICAL_RECOVERY_IDS: readonly string[] = ['restore-w3forge'];

// Basename regexes for the restore-w3forge inputs. Mirrored exactly by the
// UI wrapper (scripts/restore-w3forge-ui.sh) and the delegate
// (scripts/restore-w3forge.sh). This file is the third independent check.
const APP_BACKUP_BASENAME_REGEX =
  /^w3forge_app_[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{2}-[0-9]{2}-[0-9]{2}\.tar\.gz$/;
const DB_BACKUP_BASENAME_REGEX =
  /^w3forge_db_[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{2}-[0-9]{2}-[0-9]{2}\.sql$/;

// -----------------------------------------------------------------------------
// v0.5.25 deploy-package whitelist.
//
// The safe-deploy path is only ever permitted for the control ids listed
// here. Every other HIGH/CRITICAL control continues to be refused by the
// safe-wrapper HIGH/CRITICAL fence above. Keep this list as small as humanly
// possible. Adding an id REQUIRES an explicit Deploy-path design review.
// -----------------------------------------------------------------------------
export const DEPLOY_PACKAGE_IDS: readonly string[] = ['deploy-w3forge'];

// Strict naming convention for staged W3 Forge release packages.
// Matches w3forge-vX.Y.Z.tar.gz (e.g. w3forge-v0.5.25.tar.gz). The UI may
// only submit basenames - the package must live inside /opt/w3forge-update-packages.
// Mirrored exactly by scripts/deploy-w3forge-ui.sh and
// scripts/deploy-w3forge-noninteractive.sh. This file is the third
// independent check.
const DEPLOY_PACKAGE_BASENAME_REGEX =
  /^w3forge-v[0-9]+\.[0-9]+\.[0-9]+\.tar\.gz$/;

// Strict version tag format (matches the package basename's embedded version).
const DEPLOY_VERSION_REGEX = /^v[0-9]+\.[0-9]+\.[0-9]+$/;

// -----------------------------------------------------------------------------
// v0.5.29 Release Pipeline whitelist.
//
// The safe-pipeline path is only ever permitted for the control ids listed
// here. Every other HIGH/CRITICAL control continues to be refused by the
// safe-wrapper HIGH/CRITICAL fence above. Keep this list narrowly scoped to
// the 12 pipeline-* controls that drive the Release Pipeline tab. Adding an
// id REQUIRES an explicit Release-Pipeline design review.
//
// All ids listed here MUST also have an entry in ARGV_TABLE_PIPELINE below
// and a corresponding installed wrapper under /opt/w3forge-scripts/pipeline-*.sh.
// -----------------------------------------------------------------------------
export const PIPELINE_IDS: readonly string[] = [
  'pipeline-check-remote',
  'pipeline-fetch-tags',
  'pipeline-pull-latest',
  'pipeline-checkout-dev',
  'pipeline-push-dev',
  'pipeline-test-dev',
  'pipeline-package-dev',
  'pipeline-verify-dev-pkg',
  'pipeline-deploy-dev',
  'pipeline-rollback',
  'pipeline-reset-tree',
  'pipeline-create-tag',
  'pipeline-delete-tag',
  // v0.5.38: promote-dev-to-main copies dev/<v>/w3forge.tar.gz into
  // main/<v>/w3forge.tar.gz with verification + sha256 collision refusal.
  // No runtime mutation; no git tag; no main push. Operates purely on the
  // package archive tree.
  'pipeline-promote-dev-to-main'
];

// Strict format for an approved dev branch name (e.g. dev/v0.5.29). Mirrored
// exactly by scripts/_w3forge-pipeline-common.sh (PP_DEV_BRANCH_REGEX) and by
// the route layer in controlsRoutes.ts. The third independent check lives
// here and is intentionally restated so a future relaxation in either of the
// other two layers cannot accidentally admit an unsafe branch name.
const PIPELINE_DEV_BRANCH_REGEX = /^dev\/v[0-9]+\.[0-9]+\.[0-9]+$/;

// Strict format for an approved release tag (e.g. v0.5.29). Mirrored
// exactly by scripts/_w3forge-pipeline-common.sh (PP_TAG_REGEX) and by the
// route layer.
const PIPELINE_TAG_REGEX = /^v[0-9]+\.[0-9]+\.[0-9]+$/;

// Strict format for an approved dev package basename.
//
// v0.5.38 accepts BOTH naming patterns to bridge the canonical / legacy
// layouts. Mirrored exactly by scripts/_w3forge-pipeline-common.sh
// (PP_PACKAGE_REGEX, v0.5.38) and by the route layer in controlsRoutes.ts.
//   - Canonical: w3forge.tar.gz                  (used inside <channel>/<v>/)
//   - Legacy:    w3forge-vX.Y.Z.tar.gz            (pre-v0.5.38 flat layout)
const PIPELINE_PACKAGE_REGEX =
  /^(?:w3forge\.tar\.gz|w3forge-v[0-9]+\.[0-9]+\.[0-9]+\.tar\.gz)$/;
// Strict format for an approved channel name.
const PIPELINE_CHANNEL_REGEX = /^(?:dev|main|installed)$/;

const execFileP = promisify(execFile);

// Cap any captured stdout/stderr per stream so we never return a 50 MB blob
// to the UI even if a future control misbehaves.
const TAIL_BYTES = 16 * 1024;

function tail(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(s.length - n);
}

export interface RunnerInput {
  control: AdminControl;
  requestId: string;
}

// v0.5.24: extra runner input for the safe-recovery path. The route layer
// passes already-validated app/db backup BASENAMES (no paths). The runner
// re-validates defensively before invoking the wrapper.
export interface RecoveryRunnerInput extends RunnerInput {
  appBackupBasename: string;
  dbBackupBasename: string;
}

// v0.5.25: extra runner input for the safe-deploy path. The route layer
// passes the already-validated release package BASENAME (no paths) and the
// already-validated target version tag (vX.Y.Z). The runner re-validates
// both defensively before invoking the wrapper.
export interface DeployRunnerInput extends RunnerInput {
  packageBasename: string;
  targetVersion: string;
}

// v0.5.29: extra runner input for the safe-pipeline path. The route layer
// passes already-validated values for whichever optional fields each
// pipeline control needs (branch / tag / packageBasename / message /
// confirmDeleteTag). The argv builder in ARGV_TABLE_PIPELINE picks the
// fields it requires per id; unused fields are ignored. The runner
// re-validates every supplied value defensively before spawning a child.
export interface PipelineRunnerInput extends RunnerInput, PipelineOverrides {
  branch?: string;
  tag?: string;
  packageBasename?: string;
  message?: string;
  // For pipeline-delete-tag only. Must equal 'DELETE-TAG' to admit.
  confirmDeleteTag?: string;
  // v0.5.38: target channel for channel/version-aware controls
  // (pipeline-verify-dev-pkg, pipeline-deploy-dev,
  // pipeline-promote-dev-to-main). Must match PIPELINE_CHANNEL_REGEX.
  channel?: string;
  // v0.5.38: explicit version override (vX.Y.Z) used by controls that do
  // not derive the version from a legacy package basename.
  version?: string;
}

// -----------------------------------------------------------------------------
// Fixed argv per control id for the safe-direct path. Anything not listed gets
// argv = []. This is the ONLY place the safe-direct runner derives subcommands.
// -----------------------------------------------------------------------------
const ARGV_TABLE_DIRECT: Record<string, string[]> = {
  'status-w3forge': [],
  'doctor-w3forge': [],
  'logs-list': ['list'],
  'changed-files': [],
  'backup-list': [],
  'backup-verify-latest': [],
  'package-list': []
  // NOTE: package-verify-latest moves to the safe-wrapper path in v0.5.14
  // so the wrapper can report no_package_found cleanly.
};

// -----------------------------------------------------------------------------
// Fixed argv builder per control id for the safe-wrapper path. Each function
// receives the opaque requestId and returns a static argv. Anything not listed
// is rejected before the runner is even invoked.
// -----------------------------------------------------------------------------
const ARGV_TABLE_WRAPPER: Record<string, (requestId: string) => string[]> = {
  // release-current-w3forge-ui.sh: requires --yes; accepts --source + --request-id.
  'release-current': (rid) => ['--yes', '--source', 'ui', '--request-id', rid],
  // package-verify-w3forge-ui.sh: read-only; accepts --request-id only.
  // (No --yes / --source flags - the wrapper performs no state mutation.)
  'package-verify-latest': (rid) => ['--request-id', rid],
  // restart-w3forge-service.sh (v0.5.17, Proposal A): requires --yes; accepts
  // --source + --request-id. The wrapper restarts only the w3forge systemd
  // unit, polls /health and /version with timeouts, and emits a structured
  // result trailer. The control is MEDIUM-risk and is gated upstream by the
  // global action lock + checkbox confirmation + typed phrase "RESTART".
  'service-restart': (rid) => ['--yes', '--source', 'ui', '--request-id', rid],
  // backup-w3forge-ui.sh (v0.5.18, Proposal B): requires --yes; accepts
  // --source + --request-id. The wrapper invokes scripts/backup-w3forge.sh
  // unmodified with stdin closed, parses the delegate's existing stdout
  // for the app + DB backup paths, infers remote_sync from the delegate's
  // exit code and stdout, and emits a ===STRUCTURED-RESULT=== trailer.
  // The control is MEDIUM-risk and is gated upstream by the global action
  // lock + checkbox confirmation "confirmCreate".
  'backup-create': (rid) => ['--yes', '--source', 'ui', '--request-id', rid],
  // restore-test-w3forge-ui.sh (v0.5.20, Proposal C): requires --yes;
  // accepts --source + --request-id. The wrapper invokes
  // scripts/restore-test-w3forge.sh unmodified with stdin closed, parses
  // the delegate's existing stdout for the resolved backup pair and the
  // temp DB name, re-asserts that the parsed temp DB name does NOT equal
  // the production DB name, and emits a ===STRUCTURED-RESULT=== trailer
  // with app_path, db_path, temp_db_name, restore_seconds,
  // production_db_untouched, and cleanup_ok. The control is MEDIUM-risk
  // and is gated upstream by the global action lock + checkbox
  // confirmation "confirmRestoreTest". Production DB is never touched:
  // the delegate creates/drops only a temp DB whose name pattern is
  // /^w3forge_restore_test_<TS>_<pid>$/.
  'restore-test': (rid) => ['--yes', '--source', 'ui', '--request-id', rid]
};

// -----------------------------------------------------------------------------
// v0.5.29 Fixed argv builders per pipeline control id for the safe-pipeline
// path. Each builder receives the requestId and an already-validated input
// bundle, and returns a static argv. Anything not listed here is rejected
// before the runner is even invoked.
//
// Every pipeline wrapper accepts --yes --source ui --request-id <rid> as a
// common prefix; the per-id argv adds whichever typed inputs that wrapper
// needs. The input values are re-validated by runSafePipeline below before
// they ever appear on the argv.
// -----------------------------------------------------------------------------
// v0.5.32: derive the vX.Y.Z portion from a w3forge-vX.Y.Z.tar.gz basename.
// Returns null on no match so the wrapper's argv ends up with an empty
// --version value and the safe-pipeline runner's defensive validation
// (PIPELINE_PACKAGE_REGEX) plus the wrapper's pp_validate_tag rejects the
// call before any artifact mutation. We intentionally keep this strict and
// anchored.
function deriveVersionFromPackage(basename: string | undefined): string | null {
  if (typeof basename !== 'string' || basename.length === 0) return null;
  const m = basename.match(/^w3forge-(v[0-9]+\.[0-9]+\.[0-9]+)\.tar\.gz$/);
  return m ? m[1] : null;
}

const ARGV_TABLE_PIPELINE: Record<
  string,
  (requestId: string, input: PipelineRunnerInput) => string[]
> = {
  // LOW-risk read-only probes: no extra inputs.
  'pipeline-check-remote': (rid) => ['--yes', '--source', 'ui', '--request-id', rid],
  'pipeline-fetch-tags':   (rid) => ['--yes', '--source', 'ui', '--request-id', rid],

  // MEDIUM: pull --ff-only on the CURRENT branch; dirty checkout override is opt-in.
  'pipeline-pull-latest': (rid, i) => [
    '--yes', '--source', 'ui', '--request-id', rid,
    ...(i.allowDirty === true ? ['--allow-dirty'] : [])
  ],

  // MEDIUM: checkout / push require --branch <dev/vX.Y.Z>.
  'pipeline-checkout-dev': (rid, i) => [
    '--yes', '--source', 'ui', '--request-id', rid, '--branch', i.branch ?? ''
  ],
  'pipeline-push-dev': (rid, i) => [
    '--yes', '--source', 'ui', '--request-id', rid, '--branch', i.branch ?? ''
  ],

  // MEDIUM: run repo tests; no extra inputs (operates on current checkout).
  'pipeline-test-dev': (rid) => ['--yes', '--source', 'ui', '--request-id', rid],

  // HIGH: package the current dev release. --version <vX.Y.Z>.
  //
  // v0.5.32 audit: wrapper accepts ONLY '--version' (not '--tag'). The UI
  // input field is named 'tag' for ergonomic reasons (it's a vX.Y.Z value),
  // but the wrapper flag MUST be --version. Verified by:
  //   grep -n 'pipeline-package-dev-release-w3forge-ui.sh' help text:
  //     --yes --request-id <id> --version vX.Y.Z
  // The argv below maps i.tag -> '--version <tag>'. Do NOT change to --tag.
  'pipeline-package-dev': (rid, i) => [
    '--yes', '--source', 'ui', '--request-id', rid, '--version', i.tag ?? '',
    ...(i.force === true ? ['--force'] : [])
  ],

  // MEDIUM: verify a dev package. Wrapper REQUIRES both --package and
  // --version (v0.5.32 audit). The route layer only provides the package
  // basename, so we derive the version from the basename via
  // deriveVersionFromPackage() below. The wrapper cross-checks the two.
  //
  // v0.5.38: also pass --channel when supplied; defaults at the wrapper to
  // 'dev' for backward compatibility. When `i.version` is supplied directly
  // (e.g. for canonical layout where the package basename is w3forge.tar.gz),
  // it overrides the basename-derived version.
  'pipeline-verify-dev-pkg': (rid, i) => {
    const argv = [
      '--yes', '--source', 'ui', '--request-id', rid,
      '--package', i.packageBasename ?? '',
      '--version',
      i.version ?? (deriveVersionFromPackage(i.packageBasename) ?? '')
    ];
    if (i.channel) argv.push('--channel', i.channel);
    return argv;
  },

  // HIGH: deploy a dev package. Wrapper REQUIRES both --package and
  // --version (v0.5.32 audit). The wrapper delegates to the unmodified
  // scripts/deploy-w3forge-noninteractive.sh which performs the mandatory
  // pre-deploy backup, verify, extract, migrate, restart, and /health +
  // /version probe.
  //
  // v0.5.38: also pass --channel when supplied (default 'dev'). When
  // `i.version` is supplied it overrides the basename-derived version,
  // which is required for canonical-layout packages whose basename is just
  // w3forge.tar.gz (no embedded version).
  'pipeline-deploy-dev': (rid, i) => {
    const argv = [
      '--yes', '--source', 'ui', '--request-id', rid,
      '--package', i.packageBasename ?? '',
      '--version',
      i.version ?? (deriveVersionFromPackage(i.packageBasename) ?? '')
    ];
    if (i.channel) argv.push('--channel', i.channel);
    return argv;
  },

  // HIGH: rollback delegates to scripts/rollback-w3forge-stable.sh. No
  // extra inputs from the UI - the wrapper passes its own internal
  // --confirm ROLLBACK --apply tokens to the delegate.
  'pipeline-rollback': (rid) => ['--yes', '--source', 'ui', '--request-id', rid],

  // HIGH: reset the /opt/w3forge-deploy working tree (git reset --hard
  // HEAD + git clean -fd preserving node_modules + dist). No extra inputs.
  'pipeline-reset-tree': (rid) => ['--yes', '--source', 'ui', '--request-id', rid],

  // HIGH: create an annotated tag on HEAD. --tag <vX.Y.Z> and an optional
  // --message <txt>. The wrapper enforces that the current branch matches
  // dev/<tag>.
  'pipeline-create-tag': (rid, i) => {
    const argv = [
      '--yes', '--source', 'ui', '--request-id', rid, '--tag', i.tag ?? ''
    ];
    if (i.message && i.message.length > 0) {
      argv.push('--message', i.message);
    }
    return argv;
  },

  // HIGH: delete a tag locally and on origin. --tag <vX.Y.Z> and the
  // required typed phrase --confirm DELETE-TAG.
  'pipeline-delete-tag': (rid, i) => [
    '--yes', '--source', 'ui', '--request-id', rid,
    '--tag', i.tag ?? '',
    '--confirm', i.confirmDeleteTag ?? ''
  ],

  // v0.5.38 HIGH: promote a verified dev package to the main channel.
  // Source : /opt/w3forge-update-packages/dev/<vX.Y.Z>/w3forge.tar.gz
  // Target : /opt/w3forge-update-packages/main/<vX.Y.Z>/w3forge.tar.gz
  //
  // Refuses overwrite on sha256 divergence unless the operator explicitly
  // selects the wrapper's existing --force override. No git push, no tag.
  'pipeline-promote-dev-to-main': (rid, i) => [
    '--yes', '--source', 'ui', '--request-id', rid,
    '--version', i.version ?? (deriveVersionFromPackage(i.packageBasename) ?? ''),
    ...(i.force === true ? ['--force'] : [])
  ]
};

// -----------------------------------------------------------------------------
// Structured result trailer parser.
//
// The UI wrappers emit a block of the form:
//
//   ===STRUCTURED-RESULT===
//   status=success
//   request_id=<id>
//   output_path=/opt/w3forge-update-packages/...tar.gz
//   bytes=12345
//   duration_seconds=3
//   verified=true
//   ===END===
//
// Each line between the markers is a `key=value` pair. Unknown keys are
// preserved as strings in the returned object. We only parse the LAST such
// block in case the delegate script itself emits the marker for any reason.
// -----------------------------------------------------------------------------
interface StructuredResult {
  status?: string;
  reason?: string;
  output_path?: string;
  bytes?: number;
  duration_seconds?: number;
  verified?: boolean;
  [key: string]: unknown;
}

function parseStructuredTrailer(stdout: string): StructuredResult | null {
  const startMarker = '===STRUCTURED-RESULT===';
  const endMarker = '===END===';
  const startIdx = stdout.lastIndexOf(startMarker);
  if (startIdx < 0) return null;
  const afterStart = stdout.slice(startIdx + startMarker.length);
  const endIdx = afterStart.indexOf(endMarker);
  const body = endIdx < 0 ? afterStart : afterStart.slice(0, endIdx);

  const out: StructuredResult = {};
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (!key) continue;
    if (key === 'bytes' || key === 'duration_seconds') {
      const n = Number(value);
      out[key] = Number.isFinite(n) ? n : undefined;
    } else if (key === 'verified') {
      out.verified = value === 'true' || value === '1';
    } else {
      out[key] = value;
    }
  }
  // Empty object → treat as no trailer.
  if (Object.keys(out).length === 0) return null;
  return out;
}

function mapStructuredStatus(s: string | undefined, exitCode: number): RunStatus {
  if (s === 'success') return 'success';
  // v0.11.3: pipeline-deploy-dev emits status=success from both its legacy and
  // canonical trailers. The canonical trailer also carries a runStatus=
  // launched-detached KV pair (distinct from the status= field). The status=
  // field is always 'success' for a clean launch. However, guard against any
  // future wrapper that emits status=launched-detached directly in the status
  // field — treat it as success because the launch was clean and the actual
  // deploy outcome is confirmed by /health + /version recovery in the UI.
  if (s === 'launched-detached') return 'success';
  if (s === 'failed') return 'failed';
  if (s === 'no_package_found') return 'no_package_found';
  if (s === 'blocked') return 'blocked';
  // Fallback: trust the exit code.
  return exitCode === 0 ? 'success' : 'failed';
}

// -----------------------------------------------------------------------------
// safe-direct path.
// -----------------------------------------------------------------------------
export async function runSafeDirect({ control, requestId }: RunnerInput): Promise<RunResponse> {
  if (!control.enabled || control.runStrategy !== 'safe-direct') {
    return {
      controlId: control.id,
      accepted: false,
      runStatus: 'disabled',
      reason: 'Control is not safe-direct or not enabled - execution refused.',
      requestId
    };
  }
  if (control.riskLevel !== 'LOW' || !control.readOnly) {
    return {
      controlId: control.id,
      accepted: false,
      runStatus: 'blocked',
      reason: 'Only LOW-risk, read-only controls may execute on the safe-direct path.',
      requestId
    };
  }

  try {
    await fsp.access(control.expectedInstalledPath);
  } catch {
    return {
      controlId: control.id,
      accepted: false,
      runStatus: 'failed',
      reason: `Script not found at expected installed path: ${control.expectedInstalledPath}`,
      requestId
    };
  }

  const argv: string[] = ARGV_TABLE_DIRECT[control.id] ?? [];
  return executeChild({ control, argv, requestId, parseTrailer: false });
}

// -----------------------------------------------------------------------------
// safe-wrapper path (v0.5.14).
//
// NOTE: The HIGH/CRITICAL refusal below is the existing safe-wrapper fence
// and MUST NOT be weakened. v0.5.24 routes restore-w3forge through the new
// safe-recovery path instead of relaxing this check.
// -----------------------------------------------------------------------------
export async function runSafeWrapper({ control, requestId }: RunnerInput): Promise<RunResponse> {
  if (!control.enabled || control.runStrategy !== 'safe-wrapper') {
    return {
      controlId: control.id,
      accepted: false,
      runStatus: 'disabled',
      reason: 'Control is not safe-wrapper or not enabled - execution refused.',
      requestId
    };
  }
  if (control.riskLevel === 'HIGH' || control.riskLevel === 'CRITICAL') {
    return {
      controlId: control.id,
      accepted: false,
      runStatus: 'blocked',
      reason: 'HIGH/CRITICAL controls may not run on the safe-wrapper path.',
      requestId
    };
  }
  const argvBuilder = ARGV_TABLE_WRAPPER[control.id];
  if (!argvBuilder) {
    return {
      controlId: control.id,
      accepted: false,
      runStatus: 'needs_wrapper',
      reason: 'No wrapper argv binding registered for this control id.',
      requestId
    };
  }

  try {
    await fsp.access(control.expectedInstalledPath);
  } catch {
    return {
      controlId: control.id,
      accepted: false,
      runStatus: 'needs_wrapper',
      reason: `Wrapper script not found at expected installed path: ${control.expectedInstalledPath}`,
      requestId
    };
  }

  const argv = argvBuilder(requestId);
  return executeChild({ control, argv, requestId, parseTrailer: true });
}

// -----------------------------------------------------------------------------
// safe-recovery path (NEW in v0.5.24).
//
// Whitelisted CRITICAL recovery execution path. This is the ONLY way a
// CRITICAL control may reach the executor today, and only for ids in
// CRITICAL_RECOVERY_IDS. The existing HIGH/CRITICAL refusal inside
// runSafeWrapper above is unchanged.
//
// The route layer is responsible for:
//   - server-side input validation (basenames only, regex-matched)
//   - confirmations (checkbox + typed phrase RESTORE + typed db name w3forge)
//   - action-lock acquisition
//   - audit log: admitted/started/completed/failed/refused
//
// This runner enforces the whitelist + basename regex DEFENSIVELY before
// spawning any child process. It then invokes the bound wrapper with stdin
// closed and parses the structured trailer.
// -----------------------------------------------------------------------------
export async function runSafeRecovery(
  input: RecoveryRunnerInput
): Promise<RunResponse> {
  const { control, requestId, appBackupBasename, dbBackupBasename } = input;

  if (!control.enabled || control.runStrategy !== 'safe-recovery') {
    return {
      controlId: control.id,
      accepted: false,
      runStatus: 'disabled',
      reason: 'Control is not safe-recovery or not enabled - execution refused.',
      requestId
    };
  }

  // Whitelist gate - the single source of truth for which CRITICAL controls
  // are admitted to this path. Everything else is refused.
  if (!CRITICAL_RECOVERY_IDS.includes(control.id)) {
    return {
      controlId: control.id,
      accepted: false,
      runStatus: 'blocked',
      reason:
        'safe-recovery path is restricted to whitelisted recovery control ids.',
      requestId
    };
  }

  // Defensive basename re-validation. The route layer already did this; we
  // re-check to keep the runner self-contained and audit-friendly.
  //
  // The leading-dash check is structurally redundant with the anchored
  // APP_BACKUP_BASENAME_REGEX / DB_BACKUP_BASENAME_REGEX below (any value
  // not starting with 'w3forge_app_' / 'w3forge_db_' fails the regex), but it
  // is restated here as defence in depth so a future regex relaxation cannot
  // accidentally admit an argv-injection-shaped value through this runner.
  if (
    typeof appBackupBasename !== 'string' ||
    appBackupBasename.startsWith('-') ||
    !APP_BACKUP_BASENAME_REGEX.test(appBackupBasename) ||
    appBackupBasename.includes('/') ||
    appBackupBasename.includes('..')
  ) {
    return {
      controlId: control.id,
      accepted: false,
      runStatus: 'blocked',
      reason:
        'App backup basename rejected by safe-recovery runner (must match w3forge_app_*.tar.gz; no paths).',
      requestId
    };
  }
  if (
    typeof dbBackupBasename !== 'string' ||
    dbBackupBasename.startsWith('-') ||
    !DB_BACKUP_BASENAME_REGEX.test(dbBackupBasename) ||
    dbBackupBasename.includes('/') ||
    dbBackupBasename.includes('..')
  ) {
    return {
      controlId: control.id,
      accepted: false,
      runStatus: 'blocked',
      reason:
        'DB backup basename rejected by safe-recovery runner (must match w3forge_db_*.sql; no paths).',
      requestId
    };
  }

  try {
    await fsp.access(control.expectedInstalledPath);
  } catch {
    return {
      controlId: control.id,
      accepted: false,
      runStatus: 'needs_wrapper',
      reason: `Recovery wrapper script not found at expected installed path: ${control.expectedInstalledPath}`,
      requestId
    };
  }

  // Fixed argv contract for restore-w3forge-ui.sh:
  //   --yes --source ui --request-id <rid> --app <basename> --db <basename>
  const argv = [
    '--yes',
    '--source',
    'ui',
    '--request-id',
    requestId,
    '--app',
    appBackupBasename,
    '--db',
    dbBackupBasename
  ];
  return executeChild({ control, argv, requestId, parseTrailer: true });
}

// -----------------------------------------------------------------------------
// safe-deploy path (NEW in v0.5.25).
//
// Whitelisted HIGH-risk deploy execution path. This is the ONLY way a HIGH
// control may reach the executor today, and only for ids in
// DEPLOY_PACKAGE_IDS (today: 'deploy-w3forge'). The existing HIGH/CRITICAL
// refusal inside runSafeWrapper above is unchanged.
//
// The route layer is responsible for:
//   - server-side input validation (package basename only, regex-matched;
//     version tag matched; no '/', '..', or leading '-')
//   - confirmations (confirmBackup + confirmDeploy + typed DEPLOY + typed
//     target version)
//   - action-lock acquisition
//   - audit log: admitted/started/completed/failed/refused
//
// This runner enforces the whitelist + basename regex + version regex
// DEFENSIVELY before spawning any child process. It then invokes the bound
// wrapper (scripts/deploy-w3forge-ui.sh) with stdin closed and parses the
// structured trailer.
//
// The wrapper delegates to scripts/deploy-w3forge-noninteractive.sh which
// performs ONLY the deploy steps (verify package / mandatory backup / stop
// service / extract / migrate / restart / /health + /version probes). It
// never runs git tag, git commit, or git push. Tagging, merging, and
// pushing to main remain user-only operations.
// -----------------------------------------------------------------------------
export async function runSafeDeploy(
  input: DeployRunnerInput
): Promise<RunResponse> {
  const { control, requestId, packageBasename, targetVersion } = input;

  if (!control.enabled || control.runStrategy !== 'safe-deploy') {
    return {
      controlId: control.id,
      accepted: false,
      runStatus: 'disabled',
      reason: 'Control is not safe-deploy or not enabled - execution refused.',
      requestId
    };
  }

  // Whitelist gate - the single source of truth for which HIGH/CRITICAL
  // controls are admitted to this path. Everything else is refused.
  if (!DEPLOY_PACKAGE_IDS.includes(control.id)) {
    return {
      controlId: control.id,
      accepted: false,
      runStatus: 'blocked',
      reason:
        'safe-deploy path is restricted to whitelisted deploy control ids.',
      requestId
    };
  }

  // Defensive package basename re-validation. The route layer already did
  // this; we re-check to keep the runner self-contained and audit-friendly.
  //
  // The leading-dash check is structurally redundant with the anchored
  // DEPLOY_PACKAGE_BASENAME_REGEX below (any value not starting with
  // 'w3forge-v' fails the regex), but it is restated here as defence in
  // depth so a future regex relaxation cannot accidentally admit an
  // argv-injection-shaped value through this runner.
  if (
    typeof packageBasename !== 'string' ||
    packageBasename.startsWith('-') ||
    !DEPLOY_PACKAGE_BASENAME_REGEX.test(packageBasename) ||
    packageBasename.includes('/') ||
    packageBasename.includes('..')
  ) {
    return {
      controlId: control.id,
      accepted: false,
      runStatus: 'blocked',
      reason:
        'Package basename rejected by safe-deploy runner (must match w3forge-vX.Y.Z.tar.gz; no paths).',
      requestId
    };
  }

  if (
    typeof targetVersion !== 'string' ||
    targetVersion.startsWith('-') ||
    !DEPLOY_VERSION_REGEX.test(targetVersion)
  ) {
    return {
      controlId: control.id,
      accepted: false,
      runStatus: 'blocked',
      reason:
        'Target version rejected by safe-deploy runner (must match vX.Y.Z).',
      requestId
    };
  }

  // Cross-check: the embedded version in the package basename MUST match
  // the supplied target version. This makes it impossible to deploy a
  // mis-typed version against a different package.
  const expectedBasename = `w3forge-${targetVersion}.tar.gz`;
  if (packageBasename !== expectedBasename) {
    return {
      controlId: control.id,
      accepted: false,
      runStatus: 'blocked',
      reason: `Package basename (${packageBasename}) does not match target version (${targetVersion}). Expected ${expectedBasename}.`,
      requestId
    };
  }

  try {
    await fsp.access(control.expectedInstalledPath);
  } catch {
    return {
      controlId: control.id,
      accepted: false,
      runStatus: 'needs_wrapper',
      reason: `Deploy wrapper script not found at expected installed path: ${control.expectedInstalledPath}`,
      requestId
    };
  }

  // Fixed argv contract for deploy-w3forge-ui.sh:
  //   --yes --source ui --request-id <rid>
  //   --package <basename> --version <vX.Y.Z>
  const argv = [
    '--yes',
    '--source',
    'ui',
    '--request-id',
    requestId,
    '--package',
    packageBasename,
    '--version',
    targetVersion
  ];
  return executeChild({ control, argv, requestId, parseTrailer: true });
}

// -----------------------------------------------------------------------------
// safe-pipeline path (NEW in v0.5.29).
//
// Whitelisted Release Pipeline execution path. This is the ONLY way the
// pipeline-* controls reach the executor, and only for ids in PIPELINE_IDS.
// The existing HIGH/CRITICAL refusal inside runSafeWrapper above is
// unchanged; HIGH-risk pipeline controls (package / deploy-dev / rollback /
// reset-tree / create-tag / delete-tag) reach the executor exclusively
// through THIS path, and only when their id is whitelisted here.
//
// The route layer is responsible for:
//   - server-side input validation (branch / tag / package basename;
//     anchored regexes; no '/', '..', or leading '-')
//   - confirmations (per-control checkbox + typed phrase requirements)
//   - action-lock acquisition
//   - audit log: admitted/started/completed/failed/refused
//
// This runner enforces the whitelist + per-id argv contract + defensive
// regex re-validation before spawning any child process. It then invokes
// the bound wrapper (scripts/pipeline-*-w3forge-ui.sh) with stdin closed and
// parses the structured trailer.
//
// All pipeline wrappers operate against /opt/w3forge-deploy only. They never
// touch /opt/w3forge (runtime), /opt/w3forge-scripts (operator scripts), or
// production database state directly. The pipeline-deploy-dev wrapper
// delegates to the unmodified scripts/deploy-w3forge-noninteractive.sh
// (which performs the mandatory pre-deploy backup, verify, extract,
// migrate, restart, and probe).
//
// git tag, git commit on main, and git push to main remain user-only.
// pipeline-create-tag creates annotated tags on the dev/vX.Y.Z branch only
// and pushes ONLY that tag (refs/tags/<tag>); main is never pushed.
// -----------------------------------------------------------------------------
export async function runSafePipeline(
  input: PipelineRunnerInput
): Promise<RunResponse> {
  const { control, requestId } = input;

  if (!control.enabled || control.runStrategy !== 'safe-pipeline') {
    return {
      controlId: control.id,
      accepted: false,
      runStatus: 'disabled',
      reason: 'Control is not safe-pipeline or not enabled - execution refused.',
      requestId
    };
  }

  // Whitelist gate - the single source of truth for which controls are
  // admitted to this path. Everything else is refused.
  if (!PIPELINE_IDS.includes(control.id)) {
    return {
      controlId: control.id,
      accepted: false,
      runStatus: 'blocked',
      reason: 'safe-pipeline path is restricted to whitelisted pipeline control ids.',
      requestId
    };
  }

  const builder = ARGV_TABLE_PIPELINE[control.id];
  if (!builder) {
    return {
      controlId: control.id,
      accepted: false,
      runStatus: 'needs_wrapper',
      reason: 'No pipeline argv binding registered for this control id.',
      requestId
    };
  }

  // Defensive re-validation of every supplied input value before it can
  // reach the argv. The route layer already validates these; we restate
  // every check here so the runner is self-contained and audit-friendly.
  // Each `argv-injection`-shaped check (leading '-', '/', '..') is restated
  // as defence in depth so a future regex relaxation cannot accidentally
  // admit unsafe values through the wrapper flag parser.
  const overrideError = pipelineOverrideError(control.id, input);
  if (overrideError) {
    return {
      controlId: control.id, accepted: false, runStatus: 'blocked',
      reason: overrideError, requestId
    };
  }
  if (input.branch !== undefined) {
    const b = input.branch;
    if (
      typeof b !== 'string' ||
      b.length === 0 ||
      b === 'main' ||
      b.startsWith('-') ||
      b.includes('..') ||
      !PIPELINE_DEV_BRANCH_REGEX.test(b)
    ) {
      return {
        controlId: control.id,
        accepted: false,
        runStatus: 'blocked',
        reason: 'Branch rejected by safe-pipeline runner (must match dev/vX.Y.Z; main is refused).',
        requestId
      };
    }
  }
  if (input.tag !== undefined) {
    const t = input.tag;
    if (
      typeof t !== 'string' ||
      t.length === 0 ||
      t.startsWith('-') ||
      t.includes('/') ||
      t.includes('..') ||
      !PIPELINE_TAG_REGEX.test(t)
    ) {
      return {
        controlId: control.id,
        accepted: false,
        runStatus: 'blocked',
        reason: 'Tag rejected by safe-pipeline runner (must match vX.Y.Z; no paths).',
        requestId
      };
    }
  }
  if (input.packageBasename !== undefined) {
    const p = input.packageBasename;
    if (
      typeof p !== 'string' ||
      p.length === 0 ||
      p.startsWith('-') ||
      p.includes('/') ||
      p.includes('..') ||
      !PIPELINE_PACKAGE_REGEX.test(p)
    ) {
      return {
        controlId: control.id,
        accepted: false,
        runStatus: 'blocked',
        reason: 'Package basename rejected by safe-pipeline runner (must match w3forge-vX.Y.Z.tar.gz; no paths).',
        requestId
      };
    }
  }
  if (input.message !== undefined) {
    const m = input.message;
    if (
      typeof m !== 'string' ||
      m.length > 200 ||
      m.includes('\n') ||
      m.includes('\r')
    ) {
      return {
        controlId: control.id,
        accepted: false,
        runStatus: 'blocked',
        reason: 'Tag message rejected by safe-pipeline runner (max 200 chars; no newlines).',
        requestId
      };
    }
  }
  // v0.5.38: validate channel + version when supplied.
  if (input.channel !== undefined) {
    const c = input.channel;
    if (
      typeof c !== 'string' ||
      c.length === 0 ||
      c.startsWith('-') ||
      c.includes('/') ||
      c.includes('..') ||
      !PIPELINE_CHANNEL_REGEX.test(c)
    ) {
      return {
        controlId: control.id,
        accepted: false,
        runStatus: 'blocked',
        reason: 'Channel rejected by safe-pipeline runner (must be dev, main, or installed).',
        requestId
      };
    }
  }
  if (input.version !== undefined) {
    const v = input.version;
    if (
      typeof v !== 'string' ||
      v.length === 0 ||
      v.startsWith('-') ||
      v.includes('/') ||
      v.includes('..') ||
      !PIPELINE_TAG_REGEX.test(v)
    ) {
      return {
        controlId: control.id,
        accepted: false,
        runStatus: 'blocked',
        reason: 'Version rejected by safe-pipeline runner (must match vX.Y.Z).',
        requestId
      };
    }
  }

  // Per-id required-input gates. Each pipeline control id either requires
  // specific inputs (and refuses without them) or accepts none. Keep this
  // table tightly aligned with ARGV_TABLE_PIPELINE above.
  switch (control.id) {
    case 'pipeline-checkout-dev':
    case 'pipeline-push-dev':
      if (!input.branch) {
        return {
          controlId: control.id,
          accepted: false,
          runStatus: 'needs_inputs',
          reason: `${control.id} requires --branch (dev/vX.Y.Z).`,
          requestId
        };
      }
      break;
    case 'pipeline-package-dev':
    case 'pipeline-create-tag':
      if (!input.tag) {
        return {
          controlId: control.id,
          accepted: false,
          runStatus: 'needs_inputs',
          reason: `${control.id} requires --tag (vX.Y.Z).`,
          requestId
        };
      }
      break;
    case 'pipeline-verify-dev-pkg':
    case 'pipeline-deploy-dev':
      if (!input.packageBasename) {
        return {
          controlId: control.id,
          accepted: false,
          runStatus: 'needs_inputs',
          reason: `${control.id} requires --package (w3forge-vX.Y.Z.tar.gz).`,
          requestId
        };
      }
      break;
    case 'pipeline-delete-tag':
      if (!input.tag) {
        return {
          controlId: control.id,
          accepted: false,
          runStatus: 'needs_inputs',
          reason: 'pipeline-delete-tag requires --tag (vX.Y.Z).',
          requestId
        };
      }
      if (input.confirmDeleteTag !== 'DELETE-TAG') {
        return {
          controlId: control.id,
          accepted: false,
          runStatus: 'needs_confirmation',
          reason: 'pipeline-delete-tag requires the typed confirmation "DELETE-TAG".',
          requestId
        };
      }
      break;
    case 'pipeline-promote-dev-to-main': {
      // v0.5.38: requires an explicit version (vX.Y.Z) OR a legacy package
      // basename from which the version is derived.
      const ver =
        input.version ?? deriveVersionFromPackage(input.packageBasename);
      if (!ver || !PIPELINE_TAG_REGEX.test(ver)) {
        return {
          controlId: control.id,
          accepted: false,
          runStatus: 'needs_inputs',
          reason:
            'pipeline-promote-dev-to-main requires --version vX.Y.Z (or a legacy --package basename that embeds it).',
          requestId
        };
      }
      break;
    }
    default:
      // Other controls take no additional required inputs. Pull Latest's
      // optional override has already been validated above.
      break;
  }

  try {
    await fsp.access(control.expectedInstalledPath);
  } catch {
    return {
      controlId: control.id,
      accepted: false,
      runStatus: 'needs_wrapper',
      reason: `Pipeline wrapper script not found at expected installed path: ${control.expectedInstalledPath}`,
      requestId
    };
  }

  const argv = builder(requestId, input);
  return executeChild({ control, argv, requestId, parseTrailer: true });
}

// -----------------------------------------------------------------------------
// v0.5.32: Post-success artifact gate.
//
// Closes the v0.5.31 bug where Package Dev Release showed Success even when
// no /opt/w3forge-update-packages/dev/w3forge-vX.Y.Z.tar.gz appeared. We refuse to
// surface runStatus='success' for HIGH-risk pipeline controls unless the
// structured trailer carries a fully-resolved artifact path under the
// CONTROL-SPECIFIC approved root AND that file actually exists on disk.
//
// v0.5.32 dev-path follow-up: the per-control table below enforces dev/prod
// separation in the success criteria itself:
//   - pipeline-package-dev MUST write to /opt/w3forge-update-packages/dev/...
//     (production root is rejected so a misconfigured wrapper can never silently
//     pollute the canonical staged directory).
//   - pipeline-deploy-dev promotes a dev tarball INTO /opt/w3forge-update-packages/...
//     and emits the promoted path as staged_path, so its approved prefix is the
//     production root and its dev subdirectory is rejected as a no-op promotion.
//
// Returns a downgrade reason string when the gate fails, or null when the
// artifact contract is satisfied. We do NOT mutate the artifact, just check
// its existence. This is a read-only filesystem stat; it does not change
// deployment or packaging behaviour.
// -----------------------------------------------------------------------------
interface ArtifactGateRule {
  // Which structured trailer key carries the artifact path. package-dev emits
  // output_path; deploy-dev emits staged_path (the promoted production path).
  readonly key: 'output_path' | 'staged_path';
  // The approved directory the artifact MUST live in. Anything not starting
  // with this prefix (and free of '..' traversal) fails the gate. The trailing
  // slash is mandatory so /opt/w3forge-update-packages-evil/ cannot pass for
  // /opt/w3forge-update-packages/.
  readonly approvedPrefix: string;
  // Optional disallowed prefix to enforce dev/prod separation. For deploy-dev
  // we reject paths that still live under /opt/w3forge-update-packages/dev/ because
  // the promotion step must have moved the tarball out of dev.
  readonly disallowedPrefix?: string;
  // Human-readable description for failure messages so operators see exactly
  // what was expected.
  readonly expectedExample: string;
}

// v0.5.38: the canonical filename inside per-version directories is just
// w3forge.tar.gz, but legacy archives are still w3forge-vX.Y.Z.tar.gz. The
// artifact filename regex below accepts both shapes. The per-control gate
// directories themselves are unchanged for backward compatibility:
//   - pipeline-package-dev still writes under /opt/w3forge-update-packages/dev/
//   - pipeline-deploy-dev's artifact now lives under /opt/w3forge-update-packages/installed/
//     (the v0.5.38 deploy archives the deployed tarball there); legacy
//     staged path under /opt/w3forge-update-packages/ is still accepted to keep
//     pre-v0.5.38 packages working.
const PIPELINE_ARTIFACT_GATES: Record<string, ArtifactGateRule> = {
  // Package Dev Release writes the freshly-built tarball into the dev staging
  // area. Production root /opt/w3forge-update-packages/ is intentionally rejected so
  // a buggy wrapper variant cannot leak dev artefacts into production staging.
  'pipeline-package-dev': {
    key: 'output_path',
    approvedPrefix: path.resolve(UPDATE_PACKAGES_DEV_DIR) + path.sep,
    expectedExample: path.join(UPDATE_PACKAGES_DEV_DIR, '<vX.Y.Z>', 'w3forge.tar.gz')
  },
  // v0.5.38: Promote Dev to Main writes to the main channel directory.
  'pipeline-promote-dev-to-main': {
    key: 'output_path',
    approvedPrefix: path.resolve(UPDATE_PACKAGES_MAIN_DIR) + path.sep,
    expectedExample: path.join(UPDATE_PACKAGES_MAIN_DIR, '<vX.Y.Z>', 'w3forge.tar.gz')
  }
  // v0.5.38: pipeline-deploy-dev no longer has a single-path artifact gate.
  // The canonical layout deploys directly from <channel>/<v>/w3forge.tar.gz
  // and writes installed/<v>/w3forge.tar.gz as the durable record. The gate
  // has been removed for that id; success is now signalled by the structured
  // trailer status (status=success) and delegate exit code, with the
  // installed/<v>/ sidecars (deployed-at.txt, sha256.txt, ...) serving as
  // the persistent audit record.
};

async function validatePipelineArtifact(
  controlId: string,
  parsed: StructuredResult | null
): Promise<string | null> {
  const rule = PIPELINE_ARTIFACT_GATES[controlId];
  if (!rule) return null;

  const raw = parsed ? (parsed as Record<string, unknown>)[rule.key] : undefined;
  const artifactPath = typeof raw === 'string' ? raw : '';
  if (!artifactPath) {
    return (
      `Refusing Success: wrapper did not emit ${rule.key} in the structured ` +
      `result trailer. Expected ${rule.key} to be present (e.g. ` +
      `${rule.expectedExample}). Treating as failed.`
    );
  }
  if (artifactPath.includes('..') || !path.isAbsolute(artifactPath)) {
    return (
      `Refusing Success: ${rule.key} (${artifactPath}) is not inside the approved ` +
      '/opt/w3forge-update-packages tree. Treating as failed.'
    );
  }
  if (!artifactPath.startsWith(rule.approvedPrefix)) {
    return (
      `Refusing Success: ${rule.key} (${artifactPath}) is outside the approved ` +
      `directory for ${controlId} (${rule.approvedPrefix}). Treating as failed.`
    );
  }
  if (rule.disallowedPrefix && artifactPath.startsWith(rule.disallowedPrefix)) {
    return (
      `Refusing Success: ${rule.key} (${artifactPath}) still lives under ` +
      `${rule.disallowedPrefix} — ${controlId} must promote the artifact out ` +
      'of the dev staging area. Treating as failed.'
    );
  }
  // v0.5.38: accept both canonical and legacy artifact filenames.
  if (
    !/\/w3forge\.tar\.gz$/.test(artifactPath) &&
    !/\/w3forge-v[0-9]+\.[0-9]+\.[0-9]+\.tar\.gz$/.test(artifactPath)
  ) {
    return (
      `Refusing Success: ${rule.key} (${artifactPath}) does not look like a ` +
      'canonical w3forge.tar.gz or legacy w3forge-vX.Y.Z.tar.gz artifact. Treating as failed.'
    );
  }
  try {
    const [rootReal, artifactReal, artifactStat] = await Promise.all([
      fsp.realpath(rule.approvedPrefix), fsp.realpath(artifactPath), fsp.stat(artifactPath)
    ]);
    const relative = path.relative(rootReal, artifactReal);
    if (!artifactStat.isFile() || !relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      return 'Refusing Success: artifact resolves outside its configured package channel or is not a file.';
    }
  } catch {
    return (
      `Refusing Success: wrapper reported success but artifact does not ` +
      `exist on disk at ${artifactPath}. Treating as failed.`
    );
  }
  return null;
}

// -----------------------------------------------------------------------------
// Internal: actually spawn the child process. Shared by all paths.
// -----------------------------------------------------------------------------
async function executeChild({
  control,
  argv,
  requestId,
  parseTrailer
}: {
  control: AdminControl;
  argv: string[];
  requestId: string;
  parseTrailer: boolean;
}): Promise<RunResponse> {
  const started = Date.now();
  const policyReason = controlPolicyReason(control);
  if (policyReason) return { controlId: control.id, accepted: false, runStatus: 'blocked', reason: policyReason, requestId };
  try {
    const { stdout, stderr } = await execFileP(control.expectedInstalledPath, argv, {
      timeout: control.timeoutSeconds * 1000,
      maxBuffer: 8 * 1024 * 1024,
      shell: false,
      windowsHide: true,
      env: controlEnvironment()
    });
    const stdoutStr = stdout ?? '';
    const stderrStr = stderr ?? '';

    let runStatus: RunStatus = 'success';
    let reason = 'OK';
    let parsed: StructuredResult | null = null;
    if (parseTrailer) {
      parsed = parseStructuredTrailer(stdoutStr);
      runStatus = mapStructuredStatus(parsed?.status, 0);
      reason = parsed?.reason ?? (runStatus === 'success' ? 'OK' : 'Completed');
    }

    // v0.5.32: post-success artifact validation for HIGH-risk pipeline
    // controls that produce or operate on a tarball on disk. Even if the
    // wrapper reports status=success and exit 0, we refuse to surface
    // Success unless the expected artifact actually exists. This closes
    // the bug where Package Dev Release showed Success but no
    // /opt/w3forge-update-packages/dev/w3forge-vX.Y.Z.tar.gz was created.
    if (runStatus === 'success' && parseTrailer) {
      const downgrade = await validatePipelineArtifact(control.id, parsed);
      if (downgrade) {
        runStatus = 'failed';
        reason = downgrade;
      }
    }

    return {
      controlId: control.id,
      accepted: true,
      runStatus,
      reason,
      requestId,
      exitCode: 0,
      stdoutTail: tail(stdoutStr, TAIL_BYTES),
      stderrTail: tail(stderrStr, TAIL_BYTES),
      durationMs: Date.now() - started,
      logFile: null,
      structured: parsed ?? undefined
    };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
      killed?: boolean;
    };
    const exitCode = typeof e.code === 'number' ? e.code : -1;
    const stdoutStr = e.stdout ?? '';
    const stderrStr = e.stderr ?? '';

    let runStatus: RunStatus = 'failed';
    let reason = e.killed ? 'Killed (timeout)' : (e.message || 'Failed');
    let parsed: StructuredResult | null = null;
    if (parseTrailer) {
      parsed = parseStructuredTrailer(stdoutStr);
      runStatus = mapStructuredStatus(parsed?.status, exitCode);
      if (parsed?.reason) reason = parsed.reason;
    }

    // v0.5.32: defence in depth - if the wrapper somehow emitted
    // status=success but exec threw (non-zero exit code path), the artifact
    // is necessarily suspect. Re-run the same artifact gate.
    if (runStatus === 'success' && parseTrailer) {
      const downgrade = await validatePipelineArtifact(control.id, parsed);
      if (downgrade) {
        runStatus = 'failed';
        reason = downgrade;
      }
    }

    return {
      controlId: control.id,
      accepted: true,
      runStatus,
      reason,
      requestId,
      exitCode,
      stdoutTail: tail(stdoutStr, TAIL_BYTES),
      stderrTail: tail(stderrStr, TAIL_BYTES),
      durationMs: Date.now() - started,
      logFile: null,
      structured: parsed ?? undefined
    };
  }
}
