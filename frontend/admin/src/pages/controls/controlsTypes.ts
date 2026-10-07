// =============================================================================
// W3 Core v0.5.14 - Admin Controls UI types.
// =============================================================================
//
// Mirrors backend/src/admin/controls/types.ts. v0.5.14 adds an additive
// `effectiveStatus` field on every control and a `byEffectiveStatus` counter
// on the response - the canonical four-bucket classification surfaced by the
// operator-facing summary.
//
// Mirrors backend/src/admin/controls/types.ts. We re-declare the wire shapes
// here (rather than sharing a TS module across workspaces) because the admin
// frontend has its own tsconfig and intentionally has no dependency on the
// backend package.

export type ControlCategory =
  | 'system-health'
  | 'backups'
  | 'packages-deploy'
  | 'logs-diagnostics'
  | 'service-controls'
  | 'dangerous-controls';

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export type ControlStatus =
  | 'UI_READY'
  | 'NEEDS_INPUTS'
  | 'NEEDS_WRAPPER'
  | 'DANGEROUS_DISABLED'
  | 'TERMINAL_ONLY'
  | 'UNKNOWN_REVIEW_REQUIRED';

// v0.5.14 canonical four-bucket Admin Controls classification.
export type EffectiveStatus =
  | 'UI_READY'
  | 'NEEDS_WRAPPER'
  | 'TERMINAL_ONLY'
  | 'DISABLED';

export type RunStrategy =
  | 'safe-direct'
  | 'safe-wrapper'
  | 'safe-recovery'
  | 'safe-deploy'
  | 'safe-pipeline'
  | 'wrapper'
  | 'terminal-only'
  | 'disabled';

// v0.5.14: richer per-run status used to render multi-state status pills.
export type RunStatus =
  | 'success'
  | 'failed'
  | 'blocked'
  | 'disabled'
  | 'needs_inputs'
  | 'needs_confirmation'
  | 'needs_wrapper'
  | 'no_package_found'
  | 'already_running';

export interface LockSnapshotWire {
  controlId: string;
  requestId: string;
  startedAt: string;
}

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
  pattern?: string;
}
export interface InputFieldSelect extends InputFieldBase {
  type: 'select';
  optionsSource?: 'packages.staged' | 'backups.local' | 'static';
  staticOptions?: Array<{ value: string; label: string }>;
}
export interface InputFieldCheckbox extends InputFieldBase {
  type: 'checkbox';
  mustBeTrue: boolean;
}
export type InputField = InputFieldText | InputFieldSelect | InputFieldCheckbox;

export interface InputSchema { fields: InputField[]; }

export interface ConfirmationCheckbox {
  key: string;
  label: string;
  mustBeTrue: true;
}
export interface ConfirmationTypedPhrase {
  key: string;
  label: string;
  expected: string;
}
export interface ConfirmationSchema {
  checkboxes: ConfirmationCheckbox[];
  typedPhrases: ConfirmationTypedPhrase[];
}

export interface AdminControlPublic {
  id: string;
  label: string;
  description: string;
  category: ControlCategory;
  scriptName: string;
  scriptSourcePath: string;
  expectedInstalledPath: string;
  riskLevel: RiskLevel;
  status: ControlStatus;
  enabled: boolean;
  runStrategy: RunStrategy;
  readOnly: boolean;
  writesToDisk: boolean;
  touchesDatabase: boolean;
  restartsService: boolean;
  destructive: boolean;
  requiresPreBackup: boolean;
  requiresInputs: boolean;
  inputSchema: InputSchema | null;
  requiresConfirmation: boolean;
  confirmationSchema: ConfirmationSchema | null;
  interactivePromptsToday: string[];
  nonInteractiveToday: boolean;
  timeoutSeconds: number;
  allowedRoles: string[];
  logCategory: string;
  notes: string;
  // v0.5.14: canonical four-bucket classification surfaced by the backend.
  // The granular `status` above stays for the per-card pill; this field is
  // what the operator-facing summary and reports use.
  effectiveStatus: EffectiveStatus;
}

export interface AdminControlsResponse {
  generatedAt: string;
  version: string;
  release: string;
  categories: Array<{
    id: ControlCategory;
    label: string;
    description: string;
    controls: AdminControlPublic[];
  }>;
  counts: {
    total: number;
    byStatus: Record<ControlStatus, number>;
    byEffectiveStatus: Record<EffectiveStatus, number>;
    byRisk: Record<RiskLevel, number>;
  };
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
  runnable: boolean;
  issues: ValidateIssue[];
  echo: ValidateRequestBody;
}

// v0.5.32+: parsed key/value pairs from the wrapper's ===STRUCTURED-RESULT===
// trailer. Surfaces fields like output_path / staged_path / verified to the
// UI so the frontend can refuse to render Success unless the artifact
// contract is actually satisfied. v0.5.38 adds the canonical channel /
// resolved_package_path / sha256 / installed_metadata_dir fields emitted by
// the channel-aware wrappers (package / verify / deploy / promote).
// Mirrors backend/src/admin/controls/types.ts RunStructured.
export interface RunStructured {
  status?: string;
  reason?: string;
  // pipeline-package-dev: path to freshly-built tarball under
  // /opt/w3buildcost-update-packages/dev/<version>/w3buildcost.tar.gz.
  output_path?: string;
  // pipeline-deploy-dev (legacy): promoted path under /opt/w3buildcost-update-packages/.
  // v0.5.38 wrappers prefer resolved_package_path; staged_path is retained for
  // backward compatibility with pre-v0.5.38 deploy structured trailers.
  staged_path?: string;
  // pipeline-deploy-dev: exit code of the underlying deploy-w3buildcost.sh delegate.
  delegate_exit_code?: number;
  bytes?: number;
  duration_seconds?: number;
  verified?: boolean;
  package?: string;
  version?: string;
  branch?: string;
  head?: string;
  // v0.5.38 canonical channel/version model. Wrappers that produce or read
  // /opt/w3buildcost-update-packages/<channel>/<version>/w3buildcost.tar.gz emit these so the
  // UI can display the resolved channel + version and the artifact gate can
  // verify the canonical path. channel is dev|main|installed; version is
  // vX.Y.Z.
  channel?: string;
  resolved_package_path?: string;
  sha256?: string;
  installed_metadata_dir?: string;
  // v0.11.3: pipeline-deploy-dev detached-launch trailer fields.
  // The wrapper emits `runStatus=launched-detached` as a KV metadata pair
  // (NOT the same as the `status=` field which is always success|failed|
  // blocked). The actual deploy runs in a transient systemd unit; the UI
  // confirms success by polling /health + /version after the service bounces.
  runStatus?: string;           // e.g. 'launched-detached' metadata tag
  detached_unit?: string;       // systemd transient unit name
  trailer_path?: string;        // path to the on-disk trailer file
  log_path?: string;            // path to the transient unit log file
  // Unknown wrapper keys are preserved.
  [key: string]: unknown;
}

export interface RunResponse {
  controlId: string;
  accepted: boolean;
  reason: string;
  runStatus: RunStatus;
  requestId?: string;
  exitCode?: number;
  stdoutTail?: string;
  stderrTail?: string;
  durationMs?: number;
  logFile?: string | null;
  // v0.5.32+: parsed structured trailer fields from the wrapper. Used by the
  // UI to render a precise result summary and enforce artifact-existence
  // success gates.
  structured?: RunStructured;
  lockHeldBy?: LockSnapshotWire;
}
