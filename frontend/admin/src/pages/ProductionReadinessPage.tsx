import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import { AdminListPage } from '../components/ui/AdminListPage';
import { Badge, type BadgeTone } from '../components/ui/Badge';
import { LoadingState, ErrorState } from '../components/ui/States';
import { adminGet } from '../lib/api';
import type { Connections } from '../lib/connections';
import { terminalRequest, type TerminalStatus } from '../lib/terminal';

interface GitStatus { branch: string; branchAllowed: boolean; dirty: boolean }
interface ReadinessRow { label: string; status: string; tone: BadgeTone; detail: string }

// Same read-only checklist presentation as the shared console. Configuration
// is never presented as proof of service reachability or release approval.
export function ProductionReadinessPage() {
  const connections = useQuery({ queryKey: ['connections'], queryFn: () => adminGet<Connections>('/connections') });
  const git = useQuery({ queryKey: ['git', 'status'], queryFn: () => adminGet<GitStatus>('/git/status') });
  const terminal = useQuery({ queryKey: ['admin', 'terminal', 'status'], queryFn: () => terminalRequest<TerminalStatus>('/status'), retry: false });
  const terminalData = terminal.isError ? undefined : terminal.data;
  const rows: ReadinessRow[] = [
    { label: 'W3 Core access', status: connections.data?.core.configured ? 'Configured' : 'Needs setup', tone: connections.data?.core.configured ? 'info' : 'warning', detail: 'Core owns pairing, sign-in, two-factor authentication and per-app assignments.' },
    { label: 'Development branch', status: git.data?.branchAllowed ? 'Allowed' : 'Needs review', tone: git.data?.branchAllowed ? 'success' : 'warning', detail: git.data?.branch || 'No branch reported.' },
    { label: 'Workspace', status: git.data?.dirty ? 'Changes present' : 'Clean', tone: git.data?.dirty ? 'warning' : 'success', detail: 'A clean checkout does not establish test results or release approval.' },
    { label: 'Terminal', status: terminal.isPending ? 'Checking' : terminalData?.available ? 'Available' : 'Unavailable', tone: terminalData?.available ? 'success' : 'slate', detail: terminalData?.message || 'Host terminal availability has not been confirmed.' },
    { label: 'Packages and backups', status: 'Managed in Core', tone: 'slate', detail: 'This installation does not provide local package or backup management.' },
    { label: 'Production release', status: 'Owner review required', tone: 'warning', detail: 'Tests, backups and live sign-in must be verified before the owner approves release.' }
  ];
  const pending = connections.isPending || git.isPending;
  const error = connections.error || git.error;
  const body = pending ? <LoadingState label="Loading readiness…" /> : error ? <ErrorState error={error} /> : <>
    {terminal.isError ? <ErrorState title="Terminal status unavailable" error={terminal.error} /> : null}
    <div className="desktop-table overflow-x-auto"><table className="table-dark w-full"><thead><tr><th>Check</th><th>Status</th><th>Detail</th></tr></thead><tbody>
      {rows.map(row => <tr key={row.label}><td className="text-sm">{row.label}</td><td><Badge tone={row.tone}>{row.status}</Badge></td><td className="text-xs text-[var(--w3-text-muted)]">{row.detail}</td></tr>)}
    </tbody></table></div>
    <div className="mobile-cards">{rows.map(row => <div className="stack-card" key={row.label}><div className="stack-card__row"><span className="stack-card__title">{row.label}</span><Badge tone={row.tone}>{row.status}</Badge></div><p className="text-xs text-[var(--w3-text-muted)]">{row.detail}</p></div>)}</div>
  </>;
  return <AdminListPage header={{ title: 'Production Readiness', subtitle: 'Configuration and operational checks for this installation.', actions: <button type="button" className="btn" disabled={connections.isFetching || git.isFetching || terminal.isFetching} onClick={() => { void connections.refetch(); void git.refetch(); void terminal.refetch(); }}><RefreshCw size={13} /> Refresh</button> }}
    standardCard={{ title: 'Release Review', right: <Badge tone="warning">Manual review required</Badge>, body: <p className="text-sm text-[var(--w3-text-muted)]">Configuration checks support the owner's review. They do not approve a release or enable production deployment.</p> }}
    currentStateCard={{ title: 'Readiness Checklist', body }}
    detailsSlot={<div className="flex flex-wrap gap-2"><Link className="btn" to="/github">GitHub / Releases</Link><Link className="btn" to="/controls">Open Controls</Link><Link className="btn" to="/settings">Settings</Link></div>} />;
}
