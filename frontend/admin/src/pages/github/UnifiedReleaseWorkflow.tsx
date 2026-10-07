import { consoleText } from "../../../../../shared/consoleApp";
// =============================================================================
// W3 Core v0.5.39 — Unified Release Workflow (Controls-tab reuse refactor).
// =============================================================================
//
// Purpose: provide a single, simple, guided "do the next step" workflow for
// the release pipeline. Per the v0.5.38 PAUSE/REFACTOR directive, this view
// is now a thin orchestrator that delegates every step's execution to the
// same `<ControlCard>` component the Controls tab uses. It no longer owns
// any execution state machine, run mutation, payload preview, or per-step
// error handling — those all live inside ControlCard, on the same code path
// that has been proven working in production for read/restart/backup/verify
// controls since v0.5.14.
//
// What this component owns:
//   - Branch selector + derived version at the top of the page.
//   - Step ordering (1–7) and a tiny session-local success bitmap so each
//     step's primary action is gated until the previous step has succeeded
//     at least once this session.
//   - Lookup of each pipeline-* AdminControlPublic from a single
//     /admin/controls fetch (same fetch ControlsPage uses).
//   - Pre-fill of `branch`, `tag`, and `version` inputs into ControlCard via
//     the new `initialInputs` prop (frontend-only seed; the operator can
//     still edit before pressing Run).
//
// What this component does NOT do anymore:
//   - No custom adminPost call. No useMutation. No payload preview. No per
//     step state Map.
//   - No request-id surface. No stale-state clearing. No lock-contention
//     banner. ControlCard already handles all of that on the same code path
//     the Controls tab uses today.
//   - No backend changes, no script changes, no registry mutation, no auth
//     change, no dependency change.
//
// Workflow steps (control id mapping):
//   1. Check Remote               → pipeline-check-remote
//   2. Checkout / Pull Dev Branch → pipeline-checkout-dev (+ pipeline-pull-latest secondary)
//   3. Test Dev Branch            → pipeline-test-dev
//   4. Package DEV                → pipeline-package-dev
//   5. Verify DEV                 → pipeline-verify-dev-pkg
//   6. Promote DEV → MAIN         → pipeline-promote-dev-to-main
//   7. Deploy MAIN                → pipeline-deploy-dev
//
// v0.5.39 changes vs v0.5.38:
//   - Removed Step 8 ("Confirm Installed Metadata") from the guided
//     workflow. After Step 7 succeeds and /version reports vX.Y.Z, the
//     guided path is complete. Release tagging and installed-metadata
//     inspection are handled separately from the Controls tab.
//   - The backend route GET /admin/packages/installed/:version and the
//     installed-metadata sidecar scripts remain in place untouched — only
//     this guided UI no longer consumes them.
//
// Scope rules (v0.5.38, retained for v0.5.39):
//   - Frontend only. No new backend route. No registry mutation.
//   - Does not change auth, permissions, schema, persistent data,
//     dependencies, CI, branch protection, status checks, systemd, ports,
//     reverse proxy, or merge gates.
// =============================================================================

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleDashed,
  Info
} from 'lucide-react';
import { adminGet, AdminApiError } from '../../lib/api';
import {
  DEV_BRANCH_RE,
  deriveVersionTag,
  deriveVersionBare,
  pickHighestDevBranch
} from '../../lib/devBranchVersion';
import { DarkSelect, type DarkSelectOption } from '../../components/ui/DarkSelect';
import { ControlCard } from '../controls/ControlCard';
import type {
  AdminControlPublic,
  AdminControlsResponse,
  RunResponse
} from '../controls/controlsTypes';
import { usePipelineSharedState } from './pipelineContext';

// ---------------------------------------------------------------------------
// Local types
// ---------------------------------------------------------------------------

type StepKey =
  | 'check-remote'
  | 'checkout-dev'
  | 'test-dev'
  | 'package-dev'
  | 'verify-dev'
  | 'promote-dev'
  | 'deploy-main';

