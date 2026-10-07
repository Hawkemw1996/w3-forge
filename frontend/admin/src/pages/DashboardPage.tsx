import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Activity, Archive, Cpu, HardDrive, Package, PackageCheck, Settings2, ShieldAlert, Tag, Terminal } from 'lucide-react';
import { Card, CardBody, CardHeader } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { SectionHeader } from '../components/ui/SectionHeader';
import { LoadingState, ErrorState, EmptyState } from '../components/ui/States';
import { adminGet } from '../lib/api';
import { formatDuration, formatTimestamp } from '../lib/format';

interface OverviewResp {
  attention: { message: string; items: Array<{ severity: 'info' | 'warning' | 'danger'; label: string }> };
}
interface SystemResp {
  app: string; name: string; version: string; startedAt: string; uptimeSeconds: number; host: string;
}
interface VersionResp { app: string; version: string; nodeEnv: string }
interface LogsResp { files: string[] }

// W3 Core / BuildCost Operations Overview: same operational tile names,
// order and card chrome. The Forge adapter renders only data its API supplies.
export function DashboardPage() {
  const overview = useQuery({ queryKey: ['overview'], queryFn: () => adminGet<OverviewResp>('/overview') });
  const system = useQuery({ queryKey: ['system'], queryFn: () => adminGet<SystemResp>('/system'), refetchInterval: 30_000 });
  const version = useQuery({ queryKey: ['admin', 'version'], queryFn: () => adminGet<VersionResp>('/version') });
  const logs = useQuery({ queryKey: ['logs'], queryFn: () => adminGet<LogsResp>('/logs'), refetchInterval: 30_000 });
  return <div className="space-y-4">
    <SectionHeader title="Operations Overview" subtitle="System health, version, logs, packages, and backups."
      actions={<span className="hidden md:inline-flex" title="Dashboard layout customization is not configured for this installation."><button type="button" className="btn" disabled><Settings2 size={14} /> Customize</button></span>} />
    <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
      <Tile title="System Health" icon={<Activity size={14} />} right={<Badge tone={system.isError ? 'danger' : system.data ? 'success' : 'slate'}>{system.isError ? 'Unavailable' : system.data ? 'Responding' : 'Checking'}</Badge>}>
        {system.isPending ? <LoadingState /> : system.isError ? <ErrorState error={system.error} /> : <div className="space-y-2 text-xs text-[var(--w3-text-muted)]">
          <p className="text-sm font-semibold text-[var(--w3-text)]">{system.data.name}</p>
          <p>Host: {system.data.host}</p><p>Uptime: {formatDuration(system.data.uptimeSeconds)}</p>
          <Link className="btn" to="/system">System Status</Link>
        </div>}
      </Tile>
      <Tile title="Version" icon={<Tag size={14} />} right={version.data ? <Badge tone="gold">v{version.data.version}</Badge> : null}>
        {version.isPending ? <LoadingState /> : version.isError ? <ErrorState error={version.error} /> : <div>
          <div className="stat-value">v{version.data.version}</div>
          <div className="mt-1 text-xs text-[var(--w3-text-muted)]">{version.data.app} · {version.data.nodeEnv}</div>
          <div className="mt-1 text-[11px] text-[var(--w3-text-dim)]">up since {formatTimestamp(system.data?.startedAt)}</div>
        </div>}
      </Tile>
      <Tile title="Attention Required" icon={<ShieldAlert size={14} />} right={<Badge tone="info">Review</Badge>}>
        {overview.isPending ? <LoadingState /> : overview.isError ? <ErrorState error={overview.error} /> : <div className="space-y-2 text-xs text-[var(--w3-text-muted)]">
          <p>{overview.data.attention.message}</p>
          <ul className="space-y-2">{overview.data.attention.items.map((item, index) => <li key={index} className="flex items-start gap-2"><Badge tone={item.severity}>{item.severity}</Badge><span>{item.label}</span></li>)}</ul>
        </div>}
      </Tile>
      <div className="md:col-span-2">
        <Card className="h-full"><CardHeader title={<span className="flex items-center gap-1.5"><Terminal size={14} /> Recent Logs</span>} right={logs.data ? <Badge tone="slate">{logs.data.files.length} {logs.data.files.length === 1 ? 'File' : 'Files'}</Badge> : null} />
          <CardBody className="recent-logs-body !p-0">
            <div className="recent-logs-meta text-xs text-[var(--w3-text-muted)]">Log files · choose a file in Logs to read its latest entries.</div>
            <div className="recent-logs-inset"><div className="recent-logs-viewport">
              {logs.isPending ? <LoadingState /> : logs.isError ? <ErrorState error={logs.error} /> : logs.data.files.length ? <ul className="space-y-1 p-3 text-xs font-mono">{logs.data.files.slice(0, 8).map(file => <li className="break-all" key={file}>{file}</li>)}</ul> : <EmptyState>No log files available.</EmptyState>}
            </div><Link className="btn mt-3" to="/logs">Open Logs</Link></div>
          </CardBody>
        </Card>
      </div>
      <UnavailableTile title="Memory / CPU" icon={<Cpu size={14} />}>Resource measurements are not provided by this installation.</UnavailableTile>
      <UnavailableTile title="Disk Usage" icon={<HardDrive size={14} />}>Disk measurements are not provided by this installation.</UnavailableTile>
      <UnavailableTile title="Staged Packages" icon={<Package size={14} />}>Package staging is managed through W3 Core.</UnavailableTile>
      <UnavailableTile title="Installed Packages" icon={<PackageCheck size={14} />}>Package history is managed through W3 Core.</UnavailableTile>
      <UnavailableTile title="Backup Summary" icon={<Archive size={14} />}>Backups are managed through W3 Core.</UnavailableTile>
    </div>
  </div>;
}
function Tile({ title, icon, right, children }: { title: string; icon: ReactNode; right?: ReactNode; children: ReactNode }) {
  return <Card className="h-full"><CardHeader title={<span className="flex items-center gap-1.5">{icon}{title}</span>} right={right} /><CardBody>{children}</CardBody></Card>;
}
function UnavailableTile({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return <Tile title={title} icon={icon} right={<Badge tone="slate">Unavailable</Badge>}><EmptyState>{children}</EmptyState></Tile>;
}
