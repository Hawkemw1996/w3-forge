import { applyControlPolicy } from '../controls/controlPolicy';
import { env } from '../../config/env';
import { Router } from 'express';
import {
  ADMIN_CONTROLS,
  CATEGORY_META,
  deriveEffectiveStatus,
  getControl
} from '../controls/registry';
// v0.6.2: app-aware controls registry foundation. Additive only — the legacy
// ADMIN_CONTROLS array remains the source of control rows. decorateAppControl
// attaches the optional `app_id` field and resolves expectedInstalledPath
// through the app-config scripts directory (preserves legacy values on an
// unmodified host).
import {
  decorateAppControl,
  getAppControlRegistryMeta
} from '../controls/appControlRegistry';
import type {
  AdminControlsResponse,
  ControlCategory,
  ControlStatus,
  EffectiveStatus,
  RiskLevel,
  RunResponse,
  RunStatus,
  ScriptAuditRow,
  ScriptsAuditResponse,
  ValidateRequestBody
} from '../controls/types';
import { appendControlRunAudit } from '../adminAudit';
import { validateControl } from '../controls/validator';
import {
  runSafeDirect,
  runSafeWrapper,
  runSafeRecovery,
  runSafeDeploy,
  runSafePipeline,
  CRITICAL_RECOVERY_IDS,
  DEPLOY_PACKAGE_IDS,
  PIPELINE_IDS
} from '../controls/safeRunner';
import {
  acquire as acquireLock,
  release as releaseLock,
  snapshotCurrent as currentLock,
  newRequestId
} from '../controls/actionLock';

// =============================================================================
// /api/admin/controls/* - v0.5.29 Admin Controls
// (Recovery Center + Deploy Release Package + Release Pipeline wiring).
// =============================================================================
//
//   GET  /controls                       grouped registry for the UI
//   GET  /controls/scripts/audit         flat audit table (per-script)
//   GET  /controls/lock                  current action lock snapshot (or null)
//   POST /controls/:id/validate          dry-run validator (no execution)
//   POST /controls/:id/run               safe-direct OR safe-wrapper OR
//                                        safe-recovery OR safe-deploy OR
//                                        safe-pipeline execution
//
// v0.5.14 adds:
//   - safe-wrapper execution path (MEDIUM allowed) via runSafeWrapper.
//   - Global action lock for any write-class control (anything that is not
//     readOnly). Lock contention returns HTTP 409 with lockHeldBy populated
//     so the UI can render a "Another admin action is already running" banner.
//   - Multi-state runStatus on every /run response so the UI never shows
//     "Accepted" for a run that actually reported a failure or empty state.
//
// v0.5.24 adds:
//   - safe-recovery execution path. The dispatch admits ONLY control ids in
//     CRITICAL_RECOVERY_IDS (today: 'restore-w3forge'). The existing
//     HIGH/CRITICAL risk fence is preserved verbatim for every other path;
//     a single early branch reroutes whitelisted recovery ids around the
//     fence by dispatching them to runSafeRecovery before the fence is
//     reached. Every other CRITICAL control continues to be refused.
//   - Server-side basename validation for restore-w3forge inputs
//     (appBackupFilename, dbBackupFilename). Both must match a strict regex
//     and contain no `/` or `..`; arbitrary filesystem paths are rejected.
//
// v0.5.25 adds:
//   - safe-deploy execution path. The dispatch admits ONLY control ids in
//     DEPLOY_PACKAGE_IDS (today: 'deploy-w3forge'). The existing
//     HIGH/CRITICAL risk fence is preserved verbatim for every other path;
//     a single early branch reroutes whitelisted deploy ids around the
//     fence by dispatching them to runSafeDeploy before the fence is
//     reached. Every other HIGH/CRITICAL control continues to be refused.
//   - Server-side basename + version validation for deploy-w3forge inputs
//     (packageName, targetVersion). The package basename must match a
//     strict regex (w3forge-vX.Y.Z.tar.gz), the version must match vX.Y.Z,
//     and the basename's embedded version must equal the supplied target
//     version. Arbitrary filesystem paths, '/', '..', and leading '-' are
//     rejected.
//
// v0.5.29 adds:
//   - safe-pipeline execution path. The dispatch admits ONLY control ids in
//     PIPELINE_IDS (the pipeline-* Release Pipeline whitelist). The existing
//     HIGH/CRITICAL risk fence is preserved verbatim for every other path;
//     a single early branch reroutes whitelisted pipeline ids around the
//     fence by dispatching them to runSafePipeline before the fence is
//     reached. Every other HIGH/CRITICAL control outside the recovery,
//     deploy, and pipeline whitelists continues to be refused.
//   - Server-side input validation for pipeline-* controls:
//       * branch (dev/vX.Y.Z) - regex-fenced; main is never accepted.
//       * tag (vX.Y.Z)        - regex-fenced.
//       * packageName         - w3forge-vX.Y.Z.tar.gz basename only;
//                               no '/', '..', or leading '-'.
//       * confirmDeleteTag    - must literally equal DELETE-TAG.
//     Validation runs at the route layer, again inside runSafePipeline, and
//     again inside the installed pipeline-*-w3forge-ui.sh wrapper.

