// =============================================================================
// W3 Core v0.5.18 - Admin Control Registry types.
// =============================================================================
//
// v0.5.14 working-pass note (additive, non-breaking):
//
//   The granular registry `status` (UI_READY / NEEDS_INPUTS / NEEDS_WRAPPER /
//   DANGEROUS_DISABLED / TERMINAL_ONLY / UNKNOWN_REVIEW_REQUIRED) is preserved
//   exactly as-is so existing UI counters and tests do not move. On the wire,
//   every control now ALSO carries a canonical `effectiveStatus` that collapses
//   to the W3 Forge Admin Controls v0.5.14 four-bucket scheme:
//
//     UI_READY        - safe to run from the UI today (enabled + safe-direct
//                       or safe-wrapper).
//     NEEDS_WRAPPER   - a non-interactive wrapper is required before UI
//                       execution can be wired safely.
//     TERMINAL_ONLY   - operator-only; never run from the UI.
//     DISABLED        - explicitly disabled or dangerous-disabled; never run
//                       from the UI in v0.5.x.
//
//   This collapse is computed in registry.ts (deriveEffectiveStatus) and is the
//   single source of truth surfaced to operator-facing summaries and reports.
//
// These types describe every operational script / admin action the W3 Forge
// Admin Console knows about. The registry itself is plain data
// (controls.ts), so the shape lives here in its own module. The Admin
// Controls UI is rendered entirely from this registry; the backend never
// executes anything unless a control is explicitly marked enabled AND its
// `runStrategy` is `safe-direct` AND it passes validation.
//
// v0.5.13 is intentionally an AUDIT + REGISTRY + VALIDATION release.
//   - GET    /api/admin/controls                  read-only registry
//   - GET    /api/admin/controls/scripts/audit    flat script audit table
//   - POST   /api/admin/controls/:id/validate     input/confirmation gate
//   - POST   /api/admin/controls/:id/run          refuses everything that is
//                                                 not explicitly safe-direct
//
// Future v0.5.x releases (per ROADMAP) will:
//   - v0.5.14  add non-interactive --yes/--source-ui wrappers to scripts
//   - v0.5.15  add a safe action runner with live output + action locks
//   - v0.5.16+ wire deploy/backup/restore once their wrappers exist
//
// Until then: NEVER pipe yes/no into an interactive script from the UI.

export type ControlCategory =
  | 'system-health'
  | 'backups'
  | 'packages-deploy'
  | 'logs-diagnostics'
  | 'service-controls'
  | 'dangerous-controls';

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

// Lifecycle/readiness classification for each control. The UI maps this
// directly to a button state via Controls tab rules.
export type ControlStatus =
  | 'UI_READY'                  // ready to run from UI today
  | 'NEEDS_INPUTS'              // ready but requires user inputs first
  | 'NEEDS_WRAPPER'             // script needs --yes / non-interactive flags before UI run
  | 'DANGEROUS_DISABLED'        // dangerous; intentionally disabled in v0.5.13+
  | 'TERMINAL_ONLY'             // explicitly operator-only (e.g. hardreset, restore)
  | 'UNKNOWN_REVIEW_REQUIRED';  // not yet audited

// v0.5.14 canonical four-bucket Admin Controls classification used by the
// operator-facing summary and reports. Derived from ControlStatus + enabled +
// runStrategy by deriveEffectiveStatus().
export type EffectiveStatus =
  | 'UI_READY'
  | 'NEEDS_WRAPPER'
  | 'TERMINAL_ONLY'
  | 'DISABLED';

