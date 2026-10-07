import { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Activity, Archive, Cpu, Database, FolderTree, GitBranch, HardDrive, Lock, MemoryStick, Package, Server, ShieldAlert, Tag, Terminal } from 'lucide-react';
import { SectionHeader } from '../components/ui/SectionHeader';
import { MetricTile } from '../components/ui/MetricTile';
import { Badge } from '../components/ui/Badge';
import { DashboardTile } from '../components/operations/DashboardTile';
import { adminGet } from '../lib/api';
import { formatDuration, formatTimestamp } from '../lib/format';

interface SystemResp {
  app: string; name: string; version: string; forgeRoot: string; startedAt: string;
  uptimeSeconds: number; host: string; platform: string; nodeVersion: string;
  authority: { mayDeploy: boolean; mayTagRelease: boolean; mayModifyProductionData: boolean };
  readOnlyFoundation: boolean;
}
interface VersionResp { app: string; version: string; nodeEnv: string }
interface GitStatus { workspace: string; branch: string; dirty: boolean; head: string; upstream: string | null; branchAllowed: boolean }

// Standard Core / BuildCost System Status tile order and shells. Forge adapters
// provide only reported facts; absent telemetry is explicitly unavailable.
export function SystemStatusPage() {
  const q = useQuery({ queryKey: ['system'], queryFn: () => adminGet<SystemResp>('/system'), refetchInterval: 30_000 });
  const version = useQuery({ queryKey: ['version'], queryFn: () => adminGet<VersionResp>('/version') });
  const git = useQuery({ queryKey: ['git', 'status'], queryFn: () => adminGet<GitStatus>('/git/status'), refetchInterval: 60_000 });
  const data = q.isError ? undefined : q.data;
  const repository = git.isError ? undefined : git.data;
  return (
    <div className="space-y-4">
      <SectionHeader title="System Status" subtitle={data ? `${data.host} · ${data.platform}` : 'Runtime diagnostics and operational status.'}
        actions={<div className="flex max-w-[calc(100vw-5rem)] flex-wrap items-center gap-1.5">
          {data ? <Badge tone="gold"><Tag size={11} /><span>v{data.version}</span></Badge> : null}<Badge tone="warning">Internal Only</Badge>
        </div>} />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <DashboardTile icon={<Server size={14} />} title="Service Status" subtitle="Process and environment." loading={q.isLoading} error={q.error}>
          {data ? <div className="sys-stat-grid">
            <MetricTile label="Service" value={data.name} /><MetricTile label="Environment" value={version.isError ? 'Unavailable' : version.data?.nodeEnv ?? '—'} />
            <MetricTile label="App" value={data.app} /><MetricTile label="Version" value={<Badge tone="gold">v{data.version}</Badge>} />
            <MetricTile label="Node" value={data.nodeVersion} /><MetricTile label="Uptime" value={formatDuration(data.uptimeSeconds)} hint={`started ${formatTimestamp(data.startedAt)}`} />
          </div> : null}
        </DashboardTile>
        <UnavailableTile icon={<Database size={14} />} title="Database Status" subtitle="Database connection and latency." note="Database health telemetry is not exposed by this Forge installation." />
        <UnavailableTile icon={<Activity size={14} />} title="API Status" subtitle="Request activity and response times." note="Request metrics are not exposed by this Forge installation." />
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <UnavailableTile icon={<MemoryStick size={14} />} title="Memory Status" subtitle="Container and process footprint." note="Memory telemetry is not exposed by this Forge installation." />
        <UnavailableTile icon={<Cpu size={14} />} title="CPU Status" subtitle="Processor load and capacity." note="CPU telemetry is not exposed by this Forge installation." />
        <UnavailableTile icon={<HardDrive size={14} />} title="Root Volume" subtitle="Container root filesystem." note="Filesystem capacity is not exposed by this Forge installation." />
      </div>
      <DashboardTile icon={<FolderTree size={14} />} title="Folder Usage" subtitle="Actual on-disk size of monitored W3 Forge folders."
        status={{ tone: 'slate', label: 'Unavailable' }} loading={q.isLoading} error={q.error} noBodyPadding>
        {data ? <div className="sys-table-scroll"><table className="table-dark">
          <thead><tr><th>Folder</th><th>Path</th><th className="text-right">Size On Disk</th><th>Status</th><th>Sampled</th></tr></thead>
          <tbody><tr><td>Forge Workspace</td><td className="font-mono text-xs text-[var(--w3-text-muted)]">{data.forgeRoot}</td><td className="text-right font-mono">—</td><td><Badge tone="slate">Not Measured</Badge></td><td className="text-xs text-[var(--w3-text-muted)]">—</td></tr></tbody>
        </table></div> : null}
      </DashboardTile>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <UnavailableTile icon={<Package size={14} />} title="Package System" subtitle="Update tarball inventory." note="Package inventory is unavailable in Forge. Release packaging remains with W3 Core." />
        <UnavailableTile icon={<Archive size={14} />} title="Backup System" subtitle="App and database archive pairs." note="Backup inventory is unavailable in Forge. Backup management remains with W3 Core." />
        <DashboardTile icon={<GitBranch size={14} />} title="Git / Release" subtitle="Engineering workspace repository state."
          status={repository ? { tone: repository.dirty ? 'warning' : 'success', label: repository.dirty ? 'Dirty' : 'Clean' } : undefined}
          loading={git.isLoading} error={git.error}>
          {repository ? <>
            <div className="sys-stat-grid"><MetricTile label="Branch" value={repository.branch || '—'} /><MetricTile label="Commit" value={repository.head?.slice(0, 12) || '—'} />
              <MetricTile label="Upstream" value={repository.upstream || '—'} /><MetricTile label="App Version" value={data ? <Badge tone="gold">v{data.version}</Badge> : '—'} /></div>
            <div className="sys-commit mt-3"><div className="sys-commit__subject break-all">{repository.workspace}</div><div className="sys-commit__meta">{repository.branchAllowed ? 'Allowed development branch' : 'Branch needs attention'}</div></div>
          </> : null}
        </DashboardTile>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <DashboardTile icon={<Lock size={14} />} title="Security / Exposure" subtitle="Network reachability and guard status."
          status={{ tone: 'slate', label: 'Not Measured' }} loading={q.isLoading} error={q.error}>
          <div className="sys-section"><div className="sys-section__head"><span className="sys-section__label">Console Access</span></div>
            <p className="sys-section__note">Core-verified Forge administrators. Public reachability probes are not collected by this installation.</p>
            <div className="sys-stat-grid"><MetricTile label="Admin Guard" value="Core App Admin" /><MetricTile label="Host" value={data?.host ?? '—'} /></div>
          </div>
          {data ? <div className="sys-section mt-3"><div className="sys-section__head"><span className="sys-section__label">Operating Authority</span></div>
            <div className="flex flex-wrap gap-1.5">{[
              ['Deploy', data.authority.mayDeploy], ['Tag Releases', data.authority.mayTagRelease], ['Modify Production Data', data.authority.mayModifyProductionData]
            ].map(([label, allowed]) => <Badge key={String(label)} tone={allowed ? 'warning' : 'slate'}>{label}: {allowed ? 'Allowed' : 'Not Allowed'}</Badge>)}</div>
            <p className="sys-section__helper">W3 Core remains deployment and release authority.</p>
          </div> : null}
        </DashboardTile>
        <DashboardTile icon={<Terminal size={14} />} title="Recent Errors" subtitle="Tail of error-level log entries."
          headerActions={<Link to="/logs"><Badge tone="slate"><ShieldAlert size={11} />See Logs Page</Badge></Link>}
          status={{ tone: 'slate', label: 'Unavailable' }}>
          <div className="sys-section"><div className="sys-section__head"><span className="sys-section__label">Error Summary</span></div>
            <p className="sys-section__note">An error summary is not exposed by Forge. Open Logs to inspect a file and filter its entries.</p>
            <p className="sys-section__helper"><Link className="underline" to="/logs">Open Logs</Link></p>
          </div>
        </DashboardTile>
      </div>
    </div>
  );
}

function UnavailableTile({ icon, title, subtitle, note }: { icon: ReactNode; title: string; subtitle: string; note: string }) {
  return <DashboardTile icon={icon} title={title} subtitle={subtitle} status={{ tone: 'slate', label: 'Unavailable' }}>
    <div className="sys-section"><p className="sys-section__note">{note}</p></div>
  </DashboardTile>;
}
