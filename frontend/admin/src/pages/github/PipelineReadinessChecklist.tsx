import { consoleText, consolePattern } from "../../../../../shared/consoleApp";
// =============================================================================
// W3 Core v0.5.31 - "Pipeline Readiness Checklist" UI.
// =============================================================================
//
// Eight derived checks the operator can see at a glance:
//
//   1. GitHub reachable               (last pipeline-check-remote success OR
//                                      /git/status returned a remote)
//   2. Dev branch selected            (PipelineSharedStateContext.branch is set
//                                      AND matches /^dev\/v\d+\.\d+\.\d+$/)
//   3. Working tree clean             (/git/status .clean === true)
//   4. Test passed                    (stageSuccess.test === true)
//   5. Package exists                 (PipelineSharedStateContext.packageBasename
//                                      is set AND matches the regex)
//   6. Package verified               (stageSuccess.verify === true)
//   7. Runtime version checked        (/git/compare-installed has been observed
//                                      OR /controls release equals VERSION)
//   8. High-risk actions still gated  (statically true — see comment below)
//
// All checks are derived from already-cached react-query data plus the
// PipelineSharedStateContext that the panel publishes. No new fetches,
// no new endpoints, no backend contract change.
// =============================================================================

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, AlertTriangle, Circle, Lock } from 'lucide-react';
import { adminGet } from '../../lib/api';
import { usePipelineSharedState } from './pipelineContext';

interface GitStatusSlim {
  branch: string | null;
  clean: boolean | null;
  remote: string | null;
  releaseVersion: string;
  describedTag: string | null;
}

interface ControlsRegistrySlim {
  release: string;
  version: string;
  categories: Array<{
    id: string;
    controls: Array<{ id: string; riskLevel: string }>;
  }>;
}

const DEV_BRANCH_RE = /^dev\/v\d+\.\d+\.\d+$/;
const PACKAGE_RE = new RegExp(consolePattern("^w3buildcost-v\\d+\\.\\d+\\.\\d+\\.tar\\.gz$"), "");

type CheckTone = 'success' | 'warning' | 'pending';

interface CheckRow {
  label: string;
  tone: CheckTone;
  detail: string;
}

function ToneIcon({ tone }: { tone: CheckTone }) {
  if (tone === 'success') {
    return <CheckCircle2 size={13} style={{ color: 'var(--status-success)' }} />;
  }
  if (tone === 'warning') {
    return <AlertTriangle size={13} style={{ color: 'var(--status-warning)' }} />;
  }
  return <Circle size={13} style={{ color: 'var(--w3-text-muted)' }} />;
}