export type RunStrategy =
  | 'safe-direct'    // backend may run the underlying script with fixed argv (LOW-risk read-only)
  | 'safe-wrapper'   // v0.5.14: backend may run a non-interactive UI wrapper with --yes + --request-id (MEDIUM allowed)
  | 'safe-recovery'  // v0.5.24: dedicated CRITICAL recovery path. Whitelisted to a fixed set of recovery control ids (restore-w3forge only). Does NOT weaken the existing safe-wrapper HIGH/CRITICAL refusal fence - every other CRITICAL control is still refused.
  | 'safe-deploy'    // v0.5.25: dedicated HIGH-risk deploy path. Whitelisted to a fixed set of deploy control ids (deploy-w3forge only). Does NOT weaken the existing safe-wrapper HIGH/CRITICAL refusal fence - every other HIGH/CRITICAL control is still refused.
  | 'safe-pipeline'  // v0.5.29: dedicated Release Pipeline path. Whitelisted to the fixed set of pipeline-* control ids that drive the Release Pipeline UI (pipeline-check-remote ... pipeline-delete-tag). Targets /opt/w3forge-deploy only; never touches /opt/w3forge runtime. Does NOT weaken the existing safe-wrapper HIGH/CRITICAL refusal fence - every other HIGH/CRITICAL control outside the pipeline whitelist is still refused.
  | 'wrapper'        // script lacks an installed non-interactive wrapper; UI execution not wired yet
  | 'terminal-only'  // never run from UI; show as Terminal Only
  | 'disabled';      // explicitly disabled; never run

// Per-run status returned by the /run endpoint. Strictly richer than the
// v0.5.13 binary `accepted` flag - the frontend renders a multi-state pill
// using this value so an "Accepted" badge can no longer be shown for a run
// that actually produced "no .tar.gz packages found".
// v0.11.3 note: pipeline-deploy-dev wrapper (pipeline-deploy-dev-package-
// w3forge-ui.sh) emits a KV pair `runStatus=launched-detached` inside its
// structured trailer to describe the detached systemd-run launch mode. That
// KV pair is NOT the `status=` field and is never mapped to this type. The
// `status=` field is always 'success' | 'failed' | 'blocked'. mapStructured-
// Status in safeRunner.ts guards against any future wrapper that emits
// `status=launched-detached` by treating it as 'success'. Do not add
// 'launched-detached' here — it is a trailer metadata value, not a RunStatus.
export type RunStatus =
  | 'success'             // wrapper ran and reported a clean pass
  | 'failed'              // wrapper ran and reported a real failure (non-zero / structured fail)
  | 'blocked'             // refused by validator (inputs/confirmations) or risk gate
  | 'disabled'            // control or strategy is disabled
  | 'needs_inputs'        // requires inputs the request did not supply
  | 'needs_confirmation'  // requires confirmations the request did not supply
  | 'needs_wrapper'       // script lacks an installed non-interactive wrapper
  | 'no_package_found'    // verifier-style empty state (no staged release tarball)
  | 'already_running'     // another admin action holds the action lock

// -----------------------------------------------------------------------------
// Input / confirmation schemas. Kept intentionally small and JSON-shaped so the
// frontend can render them directly without importing a schema library.
// -----------------------------------------------------------------------------

export interface InputFieldBase {
  key: string;
  label: string;
  description?: string;
  required: boolean;
}

export interface InputFieldText extends InputFieldBase {
  type: 'text';
  placeholder?: string;
  minLength?: number;
  maxLength?: number;
  pattern?: string;            // regex (string form) for client + server validation
}

export interface InputFieldSelect extends InputFieldBase {
  type: 'select';
  // For dynamic option sources (e.g. staged packages) the frontend resolves
  // the list from a known endpoint identified by `optionsSource`. v0.5.13
  // does not yet ship UI for any input that uses this, but it is modeled
  // for v0.5.16 (Package Deploy From UI).
  optionsSource?: 'packages.staged' | 'backups.local' | 'static';
  staticOptions?: Array<{ value: string; label: string }>;
}

export interface InputFieldCheckbox extends InputFieldBase {
  type: 'checkbox';
  mustBeTrue: boolean;        // true => validator rejects unless checked
}

export type InputField = InputFieldText | InputFieldSelect | InputFieldCheckbox;

export interface InputSchema {
  fields: InputField[];
}

// Confirmation schema - separate from inputs so the UI can show
// confirmations as a distinct final step before submission.
export interface ConfirmationCheckbox {
  key: string;
  label: string;
  mustBeTrue: true;
}

export interface ConfirmationTypedPhrase {
  key: string;
  label: string;
  expected: string;            // case-sensitive exact match
}