const RELEASE = env.appVersion.startsWith('v') ? env.appVersion : 'v' + env.appVersion;

function emptyStatusCounter(): Record<ControlStatus, number> {
  return {
    UI_READY: 0,
    NEEDS_INPUTS: 0,
    NEEDS_WRAPPER: 0,
    DANGEROUS_DISABLED: 0,
    TERMINAL_ONLY: 0,
    UNKNOWN_REVIEW_REQUIRED: 0
  };
}

function emptyEffectiveStatusCounter(): Record<EffectiveStatus, number> {
  return {
    UI_READY: 0,
    NEEDS_WRAPPER: 0,
    TERMINAL_ONLY: 0,
    DISABLED: 0
  };
}

function emptyRiskCounter(): Record<RiskLevel, number> {
  return { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 };
}

function refusal(controlId: string, runStatus: RunStatus, reason: string): RunResponse {
  return { controlId, accepted: false, runStatus, reason };
}

export function buildAdminControlsRoutes(): Router {
  const router = Router();

  // ---------------------------------------------------------------------------
  // GET /controls - grouped registry for the UI.
  // ---------------------------------------------------------------------------
  router.get('/controls', (_req, res) => {
    const byStatus = emptyStatusCounter();
    const byEffectiveStatus = emptyEffectiveStatusCounter();
    const byRisk = emptyRiskCounter();
    const groups = new Map<
      ControlCategory,
      AdminControlsResponse['categories'][number]
    >();

    for (const cat of Object.keys(CATEGORY_META) as ControlCategory[]) {
      groups.set(cat, {
        id: cat,
        label: CATEGORY_META[cat].label,
        description: CATEGORY_META[cat].description,
        controls: []
      });
    }

    // v0.6.2: decorate via the app-aware layer. Iteration source remains the
    // legacy ADMIN_CONTROLS array, so order, count, ids, categories, risk
    // levels, run strategies, and confirmation requirements are unchanged.
    const meta = getAppControlRegistryMeta();
    for (const registered of ADMIN_CONTROLS) {
      const control = applyControlPolicy(registered);
      byStatus[control.status] += 1;
      byEffectiveStatus[deriveEffectiveStatus(control)] += 1;
      byRisk[control.riskLevel] += 1;
      const group = groups.get(control.category);
      if (group) group.controls.push(decorateAppControl(control, meta.app_id));
    }

    const ordered = (Object.keys(CATEGORY_META) as ControlCategory[])
      .sort((a, b) => CATEGORY_META[a].order - CATEGORY_META[b].order)
      .map((id) => groups.get(id)!)
      .filter((g) => g.controls.length > 0);

    const payload: AdminControlsResponse = {
      generatedAt: new Date().toISOString(),
      version: env.appVersion,
      release: RELEASE,
      categories: ordered,
      counts: {
        total: ADMIN_CONTROLS.length,
        byStatus,
        byEffectiveStatus,
        byRisk
      },
      // v0.6.2 additive fields. Backward-compatible — v0.5.x clients ignore.
      app_id: meta.app_id,
      app_name: meta.app_name,
      registry_source: meta.registry_source,
      config_driven: meta.config_driven
    };

    res.json({ success: true, data: payload });
  });

  // ---------------------------------------------------------------------------
  // GET /controls/scripts/audit - flat per-script audit table.
  // ---------------------------------------------------------------------------
  router.get('/controls/scripts/audit', (_req, res) => {
    // v0.6.2: installedPath comes from the decorated control so it reflects
    // the app-config scripts directory. All other fields are unchanged.
    const rows: ScriptAuditRow[] = ADMIN_CONTROLS.map((c) => {
      const decorated = decorateAppControl(c);
      return {
        id: c.id,
        scriptName: c.scriptName,
        sourcePath: c.scriptSourcePath,
        installedPath: decorated.expectedInstalledPath,
        category: c.category,
        riskLevel: c.riskLevel,
        status: c.status,
        enabled: c.enabled,
        interactiveToday: !c.nonInteractiveToday,
        interactivePrompts: c.interactivePromptsToday,
        needsWrapper: c.runStrategy === 'wrapper' || c.status === 'NEEDS_WRAPPER',
        notes: c.notes
      };
    });

    const payload: ScriptsAuditResponse = {
      generatedAt: new Date().toISOString(),
      release: RELEASE,
      totalScripts: rows.length,
      rows
    };
    res.json({ success: true, data: payload });
  });

  // ---------------------------------------------------------------------------
  // GET /controls/lock - current action lock snapshot (or null).
  // The UI polls this when it sees a 409 to render a live banner.
  // ---------------------------------------------------------------------------
  router.get('/controls/lock', (_req, res) => {
    res.json({ success: true, data: { active: currentLock() } });
  });

  // ---------------------------------------------------------------------------
  // POST /controls/:id/validate - dry-run validator, never executes.
  // ---------------------------------------------------------------------------
  router.post('/controls/:id/validate', (req, res) => {
    const registered = getControl(req.params.id);
    const control = registered ? applyControlPolicy(registered) : undefined;
    if (!control) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'CONTROL_NOT_FOUND',
          message: `No admin control with id "${req.params.id}".`
        }
      });
    }
    const body = (req.body ?? {}) as ValidateRequestBody;
    const result = validateControl(control, body);
    res.json({ success: true, data: result });
  });

  // ---------------------------------------------------------------------------
  // POST /controls/:id/run - safe-direct or safe-wrapper execution only.
  //
  // v0.5.14 audit instrumentation:
  //   Every branch below emits exactly one structured per-control-run audit
  //   line via appendControlRunAudit(). The line carries the request id,
  //   outcome (RunStatus), reason, and - for completed runs - exit code and
  //   duration. The wider /api/admin/* request-level audit log still runs in
  //   parallel via the adminAudit middleware (controlsRoutes is mounted under
  //   it in admin/index.ts), so this file does NOT need to repeat method/path/
  //   status - only the controls-execution-specific facts.
  // ---------------------------------------------------------------------------
  router.post('/controls/:id/run', async (req, res) => {
    const registered = getControl(req.params.id);
    const control = registered ? applyControlPolicy(registered) : undefined;
    if (!control) {
      // Note: no controlId resolved - still log so misuses are visible.
      appendControlRunAudit({
        controlId: req.params.id ?? '(unknown)',
        phase: 'refused',
        outcome: 'not_found',
        reason: `No admin control with id "${req.params.id}".`,
        adminMode: req.adminAuth?.mode,
        ip: req.ip ?? null
      });
      return res.status(404).json({
        success: false,
        error: {
          code: 'CONTROL_NOT_FOUND',
          message: `No admin control with id "${req.params.id}".`
        }
      });
    }

    // Shared audit fields for this control (lets every branch stay compact).
    const auditBase = {
      controlId: control.id,
      riskLevel: control.riskLevel,
      runStrategy: control.runStrategy,
      enabled: control.enabled,
      effectiveStatus: deriveEffectiveStatus(control),
      adminMode: req.adminAuth?.mode,
      ip: req.ip ?? null
    };

    // ---- 1) Gate by strategy + enabled. Refuse anything that is not a UI-
    //         executable strategy in a clear, single branch.
    if (!control.enabled) {
      const data = refusal(control.id, 'disabled', 'Control is disabled.');
      appendControlRunAudit({ ...auditBase, phase: 'refused', outcome: data.runStatus, reason: data.reason });
      return res.status(409).json({ success: true, data });
    }
    if (control.runStrategy === 'disabled') {
      const data = refusal(control.id, 'disabled', 'Run strategy is "disabled".');
      appendControlRunAudit({ ...auditBase, phase: 'refused', outcome: data.runStatus, reason: data.reason });
      return res.status(409).json({ success: true, data });
    }
    if (control.runStrategy === 'terminal-only') {
      const data = refusal(
        control.id,
        'disabled',
        'Control is TERMINAL_ONLY. Run it from the host shell instead.'
      );
      appendControlRunAudit({ ...auditBase, phase: 'refused', outcome: data.runStatus, reason: data.reason });
      return res.status(409).json({ success: true, data });
    }
    if (control.runStrategy === 'wrapper') {
      const data = refusal(
        control.id,
        'needs_wrapper',
        'Control NEEDS_WRAPPER - no installed non-interactive wrapper. UI execution is not wired yet.'
      );
      appendControlRunAudit({ ...auditBase, phase: 'refused', outcome: data.runStatus, reason: data.reason });
      return res.status(409).json({ success: true, data });
    }
    if (
      control.runStrategy !== 'safe-direct' &&
      control.runStrategy !== 'safe-wrapper' &&
      control.runStrategy !== 'safe-recovery' &&
      control.runStrategy !== 'safe-deploy' &&
      control.runStrategy !== 'safe-pipeline'
    ) {
      const data = refusal(control.id, 'disabled', 'Control is not enabled for UI execution.');
      appendControlRunAudit({ ...auditBase, phase: 'refused', outcome: data.runStatus, reason: data.reason });
      return res.status(409).json({ success: true, data });
    }

    // ---- 2a) v0.5.24 Recovery Center early admission.
    //
    //         If and only if the control declares runStrategy='safe-recovery'
    //         AND its id is in the CRITICAL_RECOVERY_IDS whitelist, we admit
    //         it BEFORE the HIGH/CRITICAL fence below. This is the ONLY way
    //         a CRITICAL control can reach an executor today, and the
    //         whitelist is intentionally tiny (restore-w3forge only).
    //
    //         The existing HIGH/CRITICAL fence below is unchanged and still
    //         refuses every other CRITICAL control - deploy-w3forge,
    //         hardreset-data, patch controls, cleanup-legacy, etc.
    if (control.runStrategy === 'safe-recovery') {
      if (!CRITICAL_RECOVERY_IDS.includes(control.id)) {
        const data = refusal(
          control.id,
          'blocked',
          'safe-recovery is restricted to whitelisted recovery control ids.'
        );
        appendControlRunAudit({ ...auditBase, phase: 'refused', outcome: data.runStatus, reason: data.reason });
        return res.status(409).json({ success: true, data });
      }

      // Validate inputs + confirmations BEFORE acquiring the lock.
      const body = (req.body ?? {}) as ValidateRequestBody;
      const validation = validateControl(control, body);
      if (!validation.runnable) {
        const status: RunStatus = (() => {
          const k = validation.issues[0]?.kind;
          if (k === 'missing') return 'needs_confirmation';
          if (k === 'mismatch') return 'needs_confirmation';
          if (k === 'disabled') return 'disabled';
          return 'blocked';
        })();
        const data: RunResponse = {
          controlId: control.id,
          accepted: false,
          runStatus: status,
          reason:
            'Validation failed: ' + validation.issues.map((i) => i.message).join(' ')
        };
        appendControlRunAudit({ ...auditBase, phase: 'refused', outcome: status, reason: data.reason });
        return res.status(409).json({ success: true, data, validation });
      }

      // Strict server-side basename validation for restore-w3forge inputs.
      // No arbitrary paths, no traversal - the UI may only select from the
      // approved /opt/backups/w3forge directory and may only submit basenames.
      const inputs = (body.inputs ?? {}) as Record<string, unknown>;
      const appBackupRaw = inputs['appBackupFilename'];
      const dbBackupRaw = inputs['dbBackupFilename'];
      const appBackup = typeof appBackupRaw === 'string' ? appBackupRaw : '';
      const dbBackup = typeof dbBackupRaw === 'string' ? dbBackupRaw : '';
      const APP_RE =
        /^w3forge_app_[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{2}-[0-9]{2}-[0-9]{2}\.tar\.gz$/;
      const DB_RE =
        /^w3forge_db_[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{2}-[0-9]{2}-[0-9]{2}\.sql$/;
      // Defence-in-depth: explicitly reject leading-dash filenames. The
      // anchored APP_RE/DB_RE regexes below already reject any value not
      // starting with 'w3forge_app_' / 'w3forge_db_', so a leading '-' is
      // already structurally impossible to pass. We restate the check here
      // so the rejection is obvious at audit-grep time and so any future
      // regex relaxation cannot accidentally re-admit argv-injection-shaped
      // inputs through the wrapper/delegate flag parser. The wrapper and
      // delegate scripts perform the same check independently.
      const badAppBasename =
        !appBackup ||
        appBackup.startsWith('-') ||
        appBackup.includes('/') ||
        appBackup.includes('..') ||
        !APP_RE.test(appBackup);
      const badDbBasename =
        !dbBackup ||
        dbBackup.startsWith('-') ||
        dbBackup.includes('/') ||
        dbBackup.includes('..') ||
        !DB_RE.test(dbBackup);
      if (badAppBasename || badDbBasename) {
        const data = refusal(
          control.id,
          'blocked',
          'Backup selection rejected: appBackupFilename and dbBackupFilename must be basenames inside the approved backup directory only.'
        );
        appendControlRunAudit({ ...auditBase, phase: 'refused', outcome: data.runStatus, reason: data.reason });
        return res.status(409).json({ success: true, data });
      }

      // Acquire the global action lock - restore-w3forge is write-class.
      const requestId = newRequestId();
      const got = await acquireLock({ controlId: control.id, requestId });
      if (!got.ok) {
        const data: RunResponse = {
          controlId: control.id,
          accepted: false,
          runStatus: 'already_running',
          reason: `Another admin action is already running: ${got.active.controlId} (started ${got.active.startedAt}).`,
          lockHeldBy: got.active
        };
        appendControlRunAudit({
          ...auditBase,
          phase: 'refused',
          outcome: 'already_running',
          requestId,
          reason: data.reason,
          lockHeldBy: got.active
        });
        return res.status(409).json({ success: true, data });
      }

      appendControlRunAudit({ ...auditBase, phase: 'admitted', outcome: 'admitted', requestId });
      try {
        const result = await runSafeRecovery({
          control,
          requestId,
          appBackupBasename: appBackup,
          dbBackupBasename: dbBackup
        });
        appendControlRunAudit({
          ...auditBase,
          phase: 'completed',
          outcome: result.runStatus,
          requestId,
          reason: result.reason,
          exitCode: result.exitCode,
          durationMs: result.durationMs
        });
        return res.json({ success: true, data: result });
      } finally {
        await releaseLock(requestId);
      }
    }

    // ---- 2b) v0.5.25 Deploy Release Package early admission.
    //
    //         If and only if the control declares runStrategy='safe-deploy'
    //         AND its id is in the DEPLOY_PACKAGE_IDS whitelist, we admit
    //         it BEFORE the HIGH/CRITICAL fence below. This is the ONLY way
    //         a HIGH deploy control can reach an executor today, and the
    //         whitelist is intentionally tiny (deploy-w3forge only).
    //
    //         The existing HIGH/CRITICAL fence below is unchanged and still
    //         refuses every other HIGH/CRITICAL control - hardreset-data,
    //         patch controls, cleanup-legacy, etc. The safe-recovery path
    //         (2a above) still admits restore-w3forge. No other strategy can
    //         cross the fence.
    if (control.runStrategy === 'safe-deploy') {
      if (!DEPLOY_PACKAGE_IDS.includes(control.id)) {
        const data = refusal(
          control.id,
          'blocked',
          'safe-deploy is restricted to whitelisted deploy control ids.'
        );
        appendControlRunAudit({ ...auditBase, phase: 'refused', outcome: data.runStatus, reason: data.reason });
        return res.status(409).json({ success: true, data });
      }

      // Validate inputs + confirmations BEFORE acquiring the lock.
      const body = (req.body ?? {}) as ValidateRequestBody;
      const validation = validateControl(control, body);
      if (!validation.runnable) {
        const status: RunStatus = (() => {
          const k = validation.issues[0]?.kind;
          if (k === 'missing') return 'needs_confirmation';
          if (k === 'mismatch') return 'needs_confirmation';
          if (k === 'disabled') return 'disabled';
          return 'blocked';
        })();
        const data: RunResponse = {
          controlId: control.id,
          accepted: false,
          runStatus: status,
          reason:
            'Validation failed: ' + validation.issues.map((i) => i.message).join(' ')
        };
        appendControlRunAudit({ ...auditBase, phase: 'refused', outcome: status, reason: data.reason });
        return res.status(409).json({ success: true, data, validation });
      }

      // Strict server-side basename + version validation for deploy-w3forge
      // inputs. No arbitrary paths, no traversal - the UI may only select
      // from the approved /opt/w3forge-update-packages directory and may only submit
      // basenames. The package basename embedded version MUST equal the
      // typed targetVersion so a mis-typed version cannot deploy a different
      // package.
      const inputs = (body.inputs ?? {}) as Record<string, unknown>;
      const packageNameRaw = inputs['packageName'];
      const targetVersionRaw = inputs['targetVersion'];
      const packageName = typeof packageNameRaw === 'string' ? packageNameRaw : '';
      const targetVersion = typeof targetVersionRaw === 'string' ? targetVersionRaw : '';
      const PKG_RE = /^w3forge-v[0-9]+\.[0-9]+\.[0-9]+\.tar\.gz$/;
      const VER_RE = /^v[0-9]+\.[0-9]+\.[0-9]+$/;
      // Defence-in-depth: explicitly reject leading-dash filenames and any
      // value containing '/' or '..'. The anchored PKG_RE/VER_RE regexes
      // already reject any value not starting with 'w3forge-v' / 'v', so a
      // leading '-' is already structurally impossible to pass. We restate
      // the check here so the rejection is obvious at audit-grep time and
      // so any future regex relaxation cannot accidentally re-admit
      // argv-injection-shaped inputs through the wrapper/delegate flag
      // parser. The wrapper and delegate scripts perform the same check
      // independently.
      const badPackageName =
        !packageName ||
        packageName.startsWith('-') ||
        packageName.includes('/') ||
        packageName.includes('..') ||
        !PKG_RE.test(packageName);
      const badTargetVersion =
        !targetVersion ||
        targetVersion.startsWith('-') ||
        !VER_RE.test(targetVersion);
      if (badPackageName || badTargetVersion) {
        const data = refusal(
          control.id,
          'blocked',
          'Deploy selection rejected: packageName must be a w3forge-vX.Y.Z.tar.gz basename inside the approved package directory, and targetVersion must match vX.Y.Z.'
        );
        appendControlRunAudit({ ...auditBase, phase: 'refused', outcome: data.runStatus, reason: data.reason });
        return res.status(409).json({ success: true, data });
      }
      // Cross-check: the embedded version in the basename MUST equal the
      // typed targetVersion. This makes it impossible to deploy a mis-typed
      // version against a different package.
      const expectedBasename = `w3forge-${targetVersion}.tar.gz`;
      if (packageName !== expectedBasename) {
        const data = refusal(
          control.id,
          'blocked',
          `Deploy selection rejected: package basename (${packageName}) does not match target version (${targetVersion}). Expected ${expectedBasename}.`
        );
        appendControlRunAudit({ ...auditBase, phase: 'refused', outcome: data.runStatus, reason: data.reason });
        return res.status(409).json({ success: true, data });
      }

      // Acquire the global action lock - deploy-w3forge is write-class.
      const requestId = newRequestId();
      const got = await acquireLock({ controlId: control.id, requestId });
      if (!got.ok) {
        const data: RunResponse = {
          controlId: control.id,
          accepted: false,
          runStatus: 'already_running',
          reason: `Another admin action is already running: ${got.active.controlId} (started ${got.active.startedAt}).`,
          lockHeldBy: got.active
        };
        appendControlRunAudit({
          ...auditBase,
          phase: 'refused',
          outcome: 'already_running',
          requestId,
          reason: data.reason,
          lockHeldBy: got.active
        });
        return res.status(409).json({ success: true, data });
      }

      appendControlRunAudit({ ...auditBase, phase: 'admitted', outcome: 'admitted', requestId });
      try {
        const result = await runSafeDeploy({
          control,
          requestId,
          packageBasename: packageName,
          targetVersion: targetVersion
        });
        appendControlRunAudit({
          ...auditBase,
          phase: 'completed',
          outcome: result.runStatus,
          requestId,
          reason: result.reason,
          exitCode: result.exitCode,
          durationMs: result.durationMs
        });
        return res.json({ success: true, data: result });
      } finally {
        await releaseLock(requestId);
      }
    }

    // ---- 2c) v0.5.29 Release Pipeline early admission.
    //
    //         If and only if the control declares runStrategy='safe-pipeline'
    //         AND its id is in the PIPELINE_IDS whitelist, we admit it BEFORE
    //         the HIGH/CRITICAL fence below. This is the third (and currently
    //         final) way a HIGH-risk control can reach an executor today, and
    //         the whitelist is intentionally fixed (pipeline-* ids only).
    //
    //         The existing HIGH/CRITICAL fence below is unchanged and still
    //         refuses every other HIGH/CRITICAL control - hardreset-data,
    //         patch controls, cleanup-legacy, etc. The safe-recovery path
    //         (2a above) still admits restore-w3forge. The safe-deploy path
    //         (2b above) still admits deploy-w3forge. No other strategy can
    //         cross the fence.
    //
    //         All pipeline-* controls target /opt/w3forge-deploy only; the
    //         live runtime path /opt/w3forge is never touched by safe-pipeline.
    //         The deploy-w3forge runtime extract path remains owned by the
    //         separate safe-deploy whitelist.
    if (control.runStrategy === 'safe-pipeline') {
      if (!PIPELINE_IDS.includes(control.id)) {
        const data = refusal(
          control.id,
          'blocked',
          'safe-pipeline is restricted to whitelisted pipeline-* control ids.'
        );
        appendControlRunAudit({ ...auditBase, phase: 'refused', outcome: data.runStatus, reason: data.reason });
        return res.status(409).json({ success: true, data });
      }

      // Validate inputs + confirmations BEFORE acquiring the lock.
      const body = (req.body ?? {}) as ValidateRequestBody;
      const validation = validateControl(control, body);
      if (!validation.runnable) {
        const status: RunStatus = (() => {
          const k = validation.issues[0]?.kind;
          if (k === 'missing') return 'needs_confirmation';
          if (k === 'mismatch') return 'needs_confirmation';
          if (k === 'disabled') return 'disabled';
          return 'blocked';
        })();
        const data: RunResponse = {
          controlId: control.id,
          accepted: false,
          runStatus: status,
          reason:
            'Validation failed: ' + validation.issues.map((i) => i.message).join(' ')
        };
        appendControlRunAudit({ ...auditBase, phase: 'refused', outcome: status, reason: data.reason });
        return res.status(409).json({ success: true, data, validation });
      }

      // Strict server-side validation for pipeline-* inputs. The same regexes
      // are mirrored inside runSafePipeline and inside each installed
      // pipeline-*-w3forge-ui.sh wrapper. The route layer enforces them first
      // so an obviously bad payload never reaches the runner.
      const inputs = (body.inputs ?? {}) as Record<string, unknown>;
      const branchRaw = inputs['branch'];
      const tagRaw = inputs['tag'];
      const packageRaw = inputs['packageName'];
      const messageRaw = inputs['message'];
      const confirmDeleteRaw = inputs['confirmDeleteTag'];
      const channelRaw = inputs['channel'];
      const versionRaw = inputs['version'];
      const branch = typeof branchRaw === 'string' ? branchRaw : '';
      const tag = typeof tagRaw === 'string' ? tagRaw : '';
      const packageName = typeof packageRaw === 'string' ? packageRaw : '';
      const message = typeof messageRaw === 'string' ? messageRaw : '';
      const confirmDeleteTag = typeof confirmDeleteRaw === 'string' ? confirmDeleteRaw : '';
      const channel = typeof channelRaw === 'string' ? channelRaw : '';
      const version = typeof versionRaw === 'string' ? versionRaw : '';
      const DEV_BRANCH_RE = /^dev\/v[0-9]+\.[0-9]+\.[0-9]+$/;
      const TAG_RE = /^v[0-9]+\.[0-9]+\.[0-9]+$/;
      // v0.5.38: accept BOTH the canonical channel/version filename
      // (w3forge.tar.gz) AND the legacy embedded-version filename
      // (w3forge-vX.Y.Z.tar.gz) while the transition is in flight.
      const PIPELINE_PKG_RE = /^(?:w3forge\.tar\.gz|w3forge-v[0-9]+\.[0-9]+\.[0-9]+\.tar\.gz)$/;
      const PIPELINE_CHANNEL_RE = /^(?:dev|main)$/;
      const PIPELINE_VERSION_RE = /^v[0-9]+\.[0-9]+\.[0-9]+$/;

      // Per-id required-input gates. A missing or malformed required input is
      // rejected at the route layer with a clear reason so the UI can render
      // a precise blocker message.
      const requiresBranch =
        control.id === 'pipeline-checkout-dev' || control.id === 'pipeline-push-dev';
      const requiresTag =
        control.id === 'pipeline-package-dev' ||
        control.id === 'pipeline-create-tag' ||
        control.id === 'pipeline-delete-tag';
      const requiresPackage =
        control.id === 'pipeline-verify-dev-pkg' || control.id === 'pipeline-deploy-dev';
      const requiresConfirmDelete = control.id === 'pipeline-delete-tag';
      // v0.5.38: promote-dev-to-main requires version (the source dev/<v>/
      // directory to promote). channel is optional everywhere and defaults
      // to 'dev' inside the runner.
      const requiresVersion = control.id === 'pipeline-promote-dev-to-main';

      if (requiresBranch) {
        const badBranch =
          !branch ||
          branch.startsWith('-') ||
          branch.includes('..') ||
          !DEV_BRANCH_RE.test(branch);
        if (badBranch) {
          const data = refusal(
            control.id,
            'blocked',
            'Pipeline input rejected: branch must match dev/vX.Y.Z (main and other refs are never accepted).'
          );
          appendControlRunAudit({ ...auditBase, phase: 'refused', outcome: data.runStatus, reason: data.reason });
          return res.status(409).json({ success: true, data });
        }
      }

      if (requiresTag) {
        const badTag =
          !tag ||
          tag.startsWith('-') ||
          tag.includes('/') ||
          tag.includes('..') ||
          !TAG_RE.test(tag);
        if (badTag) {
          const data = refusal(
            control.id,
            'blocked',
            'Pipeline input rejected: tag must match vX.Y.Z.'
          );
          appendControlRunAudit({ ...auditBase, phase: 'refused', outcome: data.runStatus, reason: data.reason });
          return res.status(409).json({ success: true, data });
        }
      }

      if (requiresPackage) {
        const badPkg =
          !packageName ||
          packageName.startsWith('-') ||
          packageName.includes('/') ||
          packageName.includes('..') ||
          !PIPELINE_PKG_RE.test(packageName);
        if (badPkg) {
          const data = refusal(
            control.id,
            'blocked',
            'Pipeline input rejected: packageName must be a w3forge-vX.Y.Z.tar.gz basename inside the approved package directory.'
          );
          appendControlRunAudit({ ...auditBase, phase: 'refused', outcome: data.runStatus, reason: data.reason });
          return res.status(409).json({ success: true, data });
        }
      }

      if (requiresConfirmDelete && confirmDeleteTag !== 'DELETE-TAG') {
        const data = refusal(
          control.id,
          'blocked',
          'Pipeline input rejected: confirmDeleteTag must literally equal DELETE-TAG.'
        );
        appendControlRunAudit({ ...auditBase, phase: 'refused', outcome: data.runStatus, reason: data.reason });
        return res.status(409).json({ success: true, data });
      }

      // v0.5.38: optional channel (dev|main). When provided it MUST match.
      // When omitted, the runner / wrapper applies the per-id default.
      if (channel && !PIPELINE_CHANNEL_RE.test(channel)) {
        const data = refusal(
          control.id,
          'blocked',
          'Pipeline input rejected: channel must be dev or main.'
        );
        appendControlRunAudit({ ...auditBase, phase: 'refused', outcome: data.runStatus, reason: data.reason });
        return res.status(409).json({ success: true, data });
      }

      // v0.5.38: version is required for pipeline-promote-dev-to-main
      // (identifies which dev/<v>/ to promote into main/<v>/). It is also
      // accepted as an override on verify/deploy when packageName is the
      // canonical w3forge.tar.gz (which carries no embedded version).
      if (requiresVersion) {
        if (!version || version.startsWith('-') || !PIPELINE_VERSION_RE.test(version)) {
          const data = refusal(
            control.id,
            'blocked',
            'Pipeline input rejected: version must match vX.Y.Z.'
          );
          appendControlRunAudit({ ...auditBase, phase: 'refused', outcome: data.runStatus, reason: data.reason });
          return res.status(409).json({ success: true, data });
        }
      } else if (version && !PIPELINE_VERSION_RE.test(version)) {
        const data = refusal(
          control.id,
          'blocked',
          'Pipeline input rejected: version (when supplied) must match vX.Y.Z.'
        );
        appendControlRunAudit({ ...auditBase, phase: 'refused', outcome: data.runStatus, reason: data.reason });
        return res.status(409).json({ success: true, data });
      }

      // v0.5.38: when packageName is the canonical w3forge.tar.gz on a
      // verify/deploy control, a version override MUST be supplied (the
      // filename itself no longer carries the version).
      if (
        requiresPackage &&
        packageName === 'w3forge.tar.gz' &&
        !version
      ) {
        const data = refusal(
          control.id,
          'blocked',
          'Pipeline input rejected: when packageName is the canonical w3forge.tar.gz, version (vX.Y.Z) is required so the resolver can locate <channel>/<version>/w3forge.tar.gz.'
        );
        appendControlRunAudit({ ...auditBase, phase: 'refused', outcome: data.runStatus, reason: data.reason });
        return res.status(409).json({ success: true, data });
      }

      // Optional message: bound length defensively even though the wrapper
      // already truncates. Reject obvious argv-injection shapes.
      if (message && (message.startsWith('-') || message.length > 256)) {
        const data = refusal(
          control.id,
          'blocked',
          'Pipeline input rejected: message must not start with - and must be at most 256 characters.'
        );
        appendControlRunAudit({ ...auditBase, phase: 'refused', outcome: data.runStatus, reason: data.reason });
        return res.status(409).json({ success: true, data });
      }

      // Acquire the global action lock for any non-readOnly pipeline control.
      // Read-only pipeline probes (pipeline-check-remote, pipeline-fetch-tags,
      // pipeline-verify-dev-pkg) still receive a requestId for logging but do
      // not contend with write-class actions.
      const requestId = newRequestId();
      let lockedRequestId: string | null = null;
      if (!control.readOnly) {
        const got = await acquireLock({ controlId: control.id, requestId });
        if (!got.ok) {
          const data: RunResponse = {
            controlId: control.id,
            accepted: false,
            runStatus: 'already_running',
            reason: `Another admin action is already running: ${got.active.controlId} (started ${got.active.startedAt}).`,
            lockHeldBy: got.active
          };
          appendControlRunAudit({
            ...auditBase,
            phase: 'refused',
            outcome: 'already_running',
            requestId,
            reason: data.reason,
            lockHeldBy: got.active
          });
          return res.status(409).json({ success: true, data });
        }
        lockedRequestId = requestId;
      }

      appendControlRunAudit({ ...auditBase, phase: 'admitted', outcome: 'admitted', requestId });
      try {
        const result = await runSafePipeline({
          control,
          requestId,
          branch: branch || undefined,
          tag: tag || undefined,
          packageBasename: packageName || undefined,
          message: message || undefined,
          confirmDeleteTag: confirmDeleteTag || undefined,
          channel: channel || undefined,
          version: version || undefined,
          // validateControl has already enforced strict booleans and per-control support.
          force: typeof inputs.force === 'boolean' ? inputs.force : undefined,
          allowDirty: typeof inputs.allowDirty === 'boolean' ? inputs.allowDirty : undefined
        });
        appendControlRunAudit({
          ...auditBase,
          phase: 'completed',
          outcome: result.runStatus,
          requestId,
          reason: result.reason,
          exitCode: result.exitCode,
          durationMs: result.durationMs
        });
        return res.json({ success: true, data: result });
      } finally {
        if (lockedRequestId) {
          await releaseLock(lockedRequestId);
        }
      }
    }

    // ---- 2) Risk fence. HIGH/CRITICAL are never allowed on the safe-direct or
    //         safe-wrapper paths. The v0.5.24 safe-recovery path is handled
    //         above (2a), the v0.5.25 safe-deploy path is handled above (2b),
    //         and the v0.5.29 safe-pipeline path is handled above (2c) BEFORE
    //         this fence - only the whitelisted recovery, deploy, and
    //         pipeline ids reach the executor; every other HIGH/CRITICAL
    //         control is still refused here.
    if (control.riskLevel === 'HIGH' || control.riskLevel === 'CRITICAL') {
      const data = refusal(
        control.id,
        'blocked',
        'HIGH/CRITICAL controls are not eligible for UI execution in v0.5.29 outside the whitelisted safe-recovery, safe-deploy, and safe-pipeline paths.'
      );
      appendControlRunAudit({ ...auditBase, phase: 'refused', outcome: data.runStatus, reason: data.reason });
      return res.status(409).json({ success: true, data });
    }

    // ---- 3) Validate inputs/confirmations.
    const body = (req.body ?? {}) as ValidateRequestBody;
    const validation = validateControl(control, body);
    if (!validation.runnable) {
      const status: RunStatus = (() => {
        const k = validation.issues[0]?.kind;
        if (k === 'missing') return 'needs_confirmation';
        if (k === 'mismatch') return 'needs_confirmation';
        if (k === 'disabled') return 'disabled';
        return 'blocked';
      })();
      const data: RunResponse = {
        controlId: control.id,
        accepted: false,
        runStatus: status,
        reason:
          'Validation failed: ' + validation.issues.map((i) => i.message).join(' ')
      };
      appendControlRunAudit({ ...auditBase, phase: 'refused', outcome: status, reason: data.reason });
      return res.status(409).json({
        success: true,
        data,
        validation
      });
    }

    // ---- 4) Action lock. Any write-class control (anything not readOnly)
    //         must hold the global lock for the duration of its run. Read-only
    //         safe-direct controls skip the lock so multiple operators can
    //         poll status concurrently.
    const needsLock = !control.readOnly;
    const requestId = newRequestId();

    if (needsLock) {
      const got = await acquireLock({ controlId: control.id, requestId });
      if (!got.ok) {
        const data: RunResponse = {
          controlId: control.id,
          accepted: false,
          runStatus: 'already_running',
          reason: `Another admin action is already running: ${got.active.controlId} (started ${got.active.startedAt}).`,
          lockHeldBy: got.active
        };
        appendControlRunAudit({
          ...auditBase,
          phase: 'refused',
          outcome: 'already_running',
          requestId,
          reason: data.reason,
          lockHeldBy: got.active
        });
        return res.status(409).json({ success: true, data });
      }
    }

    // ---- 5) Dispatch to the right runner. The runner re-checks strategy and
    //         risk as a defense-in-depth measure.
    appendControlRunAudit({ ...auditBase, phase: 'admitted', outcome: 'admitted', requestId });
    try {
      let result: RunResponse;
      if (control.runStrategy === 'safe-direct') {
        result = await runSafeDirect({ control, requestId });
      } else {
        result = await runSafeWrapper({ control, requestId });
      }
      appendControlRunAudit({
        ...auditBase,
        phase: 'completed',
        outcome: result.runStatus,
        requestId,
        reason: result.reason,
        exitCode: result.exitCode,
        durationMs: result.durationMs
      });
      return res.json({ success: true, data: result });
    } finally {
      if (needsLock) {
        await releaseLock(requestId);
      }
    }
  });

  return router;
}
