// =============================================================================
// W3 Core v0.5.31 - "Current Pipeline State" summary card.
// =============================================================================
//
// Top-of-page summary that surfaces eight facts the operator needs at a
// glance before touching any pipeline action:
//
//   1. Selected dev branch        (from PipelineSharedStateContext)
//   2. Current local branch       (from /git/status)
//   3. Latest remote dev SHA      (from /git/branches-dev, newest semver)
//   4. Latest main tag            (from /git/tags, first entry)
//   5. Staged package selected    (from PipelineSharedStateContext)
//   6. Last successful action     (from PipelineSharedStateContext)
//   7. Last failed/refused action (from PipelineSharedStateContext)
//   8. Installed runtime version  (from /git/status releaseVersion + /controls release)
//
// All data is sourced from already-existing endpoints / queries.
// No new backend route, no contract change. Pure frontend read.
// =============================================================================

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { GitBranch, Hash, Package, Tag, Cpu, CheckCircle, XCircle } from 'lucide-react';
import { adminGet } from '../../lib/api';
import { Badge } from '../../components/ui/Badge';
import { usePipelineSharedState } from './pipelineContext';

interface GitStatusSlim {
  branch: string | null;
  headShortSha: string | null;
  releaseVersion: string;
  describedTag: string | null;
  clean: boolean | null;
}

interface DevBranch {
  name: string;
  sha: string | null;
  shortSha: string | null;
}

interface BranchesResponse {
  branches: DevBranch[];
  count: number;
  message?: string;
}

interface GitTag {
  name: string;
  commit: string | null;
  isLatest?: boolean;
}

interface TagsResponse {
  tags: GitTag[];
}

interface ControlsRegistrySlim {
  release: string;
  version: string;
}

// Reuse the same semver comparator the panel uses to pick "newest dev branch".
function parseDevBranchVersion(name: string): [number, number, number] | null {
  const m = /^dev\/v(\d+)\.(\d+)\.(\d+)$/.exec(name);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compareDevBranchesDesc(a: { name: string }, b: { name: string }): number {
  const av = parseDevBranchVersion(a.name);
  const bv = parseDevBranchVersion(b.name);
  if (av && bv) {
    for (let i = 0; i < 3; i += 1) {
      if (av[i] !== bv[i]) return bv[i] - av[i];
    }
    return 0;
  }
  if (av) return -1;
  if (bv) return 1;
  return a.name.localeCompare(b.name);
}

interface FactProps {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  hint?: string;
}

function Fact({ icon, label, value, hint }: FactProps) {
  return (
    <div
      className="flex flex-col gap-1 rounded-md border p-2"
      style={{
        borderColor: 'var(--w3-border-section)',
        background: 'rgba(15,23,42,0.35)'
      }}
    >
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide"
           style={{ color: 'var(--w3-text-muted)' }}>
        {icon}
        {label}
      </div>
      <div className="font-mono text-[12px]" style={{ color: 'var(--w3-text)' }}>
        {value}
      </div>
      {hint ? (
        <div className="text-[10.5px]" style={{ color: 'var(--w3-text-muted)' }}>
          {hint}
        </div>
      ) : null}
    </div>
  );
}

const PLACEHOLDER = '—';

export function PipelineStateSummary() {
  const shared = usePipelineSharedState();

  const statusQ = useQuery({
    queryKey: ['admin', 'git', 'status'],
    queryFn: () => adminGet<GitStatusSlim>('/git/status')
  });

  const branchesQ = useQuery({
    queryKey: ['admin', 'git', 'branches-dev'],
    queryFn: () => adminGet<BranchesResponse>('/git/branches-dev')
  });

  const tagsQ = useQuery({
    queryKey: ['admin', 'git', 'tags'],
    queryFn: () =>
      adminGet<TagsResponse>('/git/tags')
  });

  const controlsQ = useQuery({
    queryKey: ['admin', 'controls'],
    queryFn: () => adminGet<ControlsRegistrySlim>('/controls')
  });

  // Latest remote dev branch (semver desc, then short sha).
  const latestRemoteDev = useMemo(() => {
    const list = branchesQ.data?.branches ?? [];
    if (list.length === 0) return null;
    const sorted = [...list].sort(compareDevBranchesDesc);
    return sorted[0] ?? null;
  }, [branchesQ.data]);

  // Latest main tag = first vX.Y.Z entry (the /git/tags endpoint returns
  // tags newest-first; the first entry tagged with isLatest is canonical).
  const latestMainTag = useMemo(() => {
    const list = tagsQ.data?.tags ?? [];
    const flagged = list.find((t) => t.isLatest);
    return flagged ?? list[0] ?? null;
  }, [tagsQ.data]);

  const status = statusQ.data;
  const controls = controlsQ.data;

  const installedVersion = status?.releaseVersion
    ? `v${status.releaseVersion}`
    : controls?.version
    ? `v${controls.version}`
    : PLACEHOLDER;

  const runtimeRelease = controls?.release ?? PLACEHOLDER;

  return (
    <div
      className="rounded-md border p-3"
      style={{
        borderColor: 'var(--w3-border-section)',
        background: 'rgba(15,23,42,0.45)'
      }}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="text-[12px] font-semibold uppercase tracking-wide"
             style={{ color: 'var(--w3-text)' }}>
          Current Pipeline State
        </div>
        <Badge tone="slate">v0.5.31 readiness</Badge>
      </div>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Fact
          icon={<GitBranch size={11} />}
          label="Selected Dev Branch"
          value={shared.branch || PLACEHOLDER}
          hint={shared.branch ? 'In Release Pipeline panel below' : 'Pick a branch below'}
        />
        <Fact
          icon={<GitBranch size={11} />}
          label="Current Local Branch"
          value={status?.branch || PLACEHOLDER}
          hint={
            status?.clean === true
              ? 'Working tree clean'
              : status?.clean === false
              ? 'Uncommitted changes'
              : undefined
          }
        />
        <Fact
          icon={<Hash size={11} />}
          label="Latest Remote Dev SHA"
          value={
            latestRemoteDev
              ? `${latestRemoteDev.name} @ ${latestRemoteDev.shortSha ?? PLACEHOLDER}`
              : PLACEHOLDER
          }
          hint={
            branchesQ.data
              ? `${branchesQ.data.count} dev branch${branchesQ.data.count === 1 ? '' : 'es'} known`
              : undefined
          }
        />
        <Fact
          icon={<Tag size={11} />}
          label="Latest Main Tag"
          value={latestMainTag?.name || PLACEHOLDER}
          hint={latestMainTag?.commit ? latestMainTag.commit.slice(0, 7) : undefined}
        />

        <Fact
          icon={<Package size={11} />}
          label="Staged Package Selected"
          value={shared.packageBasename || PLACEHOLDER}
          hint={shared.packageBasename ? 'In Release Pipeline panel below' : 'Pick a package below'}
        />
        <Fact
          icon={<CheckCircle size={11} />}
          label="Last Successful Action"
          value={shared.lastSuccessId || PLACEHOLDER}
        />
        <Fact
          icon={<XCircle size={11} />}
          label="Last Failed / Refused"
          value={shared.lastFailureId || PLACEHOLDER}
        />
        <Fact
          icon={<Cpu size={11} />}
          label="Installed Runtime"
          value={installedVersion}
          hint={runtimeRelease !== PLACEHOLDER ? `controls release: ${runtimeRelease}` : undefined}
        />
      </div>
    </div>
  );
}
