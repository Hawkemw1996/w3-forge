import { consoleText } from "../../../../../shared/consoleApp";
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  HardDrive,
  Info,
  Loader2,
  PlayCircle,
  Power,
  RefreshCcw,
  ShieldAlert,
  ShieldX,
  Sliders,
  Terminal,
  Wrench
} from 'lucide-react';
import { Card, CardBody, CardHeader } from '../../components/ui/Card';
import { Badge, type BadgeTone } from '../../components/ui/Badge';
import { adminGet, adminPost, AdminApiError } from '../../lib/api';
import { deploymentVersion, needsDeploymentCheck, readInstalledDeployment, deploymentConfirmed, type DeploymentCheck } from './deployResult';
import type {
  AdminControlPublic,
  RiskLevel,
  ControlStatus,
  RunResponse,
  RunStatus,
  ValidateResponse
} from './controlsTypes';

// =============================================================================
// v0.5.14 helpers: multi-state status pill + empty-state copy.
// =============================================================================

function runStatusTone(s: RunStatus): BadgeTone {
  switch (s) {
    case 'success':
      return 'success';
    case 'failed':
      return 'danger';
    case 'blocked':
      return 'warning';
    case 'disabled':
      return 'slate';
    case 'needs_inputs':
      return 'info';
    case 'needs_confirmation':
      return 'info';
    case 'needs_wrapper':
      return 'warning';
    case 'no_package_found':
      return 'slate';
    case 'already_running':
      return 'warning';
  }
}

function runStatusLabel(s: RunStatus): string {
  switch (s) {
    case 'success':
      return 'Success';
    case 'failed':
      return 'Failed';
    case 'blocked':
      return 'Blocked';
    case 'disabled':
      return 'Disabled';
    case 'needs_inputs':
      return 'Needs Inputs';
    case 'needs_confirmation':
      return 'Needs Confirmation';
    case 'needs_wrapper':
      return 'Needs Wrapper';
    case 'no_package_found':
      return 'No Package Found';
    case 'already_running':
      return 'Already Running';
  }
}

function emptyStateCopyFor(controlId: string, runStatus: RunStatus): string | null {
  if (runStatus !== 'no_package_found') return null;
  if (controlId === 'package-verify-latest') {
    return consoleText('No staged release package found. Upload or place a w3buildcost-vX.Y.Z.tar.gz in /opt/w3buildcost-update-packages before verification.');
  }
  return 'No staged release package found.';
}

// =============================================================================
// ControlCard - one card per registry entry.
// =============================================================================
//
// Rendering rules per v0.5.13 spec:
//
//   - UI_READY        active "Run" button (only LOW + read-only actually fire)
//   - NEEDS_INPUTS    "Validate Inputs" - opens the inputs panel
//   - NEEDS_WRAPPER   disabled "Needs Wrapper"
//   - DANGEROUS_DISABLED disabled "Disabled"
//   - TERMINAL_ONLY   disabled "Terminal Only"
//   - UNKNOWN_REVIEW_REQUIRED disabled "Review Required"
//
// The card is the same width regardless of state, has the same padding rules,
// and uses the existing .card / .card-header / .card-body primitives so it
// matches Dashboard + System Status tiles exactly.

function riskTone(r: RiskLevel): BadgeTone {
  switch (r) {
    case 'LOW':
      return 'success';
    case 'MEDIUM':
      return 'info';
    case 'HIGH':
      return 'warning';
    case 'CRITICAL':
      return 'danger';
  }
}

function statusTone(s: ControlStatus): BadgeTone {
  switch (s) {
    case 'UI_READY':
      return 'success';
    case 'NEEDS_INPUTS':
      return 'info';
    case 'NEEDS_WRAPPER':
      return 'warning';
    case 'TERMINAL_ONLY':
      return 'slate';
    case 'DANGEROUS_DISABLED':
      return 'danger';
    case 'UNKNOWN_REVIEW_REQUIRED':
      return 'slate';
  }
}

function statusLabel(s: ControlStatus): string {
  switch (s) {
    case 'UI_READY':
      return 'UI Ready';
    case 'NEEDS_INPUTS':
      return 'Needs Inputs';
    case 'NEEDS_WRAPPER':
      return 'Needs Wrapper';
    case 'TERMINAL_ONLY':
      return 'Terminal Only';
    case 'DANGEROUS_DISABLED':
      return 'Disabled';
    case 'UNKNOWN_REVIEW_REQUIRED':
      return 'Review Required';
  }
}

// Per status: button label, button icon, button mode.
function buttonModeFor(c: AdminControlPublic): {
  label: string;
  icon: React.ReactNode;
  variant: 'active' | 'configure' | 'disabled';
  hint: string;
} {
  if (!c.enabled) {
    if (c.status === 'TERMINAL_ONLY')
      return {
        label: 'Terminal Only',
        icon: <Terminal size={13} />,
        variant: 'disabled',
        hint: 'Run from the host shell - never piped from the UI.'
      };
    if (c.status === 'DANGEROUS_DISABLED')
      return {
        label: 'Disabled',
        icon: <ShieldX size={13} />,
        variant: 'disabled',
        hint: 'Disabled in v0.5.13. See notes.'
      };
    if (c.status === 'NEEDS_WRAPPER')
      return {
        label: 'Needs Wrapper',
        icon: <Wrench size={13} />,
        variant: 'disabled',
        hint: 'Awaiting non-interactive wrapper (v0.5.14+).'
      };
    if (c.status === 'UNKNOWN_REVIEW_REQUIRED')
      return {
        label: 'Review Required',
        icon: <AlertTriangle size={13} />,
        variant: 'disabled',
        hint: 'Not yet audited.'
      };
    return {
      label: 'Disabled',
      icon: <ShieldX size={13} />,
      variant: 'disabled',
      hint: 'Disabled.'
    };
  }
  if (c.status === 'NEEDS_INPUTS') {
    return {
      label: 'Validate Inputs',
      icon: <Sliders size={13} />,
      variant: 'configure',
      hint: 'Provide inputs + confirmation to validate.'
    };
  }
  return {
    label: 'Run',
    icon: <PlayCircle size={13} />,
    variant: 'active',
    hint: 'Run this read-only action now.'
  };
}

// Effect chips (Writes Disk / Touches DB / Restarts Service / Destructive).
function EffectChips({ c }: { c: AdminControlPublic }) {
  const items: Array<{ tone: BadgeTone; icon: React.ReactNode; label: string }> = [];
  if (c.readOnly)
    items.push({ tone: 'success', icon: <CheckCircle2 size={11} />, label: 'Read Only' });
  if (c.writesToDisk)
    items.push({ tone: 'warning', icon: <HardDrive size={11} />, label: 'Writes Disk' });
  if (c.touchesDatabase)
    items.push({ tone: 'warning', icon: <Database size={11} />, label: 'Touches DB' });
  if (c.restartsService)
    items.push({ tone: 'warning', icon: <Power size={11} />, label: 'Restarts Service' });
  if (c.destructive)
    items.push({ tone: 'danger', icon: <ShieldAlert size={11} />, label: 'Destructive' });
  if (c.requiresPreBackup)
    items.push({ tone: 'info', icon: <RefreshCcw size={11} />, label: 'Pre-Backup' });
  if (items.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {items.map((it, i) => (
        <Badge key={i} tone={it.tone}>
          {it.icon}
          <span>{it.label}</span>
        </Badge>
      ))}
    </div>
  );
}

