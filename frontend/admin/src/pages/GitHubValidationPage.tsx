import { useEffect } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ExternalLink, GitBranch, Github, Plug, RefreshCw } from 'lucide-react';
import { adminGet, adminPost } from '../lib/api';
import { Card, CardBody, CardHeader } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { SectionHeader } from '../components/ui/SectionHeader';
import { LoadingState, ErrorState } from '../components/ui/States';

interface GitStatus {
  workspace: string; branch: string; branchAllowed: boolean; dirty: boolean; statusShort: string; devBranches: string[];
  repositoryUrl: string | null; remoteConfigured: boolean; head: string; upstream: string | null;
  ahead: number | null; behind: number | null; defaultDevBranch: string;
}
interface RemoteCheck {
  connected: boolean; repositoryUrl: string | null; branch: string;
  remoteHead: string | null; checkedAt: string; message: string;
}
export function GitHubValidationPage() {
  const query = useQuery({ queryKey: ['git', 'status'], queryFn: () => adminGet<GitStatus>('/git/status') });
  const remote = useMutation({ mutationFn: () => adminPost<RemoteCheck>('/git/check-remote', {}) });
  const status = query.data;
  useEffect(() => { remote.reset(); }, [status?.workspace, status?.branch, status?.repositoryUrl, status?.remoteConfigured, remote.reset]);
  return <div className="space-y-4">
    <SectionHeader title="GitHub Validation" subtitle="Review the connected repository and engineering workspace before running registered checks."
      actions={<button type="button" className="btn" disabled={query.isFetching} onClick={() => { remote.reset(); void query.refetch(); }}><RefreshCw size={14} /> Refresh</button>} />
    {query.isLoading ? <LoadingState /> : query.isError ? <ErrorState error={query.error} /> : status ? <>
      <Card><CardHeader title={<span className="flex items-center gap-2"><Github size={16} /> Repository connection</span>}
        right={<Badge tone={remote.data?.connected ? 'success' : remote.data ? 'warning' : 'slate'}>{remote.data?.connected ? 'Connected' : remote.data ? 'Needs attention' : 'Not checked'}</Badge>} />
        <CardBody className="space-y-3">
          {status.repositoryUrl ? <a className="inline-flex items-center gap-2 text-sm text-[var(--w3-gold-400)] break-all" href={status.repositoryUrl} target="_blank" rel="noreferrer">{status.repositoryUrl}<ExternalLink size={13} className="shrink-0" /></a>
            : <p className="text-sm text-[var(--w3-text-muted)]">{status.remoteConfigured ? 'A repository remote is configured for this workspace.' : 'No repository remote is configured for this workspace.'}</p>}
          <p className="text-xs text-[var(--w3-text-muted)]">Check repository access using the Forge host's existing Git credentials. Credentials are managed on the host.</p>
          <button type="button" className="btn btn-primary" disabled={!status.remoteConfigured || remote.isPending} onClick={() => remote.mutate()}><Plug size={14} />{remote.isPending ? 'Checking…' : 'Check Connection'}</button>
          {remote.isError ? <ErrorState title="Connection check failed" error={remote.error} /> : null}
          {remote.data ? <div role="status" className="text-sm space-y-1"><p>{remote.data.message}</p><p className="text-xs text-[var(--w3-text-muted)]">Checked {new Date(remote.data.checkedAt).toLocaleString()}{remote.data.remoteHead ? ` · Remote ${remote.data.remoteHead.slice(0, 12)}` : ''}</p></div> : null}
        </CardBody></Card>
      <Card><CardHeader title={<span className="flex items-center gap-2"><GitBranch size={16} /> Development branch</span>}
        right={<Badge tone={status.branchAllowed ? 'success' : 'danger'}>{status.branchAllowed ? 'Allowed branch' : 'Branch needs attention'}</Badge>} />
        <CardBody className="space-y-2"><p className="font-mono text-sm">{status.branch || 'No branch reported'}</p><p className="text-xs text-[var(--w3-text-muted)] break-all">{status.workspace}</p>
          <dl className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
            <div><dt className="text-[var(--w3-text-muted)]">Current commit</dt><dd className="font-mono">{status.head?.slice(0, 12) || 'Not reported'}</dd></div>
            <div><dt className="text-[var(--w3-text-muted)]">Configured development branch</dt><dd className="font-mono">{status.defaultDevBranch || 'Not configured'}</dd></div>
            <div><dt className="text-[var(--w3-text-muted)]">Upstream</dt><dd className="font-mono">{status.upstream || 'No upstream configured'}</dd></div>
            <div><dt className="text-[var(--w3-text-muted)]">Local tracking status</dt><dd>{status.ahead != null && status.behind != null ? `${status.ahead} ahead · ${status.behind} behind` : 'Not available'}</dd></div>
          </dl>
          <p className="text-xs text-[var(--w3-text-muted)]">Tracking counts use the last fetched repository state. Connection checks do not fetch or change files.</p>
        </CardBody></Card>
      <Card><CardHeader title="Workspace changes" right={<Badge tone={status.dirty ? 'warning' : 'success'}>{status.dirty ? 'Changes present' : 'Clean'}</Badge>} />
        <CardBody><pre className="console whitespace-pre-wrap text-xs">{status.statusShort || 'No uncommitted changes.'}</pre></CardBody></Card>
      <Card><CardHeader title="Registered validation" /><CardBody><p className="text-sm text-[var(--w3-text-muted)] mb-3">Run configuration, branch, tests and review-readiness checks from Controls. Results apply to the configured Forge workspace.</p><div className="flex flex-wrap gap-2"><Link className="btn btn-primary" to="/controls">Open Controls</Link><Link className="btn" to="/terminal">Open Terminal</Link></div></CardBody></Card>
    </> : null}
  </div>;
}
