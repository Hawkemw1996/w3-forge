import { consoleText, consolePattern } from "../../../../../shared/consoleApp";
// =============================================================================
// W3 Core v0.5.30 - Release Pipeline UI panel.
// =============================================================================
//
// v0.5.30 polish over the v0.5.29 baseline:
//   * Branch and staged-package pickers now use <DarkSelect> for guaranteed
//     dark-mode readability across browsers.
//   * Dev branches are sorted newest-first by semver; only the latest three
//     are shown until "Show older branches" is toggled.
//   * Each of the seven stages renders a clearer descriptive blurb plus a
//     short "what this does" line per action.
//   * Action rows now surface explicit disabled-state reasons (missing inputs,
//     missing confirmations, gate not yet satisfied) instead of a tooltip.
//   * Success / Refused / Failed / Running outcomes render as labelled badges
//     using the shared Badge component.
//   * HIGH-risk actions are grouped into a dedicated visually separated
//     section in stage 7 (Tag & Recovery).
//   * Live output now highlights [REFUSE] / [OK] / [FAIL] / [INFO] markers
//     in the existing stdout/stderr tail rendering. No backend log format
//     contract is changed.
//
// All changes are UI-only. The safe-pipeline backend contract, the registry,
// the validator, and the deployment scripts remain untouched. Every HIGH-risk
// action keeps the same typed-phrase / checkbox confirmations declared in
// the backend registry, and the backend continues to enforce them.
// =============================================================================
//
// Original v0.5.29 header preserved for historical context:
//
// This component replaces the v0.5.5 "Coming In Controls" placeholder on the
// GitHub / Releases page. It drives the thirteen pipeline-* controls shipped
// in Pass A through the safe-pipeline backend path:
//
//   POST /api/admin/controls/:id/run     (with { inputs, confirmations })
//   GET  /api/admin/git/branches-dev     (dev/vX.Y.Z branch list)
//   GET  /api/admin/packages             (staged release packages)
//
// Pass A backend contract is NOT changed by this file; this component only
// renders inputs, confirmations, and live result panels for the seven
// pipeline stages. Every HIGH-risk action keeps the same typed-phrase /
// checkbox confirmations declared in the backend registry.
//
// The pipeline is rendered as seven gated stages:
//
//   1. Check Remote        (pipeline-check-remote + pipeline-fetch-tags)
//   2. Sync Dev Branch     (pipeline-pull-latest, pipeline-checkout-dev,
//                           pipeline-push-dev)
//   3. Test Dev Branch     (pipeline-test-dev)
//   4. Package Dev Release (pipeline-package-dev)
//   5. Verify Package      (pipeline-verify-dev-pkg)
//   6. Deploy Release      (pipeline-deploy-dev)
//   7. Tag / Recovery      (pipeline-create-tag, pipeline-delete-tag,
//                           pipeline-rollback, pipeline-reset-tree)
//
// Each later stage is gated until the prior stage's prerequisite action has
// reported runStatus === 'success' in the current session. Gating is
// advisory in the UI (the backend still enforces all guards independently);
// users can override the gate via a "Force enable next step" toggle but the
// default flow is the canonical Release Pipeline order.

import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleDashed,
  Eye,
  EyeOff,
  Info,
  Loader2,
  Lock,
  Play,
  RefreshCw,
  Rocket,
  ShieldAlert,
  XCircle
} from 'lucide-react';
import { Copy, FileText } from 'lucide-react';
import { adminGet, adminPost, AdminApiError } from '../../lib/api';
import { Badge, type BadgeTone } from '../../components/ui/Badge';
import { DarkSelect, type DarkSelectOption } from '../../components/ui/DarkSelect';
import type {
  RiskLevel,
  RunResponse,
  RunStatus
} from '../controls/controlsTypes';
import { usePipelineSharedState } from './pipelineContext';

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

interface DevBranch {
  name: string;
  sha: string;
}

interface BranchesResponse {
  ok: boolean;
  listedAt: string;
  branches: DevBranch[];
  count: number;
  message: string;
  status: 'list_ok' | 'list_failed';
}

interface StagedPackage {
  name: string;
  parsedVersion?: string | null;
  mtime?: string | null;
  size?: number | null;
}

// v0.5.32: pipeline package dropdown reads from /packages/staged-dev which
// returns the artefacts produced by the GitHub / Releases pipeline (Package
// Dev Release writes to /opt/w3buildcost-update-packages/dev/). We stay defensive about
// missing fields so a server-side shape change does not break the picker.
interface PackagesResponseShape {
  root?: string;
  namingStandard?: string;
  staged?: StagedPackage[];
  packages?: StagedPackage[];
}

// ---------------------------------------------------------------------------
// Pipeline control descriptors (frontend-only metadata)
// ---------------------------------------------------------------------------

type PipelineControlId =
  | 'pipeline-check-remote'
  | 'pipeline-fetch-tags'
  | 'pipeline-pull-latest'
  | 'pipeline-checkout-dev'
  | 'pipeline-push-dev'
  | 'pipeline-test-dev'
  | 'pipeline-package-dev'
  | 'pipeline-verify-dev-pkg'
  | 'pipeline-deploy-dev'
  | 'pipeline-create-tag'
  | 'pipeline-delete-tag'
  | 'pipeline-rollback'
  | 'pipeline-reset-tree';

interface PipelineActionMeta {
  id: PipelineControlId;
  label: string;
  description: string;
  risk: RiskLevel;
  needs: {
    branch?: boolean;
    tag?: boolean;
    packageBasename?: boolean;
    message?: boolean;
    confirmDeleteTag?: boolean;
  };
  // Typed phrase confirmation declared by the backend registry. We mirror
  // the literal expected values here so the UI can render the field. If a
  // value drifts on the backend the server will still refuse the run.
  confirmPhrase?: { key: string; expected: string };
  // Checkbox confirmation key declared by the backend registry.
  confirmCheckbox?: { key: string; label: string };
}

const ACTION_META: Record<PipelineControlId, PipelineActionMeta> = {
  'pipeline-check-remote': {
    id: 'pipeline-check-remote',
    label: 'Check Remote',
    description: 'git ls-remote + fetch --dry-run. Read-only.',
    risk: 'LOW',
    needs: {}
  },
  'pipeline-fetch-tags': {
    id: 'pipeline-fetch-tags',
    label: 'Fetch Tags',
    description: 'Refresh local tag refs from origin. Read-only refs update.',
    risk: 'LOW',
    needs: {}
  },
  'pipeline-pull-latest': {
    id: 'pipeline-pull-latest',
    label: 'Pull Latest',
    description: 'git pull --ff-only on the current dev branch.',
    risk: 'MEDIUM',
    needs: {}
  },
  'pipeline-checkout-dev': {
    id: 'pipeline-checkout-dev',
    label: 'Checkout Dev Branch',
    description: 'Switch the deploy clone to the selected dev/vX.Y.Z branch.',
    risk: 'MEDIUM',
    needs: { branch: true }
  },
  'pipeline-push-dev': {
    id: 'pipeline-push-dev',
    label: 'Push Dev Branch',
    description: 'Push the selected dev/vX.Y.Z branch to origin (never main).',
    risk: 'MEDIUM',
    needs: { branch: true }
  },
  'pipeline-test-dev': {
    id: 'pipeline-test-dev',
    label: 'Test Dev Branch',
    description: 'Run npm install / build / lint / test on the current branch.',
    risk: 'MEDIUM',
    needs: {}
  },
  'pipeline-package-dev': {
    id: 'pipeline-package-dev',
    label: 'Package Dev Release',
    description: consoleText('Build w3buildcost-vX.Y.Z.tar.gz into the staged packages directory.'),
    risk: 'HIGH',
    needs: { tag: true },
    confirmPhrase: { key: 'typedPackage', expected: 'PACKAGE' },
    confirmCheckbox: {
      key: 'confirmPackage',
      label:
        'I understand this builds a staged release tarball that may later be deployed.'
    }
  },
  'pipeline-verify-dev-pkg': {
    id: 'pipeline-verify-dev-pkg',
    label: 'Verify Dev Package',
    description: 'Read-only verification of the staged tarball.',
    risk: 'MEDIUM',
    needs: { packageBasename: true }
  },
  'pipeline-deploy-dev': {
    id: 'pipeline-deploy-dev',
    label: 'Deploy Dev Package',
    description:
      consoleText('Coordinate pipeline-side deploy of a staged tarball. Live runtime extract remains owned by deploy-w3buildcost.'),
    risk: 'HIGH',
    needs: { packageBasename: true },
    confirmPhrase: { key: 'typedDeployDev', expected: 'DEPLOY-DEV' },
    confirmCheckbox: {
      key: 'confirmDeployDev',
      label:
        'I understand this prepares a release for the live runtime via the safe-pipeline path.'
    }
  },
  'pipeline-create-tag': {
    id: 'pipeline-create-tag',
    label: 'Create Release Tag',
    description: 'Create + push annotated vX.Y.Z tag to origin.',
    risk: 'HIGH',
    needs: { tag: true, message: true },
    confirmPhrase: { key: 'typedCreateTag', expected: 'CREATE-TAG' },
    confirmCheckbox: {
      key: 'confirmCreateTag',
      label: 'I understand this pushes a permanent annotated tag to origin.'
    }
  },
  'pipeline-delete-tag': {
    id: 'pipeline-delete-tag',
    label: 'Delete Release Tag',
    description: 'Delete a vX.Y.Z tag locally and on origin. Requires DELETE-TAG.',
    risk: 'HIGH',
    needs: { tag: true, confirmDeleteTag: true },
    confirmPhrase: { key: 'typedDeleteTag', expected: 'DELETE-TAG' },
    confirmCheckbox: {
      key: 'confirmDeleteTagBox',
      label:
        'I understand this permanently deletes the tag locally and on origin.'
    }
  },
  'pipeline-rollback': {
    id: 'pipeline-rollback',
    label: 'Rollback Pipeline',
    description:
      consoleText('Roll the deploy clone back to the last known-good pipeline state. Never touches /opt/w3buildcost runtime.'),
    risk: 'HIGH',
    needs: {},
    confirmPhrase: { key: 'typedRollback', expected: 'ROLLBACK' },
    confirmCheckbox: {
      key: 'confirmRollback',
      label:
        consoleText('I understand this discards uncommitted pipeline work in /opt/w3buildcost-deploy.')
    }
  },
  'pipeline-reset-tree': {
    id: 'pipeline-reset-tree',
    label: 'Reset Working Tree',
    description:
      consoleText('Hard reset + clean of /opt/w3buildcost-deploy. Never touches /opt/w3buildcost runtime.'),
    risk: 'HIGH',
    needs: {},
    confirmPhrase: { key: 'typedResetTree', expected: 'RESET-TREE' },
    confirmCheckbox: {
      key: 'confirmResetTree',
      label: 'I understand this discards all uncommitted changes in the deploy clone.'
    }
  }
};