export interface ConfirmationSchema {
  checkboxes: ConfirmationCheckbox[];
  typedPhrases: ConfirmationTypedPhrase[];
}

// -----------------------------------------------------------------------------
// AdminControl - one row of the registry.
// -----------------------------------------------------------------------------

export interface AdminControl {
  // Identity
  id: string;                       // stable kebab-case id used in URLs
  label: string;                    // human label for the UI
  description: string;              // one-line "what this does"
  category: ControlCategory;

  // Script binding
  scriptName: string;               // bare script filename, e.g. status-w3forge.sh
  scriptSourcePath: string;         // repo-relative path (source of truth)
  expectedInstalledPath: string;    // typically /opt/w3forge-scripts/<scriptName>

  // Risk + lifecycle classification
  riskLevel: RiskLevel;
  status: ControlStatus;
  enabled: boolean;                 // master switch; if false, never run
  runStrategy: RunStrategy;

  // Effects
  readOnly: boolean;                // script does not modify state
  writesToDisk: boolean;
  touchesDatabase: boolean;
  restartsService: boolean;
  destructive: boolean;
  requiresPreBackup: boolean;

  // Inputs / confirmations
  requiresInputs: boolean;
  inputSchema?: InputSchema;
  requiresConfirmation: boolean;
  confirmationSchema?: ConfirmationSchema;

  // Interactive-prompt findings (from the v0.5.13 audit).
  interactivePromptsToday: string[];    // human-readable list of prompts the script asks in a terminal
  nonInteractiveToday: boolean;         // true if the script already runs cleanly without a tty

  // Execution metadata
  timeoutSeconds: number;               // hard wall-clock cap for any future runner
  allowedRoles: string[];               // placeholder until real auth/roles land
  logCategory: string;                  // subdir under /opt/logs/w3forge/
  notes: string;                        // operator-facing safety notes / why disabled
}

// -----------------------------------------------------------------------------
// Wire shapes returned by the public endpoints. Frontend imports these to
// stay in sync without importing the registry data itself.
// -----------------------------------------------------------------------------

export interface AdminControlPublic
  extends Omit<AdminControl, 'inputSchema' | 'confirmationSchema'> {
  inputSchema: InputSchema | null;
  confirmationSchema: ConfirmationSchema | null;
  // v0.5.14 canonical four-bucket classification (UI_READY / NEEDS_WRAPPER /
  // TERMINAL_ONLY / DISABLED). Always present; derived from the granular
  // `status` + `enabled` + `runStrategy` so the operator-facing layer never
  // has to interpret the six-state ControlStatus.
  effectiveStatus: EffectiveStatus;
  // v0.6.2 additive only. Identifies which app a control belongs to. The
  // frontend may safely ignore this field — the legacy Controls tab
  // continues to render the same way it does today.
  app_id?: string;
}

export interface AdminControlsResponse {
  generatedAt: string;
  version: string;                                    // app version
  release: string;                                    // e.g. 'v0.5.18'
  categories: Array<{
    id: ControlCategory;
    label: string;
    description: string;
    controls: AdminControlPublic[];
  }>;
  counts: {
    total: number;
    byStatus: Record<ControlStatus, number>;
    // v0.5.14 canonical four-bucket totals. The Admin Controls policy doc
    // requires every control to land in exactly one of these buckets, so the
    // counter shape is fixed and exhaustive.
    byEffectiveStatus: Record<EffectiveStatus, number>;
    byRisk: Record<RiskLevel, number>;
  };
  // v0.6.2 additive only. Top-level fields describing which app the response
  // belongs to and where the registry was loaded from. These are
  // backward-compatible — v0.5.x clients ignore them.
  app_id?: string;
  app_name?: string;
  registry_source?: string;       // e.g. 'legacy-compatible' | 'app-registry'
  config_driven?: boolean;        // true when script paths come from app config
}

export interface ScriptAuditRow {
  id: string;
  scriptName: string;
  sourcePath: string;
  installedPath: string;
  category: ControlCategory;
  riskLevel: RiskLevel;
  status: ControlStatus;
  enabled: boolean;
  interactiveToday: boolean;
  interactivePrompts: string[];
  needsWrapper: boolean;
  notes: string;
}

