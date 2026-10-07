import { useEffect } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ExternalLink, Github, Plug, RefreshCw } from 'lucide-react';
import { adminGet, adminPost } from '../lib/api';
import { AdminListPage } from '../components/ui/AdminListPage';
import { Badge } from '../components/ui/Badge';
import { MetricTile } from '../components/ui/MetricTile';
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
// Shared GitHub / Releases page structure; Forge supplies its existing read-only
// repository adapter and registered validation controls.
export function GitHubValidationPage() {
  const query = useQuery({ queryKey: ['git', 'status'], queryFn: () => adminGet<GitStatus>('/git/status') });
  const remote = useMutation({ mutationFn: () => adminPost<RemoteCheck>('/git/check-remote', {}) });
  const status = query.isError ? undefined : query.data;
  const remoteResult = status ? remote.data : undefined;
  useEffect(() => { remote.reset(); }, [status?.workspace, status?.branch, status?.repositoryUrl, status?.remoteConfigured, remote.reset]);
  const loading = query.isLoading ? <LoadingState /> : query.isError ? <ErrorState error={query.error} /> : null;
  return <AdminListPage header={{
    title: 'GitHub / Releases', subtitle: status?.workspace || 'Repository and release status.',
    actions: <div className="flex max-w-[calc(100vw-5rem)] flex-wrap items-center gap-2">
      {status ? <Badge tone={status.dirty ? 'warning' : 'success'}>{status.dirty ? 'Changes present' : 'Clean'}</Badge> : null}
      <button type="button" className="btn" disabled={query.isFetching} onClick={() => { remote.reset(); void query.refetch(); }}><RefreshCw size={13} /> Refresh Status</button>
      {status?.repositoryUrl ? <a href={status.repositoryUrl} target="_blank" rel="noreferrer" className="btn" title={status.repositoryUrl}><Github size={13} /> Repo <ExternalLink size={11} /></a> : null}
    </div>
  }}
    standardCard={{
      title: 'GitHub Release Standard', subtitle: 'Tags, packages, and branches use the shared conventions.',
      body: <><div className="grid grid-cols-1 gap-2 text-xs md:grid-cols-2">
        <div><span className="text-[var(--w3-text-muted)]">Tag: </span><code>vX.Y.Z</code></div>
        <div><span className="text-[var(--w3-text-muted)]">Package: </span><code>w3forge-vX.Y.Z.tar.gz</code></div>
        <div><span className="text-[var(--w3-text-muted)]">Development branch: </span><code>{status?.defaultDevBranch || 'Not configured'}</code></div>
        <div className="break-all"><span className="text-[var(--w3-text-muted)]">Workspace: </span><code>{status?.workspace || 'Not reported'}</code></div>
      </div><p className="mt-3 text-xs text-[var(--w3-text-muted)]">Release approval and production package management remain with the owner in W3 Core. Registered validation is available in Controls.</p>
      <div className="mt-3 flex flex-wrap gap-2"><Link className="btn" to="/controls">Open Controls</Link><Link className="btn" to="/terminal">Open Terminal</Link></div></>
    }}
    currentStateCard={{
      title: 'Current Git Status', right: status ? <Badge tone={status.branchAllowed ? 'success' : 'danger'}>{status.branchAllowed ? 'Allowed branch' : 'Branch needs attention'}</Badge> : null,
      body: loading || (status ? <div className="space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <MetricTile label="Branch" value={status.branch || 'Not reported'} />
          <MetricTile label="Current Commit" value={status.head?.slice(0, 12) || 'Not reported'} />
          <MetricTile label="Upstream" value={status.upstream || 'No upstream configured'} />
          <MetricTile label="Local Tracking Status" value={status.ahead != null && status.behind != null ? `${status.ahead} ahead · ${status.behind} behind` : 'Not available'} />
        </div>
        <p className="text-xs text-[var(--w3-text-muted)]">Tracking counts use the last fetched repository state. Connection checks do not fetch or change files.</p>
      </div> : null)
    }}
    secondaryStateCard={{
      title: 'Repository Connection', right: <Badge tone={remoteResult?.connected ? 'success' : remoteResult ? 'warning' : 'slate'}>{remoteResult?.connected ? 'Connected' : remoteResult ? 'Needs attention' : 'Not checked'}</Badge>,
      body: loading || (status ? <div className="space-y-3">
        {status.repositoryUrl ? <a className="inline-flex items-center gap-2 text-sm text-[var(--w3-gold-400)] break-all" href={status.repositoryUrl} target="_blank" rel="noreferrer">{status.repositoryUrl}<ExternalLink size={13} className="shrink-0" /></a>
          : <p className="text-sm text-[var(--w3-text-muted)]">{status.remoteConfigured ? 'A repository remote is configured for this workspace.' : 'No repository remote is configured for this workspace.'}</p>}
        <p className="text-xs text-[var(--w3-text-muted)]">Check repository access using the Forge host's existing Git credentials. Credentials are managed on the host.</p>
        <button type="button" className="btn btn-primary" disabled={!status.remoteConfigured || remote.isPending} onClick={() => remote.mutate()}><Plug size={14} />{remote.isPending ? 'Checking…' : 'Check Remote'}</button>
        {remote.isError ? <ErrorState title="Connection check failed" error={remote.error} /> : null}
        {remoteResult ? <div role="status" className="text-sm space-y-1"><p>{remoteResult.message}</p><p className="text-xs text-[var(--w3-text-muted)]">Checked {new Date(remoteResult.checkedAt).toLocaleString()}{remoteResult.remoteHead ? ` · Remote ${remoteResult.remoteHead.slice(0, 12)}` : ''}</p></div> : null}
      </div> : null)
    }}
    historyTables={status ? [{ title: 'Workspace Changes', body: <pre className="console whitespace-pre-wrap text-xs">{status.statusShort || 'No uncommitted changes.'}</pre> }] : []} />;
}