// ---------------------------------------------------------------------------
// Stage definition + gating
// ---------------------------------------------------------------------------

interface PipelineStage {
  key: string;
  title: string;
  blurb: string;
  actions: PipelineControlId[];
  // Returns true if the stage's gate is satisfied (i.e. the user is allowed
  // to interact with later stages). Read from the session result map.
  gate: (results: Record<string, RunStatus | undefined>) => boolean;
}

const STAGES: PipelineStage[] = [
  {
    key: 'remote',
    title: '1. Check Remote',
    blurb:
      'Confirm origin is reachable and refresh local tag refs before any pipeline action.',
    actions: ['pipeline-check-remote', 'pipeline-fetch-tags'],
    gate: (r) => r['pipeline-check-remote'] === 'success'
  },
  {
    key: 'sync',
    title: '2. Sync Dev Branch',
    blurb:
      'Pick the active dev/vX.Y.Z branch, check it out, fast-forward pull, and (optionally) push.',
    actions: ['pipeline-checkout-dev', 'pipeline-pull-latest', 'pipeline-push-dev'],
    gate: (r) =>
      r['pipeline-pull-latest'] === 'success' ||
      r['pipeline-checkout-dev'] === 'success'
  },
  {
    key: 'test',
    title: '3. Test Dev Branch',
    blurb: 'Run install + build + lint + test. Required before packaging.',
    actions: ['pipeline-test-dev'],
    gate: (r) => r['pipeline-test-dev'] === 'success'
  },
  {
    key: 'package',
    title: '4. Package Dev Release',
    blurb: consoleText('Build the staged w3buildcost-vX.Y.Z.tar.gz artifact. HIGH risk.'),
    actions: ['pipeline-package-dev'],
    gate: (r) => r['pipeline-package-dev'] === 'success'
  },
  {
    key: 'verify',
    title: '5. Verify Package',
    blurb: 'Read-only pre-flight check of the staged tarball.',
    actions: ['pipeline-verify-dev-pkg'],
    gate: (r) => r['pipeline-verify-dev-pkg'] === 'success'
  },
  {
    key: 'deploy',
    title: '6. Deploy Release',
    blurb:
      consoleText('Pipeline-side deploy action. HIGH risk. Live runtime extract still flows through deploy-w3buildcost.'),
    actions: ['pipeline-deploy-dev'],
    gate: (r) => r['pipeline-deploy-dev'] === 'success'
  },
  {
    key: 'tag',
    title: '7. Tag & Recovery',
    blurb:
      'Create or delete the release tag once deploy is complete. Recovery actions remain available at any time.',
    actions: [
      'pipeline-create-tag',
      'pipeline-delete-tag',
      'pipeline-rollback',
      'pipeline-reset-tree'
    ],
    gate: () => true
  }
];

// ---------------------------------------------------------------------------
// v0.5.31 - explicit stage-chain prereq strings.
//
// These messages render in the per-action disabled-state panel so operators
// see EXACTLY which earlier stage is missing for each gated action.
// Stage 7 (Tag & Recovery) returns a SOFT recommendation only because the
// recovery surface is intentionally not gate-enforced.
// ---------------------------------------------------------------------------

function stagePrereqMissing(
  stageKey: string,
  results: Record<string, RunStatus | undefined>
): string[] {
  switch (stageKey) {
    case 'remote':
      return [];
    case 'sync':
      if (results['pipeline-check-remote'] !== 'success') {
        return ['Check Remote (stage 1) must succeed first.'];
      }
      return [];
    case 'test':
      if (
        results['pipeline-pull-latest'] !== 'success' &&
        results['pipeline-checkout-dev'] !== 'success'
      ) {
        return ['Sync Dev Branch (stage 2) must succeed first — run Checkout or Pull.'];
      }
      return [];
    case 'package':
      if (results['pipeline-test-dev'] !== 'success') {
        return ['Test Dev Branch (stage 3) must succeed first before Package.'];
      }
      return [];
    case 'verify':
      if (results['pipeline-package-dev'] !== 'success') {
        return ['Package Dev Release (stage 4) must succeed first before Verify.'];
      }
      return [];
    case 'deploy':
      if (results['pipeline-verify-dev-pkg'] !== 'success') {
        return ['Verify Package (stage 5) must succeed first before Deploy.'];
      }
      return [];
    case 'tag':
      // Recovery surface — intentionally soft recommendation.
      if (results['pipeline-deploy-dev'] !== 'success') {
        return [
          'Recommended: Deploy (stage 6) should succeed before tagging. Recovery actions remain available.'
        ];
      }
      return [];
    default:
      return [];
  }
}

// Map controlId -> its stage key (built from STAGES at module load).
const CONTROL_TO_STAGE: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  for (const s of STAGES) {
    for (const a of s.actions) {
      out[a] = s.key;
    }
  }
  return out;
})();

// ---------------------------------------------------------------------------
// v0.5.30 - clearer stage descriptions + per-action "what this does" lines.
//
// These strings are pure UI text. They do not change any backend behaviour.
// They render below the existing stage blurb and inside each action row to
// help operators understand what each step is for.
// ---------------------------------------------------------------------------

const STAGE_DETAIL: Record<string, string> = {
  remote:
    'Read-only sanity checks. Confirms the GitHub origin is reachable and fetches the latest tag refs before any branch work.',
  sync:
    consoleText('Brings the deploy clone (/opt/w3buildcost-deploy) onto the selected dev/vX.Y.Z branch and fast-forwards from origin. The live runtime under /opt/w3buildcost is never touched.'),
  test:
    'Runs the standard install + build + lint + test sweep on the current branch. Required by policy before any HIGH-risk action.',
  package:
    consoleText('Produces the staged release tarball under /opt/w3buildcost-update-packages/. HIGH-risk: requires the PACKAGE typed phrase and acknowledgement checkbox.'),
  verify:
    'Pure read-only inspection of the staged tarball (filenames, version markers, sanity counts). Always safe to re-run.',
  deploy:
    'Coordinates the pipeline-side handoff to the live deploy script. HIGH-risk: requires the DEPLOY-DEV typed phrase and acknowledgement checkbox.',
  tag: 'Annotated tag creation/deletion plus recovery actions. HIGH-risk actions in this stage stay separated and clearly labelled.'
};

const ACTION_HOWTO: Partial<Record<PipelineControlId, string>> = {
  'pipeline-check-remote':
    'git ls-remote against origin. No fetch, no checkout. Confirms credentials and reachability.',
  'pipeline-fetch-tags':
    'git fetch --tags --prune. Brings local tag refs in sync with origin so package/tag steps see the truth.',
  'pipeline-pull-latest':
    'git pull --ff-only on the current dev branch. Refuses if a merge would be required.',
  'pipeline-checkout-dev':
    'Switches the deploy clone to the selected dev/vX.Y.Z branch. Refused if the working tree is dirty.',
  'pipeline-push-dev':
    'git push origin dev/vX.Y.Z. Never uses --force. Refused if branch resolves to main.',
  'pipeline-test-dev':
    'npm ci + npm run build + npm run lint + npm run test on the deploy clone.',
  'pipeline-package-dev':
    consoleText('Builds w3buildcost-vX.Y.Z.tar.gz into /opt/w3buildcost-update-packages/. Refused on dirty tree, version/branch mismatch, or pre-existing tarball.'),
  'pipeline-verify-dev-pkg':
    'Read-only tarball inspection: filename version, VERSION marker, content sanity. Cannot modify state.',
  'pipeline-deploy-dev':
    'Hands the staged tarball off to the live deploy script via the safe-pipeline path. Stdin is closed to the delegate.',
  'pipeline-create-tag':
    'git tag -a vX.Y.Z -m <message> + git push origin vX.Y.Z. Refused on dirty tree or pre-existing local/remote tag.',
  'pipeline-delete-tag':
    'git tag -d vX.Y.Z + git push --delete origin vX.Y.Z. Requires the literal DELETE-TAG input on top of the typed phrase.',
  'pipeline-rollback':
    consoleText('Rolls the deploy clone back to the last known-good pipeline state. Never touches /opt/w3buildcost runtime.'),
  'pipeline-reset-tree':
    consoleText('git reset --hard + git clean -fdx on /opt/w3buildcost-deploy. node_modules and dist are preserved.')
};