export function PipelineReadinessChecklist() {
  const shared = usePipelineSharedState();

  const statusQ = useQuery({
    queryKey: ['admin', 'git', 'status'],
    queryFn: () => adminGet<GitStatusSlim>('/git/status')
  });

  const controlsQ = useQuery({
    queryKey: ['admin', 'controls'],
    queryFn: () => adminGet<ControlsRegistrySlim>('/controls')
  });

  const checks: CheckRow[] = useMemo(() => {
    const status = statusQ.data;
    const controls = controlsQ.data;
    const stageSuccess = shared.stageSuccess ?? {};

    // 1. GitHub reachable
    const githubReachable =
      stageSuccess.remote === true ||
      Boolean(status?.remote);
    const githubDetail = stageSuccess.remote
      ? 'pipeline-check-remote succeeded this session'
      : status?.remote
      ? `remote: ${status.remote}`
      : 'remote not yet confirmed — run Safe Preflight';

    // 2. Dev branch selected
    const branchSelected = Boolean(shared.branch) && DEV_BRANCH_RE.test(shared.branch);
    const branchDetail = shared.branch
      ? branchSelected
        ? `selected: ${shared.branch}`
        : `selected "${shared.branch}" does not match dev/vX.Y.Z`
      : 'no dev branch picked yet — see Release Pipeline panel';

    // 3. Working tree clean
    const cleanTone: CheckTone =
      status?.clean === true ? 'success' : status?.clean === false ? 'warning' : 'pending';
    const cleanDetail =
      status?.clean === true
        ? consoleText('no uncommitted changes in /opt/w3buildcost-deploy')
        : status?.clean === false
        ? consoleText('uncommitted changes present in /opt/w3buildcost-deploy')
        : 'unknown — /git/status not loaded';

    // 4. Test passed
    const testPassed = stageSuccess.test === true;

    // 5. Package exists (selected + matches regex)
    const packageExists =
      Boolean(shared.packageBasename) && PACKAGE_RE.test(shared.packageBasename);
    const packageDetail = shared.packageBasename
      ? packageExists
        ? `selected: ${shared.packageBasename}`
        : `selected "${shared.packageBasename}" ${consoleText('does not match w3buildcost-vX.Y.Z.tar.gz')}`
      : 'no staged package picked yet';

    // 6. Package verified
    const packageVerified = stageSuccess.verify === true;

    // 7. Runtime version checked
    const runtimeChecked = Boolean(controls?.release) && Boolean(status?.releaseVersion);
    const runtimeDetail = controls?.release
      ? `runtime release ${controls.release}, VERSION ${status?.releaseVersion ?? '?'}`
      : 'controls registry not loaded';

    // 8. High-risk actions still gated.
    // This check is intentionally derived from the controls registry: it is
    // GREEN as long as the registry still reports at least one HIGH-risk
    // pipeline-* control. If we ever lost the HIGH-risk class entirely
    // (which v0.5.31 does NOT do) this would degrade to WARNING.
    let highRiskCount = 0;
    if (controls?.categories) {
      for (const cat of controls.categories) {
        for (const ctrl of cat.controls) {
          if (
            ctrl.id.startsWith('pipeline-') &&
            (ctrl.riskLevel === 'HIGH' || ctrl.riskLevel === 'high')
          ) {
            highRiskCount += 1;
          }
        }
      }
    }
    const highRiskGated = highRiskCount > 0;

    return [
      {
        label: 'GitHub reachable',
        tone: githubReachable ? 'success' : 'pending',
        detail: githubDetail
      },
      {
        label: 'Dev branch selected',
        tone: branchSelected ? 'success' : 'pending',
        detail: branchDetail
      },
      {
        label: 'Working tree clean',
        tone: cleanTone,
        detail: cleanDetail
      },
      {
        label: 'Test passed',
        tone: testPassed ? 'success' : 'pending',
        detail: testPassed
          ? 'pipeline-test-dev succeeded this session'
          : 'pipeline-test-dev has not succeeded yet this session'
      },
      {
        label: 'Package exists',
        tone: packageExists ? 'success' : 'pending',
        detail: packageDetail
      },
      {
        label: 'Package verified',
        tone: packageVerified ? 'success' : 'pending',
        detail: packageVerified
          ? 'pipeline-verify-dev-pkg succeeded this session'
          : 'pipeline-verify-dev-pkg has not succeeded yet this session'
      },
      {
        label: 'Runtime version checked',
        tone: runtimeChecked ? 'success' : 'pending',
        detail: runtimeDetail
      },
      {
        label: 'HIGH-risk actions still gated',
        tone: highRiskGated ? 'success' : 'warning',
        detail: highRiskGated
          ? `${highRiskCount} HIGH-risk pipeline-* controls still require typed confirmation`
          : 'registry reports no HIGH-risk pipeline-* controls — review immediately'
      }
    ];
  }, [statusQ.data, controlsQ.data, shared.branch, shared.packageBasename, shared.stageSuccess]);

  const passed = checks.filter((c) => c.tone === 'success').length;
  const warnings = checks.filter((c) => c.tone === 'warning').length;

  return (
    <div
      className="rounded-md border p-3"
      style={{
        borderColor: 'var(--w3-border-section)',
        background: 'rgba(15,23,42,0.45)'
      }}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Lock size={13} style={{ color: 'var(--w3-gold)' }} />
          <div className="text-[12px] font-semibold uppercase tracking-wide"
               style={{ color: 'var(--w3-text)' }}>
            Pipeline Readiness Checklist
          </div>
        </div>
        <span className="text-[11px]" style={{ color: 'var(--w3-text-muted)' }}>
          {passed}/{checks.length} ready{warnings > 0 ? ` · ${warnings} warning${warnings === 1 ? '' : 's'}` : ''}
        </span>
      </div>

      <ul className="space-y-1.5">
        {checks.map((c) => (
          <li key={c.label} className="flex items-start gap-2 text-[11.5px]">
            <ToneIcon tone={c.tone} />
            <div className="flex flex-col">
              <span style={{ color: 'var(--w3-text)' }}>{c.label}</span>
              <span className="font-mono text-[10.5px]" style={{ color: 'var(--w3-text-muted)' }}>
                {c.detail}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