interface BranchEntry {
  name: string;
  sha: string;
}
interface BranchesResponse {
  ok: boolean;
  listedAt: string;
  branches: BranchEntry[];
  count: number;
  message: string;
  status: 'list_ok' | 'list_failed';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// v0.12.10: branch parsing / version derivation / highest-version selection
// moved to a pure, unit-tested module (frontend/admin/src/lib/devBranchVersion).
// Semantics are unchanged: `dev/v0.12.10` → version `v0.12.10`, bare `0.12.10`.
const BRANCH_RE = DEV_BRANCH_RE;
const deriveVersion = deriveVersionTag;

function errorMessage(err: unknown): string {
  if (err instanceof AdminApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Unknown error.';
}

// ---------------------------------------------------------------------------
// Step status pill (lightweight; ControlCard owns its own run trailer)
// ---------------------------------------------------------------------------

function StepBadge({ status }: { status: 'idle' | 'ready' | 'done' }) {
  if (status === 'done') {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium"
        style={{
          background: 'rgba(34, 197, 94, 0.18)',
          color: 'var(--status-success, #4ade80)'
        }}
      >
        <CheckCircle2 size={11} /> Completed
      </span>
    );
  }
  if (status === 'ready') {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium"
        style={{
          background: 'rgba(59, 130, 246, 0.18)',
          color: 'var(--status-info, #60a5fa)'
        }}
      >
        <CircleDashed size={11} /> Ready
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium"
      style={{
        background: 'rgba(100, 116, 139, 0.18)',
        color: 'var(--w3-text-muted)'
      }}
    >
      <CircleDashed size={11} /> Waiting
    </span>
  );
}

// ---------------------------------------------------------------------------
// Step shell — numbered header + (optional) gated body
// ---------------------------------------------------------------------------

interface StepShellProps {
  index: number;
  title: string;
  description: string;
  status: 'idle' | 'ready' | 'done';
  gated: boolean; // true means previous step has not succeeded yet
  gateHint?: string;
  children: ReactNode;
}

function StepShell({
  index,
  title,
  description,
  status,
  gated,
  gateHint,
  children
}: StepShellProps) {
  return (
    <div
      className="rounded-lg border p-3"
      style={{
        background: 'rgba(7,18,37,0.45)',
        borderColor: 'var(--w3-border-section)'
      }}
    >
      <div className="mb-2 flex items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <span
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold"
            style={{
              background: 'var(--w3-gold-500)',
              color: '#1A1206'
            }}
          >
            {index}
          </span>
          <div>
            <div className="text-[13px] font-medium" style={{ color: 'var(--w3-text)' }}>
              {title}
            </div>
            <div className="text-[11px]" style={{ color: 'var(--w3-text-muted)' }}>
              {description}
            </div>
          </div>
        </div>
        <StepBadge status={status} />
      </div>

      {gated ? (
        <div
          className="rounded-md border p-2 text-[11px]"
          style={{
            background: 'rgba(15,23,42,0.55)',
            borderColor: 'var(--w3-border-section)',
            color: 'var(--w3-text-muted)'
          }}
        >
          <Info size={11} className="mr-1 inline-block align-[-1px]" />
          {gateHint ?? 'Complete the previous step before running this one.'}
        </div>
      ) : (
        children
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Missing-control placeholder (registry entry not present for some reason)
// ---------------------------------------------------------------------------

function MissingControl({ id }: { id: string }) {
  return (
    <div
      className="rounded-md border p-2.5 text-[11px]"
      style={{
        background: 'rgba(15,23,42,0.6)',
        borderColor: 'rgba(239,68,68,0.4)',
        color: 'var(--status-danger)'
      }}
    >
      Registry entry not found for control{' '}
      <code className="font-mono">{id}</code>. The backend may need to be
      restarted or the controls registry refreshed.
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function UnifiedReleaseWorkflow() {
  const qc = useQueryClient();
  const shared = usePipelineSharedState();

  // Local branch state mirrors shared context (so other panels stay in sync).
  const [branch, setBranchLocal] = useState<string>(shared.branch);
  const setBranch = (next: string) => {
    setBranchLocal(next);
    shared.setBranch(next);
  };

  useEffect(() => {
    if (shared.branch !== branch) setBranchLocal(shared.branch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shared.branch]);

  // ---------------------------------------------------------------------------
  // Fetch dev branches (same endpoint ReleasePipelinePanel uses).
  // ---------------------------------------------------------------------------
  const branchesQ = useQuery({
    queryKey: ['admin', 'git', 'branches-dev'],
    queryFn: async (): Promise<BranchesResponse> =>
      adminGet<BranchesResponse>('/git/branches-dev'),
    staleTime: 30_000
  });

  const branchOptions = useMemo<DarkSelectOption[]>(() => {
    const arr: DarkSelectOption[] = [];
    if (branchesQ.data?.branches) {
      for (const b of branchesQ.data.branches) {
        arr.push({ value: b.name, label: b.name });
      }
    }
    return arr;
  }, [branchesQ.data]);

  // Auto-pick a sensible branch on first successful list.
  //
  // v0.12.10: the default is the HIGHEST numeric dev/vX.Y.Z version, chosen
  // client-side rather than trusting the response order (an older backend
  // sorted lexically, so dev/v0.12.9 was listed above dev/v0.12.10). The
  // `if (branch) return` guard is what preserves an operator's existing
  // selection across refetches / manual refreshes — it is intentionally
  // unchanged.
  useEffect(() => {
    if (branch) return;
    const names = branchesQ.data?.branches?.map((b) => b.name) ?? [];
    if (names.length === 0) return;
    setBranch(pickHighestDevBranch(names) ?? names[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchesQ.data]);

  const version = deriveVersion(branch);
  const versionBare = deriveVersionBare(branch);

  // ---------------------------------------------------------------------------
  // Fetch admin controls registry (same endpoint ControlsPage uses).
  // ---------------------------------------------------------------------------
  const controlsQ = useQuery({
    queryKey: ['admin', 'controls'],
    queryFn: async (): Promise<AdminControlsResponse> =>
      adminGet<AdminControlsResponse>('/controls'),
    staleTime: 60_000
  });

  // Flatten the categories -> controls so we can look up by id.
  const controlsById = useMemo<Map<string, AdminControlPublic>>(() => {
    const map = new Map<string, AdminControlPublic>();
    if (controlsQ.data?.categories) {
      for (const cat of controlsQ.data.categories) {
        for (const c of cat.controls) {
          map.set(c.id, c);
        }
      }
    }
    return map;
  }, [controlsQ.data]);

  // ---------------------------------------------------------------------------
  // Step-completion bitmap (session-local). A step is "done" once its
  // primary ControlCard has reported runStatus=success at least once during
  // this session. We never persist; reload resets the bitmap.
  // ---------------------------------------------------------------------------
  const [done, setDone] = useState<Record<StepKey, boolean>>({
    'check-remote': false,
    'checkout-dev': false,
    'test-dev': false,
    'package-dev': false,
    'verify-dev': false,
    'promote-dev': false,
    'deploy-main': false
  });

  const markDone = (key: StepKey) =>
    setDone((prev) => ({ ...prev, [key]: true }));

  const onStepSuccess = (key: StepKey) => (res: RunResponse) => {
    markDone(key);
    shared.setLastSuccessId(res.controlId);
    // Surface helpful invalidations so neighboring panels refresh.
    if (key === 'package-dev') {
      qc.invalidateQueries({ queryKey: ['admin', 'packages'] });
    }
    if (key === 'promote-dev' || key === 'deploy-main') {
      qc.invalidateQueries({ queryKey: ['admin', 'packages'] });
      qc.invalidateQueries({ queryKey: ['admin', 'packages', 'installed'] });
    }
    if (
      key === 'check-remote' ||
      key === 'checkout-dev'
    ) {
      qc.invalidateQueries({ queryKey: ['admin', 'git', 'status'] });
      qc.invalidateQueries({ queryKey: ['admin', 'git', 'branches-dev'] });
    }
  };

  // ---------------------------------------------------------------------------
  // v0.5.39: Step 8 ("Confirm Installed Metadata") removed from the guided
  // workflow. The backend route GET /admin/packages/installed/:version is
  // intentionally retained and is still reachable via other UI / API
  // surfaces; only the guided workflow no longer wires it.
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Resolve each step's control + its initialInputs payload.
  // ---------------------------------------------------------------------------

  const tag = version; // pipeline-package-dev expects `tag` = vX.Y.Z

  // v0.5.38 (regression fix): each step may declare `extraInputs` —
  // submission-only inputs that ControlCard merges into the POST payload at
  // run time WITHOUT surfacing them as form fields. Used to attach
  // `channel` (dev|main) and `version` (vX.Y.Z) to the verify / promote /
  // deploy controls so the backend resolver can locate the canonical
  // `<channel>/<version>/w3buildcost.tar.gz` layout. The dropdown still owns
  // the operator-visible `packageName` field. See ControlCard.extraInputs.
  const stepDefs: Array<{
    key: StepKey;
    index: number;
    title: string;
    description: string;
    controlId?: string;
    initialInputs?: Record<string, string>;
    extraInputs?: Record<string, string | undefined>;
    secondary?: { controlId: string; initialInputs?: Record<string, string> };
    custom?: ReactNode;
  }> = [
    {
      key: 'check-remote',
      index: 1,
      title: 'Check Remote',
      description:
        'Read-only check that origin is reachable and the local repo can see remote refs.',
      controlId: 'pipeline-check-remote'
    },
    {
      key: 'checkout-dev',
      index: 2,
      title: 'Checkout Dev Branch',
      description:
        'Switch the deploy clone to the selected dev/vX.Y.Z branch. Run “Pull Latest” after if origin has moved.',
      controlId: 'pipeline-checkout-dev',
      initialInputs: branch ? { branch } : undefined,
      secondary: { controlId: 'pipeline-pull-latest' }
    },
    {
      key: 'test-dev',
      index: 3,
      title: 'Test Dev Branch',
      description:
        'Run the dev-branch verification script (typecheck + build smoke). No mutation.',
      controlId: 'pipeline-test-dev'
    },
    {
      key: 'package-dev',
      index: 4,
      title: 'Package DEV',
      description:
        consoleText('Build the canonical /opt/w3buildcost-update-packages/dev/<version>/w3buildcost.tar.gz tarball for the selected version. Requires typing PACKAGE.'),
      controlId: 'pipeline-package-dev',
      initialInputs: tag ? { tag } : undefined
    },
    {
      key: 'verify-dev',
      index: 5,
      title: 'Verify DEV',
      description:
        'Read-only integrity check against the staged dev tarball. Pick the package built in Step 4.',
      controlId: 'pipeline-verify-dev-pkg',
      // v0.5.38 (regression fix): the canonical-package layout means the
      // dropdown returns `w3buildcost.tar.gz` (no embedded version), so the
      // backend resolver requires `channel` and `version` to disambiguate
      // `/opt/w3buildcost-update-packages/dev/<version>/w3buildcost.tar.gz`. Submission-
      // only; the operator still picks the package from the visible select.
      extraInputs: version ? { channel: 'dev', version } : undefined
    },
    {
      key: 'promote-dev',
      index: 6,
      title: 'Promote DEV → MAIN',
      description:
        consoleText('Channel-flip: copy the verified dev tarball into /opt/w3buildcost-update-packages/main/<version>/. No runtime touch. Requires typing PROMOTE.'),
      controlId: 'pipeline-promote-dev-to-main',
      // v0.5.38 (regression fix): the promote control's inputSchema DOES
      // include `version` as a visible text field. Pre-fill it via
      // `initialInputs` so the operator sees the derived vX.Y.Z value
      // instead of an empty input (which previously rendered the raw regex
      // pattern as a placeholder). ControlCard already submits the field
      // value as part of the run payload — no `extraInputs` needed for
      // this step.
      initialInputs: version ? { version } : undefined
    },
    {
      key: 'deploy-main',
      index: 7,
      // v0.5.38: Step 7 deploys the MAIN-channel tarball that Step 6 just
      // promoted (channel=main + version=vX.Y.Z; see extraInputs below).
      // The control id is still `pipeline-deploy-dev` for historical
      // wiring reasons, but the operator-facing label must reflect what
      // is actually being deployed.
      title: 'Deploy MAIN Package',
      description:
        consoleText('Pipeline-side deploy of the verified main-channel tarball produced by Step 6 (/opt/w3buildcost-update-packages/main/<version>/w3buildcost.tar.gz). Requires typing DEPLOY-DEV.'),
      controlId: 'pipeline-deploy-dev',
      // v0.5.38 (regression fix): Step 7 deploys what Step 6 promoted, so
      // the backend resolver must look in /opt/w3buildcost-update-packages/main/<v>/.
      // The dropdown supplies the canonical `packageName=w3buildcost.tar.gz`;
      // we attach `channel=main` and `version=vX.Y.Z` via extraInputs.
      extraInputs: version ? { channel: 'main', version } : undefined
    }
  ];

  // Gate computation: step N is enabled when step N-1 has succeeded at least
  // once OR step N is step 1 (always enabled).
  const gateOrder: StepKey[] = [
    'check-remote',
    'checkout-dev',
    'test-dev',
    'package-dev',
    'verify-dev',
    'promote-dev',
    'deploy-main'
  ];

  const isGated = (key: StepKey): boolean => {
    const idx = gateOrder.indexOf(key);
    if (idx <= 0) return false;
    const prev = gateOrder[idx - 1];
    return !done[prev];
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const branchInvalid = branch !== '' && !BRANCH_RE.test(branch);
  const noBranches =
    branchesQ.isSuccess &&
    (branchesQ.data?.branches?.length ?? 0) === 0;

  return (
    <section
      className="rounded-lg border"
      style={{
        background: 'var(--w3-bg-panel)',
        borderColor: 'var(--w3-border-section)'
      }}
    >
      <header
        className="flex flex-col gap-2 border-b p-3 sm:flex-row sm:items-end sm:justify-between"
        style={{ borderColor: 'var(--w3-border-section)' }}
      >
        {/* v0.12.10: the description block yields (min-w-0 + flex-1) and the
            field group never shrinks, so the Branch picker is not squeezed
            by the header text or the Version field. Fields stack below the
            `sm` breakpoint (already the case) and the picker sizes itself to
            its longest option via DarkSelect `fitOptions`. */}
        <div className="min-w-0 sm:flex-1">
          <h3 className="text-[13px] font-semibold" style={{ color: 'var(--w3-text)' }}>
            Release Workflow
          </h3>
          <p className="text-[11px]" style={{ color: 'var(--w3-text-muted)' }}>
            Guided 7-step workflow. Each step reuses the same execution path
            as the Controls tab. Select a dev branch to begin.
          </p>
        </div>
        <div
          className="flex max-w-full flex-col gap-2 sm:flex-row sm:items-end sm:shrink-0"
          data-testid="release-workflow-fields"
        >
          <div className="min-w-0 max-w-full" data-testid="release-workflow-branch-field">
            <div
              className="mb-1 text-[10px] font-medium uppercase tracking-[0.1em]"
              style={{ color: 'var(--w3-text-dim)' }}
            >
              Dev Branch
            </div>
            <DarkSelect
              id="release-workflow-branch"
              ariaLabel="Dev branch"
              value={branch}
              onChange={setBranch}
              options={branchOptions}
              placeholder={
                branchesQ.isLoading
                  ? 'Loading branches…'
                  : noBranches
                    ? 'No dev/vX.Y.Z branches'
                    : 'Select a dev branch'
              }
              disabled={branchesQ.isLoading || noBranches}
              fitOptions
              minWidth="11rem"
            />
          </div>
          <div className="shrink-0">
            <div
              className="mb-1 text-[10px] font-medium uppercase tracking-[0.1em]"
              style={{ color: 'var(--w3-text-dim)' }}
            >
              Version
            </div>
            <div
              className="rounded-md border px-2 py-1 font-mono text-[11px]"
              style={{
                background: 'rgba(7,18,37,0.7)',
                borderColor: branchInvalid
                  ? 'rgba(239,68,68,0.45)'
                  : version
                    ? 'rgba(34,197,94,0.35)'
                    : 'var(--w3-border-section)',
                color: 'var(--w3-text)',
                minWidth: '7rem'
              }}
              data-testid="release-workflow-version"
            >
              {version || '—'}
            </div>
          </div>
        </div>
      </header>

      <div className="space-y-2 p-3">
        {branchesQ.isError ? (
          <div
            className="rounded-md border p-2 text-[11px]"
            style={{
              background: 'var(--status-danger-bg)',
              borderColor: 'rgba(239,68,68,0.4)',
              color: 'var(--status-danger)'
            }}
          >
            Failed to list dev branches: {errorMessage(branchesQ.error)}
          </div>
        ) : null}

        {controlsQ.isError ? (
          <div
            className="rounded-md border p-2 text-[11px]"
            style={{
              background: 'var(--status-danger-bg)',
              borderColor: 'rgba(239,68,68,0.4)',
              color: 'var(--status-danger)'
            }}
          >
            Failed to load admin controls registry: {errorMessage(controlsQ.error)}
          </div>
        ) : null}

        {stepDefs.map((step) => {
          const gated = isGated(step.key);
          const status: 'idle' | 'ready' | 'done' = done[step.key]
            ? 'done'
            : gated
              ? 'idle'
              : 'ready';

          let body: ReactNode = null;
          if (step.custom) {
            body = step.custom;
          } else if (step.controlId) {
            const control = controlsById.get(step.controlId);
            if (!control) {
              body = controlsQ.isLoading ? (
                <div className="text-[11px]" style={{ color: 'var(--w3-text-muted)' }}>
                  Loading control…
                </div>
              ) : (
                <MissingControl id={step.controlId} />
              );
            } else {
              body = (
                <div className="space-y-2">
                  <ControlCard
                    key={`${step.controlId}:${branch}`}
                    control={control}
                    initialInputs={step.initialInputs}
                    extraInputs={step.extraInputs}
                    onRunSuccess={onStepSuccess(step.key)}
                  />
                  {step.secondary
                    ? (() => {
                        const sec = controlsById.get(step.secondary!.controlId);
                        if (!sec) {
                          return controlsQ.isLoading ? null : (
                            <SecondaryToggle
                              label={`Secondary: ${step.secondary!.controlId}`}
                            >
                              <MissingControl id={step.secondary!.controlId} />
                            </SecondaryToggle>
                          );
                        }
                        return (
                          <SecondaryToggle label={`Secondary: ${sec.label}`}>
                            <ControlCard
                              key={`${step.secondary!.controlId}:${branch}`}
                              control={sec}
                              initialInputs={step.secondary!.initialInputs}
                            />
                          </SecondaryToggle>
                        );
                      })()
                    : null}
                </div>
              );
            }
          }

          return (
            <StepShell
              key={step.key}
              index={step.index}
              title={step.title}
              description={step.description}
              status={status}
              gated={gated}
              gateHint={
                step.index === 1
                  ? undefined
                  : `Complete Step ${step.index - 1} successfully before running this step.`
              }
            >
              {body}
            </StepShell>
          );
        })}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// v0.5.39: the `Field` sub-component was used exclusively by the removed
// Step 8 ("Confirm Installed Metadata"). It has been deleted with that step.

function SecondaryToggle({
  label,
  children
}: {
  label: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className="rounded-md border"
      style={{
        background: 'rgba(15,23,42,0.55)',
        borderColor: 'var(--w3-border-section)'
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-[11px]"
        style={{ color: 'var(--w3-text-muted)' }}
      >
        <span>{label}</span>
        {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
      </button>
      {open ? <div className="border-t p-2.5" style={{ borderColor: 'var(--w3-border-section)' }}>{children}</div> : null}
    </div>
  );
}
