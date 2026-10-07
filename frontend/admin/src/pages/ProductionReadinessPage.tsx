import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import { AdminListPage } from '../components/ui/AdminListPage';
import { Badge, type BadgeTone } from '../components/ui/Badge';
import { adminGet } from '../lib/api';
import type { Connections } from '../lib/connections';
import { terminalRequest, type TerminalStatus } from '../lib/terminal';
import { availableInventory, inventoryStatus, usePackageInventory, useBackupInventory, type ArtifactInventory } from '../lib/inventory';

interface GitStatus { branch: string; branchAllowed: boolean; dirty: boolean; repositoryBinding?: string; repositoryMessage?: string; configuredRepositoryUrl?: string | null }
interface ReadinessRow { label: string; status: string; tone: BadgeTone; detail: string }

// Shared console checklist. File presence is separate from owner release approval.
export function ProductionReadinessPage() {
  const connections = useQuery({ queryKey: ['connections'], queryFn: () => adminGet<Connections>('/connections') });
  const git = useQuery({ queryKey: ['git', 'status'], queryFn: () => adminGet<GitStatus>('/git/status') });
  const terminal = useQuery({ queryKey: ['admin', 'terminal', 'status'], queryFn: () => terminalRequest<TerminalStatus>('/status'), retry: false });
  const staged = usePackageInventory('staged');
  const installed = usePackageInventory('installed');
  const backups = useBackupInventory();
  const connectionData = connections.isError ? undefined : connections.data;
  const gitData = git.isError ? undefined : git.data;
  const terminalData = terminal.isError ? undefined : terminal.data;
  const rows: ReadinessRow[] = [
    { label: 'App identity', status: connections.isPending ? 'Checking' : connectionData ? connectionData.app?.name || 'W3 Forge' : 'Unavailable', tone: connectionData ? 'info' : 'slate', detail: connectionData ? `${connectionData.app?.id || 'w3forge'} owns its repository, package directories and backups.` : errorText(connections.error, 'App identity has not been reported.') },
    { label: 'W3 Core access', status: connections.isPending ? 'Checking' : connections.isError ? 'Unavailable' : connectionData?.core.configured ? 'Configured' : 'Needs setup', tone: connectionData?.core.configured ? 'info' : 'warning', detail: connections.isError ? errorText(connections.error, 'Connection settings unavailable.') : 'Core manages sign-in and per-app assignments; it does not replace this app’s repository or artifact directories.' },
    { label: 'Repository identity', status: git.isPending ? 'Checking' : gitData?.repositoryBinding === 'matched' ? 'Matched' : gitData ? 'Needs review' : 'Unavailable', tone: gitData?.repositoryBinding === 'matched' ? 'info' : 'warning', detail: gitData?.repositoryMessage || errorText(git.error, 'Review this app’s configured repository and workspace origin in GitHub / Releases.') },
    { label: 'Development branch', status: git.isPending ? 'Checking' : git.isError ? 'Unavailable' : gitData?.branchAllowed ? 'Allowed' : 'Needs review', tone: gitData?.branchAllowed ? 'success' : 'warning', detail: gitData?.branch || errorText(git.error, 'No branch reported.') },
    { label: 'Workspace', status: git.isPending ? 'Checking' : !gitData ? 'Unavailable' : gitData.dirty ? 'Changes present' : 'Clean', tone: !gitData ? 'slate' : gitData.dirty ? 'warning' : 'success', detail: git.isError ? errorText(git.error, 'Workspace status unavailable.') : 'A clean checkout does not establish test results or release approval.' },
    { label: 'Terminal', status: terminal.isPending ? 'Checking' : terminalData?.available ? 'Available' : 'Unavailable', tone: terminalData?.available ? 'success' : 'slate', detail: terminalData?.message || errorText(terminal.error, 'Host terminal availability has not been confirmed.') },
    inventoryRow('Staged packages', staged), inventoryRow('Installed package directory', installed), inventoryRow('Backup files', backups),
    { label: 'Production release', status: 'Owner review required', tone: 'warning', detail: 'Package contents, backup restore readiness, tests and live sign-in must be verified before the owner approves a release for this app.' }
  ];
  const queries = [connections, git, terminal, staged, installed, backups];
  return <AdminListPage header={{ title: 'Production Readiness', subtitle: 'Configuration and operational checks for this app.', actions: <button type="button" className="btn" disabled={queries.some(query => query.isFetching)} onClick={() => queries.forEach(query => { void query.refetch(); })}><RefreshCw size={13} /> Refresh</button> }}
    standardCard={{ title: 'Release Review', right: <Badge tone="warning">Manual review required</Badge>, body: <p className="text-sm text-[var(--w3-text-muted)]">Configuration and metadata checks support the owner's review of this app. They do not approve a release or enable production deployment.</p> }}
    currentStateCard={{ title: 'Readiness Checklist', body: <><div className="desktop-table overflow-x-auto"><table className="table-dark w-full"><thead><tr><th>Check</th><th>Status</th><th>Detail</th></tr></thead><tbody>{rows.map(row => <tr key={row.label}><td className="text-sm">{row.label}</td><td><Badge tone={row.tone}>{row.status}</Badge></td><td className="text-xs text-[var(--w3-text-muted)]">{row.detail}</td></tr>)}</tbody></table></div><div className="mobile-cards">{rows.map(row => <div className="stack-card" key={row.label}><div className="stack-card__row"><span className="stack-card__title">{row.label}</span><Badge tone={row.tone}>{row.status}</Badge></div><p className="break-words text-xs text-[var(--w3-text-muted)]">{row.detail}</p></div>)}</div></> }}
    detailsSlot={<div className="flex flex-wrap gap-2"><Link className="btn" to="/github">GitHub / Releases</Link><Link className="btn" to="/packages">Packages</Link><Link className="btn" to="/backups">Backups</Link><Link className="btn" to="/controls">Open Controls</Link><Link className="btn" to="/settings">Settings</Link></div>} />;
}
function errorText(error: unknown, fallback: string) { return error instanceof Error ? error.message : fallback; }
function inventoryRow(label: string, query: ReturnType<typeof usePackageInventory> | ReturnType<typeof useBackupInventory>): ReadinessRow {
  const state = inventoryStatus(query);
  const data = availableInventory<ArtifactInventory>(query);
  const count = data && ('packages' in data ? data.packages.length : data.backups.length);
  return { label, status: state.label, tone: state.tone, detail: data ? `${count} listed files for ${data.app.name}. ${state.message} This does not verify a release or a restore.` : state.message };
}