interface RunState {
  loading: boolean;
  response?: RunResponse;
  error?: string;
  unconfirmed?: NonNullable<RunState['waiting']>;
  // Restarting controls can lose their HTTP reply. For pipeline deployments,
  // also reconcile returned interruptions and detached launch acknowledgements
  // against installed metadata; health alone does not prove deployment success.
  waiting?: {
    startedAt: number;       // ms epoch when we entered waiting mode
    elapsedMs: number;       // updated by the ticking effect
    lastHealth?: string;     // last /health probe status text
    versionBefore?: string;  // /version string captured before run (if any)
    versionAfter?: string;   // /version observed once /health recovers
    deployment?: DeploymentCheck;
  };
}

// v0.5.38: shape of /health and /version responses (root, not under
// /api/admin). Both wrap their payload in { success, data }.
interface HealthData {
  status: string;
  service?: string;
  app?: string;
  version?: string;
  database?: string;
  startedAt?: string;
}
interface VersionData {
  app?: string;
  version?: string;
  nodeEnv?: string;
}
interface RootEnvelope<T> {
  success?: boolean;
  data?: T;
}

// v0.5.38: tunables for the waiting-for-service-restart poller.
// v0.11.3: raised ceiling from 5 min to 12 min. The pipeline-deploy-dev
// control runs systemd-run to launch a detached transient unit, then exits
// immediately. The actual deploy (backup + extract + migrate + restart +
// health probe) can take 5–8+ minutes on a first-time or large-package run.
// The prior 5-minute ceiling caused synthesizeTimeout to fire before
// /health recovered, producing a false FAILED / exit -1 result even when
// the deploy ultimately succeeded. 12 minutes gives the full deploy cycle
// a safe margin while still surfacing a real timeout if the service never
// recovers (e.g. broken migration, bad package). The poll interval and
// per-probe timeout are unchanged.
const RESTART_WAIT_TIMEOUT_MS = 12 * 60 * 1000; // 12 minutes ceiling
const RESTART_POLL_INTERVAL_MS = 2_000;          // 2 s between probes
const RESTART_PROBE_TIMEOUT_MS = 3_000;          // 3 s per probe (AbortController)

// Detect whether an error from fetch/parseEnvelope is a network-level
// disconnect (the service was stopped or unreachable) versus an HTTP-layer
// failure with a real envelope. AdminApiError instances carry a numeric
// HTTP status — those are NOT network drops. Bare TypeError / DOMException
// (and the SyntaxError thrown when the body is unparseable due to a
// dropped connection) are treated as network drops.
function isNetworkDisconnect(err: unknown): boolean {
  if (err instanceof AdminApiError) return false;
  if (err instanceof TypeError) return true; // "Failed to fetch" et al.
  if (typeof DOMException !== 'undefined' && err instanceof DOMException) {
    // AbortError, NetworkError variants on some browsers.
    return true;
  }
  if (err instanceof Error) {
    const m = err.message ?? '';
    // Fall-back string sniffing for engines that don't preserve the
    // TypeError class through the promise chain. Conservative — only
    // matches well-known browser disconnect phrases.
    if (/failed to fetch|networkerror|load failed|network request failed/i.test(m)) {
      return true;
    }
  }
  return false;
}

// Probe a root-level endpoint (e.g. /health, /version). Returns the parsed
// data on success, or null on any failure. Uses AbortController so a hung
// probe cannot stall the poller for longer than RESTART_PROBE_TIMEOUT_MS.
async function probeRoot<T>(path: string): Promise<T | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), RESTART_PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(path, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
      signal: ctl.signal,
      // Defeat any intermediate cache (proxies, service workers).
      cache: 'no-store'
    });
    if (!res.ok) return null;
    const body = (await res.json()) as RootEnvelope<T>;
    if (body?.success !== true) return null;
    return (body.data ?? null) as T | null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// v0.5.24: Recovery Center backups.local option fetch.
interface BackupFile {
  name: string;
  sizeBytes: number;
  mtime: string;
}
interface BackupPair {
  timestamp: string;
  appArchive: BackupFile | null;
  dbArchive: BackupFile | null;
}
interface BackupsResponse {
  root: string;
  backups: BackupPair[];
  totalSizeBytes: number;
}

interface BackupOptions {
  loading: boolean;
  error?: string;
  // basename → label shown in the dropdown (basename + size + mtime)
  appOptions: Array<{ value: string; label: string }>;
  dbOptions: Array<{ value: string; label: string }>;
}