// ---------------------------------------------------------------------------
// v0.5.30 - dev branch sorting helpers.
//
// The /git/branches-dev endpoint returns the branches in whatever order git
// reports them. The UI wants newest-first by semver so the picker always
// surfaces the active dev cycle at the top. We do this client-side because
// the backend list is small and changing the API contract is out of scope.
// ---------------------------------------------------------------------------

function parseDevBranchVersion(name: string): [number, number, number] | null {
  const m = /^dev\/v(\d+)\.(\d+)\.(\d+)$/.exec(name);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compareDevBranchesDesc(a: { name: string }, b: { name: string }): number {
  const va = parseDevBranchVersion(a.name);
  const vb = parseDevBranchVersion(b.name);
  if (!va && !vb) return a.name.localeCompare(b.name);
  if (!va) return 1;
  if (!vb) return -1;
  for (let i = 0; i < 3; i += 1) {
    if (va[i] !== vb[i]) return vb[i] - va[i];
  }
  return 0;
}

const DEFAULT_VISIBLE_BRANCHES = 3;

// ---------------------------------------------------------------------------
// v0.5.30 - run status -> Badge tone.
//
// Maps the RunStatus values returned by the safe-pipeline backend to the
// canonical Badge tone in the dashboard visual system, so operators see
// consistent success/warning/failure colours across the console.
// ---------------------------------------------------------------------------

function runBadgeTone(s: RunStatus | undefined, busy: boolean): BadgeTone {
  if (busy) return 'info';
  if (!s) return 'slate';
  if (s === 'success') return 'success';
  if (s === 'failed') return 'danger';
  if (s === 'already_running') return 'warning';
  // blocked / disabled / refused / needs_* / no_package_found
  return 'warning';
}

function runBadgeLabel(s: RunStatus | undefined, busy: boolean): string {
  if (busy) return 'Running';
  if (!s) return 'Idle';
  if (s === 'success') return 'Success';
  if (s === 'failed') return 'Failed';
  if (s === 'already_running') return 'Locked';
  // Title-case underscore-separated status names.
  return s
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// v0.5.30 - log output color-coding (UI-only).
//
// The pipeline shell helpers emit structured prefix tokens like [REFUSE],
// [OK], [FAIL], [INFO], [WARN] that the operator currently has to spot in a
// wall of monospace text. We highlight those tokens inline. We do NOT change
// what the backend emits, so changing this regex never affects downstream
// log parsers.
// ---------------------------------------------------------------------------

const LOG_MARKER_RE = /\[(REFUSE|REFUSED|OK|PASS|FAIL|FAILED|ERROR|INFO|WARN|WARNING)\]/g;

function markerColor(token: string): string {
  const t = token.toUpperCase();
  if (t === 'OK' || t === 'PASS') return 'var(--status-success, #4ade80)';
  if (t === 'FAIL' || t === 'FAILED' || t === 'ERROR') return 'var(--status-danger, #f87171)';
  if (t === 'REFUSE' || t === 'REFUSED' || t === 'WARN' || t === 'WARNING')
    return 'var(--status-warning, #fbbf24)';
  return 'var(--status-info, #60a5fa)';
}

function renderHighlightedLog(text: string): ReactNode[] {
  // Split on markers and re-stitch with coloured <span> for each.
  const out: ReactNode[] = [];
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  LOG_MARKER_RE.lastIndex = 0;
  while ((m = LOG_MARKER_RE.exec(text)) !== null) {
    if (m.index > lastIdx) out.push(text.slice(lastIdx, m.index));
    const token = m[1];
    out.push(
      <span
        key={`m-${i}`}
        style={{
          color: markerColor(token),
          fontWeight: 600
        }}
      >
        [{token}]
      </span>
    );
    lastIdx = m.index + m[0].length;
    i += 1;
  }
  if (lastIdx < text.length) out.push(text.slice(lastIdx));
  return out;
}

// ---------------------------------------------------------------------------
// Visual helpers
// ---------------------------------------------------------------------------

function riskTone(level: RiskLevel): {
  label: string;
  bg: string;
  border: string;
  fg: string;
} {
  switch (level) {
    case 'LOW':
      return {
        label: 'LOW',
        bg: 'rgba(34,197,94,0.10)',
        border: 'rgba(34,197,94,0.45)',
        fg: 'var(--status-success, #4ade80)'
      };
    case 'MEDIUM':
      return {
        label: 'MEDIUM',
        bg: 'rgba(245,158,11,0.10)',
        border: 'rgba(245,158,11,0.45)',
        fg: 'var(--status-warning, #fbbf24)'
      };
    case 'HIGH':
      return {
        label: 'HIGH',
        bg: 'rgba(239,68,68,0.12)',
        border: 'rgba(239,68,68,0.45)',
        fg: 'var(--status-danger, #f87171)'
      };
    case 'CRITICAL':
    default:
      return {
        label: 'CRITICAL',
        bg: 'rgba(239,68,68,0.18)',
        border: 'rgba(239,68,68,0.6)',
        fg: 'var(--status-danger, #f87171)'
      };
  }
}

function statusIcon(s: RunStatus | undefined, busy: boolean) {
  if (busy) return <Loader2 size={13} className="animate-spin" />;
  if (!s) return <CircleDashed size={13} />;
  if (s === 'success') return <CheckCircle2 size={13} />;
  if (s === 'failed') return <XCircle size={13} />;
  if (s === 'already_running') return <AlertTriangle size={13} />;
  return <XCircle size={13} />;
}

function statusTone(s: RunStatus | undefined): {
  bg: string;
  border: string;
  fg: string;
  label: string;
} {
  if (!s) {
    return {
      bg: 'rgba(148,163,184,0.10)',
      border: 'var(--w3-border-section, rgba(148,163,184,0.30))',
      fg: 'var(--w3-text-muted)',
      label: 'Idle'
    };
  }
  if (s === 'success') {
    return {
      bg: 'rgba(34,197,94,0.10)',
      border: 'rgba(34,197,94,0.45)',
      fg: 'var(--status-success, #4ade80)',
      label: 'Success'
    };
  }
  if (s === 'failed') {
    return {
      bg: 'rgba(239,68,68,0.12)',
      border: 'rgba(239,68,68,0.45)',
      fg: 'var(--status-danger, #f87171)',
      label: 'Failed'
    };
  }
  if (s === 'already_running') {
    return {
      bg: 'rgba(245,158,11,0.10)',
      border: 'rgba(245,158,11,0.45)',
      fg: 'var(--status-warning, #fbbf24)',
      label: 'Locked'
    };
  }
  // blocked / disabled / needs_* / no_package_found
  return {
    bg: 'rgba(245,158,11,0.10)',
    border: 'rgba(245,158,11,0.45)',
    fg: 'var(--status-warning, #fbbf24)',
    label: s.replace(/_/g, ' ')
  };
}

function errorMessage(err: unknown): string {
  if (err instanceof AdminApiError) return `${err.code}: ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}

// ---------------------------------------------------------------------------
// Run-state map (per controlId)
// ---------------------------------------------------------------------------

interface RunCell {
  loading: boolean;
  response?: RunResponse;
  error?: string;
}

type RunMap = Record<string, RunCell | undefined>;

function statusOf(map: RunMap, id: PipelineControlId): RunStatus | undefined {
  return map[id]?.response?.runStatus;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function ReleasePipelinePanel() {
  const qc = useQueryClient();

  // Shared inputs (branch + tag + package + message) live at the panel level
  // so all stages see the same values. Individual actions also read these.
  const [branch, setBranch] = useState<string>('');
  const [tag, setTag] = useState<string>('');
  const [packageBasename, setPackageBasename] = useState<string>('');
  const [tagMessage, setTagMessage] = useState<string>('');
  const [confirmDeleteTag, setConfirmDeleteTag] = useState<string>('');

  // Per-action confirmation state (typed phrase + checkbox) keyed by controlId.
  const [phraseState, setPhraseState] = useState<Record<string, string>>({});
  const [checkboxState, setCheckboxState] = useState<Record<string, boolean>>({});

  // Per-action run state (loading / response / error) keyed by controlId.
  const [runMap, setRunMap] = useState<RunMap>({});

  // UI: force-enable gating override + collapsed stages.
  const [forceEnable, setForceEnable] = useState<boolean>(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  // v0.5.30: hide older dev branches by default. The latest few semver-sorted
  // dev branches are always visible; the rest appear only after the operator
  // toggles "Show older branches". This keeps the branch picker focused on
  // the active dev cycle.
  const [showOlderBranches, setShowOlderBranches] = useState<boolean>(false);

  // v0.5.31: shared context publication. The panel keeps its own internal
  // state (so it still works standalone) but mirrors a subset to the
  // PipelineSharedStateContext so the new PipelineStateSummary /
  // PipelineReadinessChecklist components reflect the operator's choices.
  const shared = usePipelineSharedState();
  useEffect(() => {
    shared.setBranch(branch);
  }, [branch]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    shared.setPackageBasename(packageBasename);
  }, [packageBasename]); // eslint-disable-line react-hooks/exhaustive-deps

  // v0.5.38: when the operator picks a dev branch, auto-populate Target
  // Version Tag with the matching vX.Y.Z if the field is still blank or
  // matches a previously-derived value. Operator can override by typing.
  useEffect(() => {
    const m = branch.match(/^dev\/v(\d+\.\d+\.\d+)$/);
    if (!m) return;
    const derived = `v${m[1]}`;
    setTag((current) => {
      if (current === '' || /^v\d+\.\d+\.\d+$/.test(current)) {
        return derived;
      }
      return current;
    });
  }, [branch]);

  // ---- Data fetches ----------------------------------------------------------

  const branchesQ = useQuery({
    queryKey: ['admin', 'git', 'branches-dev'],
    queryFn: () => adminGet<BranchesResponse>('/git/branches-dev')
  });

  // v0.5.32: dedicated dev staged listing. Reads /opt/w3buildcost-update-packages/dev/
  // (not the production /opt/w3buildcost-update-packages root) so the pipeline picker
  // sees the artefacts that Package Dev Release actually creates. The
  // backend reports the effective root in `root` so the UI can display the
  // host-resolved path even when W3_DEV_UPDATE_DIR is overridden.
  const packagesQ = useQuery({
    queryKey: ['admin', 'packages', 'pipeline-dev'],
    queryFn: () => adminGet<PackagesResponseShape>('/packages/staged-dev')
  });

  const devPackagesRoot = packagesQ.data?.root ?? consoleText('/opt/w3buildcost-update-packages/dev');

  const stagedPackages = useMemo<StagedPackage[]>(() => {
    const data = packagesQ.data;
    if (!data) return [];
    const list = data.staged ?? data.packages ?? [];
    return list.filter(
      (p) => typeof p.name === 'string' && new RegExp(consolePattern("^w3buildcost-v\\d+\\.\\d+\\.\\d+\\.tar\\.gz$"), "").test(p.name)
    );
  }, [packagesQ.data]);

  // v0.5.30: dev branches sorted newest-first + visibility window.
  const sortedBranches = useMemo<DevBranch[]>(() => {
    const list = branchesQ.data?.branches ?? [];
    return [...list].sort(compareDevBranchesDesc);
  }, [branchesQ.data]);

  const visibleBranches = useMemo<DevBranch[]>(() => {
    if (showOlderBranches) return sortedBranches;
    return sortedBranches.slice(0, DEFAULT_VISIBLE_BRANCHES);
  }, [sortedBranches, showOlderBranches]);

  const hiddenBranchCount = Math.max(
    0,
    sortedBranches.length - visibleBranches.length
  );

  // v0.5.30: <DarkSelect> options.
  const branchOptions = useMemo<DarkSelectOption[]>(() => {
    const opts: DarkSelectOption[] = visibleBranches.map((b) => ({
      value: b.name,
      label: b.name,
      hint: b.sha.slice(0, 7)
    }));
    return opts;
  }, [visibleBranches]);

  const packageOptions = useMemo<DarkSelectOption[]>(
    () =>
      stagedPackages.map((p) => ({
        value: p.name,
        label: p.name,
        hint: p.parsedVersion ?? undefined
      })),
    [stagedPackages]
  );

  // ---- Status map (advisory gating only) -------------------------------------

  const statusMap = useMemo<Record<string, RunStatus | undefined>>(() => {
    const out: Record<string, RunStatus | undefined> = {};
    for (const k of Object.keys(runMap)) {
      out[k] = runMap[k]?.response?.runStatus;
    }
    return out;
  }, [runMap]);

  const gates = useMemo(() => {
    const passed: boolean[] = [];
    for (let i = 0; i < STAGES.length; i += 1) {
      passed.push(STAGES[i].gate(statusMap));
    }
    return passed;
  }, [statusMap]);

  // v0.5.31: publish per-stage success bitmap to the shared context so the
  // readiness checklist can light up rows without subscribing to runMap.
  useEffect(() => {
    const next: Record<string, boolean> = {};
    for (let i = 0; i < STAGES.length; i += 1) {
      next[STAGES[i].key] = gates[i] === true;
    }
    shared.setStageSuccess(next);
  }, [gates]); // eslint-disable-line react-hooks/exhaustive-deps

  // v0.5.31: track the most recent successful + most recent failed/refused
  // action ids for the "Current Pipeline State" summary card.
  useEffect(() => {
    let lastSuccess: string | null = null;
    let lastFailure: string | null = null;
    // runMap insertion order tracks call order in our usage — the latest
    // mutation always writes the corresponding key. We iterate and overwrite
    // so later entries naturally win.
    for (const [id, cell] of Object.entries(runMap)) {
      const s = cell?.response?.runStatus;
      if (s === 'success') lastSuccess = id;
      // RunStatus never reports 'refused' / 'error' — 'failed' is the only
      // terminal failure state the backend surfaces via runStatus.
      else if (s === 'failed') lastFailure = id;
    }
    shared.setLastSuccessId(lastSuccess);
    shared.setLastFailureId(lastFailure);
  }, [runMap]); // eslint-disable-line react-hooks/exhaustive-deps

  function stageEnabled(idx: number): boolean {
    if (idx === 0) return true;
    if (forceEnable) return true;
    // Each later stage requires all prior stages' gates to have passed.
    for (let i = 0; i < idx; i += 1) {
      if (!gates[i]) return false;
    }
    return true;
  }

  // ---- Run mutation ----------------------------------------------------------

  const runMutation = useMutation({
    mutationFn: async (vars: {
      id: PipelineControlId;
      inputs: Record<string, unknown>;
      confirmations: Record<string, unknown>;
    }) => {
      return adminPost<RunResponse>(`/controls/${vars.id}/run`, {
        inputs: vars.inputs,
        confirmations: vars.confirmations
      });
    }
  });

  async function executeAction(id: PipelineControlId) {
    const meta = ACTION_META[id];
    setRunMap((m) => ({ ...m, [id]: { loading: true } }));
    // Build inputs strictly from the per-action needs map.
    const inputs: Record<string, unknown> = {};
    if (meta.needs.branch) inputs['branch'] = branch.trim();
    if (meta.needs.tag) inputs['tag'] = tag.trim();
    if (meta.needs.packageBasename) inputs['packageName'] = packageBasename.trim();
    if (meta.needs.message && tagMessage.trim()) inputs['message'] = tagMessage.trim();
    if (meta.needs.confirmDeleteTag) inputs['confirmDeleteTag'] = confirmDeleteTag.trim();
    // Confirmations.
    const confirmations: Record<string, unknown> = {};
    if (meta.confirmPhrase) {
      confirmations[meta.confirmPhrase.key] = phraseState[id] ?? '';
    }
    if (meta.confirmCheckbox) {
      confirmations[meta.confirmCheckbox.key] = checkboxState[id] === true;
    }
    try {
      const res = await runMutation.mutateAsync({ id, inputs, confirmations });
      setRunMap((m) => ({ ...m, [id]: { loading: false, response: res } }));
      // After a successful pull/checkout, refresh the dev-branches list.
      if (
        res.runStatus === 'success' &&
        (id === 'pipeline-checkout-dev' ||
          id === 'pipeline-pull-latest' ||
          id === 'pipeline-push-dev')
      ) {
        qc.invalidateQueries({ queryKey: ['admin', 'git', 'branches-dev'] });
      }
      // v0.5.32: refresh the dev-staged dropdown after a successful package
      // build so the just-created /opt/w3buildcost-update-packages/dev/w3buildcost-vX.Y.Z.tar.gz
      // appears in the picker without a manual refresh.
      if (res.runStatus === 'success' && id === 'pipeline-package-dev') {
        qc.invalidateQueries({ queryKey: ['admin', 'packages', 'pipeline-dev'] });
      }
    } catch (err) {
      setRunMap((m) => ({
        ...m,
        [id]: { loading: false, error: errorMessage(err) }
      }));
    }
  }

  // Confirmations satisfied for a given action id (UI gate; backend re-checks).
  function confirmationsSatisfied(id: PipelineControlId): boolean {
    const meta = ACTION_META[id];
    if (meta.confirmPhrase) {
      if ((phraseState[id] ?? '') !== meta.confirmPhrase.expected) return false;
    }
    if (meta.confirmCheckbox) {
      if (checkboxState[id] !== true) return false;
    }
    return true;
  }

  // Inputs satisfied for a given action id (UI gate; backend re-checks).
  function inputsSatisfied(id: PipelineControlId): boolean {
    const meta = ACTION_META[id];
    if (meta.needs.branch && !/^dev\/v\d+\.\d+\.\d+$/.test(branch.trim())) return false;
    if (meta.needs.tag && !/^v\d+\.\d+\.\d+$/.test(tag.trim())) return false;
    if (
      meta.needs.packageBasename &&
      !new RegExp(consolePattern("^w3buildcost-v\\d+\\.\\d+\\.\\d+\\.tar\\.gz$"), "").test(packageBasename.trim())
    )
      return false;
    if (meta.needs.confirmDeleteTag && confirmDeleteTag.trim() !== 'DELETE-TAG')
      return false;
    return true;
  }

  // ---- Render ----------------------------------------------------------------

  return (
    <div
      className="mt-4 rounded-md border p-3"
      style={{ borderColor: 'var(--w3-border)', background: 'var(--w3-card)' }}
    >
      {/* Header */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium text-[var(--w3-text)]">
          <Rocket size={14} />
          Release Pipeline
          <span className="rounded border px-1.5 py-0.5 font-mono text-[10px] text-[var(--w3-text-muted)]"
                style={{ borderColor: 'var(--w3-border-section)' }}>
            v0.5.38 · safe-pipeline
          </span>
        </div>
        {/* v0.5.38: Force-enable is now opt-in via the page-level
            Advanced/Danger Zone accordion. Render only when already
            enabled so the operator can still see/toggle it off here. */}
        {forceEnable ? (
          <label
            className="flex items-center gap-1.5 rounded border px-1.5 py-0.5 text-[11px]"
            style={{ borderColor: 'var(--status-danger)', color: 'var(--status-danger)' }}
          >
            <input
              type="checkbox"
              checked={forceEnable}
              onChange={(e) => setForceEnable(e.target.checked)}
            />
            Force-enable later stages (override UI gating)
          </label>
        ) : null}
      </div>

      {/* Shared inputs */}
      <div className="mb-3 grid grid-cols-1 gap-3 md:grid-cols-2">
        {/* Dev branch picker */}
        <div>
          <label className="stat-label" htmlFor="pipeline-branch">
            Dev Branch (dev/vX.Y.Z)
          </label>
          <div className="mt-1 flex gap-1.5">
            <div className="min-w-0 flex-1">
              <DarkSelect
                id="pipeline-branch"
                ariaLabel="Dev branch selector"
                value={branch}
                onChange={setBranch}
                options={branchOptions}
                placeholder={
                  branchesQ.isLoading
                    ? 'Loading dev branches…'
                    : sortedBranches.length === 0
                      ? 'No dev branches available'
                      : '— Select dev branch —'
                }
                disabled={branchesQ.isLoading || sortedBranches.length === 0}
                emptyMessage="No dev/vX.Y.Z branches on origin yet."
              />
            </div>
            <button
              type="button"
              className="btn"
              title="Refresh dev branches"
              onClick={() => qc.invalidateQueries({ queryKey: ['admin', 'git', 'branches-dev'] })}
            >
              <RefreshCw size={11} />
            </button>
          </div>
          {/* v0.5.30: Show older branches toggle. Only rendered when there
              are more dev branches than the visible window. */}
          {sortedBranches.length > DEFAULT_VISIBLE_BRANCHES ? (
            <div className="mt-1 flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setShowOlderBranches((v) => !v)}
                className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10.5px] text-[var(--w3-text-muted)] transition-colors hover:text-[var(--w3-text)]"
                style={{ borderColor: 'var(--w3-border-section)' }}
              >
                {showOlderBranches ? <EyeOff size={10} /> : <Eye size={10} />}
                {showOlderBranches
                  ? `Hide older branches (showing all ${sortedBranches.length})`
                  : `Show older branches (+${hiddenBranchCount} hidden)`}
              </button>
              <span className="text-[10px] text-[var(--w3-text-dim)]">
                Latest {Math.min(DEFAULT_VISIBLE_BRANCHES, sortedBranches.length)} shown by default
              </span>
            </div>
          ) : null}
          {branchesQ.data && branchesQ.data.count === 0 ? (
            <div className="mt-1 text-[10.5px] text-[var(--w3-text-muted)]">
              {branchesQ.data.message}
            </div>
          ) : null}
          {branchesQ.error ? (
            <div className="mt-1 text-[10.5px]" style={{ color: 'var(--status-danger)' }}>
              {errorMessage(branchesQ.error)}
            </div>
          ) : null}
        </div>

        {/* Target version tag */}
        <div>
          <label className="stat-label" htmlFor="pipeline-tag">
            Target Version Tag (vX.Y.Z)
          </label>
          <input
            id="pipeline-tag"
            type="text"
            inputMode="text"
            spellCheck={false}
            className="mt-1 w-full rounded-md border bg-transparent px-2 py-1.5 font-mono text-xs text-[var(--w3-text)]"
            style={{ borderColor: 'var(--w3-border)' }}
            placeholder={(() => {
              const m = branch.match(/^dev\/v(\d+\.\d+\.\d+)$/);
              return m ? `v${m[1]}` : 'vX.Y.Z';
            })()}
            value={tag}
            onChange={(e) => setTag(e.target.value)}
          />
        </div>

        {/* Staged dev package picker (v0.5.32) */}
        <div>
          <label className="stat-label" htmlFor="pipeline-package">
            Staged Dev Package ({devPackagesRoot})
          </label>
          <div className="mt-1 flex gap-1.5">
            <div className="min-w-0 flex-1">
              <DarkSelect
                id="pipeline-package"
                ariaLabel="Staged dev package selector"
                value={packageBasename}
                onChange={setPackageBasename}
                options={packageOptions}
                placeholder={
                  packagesQ.isLoading
                    ? 'Loading staged dev packages…'
                    : stagedPackages.length === 0
                      ? `No staged dev packages in ${devPackagesRoot}`
                      : '— Select staged dev package —'
                }
                disabled={packagesQ.isLoading || stagedPackages.length === 0}
                emptyMessage={`${consoleText('No w3buildcost-vX.Y.Z.tar.gz in')} ${devPackagesRoot} yet.`}
              />
            </div>
            <button
              type="button"
              className="btn"
              title="Refresh staged dev packages"
              onClick={() => qc.invalidateQueries({ queryKey: ['admin', 'packages', 'pipeline-dev'] })}
            >
              <RefreshCw size={11} />
            </button>
          </div>
          {packagesQ.data && stagedPackages.length === 0 ? (
            <div className="mt-1 text-[10.5px] text-[var(--w3-text-muted)]">
              No staged dev release packages found in <code className="font-mono">{devPackagesRoot}</code>.
              Run Package Dev Release to produce one. Production {consoleText("/opt/w3buildcost-update-packages/")} is
              intentionally not shown here.
            </div>
          ) : null}
        </div>

        {/* Optional tag message */}
        <div>
          <label className="stat-label" htmlFor="pipeline-tag-message">
            Tag Message (optional, used by Create Tag)
          </label>
          <input
            id="pipeline-tag-message"
            type="text"
            spellCheck={false}
            maxLength={256}
            className="mt-1 w-full rounded-md border bg-transparent px-2 py-1.5 text-xs text-[var(--w3-text)]"
            style={{ borderColor: 'var(--w3-border)' }}
            placeholder="Release vX.Y.Z"
            value={tagMessage}
            onChange={(e) => setTagMessage(e.target.value)}
          />
        </div>
      </div>

      {/* Stages */}
      <div className="space-y-3">
        {STAGES.map((stage, idx) => {
          const enabled = stageEnabled(idx);
          const isCollapsed = collapsed[stage.key] === true;
          return (
            <div
              key={stage.key}
              className="rounded-md border"
              style={{
                borderColor: enabled
                  ? 'var(--w3-border-section, var(--w3-border))'
                  : 'var(--w3-border)',
                background: 'rgba(15,23,42,0.35)',
                opacity: enabled ? 1 : 0.6
              }}
            >
              <button
                type="button"
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left"
                onClick={() => setCollapsed((c) => ({ ...c, [stage.key]: !c[stage.key] }))}
              >
                <div className="flex items-center gap-2">
                  {enabled ? null : <Lock size={12} className="opacity-70" />}
                  <span className="text-sm font-medium text-[var(--w3-text)]">
                    {stage.title}
                  </span>
                  {gates[idx] ? (
                    <span
                      className="rounded border px-1.5 py-0.5 text-[10px]"
                      style={{
                        background: 'rgba(34,197,94,0.10)',
                        borderColor: 'rgba(34,197,94,0.45)',
                        color: 'var(--status-success, #4ade80)'
                      }}
                    >
                      Passed
                    </span>
                  ) : null}
                </div>
                {isCollapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
              </button>
              {!isCollapsed ? (
                <div className="border-t px-3 py-3"
                     style={{ borderColor: 'var(--w3-border-section)' }}>
                  <p className="mb-1 text-xs text-[var(--w3-text)]">{stage.blurb}</p>
                  {/* v0.5.30 - clearer stage description */}
                  {STAGE_DETAIL[stage.key] ? (
                    <p className="mb-3 flex items-start gap-1.5 text-[10.5px] text-[var(--w3-text-muted)]">
                      <Info size={10} className="mt-[2px] flex-shrink-0" />
                      <span>{STAGE_DETAIL[stage.key]}</span>
                    </p>
                  ) : null}
                  {/* v0.5.30 - HIGH-risk grouping in stage 7 only. Stage 4 and 6
                      already have a single HIGH-risk action and are visually
                      marked by the per-action red border. */}
                  {stage.key === 'tag' ? (
                    <Stage7Grouped
                      stage={stage}
                      enabled={enabled}
                      runMap={runMap}
                      branch={branch}
                      tag={tag}
                      packageBasename={packageBasename}
                      stagePrereqReasons={stagePrereqMissing(stage.key, statusMap)}
                      phraseState={phraseState}
                      checkboxState={checkboxState}
                      confirmDeleteTag={confirmDeleteTag}
                      onPhraseChange={(id, v) =>
                        setPhraseState((s) => ({ ...s, [id]: v }))
                      }
                      onCheckboxChange={(id, v) =>
                        setCheckboxState((s) => ({ ...s, [id]: v }))
                      }
                      onConfirmDeleteTagChange={setConfirmDeleteTag}
                      inputsSatisfied={inputsSatisfied}
                      confirmationsSatisfied={confirmationsSatisfied}
                      executeAction={executeAction}
                    />
                  ) : (
                  <div className="space-y-3">
                    {stage.actions.map((id) => (
                      <ActionRow
                        key={id}
                        id={id}
                        enabled={enabled}
                        cell={runMap[id]}
                        confirmationsOk={confirmationsSatisfied(id)}
                        inputsOk={inputsSatisfied(id)}
                        phraseValue={phraseState[id] ?? ''}
                        checkboxValue={checkboxState[id] === true}
                        onPhraseChange={(v) =>
                          setPhraseState((s) => ({ ...s, [id]: v }))
                        }
                        onCheckboxChange={(v) =>
                          setCheckboxState((s) => ({ ...s, [id]: v }))
                        }
                        confirmDeleteTagValue={confirmDeleteTag}
                        onConfirmDeleteTagChange={setConfirmDeleteTag}
                        branch={branch}
                        tag={tag}
                        packageBasename={packageBasename}
                        onRun={() => executeAction(id)}
                        stagePrereqReasons={stagePrereqMissing(stage.key, statusMap)}
                      />
                    ))}
                  </div>
                  )}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {/* Live output panel */}
      <LiveOutputPanel runMap={runMap} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-action row
// ---------------------------------------------------------------------------

function ActionRow({
  id,
  enabled,
  cell,
  confirmationsOk,
  inputsOk,
  phraseValue,
  checkboxValue,
  onPhraseChange,
  onCheckboxChange,
  confirmDeleteTagValue,
  onConfirmDeleteTagChange,
  branch,
  tag,
  packageBasename,
  onRun,
  stagePrereqReasons
}: {
  id: PipelineControlId;
  enabled: boolean;
  cell: RunCell | undefined;
  confirmationsOk: boolean;
  inputsOk: boolean;
  phraseValue: string;
  checkboxValue: boolean;
  onPhraseChange: (v: string) => void;
  onCheckboxChange: (v: boolean) => void;
  confirmDeleteTagValue: string;
  onConfirmDeleteTagChange: (v: string) => void;
  branch: string;
  tag: string;
  packageBasename: string;
  onRun: () => void;
  // v0.5.31: explicit stage-chain prereqs (e.g. "Test must succeed first").
  // Empty list means this action's stage prereqs are satisfied (or the stage
  // is a recovery surface and the message is advisory). Hard-disabled rows
  // are still controlled by `enabled` above.
  stagePrereqReasons?: string[];
}) {
  const meta = ACTION_META[id];
  const tone = riskTone(meta.risk);
  const status = cell?.response?.runStatus;
  const sTone = statusTone(status);
  const busy = cell?.loading === true;
  const showHighGuards = meta.risk === 'HIGH' || meta.risk === 'CRITICAL';

  // Per-action input echo (what will actually be sent).
  const echo: string[] = [];
  if (meta.needs.branch) echo.push(`branch="${branch || '—'}"`);
  if (meta.needs.tag) echo.push(`tag="${tag || '—'}"`);
  if (meta.needs.packageBasename) echo.push(`packageName="${packageBasename || '—'}"`);
  if (meta.needs.confirmDeleteTag)
    echo.push(`confirmDeleteTag="${confirmDeleteTagValue || '—'}"`);

  const runDisabled = !enabled || busy || !inputsOk || !confirmationsOk;

  // v0.5.30 - human-readable reason the Run button is disabled. Surfaced
  // both as a tooltip and as inline helper text so operators don't have to
  // hover to discover what's missing.
  const disabledReasons: string[] = [];
  // v0.5.31: surface explicit stage-chain prereq messages BEFORE the
  // generic "prior stage gate not satisfied" line so operators see the
  // specific missing earlier stage first.
  if (stagePrereqReasons && stagePrereqReasons.length > 0) {
    for (const r of stagePrereqReasons) disabledReasons.push(r);
  }
  if (!enabled) disabledReasons.push('Prior stage gate not yet satisfied. Toggle "Force enable next step" to override.');
  if (!inputsOk) {
    const missing: string[] = [];
    if (meta.needs.branch && !/^dev\/v\d+\.\d+\.\d+$/.test(branch.trim()))
      missing.push('valid dev/vX.Y.Z branch');
    if (meta.needs.tag && !/^v\d+\.\d+\.\d+$/.test(tag.trim()))
      missing.push('valid vX.Y.Z tag');
    if (
      meta.needs.packageBasename &&
      !new RegExp(consolePattern("^w3buildcost-v\\d+\\.\\d+\\.\\d+\\.tar\\.gz$"), "").test(packageBasename.trim())
    )
      missing.push(consoleText('staged w3buildcost-vX.Y.Z.tar.gz package'));
    if (meta.needs.confirmDeleteTag && (confirmDeleteTagValue || '').trim() !== 'DELETE-TAG')
      missing.push('literal DELETE-TAG in the delete-tag input');
    if (missing.length > 0)
      disabledReasons.push(`Required input missing: ${missing.join(', ')}.`);
  }
  if (!confirmationsOk) {
    const need: string[] = [];
    if (meta.confirmPhrase && phraseValue !== meta.confirmPhrase.expected)
      need.push(`type "${meta.confirmPhrase.expected}"`);
    if (meta.confirmCheckbox && checkboxValue !== true)
      need.push('check the acknowledgement box');
    if (need.length > 0)
      disabledReasons.push(`Confirmation required: ${need.join(' and ')}.`);
  }

  const badgeTone = runBadgeTone(status, busy);
  const badgeLabel = runBadgeLabel(status, busy);

  return (
    <div
      className="rounded-md border p-2.5"
      style={{ borderColor: 'var(--w3-border-section)' }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-[var(--w3-text)]">{meta.label}</span>
            <span
              className="rounded border px-1.5 py-0.5 text-[10px]"
              style={{ background: tone.bg, borderColor: tone.border, color: tone.fg }}
            >
              {tone.label}
            </span>
            <Badge tone={badgeTone}>
              <span className="inline-flex items-center gap-1">
                {statusIcon(status, busy)}
                {badgeLabel}
              </span>
            </Badge>
          </div>
          <div className="mt-0.5 text-[10.5px] text-[var(--w3-text-muted)]">
            {meta.description}
          </div>
          {ACTION_HOWTO[id] ? (
            <div className="mt-0.5 text-[10px] text-[var(--w3-text-dim)]">
              {ACTION_HOWTO[id]}
            </div>
          ) : null}
          <div className="mt-0.5 font-mono text-[10px] text-[var(--w3-text-muted)]">
            {id}
            {echo.length > 0 ? <> · {echo.join(' ')}</> : null}
          </div>
        </div>
        <button
          type="button"
          className="btn"
          onClick={onRun}
          disabled={runDisabled}
          aria-busy={busy ? 'true' : undefined}
          title={
            runDisabled
              ? disabledReasons.join(' ') || 'Action is not currently available.'
              : 'Run this pipeline action.'
          }
        >
          {busy ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />}
          Run
        </button>
      </div>

      {/* v0.5.30 - inline disabled-state explanation. Visible only when the
          Run button is disabled and we have a concrete reason. */}
      {runDisabled && !busy && disabledReasons.length > 0 ? (
        <div
          className="mt-2 rounded-md border p-1.5 text-[10.5px]"
          style={{
            background: 'rgba(148,163,184,0.07)',
            borderColor: 'var(--w3-border-section)',
            color: 'var(--w3-text-muted)'
          }}
        >
          <div className="flex items-start gap-1.5">
            <Info size={10} className="mt-[2px] flex-shrink-0" />
            <div className="space-y-0.5">
              {disabledReasons.map((r, i) => (
                <div key={i}>{r}</div>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      {/* HIGH-risk guards: typed phrase + checkbox + (delete-tag) input confirm */}
      {showHighGuards ? (
        <div
          className="mt-2 rounded-md border p-2"
          style={{
            background: 'rgba(239,68,68,0.05)',
            borderColor: 'rgba(239,68,68,0.30)'
          }}
        >
          <div className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wide" style={{ color: 'var(--status-danger, #f87171)' }}>
            <ShieldAlert size={11} />
            HIGH risk · explicit confirmation required
          </div>
          {meta.needs.confirmDeleteTag ? (
            <div className="mb-2">
              <label className="stat-label" htmlFor={`confirm-delete-${id}`}>
                Type DELETE-TAG to confirm tag deletion
              </label>
              <input
                id={`confirm-delete-${id}`}
                type="text"
                spellCheck={false}
                className="mt-1 w-full rounded-md border bg-transparent px-2 py-1.5 font-mono text-xs text-[var(--w3-text)]"
                style={{ borderColor: 'var(--w3-border)' }}
                value={confirmDeleteTagValue}
                onChange={(e) => onConfirmDeleteTagChange(e.target.value)}
                placeholder="DELETE-TAG"
              />
            </div>
          ) : null}
          {meta.confirmPhrase ? (
            <div className="mb-2">
              <label className="stat-label" htmlFor={`phrase-${id}`}>
                Type {meta.confirmPhrase.expected} to continue
              </label>
              <input
                id={`phrase-${id}`}
                type="text"
                spellCheck={false}
                className="mt-1 w-full rounded-md border bg-transparent px-2 py-1.5 font-mono text-xs text-[var(--w3-text)]"
                style={{ borderColor: 'var(--w3-border)' }}
                value={phraseValue}
                onChange={(e) => onPhraseChange(e.target.value)}
                placeholder={meta.confirmPhrase.expected}
              />
            </div>
          ) : null}
          {meta.confirmCheckbox ? (
            <label className="flex items-start gap-2 text-[11px] text-[var(--w3-text)]">
              <input
                type="checkbox"
                checked={checkboxValue}
                onChange={(e) => onCheckboxChange(e.target.checked)}
              />
              <span>{meta.confirmCheckbox.label}</span>
            </label>
          ) : null}
        </div>
      ) : null}

      {/* Per-action result block */}
      {cell?.error ? (
        <div
          className="mt-2 rounded-md border p-2 text-[11px]"
          style={{
            background: 'rgba(239,68,68,0.08)',
            borderColor: 'rgba(239,68,68,0.40)',
            color: 'var(--w3-text)'
          }}
        >
          <strong>Error:</strong> {cell.error}
        </div>
      ) : null}
      {cell?.response ? (
        <div
          className="mt-2 rounded-md border p-2 text-[11px]"
          style={{
            background: sTone.bg,
            borderColor: sTone.border,
            color: 'var(--w3-text)'
          }}
        >
          <div className="font-medium">
            {sTone.label}
            {typeof cell.response.exitCode === 'number'
              ? <> · exit {cell.response.exitCode}</>
              : null}
            {typeof cell.response.durationMs === 'number'
              ? <> · {Math.round(cell.response.durationMs)} ms</>
              : null}
          </div>
          {cell.response.reason ? (
            <div className="mt-1">{cell.response.reason}</div>
          ) : null}
          {cell.response.lockHeldBy ? (
            <div className="mt-1">
              Locked by{' '}
              <code className="font-mono">{cell.response.lockHeldBy.controlId}</code>{' '}
              (started {cell.response.lockHeldBy.startedAt}).
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Live output / logs panel
// ---------------------------------------------------------------------------

function LiveOutputPanel({ runMap }: { runMap: RunMap }) {
  // Surface stdout/stderr tails from the most recent completed run (if any).
  // The pipeline backend returns short tails on the /run response; we render
  // them inline here so the operator does not need to leave the page.
  const [copied, setCopied] = useState<boolean>(false);

  const latest = useMemo(() => {
    const entries = Object.entries(runMap).filter(([, v]) => v && v.response);
    if (entries.length === 0) return null;
    // Pick the one with the most recent response (durationMs presence is a
    // proxy for "actually executed"). Fallback to the last key.
    return entries[entries.length - 1] as [string, RunCell];
  }, [runMap]);

  // v0.5.31: copy the latest stdout+stderr tails (plus a small header) to
  // the operator's clipboard. Pure clipboard write, no network call.
  const handleCopy = async () => {
    if (!latest) return;
    const [id, cell] = latest;
    const r = cell.response;
    if (!r) return;
    // v0.5.32: include structured trailer fields in the copy payload so
    // operators can paste a complete record of the run (including
    // output_path / bytes / verified) into a ticket or chat.
    const structuredLines: string[] = [];
    const s = r.structured;
    if (s && typeof s === 'object') {
      structuredLines.push('-- structured --');
      for (const [k, v] of Object.entries(s)) {
        if (v === undefined || v === null) continue;
        structuredLines.push(`${k}: ${String(v)}`);
      }
      structuredLines.push('');
    }
    const lines: string[] = [
      `# ${id}`,
      `status: ${r.runStatus}`,
      typeof r.exitCode === 'number' ? `exit: ${r.exitCode}` : '',
      typeof r.durationMs === 'number' ? `duration: ${Math.round(r.durationMs)} ms` : '',
      r.logFile ? `log: ${r.logFile}` : '',
      r.reason ? `reason: ${r.reason}` : '',
      '',
      ...structuredLines,
      '-- stdout --',
      r.stdoutTail ?? '(empty)',
      '',
      '-- stderr --',
      r.stderrTail ?? '(empty)'
    ].filter((l) => l !== '');
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable — silent fallback
    }
  };

  if (!latest) {
    return (
      <div
        className="mt-3 rounded-md border p-2 text-[11px]"
        style={{
          borderColor: 'var(--w3-border-section)',
          color: 'var(--w3-text-muted)'
        }}
      >
        Live output will appear here after the first pipeline action runs.
      </div>
    );
  }

  const [id, cell] = latest;
  const r = cell.response!;
  const sTone = statusTone(r.runStatus);
  return (
    <div
      className="mt-3 rounded-md border p-2"
      style={{
        borderColor: sTone.border,
        background: 'rgba(15,23,42,0.55)'
      }}
    >
      {/* v0.5.31: sticky latest-result summary header. Stays at the top of
          the output panel even when stdout/stderr tails are long enough to
          require horizontal scroll. */}
      <div
        className="sticky top-0 z-10 mb-2 flex flex-wrap items-center justify-between gap-2 rounded-sm border-b px-1 py-1 text-[11px]"
        style={{
          background: 'rgba(15,23,42,0.92)',
          borderColor: sTone.border
        }}
      >
        <div className="flex items-center gap-2">
          <span className="font-mono text-[var(--w3-text)]">{id}</span>
          <span
            className="rounded border px-1.5 py-0.5 text-[10px]"
            style={{ background: sTone.bg, borderColor: sTone.border, color: sTone.fg }}
          >
            {sTone.label}
          </span>
        </div>
        <button
          type="button"
          className="btn"
          style={{ padding: '2px 6px', fontSize: 10 }}
          onClick={handleCopy}
          title="Copy latest log output to clipboard"
        >
          <Copy size={10} />
          {copied ? 'Copied' : 'Copy log'}
        </button>
      </div>
      {/* v0.5.31: structured result display. Each field is rendered as a
          labeled row so operators see exit/duration/logFile at a glance
          without parsing free-form text. */}
      <div
        className="mb-2 grid grid-cols-2 gap-x-3 gap-y-1 rounded-sm border p-1.5 text-[10.5px] md:grid-cols-4"
        style={{ borderColor: 'var(--w3-border-section)' }}
      >
        <div>
          <div className="uppercase tracking-wide" style={{ color: 'var(--w3-text-muted)' }}>
            status
          </div>
          <div className="font-mono" style={{ color: 'var(--w3-text)' }}>
            {r.runStatus}
          </div>
        </div>
        <div>
          <div className="uppercase tracking-wide" style={{ color: 'var(--w3-text-muted)' }}>
            exit code
          </div>
          <div className="font-mono" style={{ color: 'var(--w3-text)' }}>
            {typeof r.exitCode === 'number' ? String(r.exitCode) : '—'}
          </div>
        </div>
        <div>
          <div className="uppercase tracking-wide" style={{ color: 'var(--w3-text-muted)' }}>
            duration
          </div>
          <div className="font-mono" style={{ color: 'var(--w3-text)' }}>
            {typeof r.durationMs === 'number' ? `${Math.round(r.durationMs)} ms` : '—'}
          </div>
        </div>
        <div>
          <div className="uppercase tracking-wide" style={{ color: 'var(--w3-text-muted)' }}>
            accepted
          </div>
          <div className="font-mono" style={{ color: 'var(--w3-text)' }}>
            {r.accepted ? 'yes' : 'no'}
          </div>
        </div>
      </div>
      {/* v0.5.32: structured trailer key/value display. The wrapper's
          ===STRUCTURED-RESULT=== block is parsed server-side and exposed as
          r.structured. We render it as a labeled table so the operator can
          see output_path / bytes / verified / version inline without
          searching the stdout pre block. */}
      {r.structured && Object.keys(r.structured).length > 0 ? (
        <div
          className="mb-2 rounded-sm border p-1.5 text-[10.5px]"
          style={{
            borderColor: 'var(--w3-border-section)',
            background: 'rgba(15,23,42,0.45)',
            color: 'var(--w3-text)'
          }}
        >
          <div
            className="mb-1 text-[10px] uppercase tracking-wide"
            style={{ color: 'var(--w3-text-muted)' }}
          >
            structured result
          </div>
          <div className="grid grid-cols-1 gap-x-3 gap-y-0.5 font-mono md:grid-cols-2">
            {Object.entries(r.structured)
              .filter(([, v]) => v !== undefined && v !== null && v !== '')
              .map(([k, v]) => (
                <div key={k} className="flex gap-2">
                  <span style={{ color: 'var(--w3-text-muted)' }}>{k}:</span>
                  <span className="break-all">{String(v)}</span>
                </div>
              ))}
          </div>
        </div>
      ) : null}
      {/* v0.5.32: explicit Package + Deploy defence-in-depth warning. If the
          server somehow surfaces runStatus === 'success' for an artifact-
          producing pipeline control without the expected artifact path AND
          the artifact path being under the right root, render an obvious
          inline warning so the operator does not act on a phantom success.
          The backend already downgrades these cases to failed; this is
          belt-and-braces. */}
      {id === 'pipeline-package-dev' &&
      r.runStatus === 'success' &&
      !(
        r.structured &&
        typeof r.structured.output_path === 'string' &&
        r.structured.output_path.startsWith(consoleText('/opt/w3buildcost-update-packages/dev/')) &&
        // v0.5.38 canonical: /opt/w3buildcost-update-packages/dev/<vX.Y.Z>/w3buildcost.tar.gz
        // Legacy:           /opt/w3buildcost-update-packages/dev/w3buildcost-vX.Y.Z.tar.gz
        new RegExp(consolePattern("\\/w3buildcost(?:-v\\d+\\.\\d+\\.\\d+)?\\.tar\\.gz$"), "").test(r.structured.output_path)
      ) ? (
        <div
          className="mb-2 rounded-sm border p-1.5 text-[10.5px] font-mono"
          style={{
            borderColor: 'var(--status-danger)',
            background: 'rgba(127,29,29,0.25)',
            color: 'var(--status-danger)'
          }}
        >
          Warning: success was reported but no canonical output_path under
          {consoleText("/opt/w3buildcost-update-packages/dev/")} was returned. Treat as failed and re-run.
        </div>
      ) : null}
      {id === 'pipeline-deploy-dev' &&
      r.runStatus === 'success' &&
      !(
        r.structured &&
        // v0.5.38 success contract: deploy emits resolved_package_path under
        //   /opt/w3buildcost-update-packages/installed/<vX.Y.Z>/w3buildcost.tar.gz
        // and an installed_metadata_dir sidecar directory at the same path.
        // Either resolved_package_path OR (legacy) staged_path under
        // /opt/w3buildcost-update-packages/ (outside /dev/) is accepted, since older
        // wrappers may still emit staged_path during transition.
        ((typeof r.structured.resolved_package_path === 'string' &&
          r.structured.resolved_package_path.startsWith(
            consoleText('/opt/w3buildcost-update-packages/installed/')
          ) &&
          new RegExp(consolePattern("\\/w3buildcost(?:-v\\d+\\.\\d+\\.\\d+)?\\.tar\\.gz$"), "").test(
            r.structured.resolved_package_path
          )) ||
          (typeof r.structured.staged_path === 'string' &&
            r.structured.staged_path.startsWith(consoleText('/opt/w3buildcost-update-packages/')) &&
            !r.structured.staged_path.startsWith(consoleText('/opt/w3buildcost-update-packages/dev/')) &&
            new RegExp(consolePattern("\\/w3buildcost(?:-v\\d+\\.\\d+\\.\\d+)?\\.tar\\.gz$"), "").test(
              r.structured.staged_path
            )))
      ) ? (
        <div
          className="mb-2 rounded-sm border p-1.5 text-[10.5px] font-mono"
          style={{
            borderColor: 'var(--status-danger)',
            background: 'rgba(127,29,29,0.25)',
            color: 'var(--status-danger)'
          }}
        >
          Warning: success was reported but no canonical resolved_package_path
          under {consoleText("/opt/w3buildcost-update-packages/installed/")} (and no legacy promoted
          staged_path) was returned. Treat as failed and re-run.
        </div>
      ) : null}
      {r.logFile ? (
        <div
          className="mb-2 flex items-center gap-2 rounded-sm border p-1.5 text-[10.5px] font-mono"
          style={{
            borderColor: 'var(--w3-border-section)',
            color: 'var(--w3-text)',
            background: 'rgba(15,23,42,0.45)'
          }}
        >
          <FileText size={11} style={{ color: 'var(--w3-text-muted)' }} />
          <span style={{ color: 'var(--w3-text-muted)' }}>log file:</span>
          <span className="break-all">{r.logFile}</span>
        </div>
      ) : null}
      {r.reason ? (
        <div
          className="mb-2 rounded-sm border p-1.5 text-[10.5px]"
          style={{
            borderColor: 'var(--w3-border-section)',
            color: 'var(--w3-text)',
            background: 'rgba(15,23,42,0.45)'
          }}
        >
          <span style={{ color: 'var(--w3-text-muted)' }}>reason:</span>{' '}
          <span className="font-mono">{r.reason}</span>
        </div>
      ) : null}
      {r.stdoutTail ? (
        <pre
          className="overflow-x-auto whitespace-pre-wrap font-mono text-[10.5px] leading-snug"
          style={{ color: 'var(--w3-text)' }}
          aria-label="stdout tail"
        >
          <span className="mb-0.5 inline-block text-[10px] uppercase tracking-wide" style={{ color: 'var(--w3-text-muted)' }}>
            stdout
          </span>
          {'\n'}
          {renderHighlightedLog(r.stdoutTail)}
        </pre>
      ) : null}
      {r.stderrTail ? (
        <pre
          className="mt-1 overflow-x-auto whitespace-pre-wrap font-mono text-[10.5px] leading-snug"
          style={{ color: 'var(--status-warning)' }}
          aria-label="stderr tail"
        >
          <span className="mb-0.5 inline-block text-[10px] uppercase tracking-wide" style={{ color: 'var(--status-warning)' }}>
            stderr
          </span>
          {'\n'}
          {renderHighlightedLog(r.stderrTail)}
        </pre>
      ) : null}
      {!r.stdoutTail && !r.stderrTail ? (
        <div className="text-[11px] text-[var(--w3-text-muted)]">
          (no output captured for this run)
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// v0.5.30 - Stage 7 "Tag & Recovery" grouped rendering.
//
// Stage 7 mixes the only MEDIUM-risk action that's irrelevant (none in fact
// - all four are HIGH-risk) ... actually all four stage-7 actions are HIGH-
// risk. We render them inside a single visually separated red-accented
// section so operators always see the HIGH-risk warning band before the
// individual rows. Each row is still rendered by <ActionRow> below, so the
// per-action typed-phrase / checkbox / Run-button gating stays identical.
// ---------------------------------------------------------------------------

interface Stage7GroupedProps {
  stage: PipelineStage;
  enabled: boolean;
  runMap: RunMap;
  branch: string;
  tag: string;
  packageBasename: string;
  phraseState: Record<string, string>;
  checkboxState: Record<string, boolean>;
  confirmDeleteTag: string;
  onPhraseChange: (id: PipelineControlId, v: string) => void;
  onCheckboxChange: (id: PipelineControlId, v: boolean) => void;
  onConfirmDeleteTagChange: (v: string) => void;
  inputsSatisfied: (id: PipelineControlId) => boolean;
  confirmationsSatisfied: (id: PipelineControlId) => boolean;
  executeAction: (id: PipelineControlId) => void;
  // v0.5.31: soft "Deploy should succeed first" recommendation surfaced via
  // the per-action disabled-state panel.
  stagePrereqReasons?: string[];
}

function Stage7Grouped({
  stage,
  enabled,
  runMap,
  branch,
  tag,
  packageBasename,
  phraseState,
  checkboxState,
  confirmDeleteTag,
  onPhraseChange,
  onCheckboxChange,
  onConfirmDeleteTagChange,
  inputsSatisfied,
  confirmationsSatisfied,
  executeAction,
  stagePrereqReasons
}: Stage7GroupedProps) {
  // Partition: HIGH-risk (visually grouped) vs other risk levels.
  const high = stage.actions.filter(
    (id) => ACTION_META[id].risk === 'HIGH' || ACTION_META[id].risk === 'CRITICAL'
  );
  const rest = stage.actions.filter(
    (id) => ACTION_META[id].risk !== 'HIGH' && ACTION_META[id].risk !== 'CRITICAL'
  );

  return (
    <Fragment>
      {rest.length > 0 ? (
        <div className="space-y-3">
          {rest.map((id) => (
            <ActionRow
              key={id}
              id={id}
              enabled={enabled}
              cell={runMap[id]}
              confirmationsOk={confirmationsSatisfied(id)}
              inputsOk={inputsSatisfied(id)}
              phraseValue={phraseState[id] ?? ''}
              checkboxValue={checkboxState[id] === true}
              onPhraseChange={(v) => onPhraseChange(id, v)}
              onCheckboxChange={(v) => onCheckboxChange(id, v)}
              confirmDeleteTagValue={confirmDeleteTag}
              onConfirmDeleteTagChange={onConfirmDeleteTagChange}
              branch={branch}
              tag={tag}
              packageBasename={packageBasename}
              onRun={() => executeAction(id)}
              stagePrereqReasons={stagePrereqReasons}
            />
          ))}
        </div>
      ) : null}

      {high.length > 0 ? (
        <div
          className="mt-3 rounded-md border p-2.5"
          style={{
            background: 'rgba(239,68,68,0.04)',
            borderColor: 'rgba(239,68,68,0.45)'
          }}
        >
          <div
            className="mb-2 flex items-center gap-1.5 text-[10px] uppercase tracking-wide"
            style={{ color: 'var(--status-danger, #f87171)' }}
          >
            <ShieldAlert size={11} />
            HIGH-risk actions · typed confirmation required
            <span
              className="ml-2 rounded border px-1.5 py-0.5 font-mono text-[9px]"
              style={{
                background: 'rgba(239,68,68,0.10)',
                borderColor: 'rgba(239,68,68,0.45)',
                color: 'var(--status-danger, #f87171)'
              }}
            >
              {high.length} {high.length === 1 ? 'action' : 'actions'}
            </span>
          </div>
          <div className="space-y-3">
            {high.map((id) => (
              <ActionRow
                key={id}
                id={id}
                enabled={enabled}
                cell={runMap[id]}
                confirmationsOk={confirmationsSatisfied(id)}
                inputsOk={inputsSatisfied(id)}
                phraseValue={phraseState[id] ?? ''}
                checkboxValue={checkboxState[id] === true}
                onPhraseChange={(v) => onPhraseChange(id, v)}
                onCheckboxChange={(v) => onCheckboxChange(id, v)}
                confirmDeleteTagValue={confirmDeleteTag}
                onConfirmDeleteTagChange={onConfirmDeleteTagChange}
                branch={branch}
                tag={tag}
                packageBasename={packageBasename}
                onRun={() => executeAction(id)}
                stagePrereqReasons={stagePrereqReasons}
              />
            ))}
          </div>
        </div>
      ) : null}
    </Fragment>
  );
}
