import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { GitBranch, RefreshCw } from 'lucide-react';
import { adminGet } from '../lib/api';
import { Card, CardBody, CardHeader } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { SectionHeader } from '../components/ui/SectionHeader';
import { LoadingState, ErrorState } from '../components/ui/States';

interface GitStatus { workspace: string; branch: string; branchAllowed: boolean; dirty: boolean; statusShort: string; devBranches: string[]; }
export function GitHubValidationPage() {
  const query = useQuery({ queryKey: ['git', 'status'], queryFn: () => adminGet<GitStatus>('/git/status') });
  return <div className="space-y-4">
    <SectionHeader title="GitHub Validation" subtitle="Review the configured engineering workspace before running its registered checks."
      actions={<button type="button" className="btn" disabled={query.isFetching} onClick={() => void query.refetch()}><RefreshCw size={14} /> Refresh</button>} />
    {query.isLoading ? <LoadingState /> : query.isError ? <ErrorState error={query.error} /> : query.data ? <>
      <Card><CardHeader title={<span className="flex items-center gap-2"><GitBranch size={16} /> Development branch</span>}
        right={<Badge tone={query.data.branchAllowed ? 'success' : 'danger'}>{query.data.branchAllowed ? 'Allowed branch' : 'Branch needs attention'}</Badge>} />
        <CardBody><p className="font-mono text-sm">{query.data.branch || 'No branch reported'}</p><p className="text-xs text-[var(--w3-text-muted)] break-all">{query.data.workspace}</p></CardBody></Card>
      <Card><CardHeader title="Workspace changes" right={<Badge tone={query.data.dirty ? 'warning' : 'success'}>{query.data.dirty ? 'Changes present' : 'Clean'}</Badge>} />
        <CardBody><pre className="console whitespace-pre-wrap text-xs">{query.data.statusShort || 'No uncommitted changes.'}</pre></CardBody></Card>
      <Card><CardHeader title="Registered validation" /><CardBody><p className="text-sm text-[var(--w3-text-muted)] mb-3">Run configuration, branch, tests and review-readiness checks from Controls. Results apply to the configured Forge workspace.</p><Link className="btn btn-primary" to="/controls">Open Controls</Link></CardBody></Card>
    </> : null}
  </div>;
}