// v0.5.38: staged-package option set, fetched lazily when any input field has
// optionsSource === 'packages.staged'. Sourced from
// /admin/packages/staged-dev (canonical + legacy combined). Read-only.
interface StagedPackageEntry {
  name: string;
  sizeBytes?: number;
  mtime?: string;
  parsedVersion?: string | null;
  channel?: string;
}
interface StagedPackagesResponse {
  root?: string;
  namingStandard?: string;
  packages?: StagedPackageEntry[];
}
interface PackagesOptions {
  loading: boolean;
  error?: string;
  options: Array<{ value: string; label: string }>;
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export interface ControlCardProps {
  control: AdminControlPublic;
  // v0.5.38: optional pre-fill for input fields. Used by the GitHub Release
  // Workflow to seed the `branch`, `tag`, and `version` inputs from the
  // shared pipeline context so the operator does not have to retype the
  // values they already chose at the top of the page. Operators can still
  // edit any pre-filled value before pressing Run; the card always sends the
  // current local state to the backend, never the prop directly.
  initialInputs?: Record<string, string>;
  // v0.5.38 (regression fix): optional submission-only extras merged into
  // the inputs payload at the moment of POST /controls/<id>/run. These are
  // NOT surfaced as form fields and NEVER appear in inputState. They exist
  // because the Release Pipeline canonical-package layout (introduced in
  // v0.5.38) requires the backend resolver to receive `channel` (dev|main)
  // and `version` (vX.Y.Z) alongside the canonical `packageName` of
  // `w3buildcost.tar.gz`, but the control's declared inputSchema only lists
  // `packageName` (the operator-visible select). The route layer already
  // accepts `inputs.channel` and `inputs.version` and re-validates them
  // (see backend/src/admin/routes/controlsRoutes.ts). Keys with empty or
  // undefined values are dropped before submission so this also stays safe
  // for control ids that don't need extras. Operator-visible inputs from
  // the form ALWAYS win over an extra of the same key (so the operator can
  // never be silently overridden by a parent panel).
  extraInputs?: Record<string, string | undefined>;
  // v0.5.38: optional callback fired after a successful run. Used by the
  // GitHub Release Workflow to drive a tiny step-completion bitmap so the
  // numbered guidance can mark a step as done. Failures are ignored on
  // purpose — the card still shows the failure trailer locally.
  onRunSuccess?: (response: RunResponse) => void;
}

export function ControlCard({ control, initialInputs, extraInputs, onRunSuccess }: ControlCardProps) {
  const mode = useMemo(() => buttonModeFor(control), [control]);
  const [run, setRun] = useState<RunState>({ loading: false });

  // v0.5.14: interactive confirmation state. Only used for write-class
  // controls (anything that requires confirmation). Read-only controls send
  // an empty confirmations object.
  const [checkboxState, setCheckboxState] = useState<Record<string, boolean>>({});
  const [phraseState, setPhraseState] = useState<Record<string, string>>({});

  // v0.5.24: collect input field values (used by the Recovery Center
  // restore-w3buildcost control - appBackupFilename, dbBackupFilename). Values
  // are basenames only; the route layer rejects any path or traversal.
  // v0.5.38: also used for the GitHub Release Workflow pipeline-* controls
  // (text fields for branch/tag/version, plus the packages.staged select).
  const [inputState, setInputState] = useState<Record<string, string>>(
    () => ({ ...(initialInputs ?? {}) })
  );

  // Checkbox inputs are distinct from the mandatory confirmations. An
  // override belongs to the current target and one run only, never a seed.
  const inputCheckboxContext = JSON.stringify([control.id, inputState, initialInputs, extraInputs]);
  const [inputCheckboxSelection, setInputCheckboxSelection] = useState<{
    context: string;
    values: Record<string, boolean>;
  } | null>(null);
  const inputCheckboxState = useMemo(
    () => inputCheckboxSelection?.context === inputCheckboxContext
      ? inputCheckboxSelection.values
      : {},
    [inputCheckboxSelection, inputCheckboxContext]
  );
  useEffect(() => {
    setInputCheckboxSelection(null);
  }, [inputCheckboxContext]);

  // v0.5.38: when the parent re-seeds initialInputs (e.g. the operator picks
  // a different dev branch at the top of the GitHub page), refresh any input
  // field whose current value is empty OR still equals a previous seed.
  // We never overwrite a value the operator has actively edited.
  useEffect(() => {
    if (!initialInputs) return;
    setInputState((prev) => {
      const next = { ...prev };
      for (const [key, val] of Object.entries(initialInputs)) {
        if (typeof val !== 'string') continue;
        const current = next[key];
        if (current === undefined || current === '' || current === prev[key]) {
          // Pre-fill empty or untouched fields. We treat a value matching a
          // prior seed as untouched because the operator hasn't typed yet.
          if (current === undefined || current === '') {
            next[key] = val;
          }
        }
      }
      return next;
    });
    // We intentionally depend on the stringified form so prop-identity churn
    // doesn't retrigger; only real value changes do.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(initialInputs)]);

  // v0.5.24: lazily fetch the local backups list when the control has any
  // field with optionsSource === 'backups.local'. Avoids hitting the
  // endpoint for every card on the Controls tab.
  const needsBackupsList = useMemo(() => {
    if (!control.requiresInputs || !control.inputSchema) return false;
    return control.inputSchema.fields.some(
      (f) => f.type === 'select' && f.optionsSource === 'backups.local'
    );
  }, [control]);

  // v0.5.38: lazily fetch the staged-dev package list when any input field
  // has optionsSource === 'packages.staged'. Used by
  // pipeline-verify-dev-pkg and pipeline-deploy-dev.
  const needsPackagesList = useMemo(() => {
    if (!control.requiresInputs || !control.inputSchema) return false;
    return control.inputSchema.fields.some(
      (f) => f.type === 'select' && f.optionsSource === 'packages.staged'
    );
  }, [control]);

  const [backupOptions, setBackupOptions] = useState<BackupOptions>({
    loading: false,
    appOptions: [],
    dbOptions: []
  });

  const [packagesOptions, setPackagesOptions] = useState<PackagesOptions>({
    loading: false,
    options: []
  });

  useEffect(() => {
    if (!needsPackagesList) return;
    let cancelled = false;
    setPackagesOptions((s) => ({ ...s, loading: true, error: undefined }));
    adminGet<StagedPackagesResponse>('/packages/staged-dev')
      .then((res) => {
        if (cancelled) return;
        const options: Array<{ value: string; label: string }> = [];
        for (const p of res.packages ?? []) {
          if (!p?.name) continue;
          const sizeLabel =
            typeof p.sizeBytes === 'number' && p.sizeBytes > 0
              ? ` · ${formatBytes(p.sizeBytes)}`
              : '';
          const verLabel = p.parsedVersion ? ` · v${p.parsedVersion}` : '';
          // v0.5.38 (regression fix): the staged-dev listing returns BOTH
          // canonical entries (name='w3buildcost.tar.gz', parsedVersion='X.Y.Z')
          // and legacy entries (name='w3buildcost-vX.Y.Z.tar.gz'). The backend
          // route layer accepts both basenames, but for the canonical name
          // the route additionally requires a separate `version` input so
          // the resolver can locate <channel>/<version>/w3buildcost.tar.gz.
          //
          // To keep ControlCard independent of any parent panel having to
          // also seed `version` via extraInputs (e.g. from the Controls tab
          // where there is no version selector), we submit the LEGACY
          // basename `w3buildcost-vX.Y.Z.tar.gz` whenever we can synthesize it
          // from `parsedVersion`. The submission value is fully resolver-
          // compatible (both safeRunner.deriveVersionFromPackage and the
          // wrapper scripts' --package handlers accept the legacy form),
          // and the display label still leads with the canonical filename
          // so the operator's screen continues to read
          //   w3buildcost.tar.gz · v0.5.38 · 655 KB
          // exactly as it does today. This is a frontend-only mapping
          // change — no script, validator, or registry change.
          const isCanonical = p.name === consoleText('w3buildcost.tar.gz');
          const versionBare =
            typeof p.parsedVersion === 'string' && /^\d+\.\d+\.\d+$/.test(p.parsedVersion)
              ? p.parsedVersion
              : null;
          const submissionValue =
            isCanonical && versionBare
              ? consoleText(`w3buildcost-v${versionBare}.tar.gz`)
              : p.name;
          options.push({
            value: submissionValue,
            label: `${p.name}${verLabel}${sizeLabel}`
          });
        }
        setPackagesOptions({ loading: false, options });
      })
      .catch((err) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setPackagesOptions({
          loading: false,
          options: [],
          error: message
        });
      });
    return () => {
      cancelled = true;
    };
  }, [needsPackagesList]);

  useEffect(() => {
    if (!needsBackupsList) return;
    let cancelled = false;
    setBackupOptions((s) => ({ ...s, loading: true, error: undefined }));
    adminGet<BackupsResponse>('/backups')
      .then((res) => {
        if (cancelled) return;
        const appOptions: Array<{ value: string; label: string }> = [];
        const dbOptions: Array<{ value: string; label: string }> = [];
        for (const pair of res.backups ?? []) {
          if (pair.appArchive) {
            appOptions.push({
              value: pair.appArchive.name,
              label: `${pair.appArchive.name} · ${formatBytes(pair.appArchive.sizeBytes)}`
            });
          }
          if (pair.dbArchive) {
            dbOptions.push({
              value: pair.dbArchive.name,
              label: `${pair.dbArchive.name} · ${formatBytes(pair.dbArchive.sizeBytes)}`
            });
          }
        }
        setBackupOptions({ loading: false, appOptions, dbOptions });
      })
      .catch((err) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setBackupOptions({
          loading: false,
          appOptions: [],
          dbOptions: [],
          error: message
        });
      });
    return () => {
      cancelled = true;
    };
  }, [needsBackupsList]);

  // Build the inputs payload from collected state. For backups.local
  // selects we send the chosen basename verbatim; the route layer
  // re-validates against a strict regex and rejects '/' and '..'.
  //
  // v0.5.38 (regression fix): also merge `extraInputs` (submission-only
  // extras supplied by a parent panel — e.g. UnifiedReleaseWorkflow seeds
  // `channel` and `version` for the canonical-package layout). Operator-
  // visible form values from `inputState` ALWAYS win, so a parent extra
  // can never silently overwrite a value the operator can see and edit.
  // Empty/undefined extras are dropped so this stays a no-op for controls
  // that don't need them.
  const inputsPayload = useMemo(() => {
    const out: Record<string, unknown> = {};
    if (extraInputs) {
      for (const [k, v] of Object.entries(extraInputs)) {
        if (typeof v === 'string' && v.length > 0) {
          out[k] = v;
        }
      }
    }
    if (control.requiresInputs && control.inputSchema) {
      for (const f of control.inputSchema.fields) {
        out[f.key] = f.type === 'checkbox'
          ? inputCheckboxState[f.key] === true
          : inputState[f.key] ?? '';
      }
    }
    return out;
  }, [control, inputState, inputCheckboxState, extraInputs]);

  const inputsSatisfied = useMemo(() => {
    if (!control.requiresInputs || !control.inputSchema) return true;
    for (const f of control.inputSchema.fields) {
      if (f.type === 'checkbox') {
        if (f.mustBeTrue && inputCheckboxState[f.key] !== true) return false;
        continue;
      }
      if (f.required && !(inputState[f.key] && inputState[f.key].length > 0)) {
        return false;
      }
    }
    return true;
  }, [control, inputState, inputCheckboxState]);

  const confirmationsPayload = useMemo(() => {
    const out: Record<string, unknown> = {};
    if (control.requiresConfirmation && control.confirmationSchema) {
      for (const cb of control.confirmationSchema.checkboxes) {
        out[cb.key] = checkboxState[cb.key] === true;
      }
      for (const p of control.confirmationSchema.typedPhrases) {
        out[p.key] = phraseState[p.key] ?? '';
      }
    }
    return out;
  }, [control, checkboxState, phraseState]);

  const confirmationsSatisfied = useMemo(() => {
    if (!control.requiresConfirmation || !control.confirmationSchema) return true;
    for (const cb of control.confirmationSchema.checkboxes) {
      if (cb.mustBeTrue && checkboxState[cb.key] !== true) return false;
    }
    for (const p of control.confirmationSchema.typedPhrases) {
      if ((phraseState[p.key] ?? '') !== p.expected) return false;
    }
    return true;
  }, [control, checkboxState, phraseState]);

  // v0.5.38: ref-tracked guard so the waiting poller knows when the card
  // has been unmounted (or a new run has started) and should stop polling.
  const waitGenRef = useRef(0);
  const submittingRef = useRef(false);
  useEffect(() => () => { waitGenRef.current += 1; }, [control.id]);

  const onRun = async () => {
    if (mode.variant !== 'active') return;
    if (submittingRef.current || run.waiting || run.unconfirmed) return;
    if (!confirmationsSatisfied) return;
    if (!inputsSatisfied) return;
    submittingRef.current = true;
    const gen = ++waitGenRef.current;
    setRun({ loading: true });
    const version = deploymentVersion(inputsPayload);
    const deployment: DeploymentCheck | undefined = control.id === 'pipeline-deploy-dev' ? { version } : undefined;
    let versionBefore: string | undefined;
    if (control.restartsService) {
      const [v, before] = await Promise.all([
        probeRoot<VersionData>('/version'),
        deployment ? readInstalledDeployment(version) : undefined
      ]);
      versionBefore = v?.version;
      if (deployment) deployment.before = before;
    }
    if (waitGenRef.current !== gen) { submittingRef.current = false; return; }
    setInputCheckboxSelection(null);
    const startChecking = (response?: RunResponse) => {
      if (waitGenRef.current !== gen) return;
      setRun({ loading: false, waiting: {
        startedAt: Date.now(), elapsedMs: 0, versionBefore,
        deployment: deployment ? { ...deployment, response } : undefined
      } });
    };
    try {
      const res = await adminPost<RunResponse>(`/controls/${control.id}/run`, {
        inputs: inputsPayload,
        confirmations: confirmationsPayload
      });
      if (needsDeploymentCheck(control.id, res)) {
        startChecking(res);
        return;
      }
      if (waitGenRef.current === gen) {
        setRun({ loading: false, response: res });
        if (res.runStatus === 'success' && onRunSuccess) {
          try {
            onRunSuccess(res);
          } catch {
            // never let a parent callback bubble into the card.
          }
        }
      }
    } catch (err) {
      // Network/proxy interruptions are inconclusive for a restarting deploy.
      // Keep authentication errors and explicit refusals on the ordinary path.
      const gatewayDisconnect = deployment && err instanceof AdminApiError &&
        err.code === 'HTTP_ERROR' && [502, 503, 504].includes(err.status);
      if (control.restartsService && (isNetworkDisconnect(err) || gatewayDisconnect)) {
        startChecking();
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      if (waitGenRef.current === gen) {
        setRun({ loading: false, error: message });
      }
    } finally {
      submittingRef.current = false;
    }
  };

  // v0.5.38: while in waiting mode, poll /health (and /version) until the
  // service comes back or the ceiling is hit. The effect resets whenever
  // we (re-)enter waiting mode; the generation guard prevents a stale
  // poller from racing with a fresh run on the same card.
  useEffect(() => {
    if (!run.waiting) return;
    const myGen = waitGenRef.current;
    let cancelled = false;
    const startedAt = run.waiting.startedAt;
    const versionBefore = run.waiting.versionBefore;
    const deployment = run.waiting.deployment;

    // Ticking timer just to keep elapsedMs fresh in the UI (1 s pulse).
    const tickId = window.setInterval(() => {
      if (cancelled || waitGenRef.current !== myGen) return;
      setRun((s) =>
        s.waiting
          ? {
              ...s,
              waiting: {
                ...s.waiting,
                elapsedMs: Date.now() - s.waiting.startedAt
              }
            }
          : s
      );
    }, 1000);

    let pollHandle: number | null = null;
    const scheduleNext = () => {
      if (cancelled || waitGenRef.current !== myGen) return;
      pollHandle = window.setTimeout(runProbe, RESTART_POLL_INTERVAL_MS);
    };

    const finish = (nextRun: RunState) => {
      if (cancelled || waitGenRef.current !== myGen) return;
      window.clearInterval(tickId);
      if (pollHandle !== null) window.clearTimeout(pollHandle);
      setRun(nextRun);
    };

    const synthesizeSuccess = (versionAfter?: string): RunResponse => ({
      controlId: control.id,
      accepted: true,
      runStatus: 'success',
      reason: versionAfter
        ? `Service restarted and recovered. /version reports ${versionAfter}.`
        : 'Service restarted and /health recovered. (No /version payload received.)',
      stdoutTail: undefined,
      stderrTail: undefined,
      requestId: undefined,
      exitCode: 0,
      durationMs: Date.now() - startedAt
    });

    const synthesizeTimeout = (): RunResponse => ({
      controlId: control.id,
      accepted: true,
      runStatus: 'failed',
      // v0.11.3: distinguish UI polling timeout from a confirmed deploy
      // failure. The deploy was launched successfully (wrapper exited 0,
      // status=success in trailer); the service disconnect was expected
      // (restartsService=true). This timeout means /health did not recover
      // within the polling ceiling—it does NOT mean the deploy failed.
      // The operator must verify via journal + /api/admin/packages/installed.
      reason:
        `UI reconnect timed out after ${Math.round(RESTART_WAIT_TIMEOUT_MS / 60000)} min ` +
        `— the deploy was launched successfully (wrapper exited 0) but ` +
        `/health did not respond within the polling window. ` +
        `This is a UI reporting timeout, not a confirmed deploy failure. ` +
        consoleText(`Verify: journalctl -u w3buildcost -n 200 and /api/admin/packages/installed.`),
      stdoutTail: undefined,
      stderrTail: undefined,
      requestId: undefined,
      exitCode: -1,
      durationMs: Date.now() - startedAt
    });

    const runProbe = async () => {
      if (cancelled || waitGenRef.current !== myGen) return;
      const elapsed = Date.now() - startedAt;
      if (elapsed >= RESTART_WAIT_TIMEOUT_MS) {
        if (deployment) {
          finish({ loading: false, unconfirmed: { ...run.waiting!, elapsedMs: elapsed } });
          return;
        }
        finish({ loading: false, response: synthesizeTimeout() });
        return;
      }

      if (deployment) {
        const [health, version, record] = await Promise.all([
          probeRoot<HealthData>('/health'), probeRoot<VersionData>('/version'),
          readInstalledDeployment(deployment.version)
        ]);
        if (cancelled || waitGenRef.current !== myGen) return;
        if (deploymentConfirmed(deployment, record, health?.status, version?.version)) {
          const response: RunResponse = {
            ...deployment.response, controlId: control.id, accepted: true, runStatus: 'success',
            reason: `Deployment confirmed: v${deployment.version} is installed and the service is healthy.`,
            requestId: record.requestId!, logFile: record.logPath,
            // A missing wrapper exit code is not the completed deploy's exit code.
            exitCode: undefined, durationMs: elapsed + (deployment.response?.durationMs ?? 0)
          };
          finish({ loading: false, response });
          try { onRunSuccess?.(response); } catch { /* parent callbacks cannot change the result */ }
          return;
        }
        setRun(s => s.waiting ? { ...s, waiting: { ...s.waiting, elapsedMs: elapsed,
          lastHealth: health?.status === 'ok' || health?.status === 'healthy'
            ? `Service online; waiting for the installation record for v${deployment.version ?? '?'}.`
            : 'Reconnecting to the service…'
        } } : s);
        scheduleNext();
        return;
      }

      const health = await probeRoot<HealthData>('/health');
      if (cancelled || waitGenRef.current !== myGen) return;

      if (health && (health.status === 'ok' || health.status === 'healthy')) {
        // /health recovered. Also probe /version for the success message.
        const version = await probeRoot<VersionData>('/version');
        if (cancelled || waitGenRef.current !== myGen) return;

        const versionAfter = version?.version;
        const synthesized = synthesizeSuccess(versionAfter);
        finish({
          loading: false,
          response: synthesized,
          waiting: undefined
        });
        // Notify the parent (GitHub Release Workflow) that this step
        // succeeded, the same way a normal HTTP success would.
        if (onRunSuccess) {
          try {
            onRunSuccess(synthesized);
          } catch {
            // never let a parent callback bubble into the card.
          }
        }
        // Best-effort: surface a console line so terminal-side log review
        // can correlate the UI's recovery with the journal.
        if (typeof console !== 'undefined' && console.info) {
          console.info(
            `[${control.id}] service restarted: /health ok, ` +
              `version ${versionBefore ?? '?'} -> ${versionAfter ?? '?'} ` +
              `after ${Math.round(elapsed / 1000)}s.`
          );
        }
        return;
      }

      // Not yet — record the last probe label and try again.
      setRun((s) =>
        s.waiting
          ? {
              ...s,
              waiting: {
                ...s.waiting,
                elapsedMs: elapsed,
                lastHealth: 'reconnecting…'
              }
            }
          : s
      );
      scheduleNext();
    };

    // Kick off the first probe immediately (the browser has already
    // observed at least one network-level failure by this point).
    void runProbe();

    return () => {
      cancelled = true;
      window.clearInterval(tickId);
      if (pollHandle !== null) window.clearTimeout(pollHandle);
    };
    // We deliberately depend only on the waiting-mode entry sentinel so
    // the effect doesn't restart on every tick. waitGenRef is the only
    // stable identifier for the current waiting session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.waiting?.startedAt, control.id, control.restartsService]);

  const onValidate = async () => {
    setRun({ loading: true });
    try {
      const res = await adminPost<ValidateResponse>(
        `/controls/${control.id}/validate`,
        { inputs: inputsPayload, confirmations: confirmationsPayload }
      );
      // Re-shape the validate response into a RunResponse-like preview block.
      const preview: RunResponse = {
        controlId: res.controlId,
        accepted: false,
        runStatus: res.runnable ? 'blocked' : 'needs_confirmation',
        reason: res.runnable
          ? 'Inputs validated. UI execution is not yet wired for this control.'
          : 'Validation reports issues: ' + res.issues.map((i) => i.message).join(' '),
        stdoutTail: undefined,
        stderrTail: undefined
      };
      setRun({ loading: false, response: preview });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setRun({ loading: false, error: message });
    }
  };

  const onClick = mode.variant === 'active' ? onRun : mode.variant === 'configure' ? onValidate : undefined;
  // Disable the Run button when confirmations or inputs aren't satisfied,
  // so the user sees the requirement before submitting.
  const runDisabled =
    mode.variant === 'disabled' || run.loading || Boolean(run.waiting) || Boolean(run.unconfirmed) ||
    (mode.variant === 'active' && (!confirmationsSatisfied || !inputsSatisfied));

  return (
    <Card>
      <CardHeader
        title={<span className="truncate">{control.label}</span>}
        subtitle={
          <span
            className="font-mono text-[11px] truncate block"
            style={{ color: 'var(--w3-text-dim)' }}
            title={`${control.id} · ${control.scriptName}`}
          >
            {control.id} · {control.scriptName}
          </span>
        }
        right={
          <>
            <Badge tone={riskTone(control.riskLevel)}>{control.riskLevel}</Badge>
            <Badge tone={statusTone(control.status)}>{statusLabel(control.status)}</Badge>
          </>
        }
      />
      <CardBody>
        <p className="text-xs leading-relaxed text-[var(--w3-text-muted)]">
          {control.description}
        </p>

        <EffectChips c={control} />

        {control.requiresInputs && control.inputSchema ? (
          <div
            className="mt-3 rounded-md border p-2.5 text-[11px]"
            style={{
              background: 'rgba(7,18,37,0.5)',
              borderColor: 'var(--w3-border-section)',
              color: 'var(--w3-text-muted)'
            }}
          >
            <div
              className="mb-1 font-medium uppercase tracking-[0.1em] text-[10px]"
              style={{ color: 'var(--w3-text-dim)' }}
            >
              Inputs & Options
            </div>
            <div className="space-y-2">
              {control.inputSchema.fields.map((f) => {
                if (f.type === 'checkbox') {
                  return (
                    <label key={f.key} className="flex items-start gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={inputCheckboxState[f.key] === true}
                        onChange={(e) => setInputCheckboxSelection({
                          context: inputCheckboxContext,
                          values: { ...inputCheckboxState, [f.key]: e.target.checked }
                        })}
                        disabled={mode.variant === 'disabled' || run.loading}
                        className="mt-0.5 shrink-0"
                        style={{ accentColor: 'var(--w3-gold-500)' }}
                      />
                      <span className="flex flex-col gap-1">
                        <span className="font-medium text-[var(--w3-text)]">
                          {f.label}
                          {f.required ? ' *' : ' (optional)'}
                        </span>
                        {f.description ? (
                          <span className="text-[10px] text-[var(--w3-text-dim)]">
                            {f.description} Applies to this run only.
                          </span>
                        ) : null}
                      </span>
                    </label>
                  );
                }
                // v0.5.38: render an interactive text input for any text
                // field (e.g. pipeline-* branch/tag/version). The route
                // layer re-validates pattern, length, and shape; this
                // input is a thin uncontrolled-style binding with the
                // same string state as backups.local.
                if (f.type === 'text') {
                  const value = inputState[f.key] ?? '';
                  const matchesPattern = f.pattern
                    ? new RegExp(f.pattern).test(value)
                    : true;
                  const hasValue = value.length > 0;
                  const valid = hasValue && matchesPattern;
                  return (
                    <div key={f.key} className="flex flex-col gap-1">
                      <label
                        className="text-[11px]"
                        style={{ color: 'var(--w3-text)' }}
                      >
                        <span className="font-medium">{f.label}</span>
                        {f.required ? (
                          <span style={{ color: 'var(--w3-gold-400)' }}> *</span>
                        ) : null}
                      </label>
                      <input
                        type="text"
                        value={value}
                        onChange={(e) =>
                          setInputState((s) => ({ ...s, [f.key]: e.target.value }))
                        }
                        disabled={mode.variant === 'disabled' || run.loading}
                        // v0.5.38 (regression fix): never put the raw regex
                        // `f.pattern` into the placeholder — operators were
                        // reading e.g. `^v[0-9]+\.[0-9]+\.[0-9]+$` as the
                        // expected literal. The pattern is for validation
                        // only. Helper text (`f.description`) already lives
                        // beneath the input and tells the operator the
                        // expected shape (e.g. "Must match vX.Y.Z exactly.").
                        placeholder=""
                        spellCheck={false}
                        autoCapitalize="off"
                        autoCorrect="off"
                        className="font-mono text-[11px] rounded-md border px-2 py-1"
                        style={{
                          background: 'rgba(7,18,37,0.7)',
                          borderColor: valid
                            ? 'rgba(34,197,94,0.45)'
                            : hasValue
                              ? 'rgba(239,68,68,0.45)'
                              : 'var(--w3-border-section)',
                          color: 'var(--w3-text)'
                        }}
                      />
                      {f.description ? (
                        <span
                          className="text-[10px]"
                          style={{ color: 'var(--w3-text-dim)' }}
                        >
                          {f.description}
                        </span>
                      ) : null}
                      {hasValue && !matchesPattern ? (
                        <span
                          className="text-[10px]"
                          style={{ color: 'var(--status-danger)' }}
                        >
                          Value does not match the required pattern.
                        </span>
                      ) : null}
                    </div>
                  );
                }
                // v0.5.38: render an interactive select for the
                // packages.staged source (pipeline-verify-dev-pkg,
                // pipeline-deploy-dev). Options are fetched lazily from
                // /admin/packages/staged-dev.
                if (f.type === 'select' && f.optionsSource === 'packages.staged') {
                  const options = packagesOptions.options;
                  return (
                    <div key={f.key} className="flex flex-col gap-1">
                      <label
                        className="text-[11px]"
                        style={{ color: 'var(--w3-text)' }}
                      >
                        <span className="font-medium">{f.label}</span>
                        {f.required ? (
                          <span style={{ color: 'var(--w3-gold-400)' }}> *</span>
                        ) : null}
                      </label>
                      <select
                        value={inputState[f.key] ?? ''}
                        onChange={(e) =>
                          setInputState((s) => ({ ...s, [f.key]: e.target.value }))
                        }
                        disabled={
                          mode.variant === 'disabled' ||
                          run.loading ||
                          packagesOptions.loading
                        }
                        className="font-mono text-[11px] rounded-md border px-2 py-1"
                        style={{
                          background: 'rgba(7,18,37,0.7)',
                          borderColor: inputState[f.key]
                            ? 'rgba(34,197,94,0.45)'
                            : 'var(--w3-border-section)',
                          color: 'var(--w3-text)'
                        }}
                      >
                        <option value="">
                          {packagesOptions.loading
                            ? 'Loading…'
                            : options.length === 0
                              ? 'No staged dev packages found'
                              : 'Select a staged package…'}
                        </option>
                        {options.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                      {f.description ? (
                        <span
                          className="text-[10px]"
                          style={{ color: 'var(--w3-text-dim)' }}
                        >
                          {f.description}
                        </span>
                      ) : null}
                      {packagesOptions.error ? (
                        <span
                          className="text-[10px]"
                          style={{ color: 'var(--status-danger)' }}
                        >
                          Failed to load staged packages: {packagesOptions.error}
                        </span>
                      ) : null}
                    </div>
                  );
                }
                // v0.5.24: render an interactive control for backups.local
                // selects (Recovery Center). Other field types still render
                // as a description-only chip below.
                if (f.type === 'select' && f.optionsSource === 'backups.local') {
                  // Pick app vs db option set by field key. The Recovery
                  // Center registry uses 'appBackupFilename' and
                  // 'dbBackupFilename' for these inputs.
                  const isDb = /db/i.test(f.key);
                  const options = isDb ? backupOptions.dbOptions : backupOptions.appOptions;
                  return (
                    <div key={f.key} className="flex flex-col gap-1">
                      <label
                        className="text-[11px]"
                        style={{ color: 'var(--w3-text)' }}
                      >
                        <span className="font-medium">{f.label}</span>
                        {f.required ? (
                          <span style={{ color: 'var(--w3-gold-400)' }}> *</span>
                        ) : null}
                      </label>
                      <select
                        value={inputState[f.key] ?? ''}
                        onChange={(e) =>
                          setInputState((s) => ({ ...s, [f.key]: e.target.value }))
                        }
                        disabled={
                          mode.variant === 'disabled' || run.loading || backupOptions.loading
                        }
                        className="font-mono text-[11px] rounded-md border px-2 py-1"
                        style={{
                          background: 'rgba(7,18,37,0.7)',
                          borderColor:
                            inputState[f.key]
                              ? 'rgba(34,197,94,0.45)'
                              : 'var(--w3-border-section)',
                          color: 'var(--w3-text)'
                        }}
                      >
                        <option value="">
                          {backupOptions.loading
                            ? 'Loading…'
                            : options.length === 0
                              ? 'No backups found'
                              : 'Select a backup…'}
                        </option>
                        {options.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                      {f.description ? (
                        <span
                          className="text-[10px]"
                          style={{ color: 'var(--w3-text-dim)' }}
                        >
                          {f.description}
                        </span>
                      ) : null}
                      {backupOptions.error ? (
                        <span
                          className="text-[10px]"
                          style={{ color: 'var(--status-danger)' }}
                        >
                          Failed to load backups list: {backupOptions.error}
                        </span>
                      ) : null}
                    </div>
                  );
                }
                // Fallback: description-only row (existing behavior).
                return (
                  <div key={f.key} className="flex items-start gap-1.5">
                    <span style={{ color: 'var(--w3-gold-400)' }}>•</span>
                    <span>
                      <span className="font-medium text-[var(--w3-text)]">{f.label}</span>
                      {f.description ? (
                        <span className="text-[var(--w3-text-dim)]"> - {f.description}</span>
                      ) : null}
                    </span>
                  </div>
                );
              })}
            </div>
            {mode.variant === 'active' && !inputsSatisfied ? (
              <div
                className="mt-1.5 text-[10px]"
                style={{ color: 'var(--w3-text-dim)' }}
              >
                Select all required inputs to enable Run.
              </div>
            ) : null}
          </div>
        ) : null}

        {control.requiresConfirmation && control.confirmationSchema ? (
          <div
            className="mt-2 rounded-md border p-2.5 text-[11px]"
            style={{
              background: 'rgba(7,18,37,0.5)',
              borderColor: 'var(--w3-border-section)',
              color: 'var(--w3-text-muted)'
            }}
          >
            <div
              className="mb-1 font-medium uppercase tracking-[0.1em] text-[10px]"
              style={{ color: 'var(--w3-text-dim)' }}
            >
              Confirmation
            </div>
            <div className="space-y-1.5">
              {control.confirmationSchema.checkboxes.map((c) => (
                <label
                  key={c.key}
                  className="flex items-start gap-2 cursor-pointer"
                  style={{ color: 'var(--w3-text)' }}
                >
                  <input
                    type="checkbox"
                    checked={checkboxState[c.key] === true}
                    onChange={(e) =>
                      setCheckboxState((s) => ({ ...s, [c.key]: e.target.checked }))
                    }
                    disabled={mode.variant === 'disabled' || run.loading}
                    className="mt-0.5 shrink-0"
                    style={{ accentColor: 'var(--w3-gold-500)' }}
                  />
                  <span className="text-[11px] leading-snug">{c.label}</span>
                </label>
              ))}
              {control.confirmationSchema.typedPhrases.map((p) => (
                <div key={p.key} className="flex flex-col gap-1">
                  <label
                    className="text-[11px]"
                    style={{ color: 'var(--w3-text)' }}
                  >
                    {p.label}{' '}
                    <code
                      className="font-mono"
                      style={{ color: 'var(--w3-gold-400)' }}
                    >
                      {p.expected}
                    </code>
                  </label>
                  <input
                    type="text"
                    value={phraseState[p.key] ?? ''}
                    onChange={(e) =>
                      setPhraseState((s) => ({ ...s, [p.key]: e.target.value }))
                    }
                    disabled={mode.variant === 'disabled' || run.loading}
                    placeholder={p.expected}
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                    className="font-mono text-[11px] rounded-md border px-2 py-1"
                    style={{
                      background: 'rgba(7,18,37,0.7)',
                      borderColor:
                        (phraseState[p.key] ?? '') === p.expected
                          ? 'rgba(34,197,94,0.45)'
                          : 'var(--w3-border-section)',
                      color: 'var(--w3-text)'
                    }}
                  />
                </div>
              ))}
            </div>
            {mode.variant === 'active' && !confirmationsSatisfied ? (
              <div
                className="mt-1.5 text-[10px]"
                style={{ color: 'var(--w3-text-dim)' }}
              >
                Complete the confirmation above to enable Run.
              </div>
            ) : null}
          </div>
        ) : null}

        {control.interactivePromptsToday.length > 0 ? (
          <div
            className="mt-2 rounded-md border p-2.5 text-[11px]"
            style={{
              background: 'var(--status-warning-bg)',
              borderColor: 'rgba(245,158,11,0.35)',
              color: 'var(--w3-text)'
            }}
          >
            <div
              className="mb-1 flex items-center gap-1 text-[10px] font-medium uppercase tracking-[0.1em]"
              style={{ color: 'var(--status-warning)' }}
            >
              <Terminal size={11} /> Interactive Prompts Today
            </div>
            <ul className="space-y-0.5 text-[var(--w3-text-muted)]">
              {control.interactivePromptsToday.map((p, i) => (
                <li key={i} className="font-mono text-[11px]">
                  {p}
                </li>
              ))}
            </ul>
            <p className="mt-1 text-[10px]" style={{ color: 'var(--w3-text-dim)' }}>
              UI never pipes answers into a TTY. These prompts will become
              validated form fields once a non-interactive wrapper ships.
            </p>
          </div>
        ) : null}

        {control.notes ? (
          // v0.5.26: release-history / implementation paragraphs live here
          // under a collapsed Technical Details section so the visible card
          // body stays focused on operator-facing copy. Open the disclosure
          // to read the verbatim registry notes (unchanged from the wire
          // payload).
          <details
            className="mt-3 rounded-md border"
            style={{
              background: 'rgba(7,18,37,0.45)',
              borderColor: 'var(--w3-border-section)'
            }}
          >
            <summary
              className="flex cursor-pointer items-center gap-1.5 px-2.5 py-1.5 text-[10px] font-medium uppercase tracking-[0.1em]"
              style={{ color: 'var(--w3-text-dim)' }}
            >
              <Info
                size={12}
                className="shrink-0"
                style={{ color: 'var(--w3-text-dim)' }}
              />
              <span>Technical Details</span>
            </summary>
            <div
              className="px-2.5 pb-2.5 pt-1 text-[11px] leading-relaxed"
              style={{ color: 'var(--w3-text-muted)' }}
            >
              {control.notes}
            </div>
          </details>
        ) : null}

        {/* Button row */}
        <div
          className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t pt-2.5"
          style={{ borderColor: 'var(--w3-border-row)' }}
        >
          <div className="text-[10px] uppercase tracking-[0.1em] text-[var(--w3-text-dim)]">
            Timeout: {control.timeoutSeconds}s · Log: {control.logCategory}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClick}
              disabled={runDisabled}
              className="btn text-xs"
              style={
                mode.variant === 'active'
                  ? {
                      background: 'var(--w3-gold-500)',
                      color: '#1A1206',
                      border: '1px solid var(--w3-gold-500)',
                      opacity: run.loading ? 0.6 : 1
                    }
                  : mode.variant === 'configure'
                    ? {
                        background: 'var(--status-info-bg)',
                        color: 'var(--w3-text)',
                        border: '1px solid rgba(59,130,246,0.4)',
                        opacity: run.loading ? 0.6 : 1
                      }
                    : {
                        background: 'transparent',
                        color: 'var(--w3-text-dim)',
                        border: '1px solid var(--w3-border)',
                        cursor: 'not-allowed'
                      }
              }
              title={mode.hint}
            >
              <span className="mr-1.5 inline-flex items-center">{mode.icon}</span>
              {run.loading ? 'Running…' : mode.label}
            </button>
          </div>
        </div>

        {run.error ? (
          <div
            className="mt-2 rounded-md border p-2 text-xs"
            style={{
              background: 'var(--status-danger-bg)',
              borderColor: 'rgba(239,68,68,0.4)',
              color: 'var(--status-danger)'
            }}
          >
            {run.error}
          </div>
        ) : null}

        {/* Deployment confirmation uses the existing restart banner and card layout. */}
        {run.waiting ? (
          <div
            className="mt-2 rounded-md border p-2 text-xs"
            style={{
              background: 'var(--status-info-bg)',
              borderColor: 'rgba(59,130,246,0.4)',
              color: 'var(--status-info)'
            }}
          >
            <div className="flex items-center gap-2">
              <Loader2 size={14} className="animate-spin" />
              <span style={{ color: 'var(--w3-text)', fontWeight: 500 }}>
                {run.waiting.deployment ? 'Checking deployment…' : 'Service restarting — reconnecting…'}
              </span>
              <span
                className="ml-auto font-mono"
                style={{ color: 'var(--w3-text-muted)' }}
              >
                {Math.floor(run.waiting.elapsedMs / 1000)}s
              </span>
            </div>
            <div className="mt-1.5" style={{ color: 'var(--w3-text-muted)' }}>
              {run.waiting.deployment ? 'Waiting for this installation to be recorded, the selected version to be running, and the service to be healthy. You do not need to run Deploy again.' : <>The deploy script intentionally bounces the {consoleText("w3buildcost")} service
              mid-run. The card is polling <code className="font-mono">/health</code>{' '}
              and will mark this step successful once the service answers again.</>}
            </div>
            {run.waiting.versionBefore ? (
              <div
                className="mt-1 font-mono"
                style={{ color: 'var(--w3-text-dim)' }}
              >
                version before: {run.waiting.versionBefore}
              </div>
            ) : null}
            {run.waiting.lastHealth ? (
              <div
                className="mt-0.5 font-mono"
                style={{ color: 'var(--w3-text-dim)' }}
              >
                last health: {run.waiting.lastHealth}
              </div>
            ) : null}
          </div>
        ) : null}

        {run.unconfirmed ? (
          <div className="mt-2 rounded-md border p-2 text-xs" style={{ borderColor: 'var(--w3-gold-500)' }}>
            <Badge tone="warning">Deployment result unconfirmed</Badge>
            <p className="mt-2">The confirmation window ended. The deployment may still have completed. Check its status again before starting another deployment.</p>
            {run.unconfirmed.deployment?.response?.requestId ? <p className="mt-1 font-mono">{run.unconfirmed.deployment.response.requestId}</p> : null}
            <button type="button" className="mt-2 underline" onClick={() => {
              waitGenRef.current += 1;
              setRun({ loading: false, waiting: { ...run.unconfirmed!, startedAt: Date.now(), elapsedMs: 0 } });
            }}>Check again</button>
          </div>
        ) : null}

        {run.response ? (
          <div
            className="mt-2 rounded-md border p-2 text-[11px]"
            style={{
              background: 'rgba(7,18,37,0.6)',
              borderColor: 'var(--w3-border-section)'
            }}
          >
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={runStatusTone(run.response.runStatus)}>
                {runStatusLabel(run.response.runStatus)}
              </Badge>
              {typeof run.response.exitCode === 'number' ? (
                <span style={{ color: 'var(--w3-text-muted)' }}>
                  exit {run.response.exitCode}
                </span>
              ) : null}
              {typeof run.response.durationMs === 'number' ? (
                <span style={{ color: 'var(--w3-text-muted)' }}>
                  {run.response.durationMs}ms
                </span>
              ) : null}
              {run.response.requestId ? (
                <span
                  className="font-mono"
                  style={{ color: 'var(--w3-text-dim)' }}
                >
                  {run.response.requestId}
                </span>
              ) : null}
            </div>

            {/* Action lock contention banner (409 already_running). */}
            {run.response.runStatus === 'already_running' && run.response.lockHeldBy ? (
              <div
                className="mt-2 rounded-md border p-2 text-[11px]"
                style={{
                  background: 'var(--status-warning-bg)',
                  borderColor: 'rgba(245,158,11,0.4)',
                  color: 'var(--w3-text)'
                }}
              >
                Another admin action is already running:{' '}
                <code className="font-mono">{run.response.lockHeldBy.controlId}</code>{' '}
                (started {run.response.lockHeldBy.startedAt}). Wait for it to
                finish, then try again.
              </div>
            ) : null}

            {/* Verifier empty-state banner. */}
            {emptyStateCopyFor(control.id, run.response.runStatus) ? (
              <div
                className="mt-2 rounded-md border p-2 text-[11px]"
                style={{
                  background: 'rgba(15,23,42,0.6)',
                  borderColor: 'var(--w3-border-section)',
                  color: 'var(--w3-text-muted)'
                }}
              >
                {emptyStateCopyFor(control.id, run.response.runStatus)}
              </div>
            ) : null}

            <div className="mt-1.5 text-[var(--w3-text)]">{run.response.reason}</div>
            {run.response.stdoutTail ? (
              <pre
                className="mt-2 overflow-x-auto whitespace-pre-wrap font-mono text-[10.5px] leading-snug"
                style={{ color: 'var(--w3-text-muted)' }}
              >
                {run.response.stdoutTail}
              </pre>
            ) : null}
            {run.response.stderrTail ? (
              <pre
                className="mt-2 overflow-x-auto whitespace-pre-wrap font-mono text-[10.5px] leading-snug"
                style={{ color: 'var(--status-warning)' }}
              >
                {run.response.stderrTail}
              </pre>
            ) : null}
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}