export interface ScriptsAuditResponse {
  generatedAt: string;
  release: string;
  totalScripts: number;
  rows: ScriptAuditRow[];
}

export interface ValidateRequestBody {
  inputs?: Record<string, unknown>;
  confirmations?: Record<string, unknown>;
}

export interface ValidateIssue {
  key: string;
  kind: 'missing' | 'invalid' | 'mismatch' | 'disabled' | 'unsafe';
  message: string;
}

export interface ValidateResponse {
  controlId: string;
  enabled: boolean;
  status: ControlStatus;
  riskLevel: RiskLevel;
  runnable: boolean;             // overall verdict
  issues: ValidateIssue[];       // human-readable blockers (empty => runnable)
  echo: ValidateRequestBody;     // server-normalized echo for the UI
}

export interface LockSnapshotWire {
  controlId: string;
  requestId: string;
  startedAt: string;
}

// v0.5.32: parsed key/value pairs from the wrapper's ===STRUCTURED-RESULT===
// trailer. Surfaces fields like output_path / bytes / verified to the UI so
// the frontend can refuse to render Success unless the artifact contract is
// actually satisfied. Each pipeline wrapper documents its own keys.
export interface RunStructured {
  status?: string;
  reason?: string;
  // Package Dev Release emits the path to the freshly-built tarball under
  // /opt/w3forge-update-packages/dev/. Used by the artifact gate for pipeline-package-dev.
  output_path?: string;
  // Deploy Dev Package emits the promoted path under /opt/w3forge-update-packages/
  // (outside /dev/). Used by the artifact gate for pipeline-deploy-dev.
  staged_path?: string;
  // Deploy Dev Package: exit code of the underlying deploy-w3forge.sh delegate.
  delegate_exit_code?: number;
  bytes?: number;
  duration_seconds?: number;
  verified?: boolean;
  package?: string;
  version?: string;
  branch?: string;
  head?: string;
  // v0.5.38: canonical channel/version model. Wrappers that produce or read
  // /opt/w3forge-update-packages/<channel>/<version>/w3forge.tar.gz emit these so the
  // UI can display the resolved channel + version and the artifact gate can
  // verify the canonical path. 'channel' is dev|main; 'version' is vX.Y.Z.
  channel?: string;
  resolved_package_path?: string;
  sha256?: string;
  installed_metadata_dir?: string;
  // v0.11.3: pipeline-deploy-dev detached-launch trailer fields.
  // The wrapper emits `runStatus=launched-detached` as a KV metadata pair
  // inside the structured trailer to describe the detached systemd-run launch
  // mode. This is NOT the same as the trailer's `status=` field (which is
  // always 'success' | 'failed' | 'blocked'). The actual deploy runs in a
  // transient systemd unit; UI success is confirmed by /health + /version
  // recovery polling after the service bounces.
  runStatus?: string;           // e.g. 'launched-detached' — metadata, not RunStatus
  detached_unit?: string;       // systemd transient unit name (w3forge-deploy-<rid>)
  trailer_path?: string;        // path to the on-disk ExecStopPost trailer file
  log_path?: string;            // path to the transient unit stdout/stderr log file
  // Unknown wrapper keys are preserved as strings.
  [key: string]: unknown;
}

export interface RunResponse {
  controlId: string;
  accepted: boolean;
  reason: string;                // why accepted=false / human-readable summary on success
  runStatus: RunStatus;          // v0.5.14: richer per-run status (see RunStatus)
  requestId?: string;            // opaque action handle, present once an action is admitted
  // Present only when execution actually ran.
  exitCode?: number;
  stdoutTail?: string;
  stderrTail?: string;
  durationMs?: number;
  logFile?: string | null;
  // v0.5.32: parsed structured trailer fields from the wrapper (when
  // parseTrailer is true on the runner path). Used by the UI to render a
  // precise result summary and to enforce artifact-existence success gates.
  structured?: RunStructured;
  // Present only on 409-class lock contention.
  lockHeldBy?: LockSnapshotWire;
}
