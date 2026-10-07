import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Activity, Archive, Cpu, HardDrive, Package, PackageCheck, Settings2, ShieldAlert, Tag, Terminal } from 'lucide-react';
import { Card, CardBody, CardHeader } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { SectionHeader } from '../components/ui/SectionHeader';
import { LoadingState, ErrorState, EmptyState } from '../components/ui/States';
import { adminGet } from '../lib/api';
import { formatBytes, formatDuration, formatTimestamp } from '../lib/format';
import type { RuntimeSystem } from '../lib/runtime';
import { availableInventory, inventoryStatus, usePackageInventory, useBackupInventory, type ArtifactInventory } from '../lib/inventory';

interface OverviewResp {
  attention: { message: string; items: Array<{ severity: 'info' | 'warning' | 'danger'; label: string }> };
}

interface VersionResp { app: string; version: string; nodeEnv: string }
interface LogsResp { files: string[] }

// W3 Core / BuildCost Operations Overview: same operational tile names,
// order and card chrome. The Forge adapter renders only data its API supplies.
export function DashboardPage() {
  const overview = useQuery({ queryKey: ['overview'], queryFn: () => adminGet<OverviewResp>('/overview') });
  const system = useQuery({ queryKey: ['system'], queryFn: () => adminGet<RuntimeSystem>('/system'), refetchInterval: 30_000 });
  const version = useQuery({ queryKey: ['admin', 'version'], queryFn: () => adminGet<VersionResp>('/version') });
  const logs = useQuery({ queryKey: ['logs'], queryFn: () => adminGet<LogsResp>('/logs'), refetchInterval: 30_000 });
  const staged = usePackageInventory('staged');
  const installed = usePackageInventory('installed');
  const backups = useBackupInventory();
  const runtime = system.isError ? undefined : system.data;
  const hasMemory = runtime?.memory && Object.values(runtime.memory).some(value => value != null);
  const hasCpu = !!runtime?.cpu && (runtime.cpu.cores > 0 || !!runtime.cpu.loadAverage?.length);
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
      <Tile title="Memory / CPU" icon={<Cpu size={14} />} right={<Badge tone={hasMemory || hasCpu ? 'info' : 'slate'}>{hasMemory || hasCpu ? 'Reported' : 'Unavailable'}</Badge>}>
        {system.isPending ? <LoadingState /> : system.isError ? <ErrorState error={system.error} /> : runtime?.memory || runtime?.cpu ? <div className="space-y-2 text-xs text-[var(--w3-text-muted)]">
          {runtime.memory ? <><p>Process RSS: {formatBytes(runtime.memory.processRssBytes)}</p><p>Host memory: {formatBytes(runtime.memory.hostFreeBytes)} free / {formatBytes(runtime.memory.hostTotalBytes)} total</p></> : <p>Memory measurements unavailable.</p>}
          {runtime.cpu ? <><p>Host CPUs: {runtime.cpu.cores > 0 ? runtime.cpu.cores : 'Unavailable'}</p><p>Host load (1 / 5 / 15 min): {runtime.cpu.loadAverage?.map(value => value.toFixed(2)).join(' / ') || 'Unavailable'}</p></> : <p>CPU measurements unavailable.</p>}
          <Link className="btn" to="/system">System Status</Link>
        </div> : <EmptyState>Resource measurements are not provided by this installation.</EmptyState>}
      </Tile>
      <Tile title="Disk Usage" icon={<HardDrive size={14} />} right={<Badge tone={runtime?.disk ? 'info' : 'slate'}>{runtime?.disk ? 'Reported' : 'Unavailable'}</Badge>}>
        {system.isPending ? <LoadingState /> : system.isError ? <ErrorState error={system.error} /> : runtime?.disk ? <div className="space-y-2 text-xs text-[var(--w3-text-muted)]"><p className="break-all">Filesystem at: <code>{runtime.disk.root}</code></p><p>{formatBytes(runtime.disk.usedBytes)} used / {formatBytes(runtime.disk.sizeBytes)} total</p><p>{formatBytes(runtime.disk.availableBytes)} available</p></div> : <EmptyState>Disk measurements are not provided by this installation.</EmptyState>}
      </Tile>
      <InventoryTile title="Staged Packages" icon={<Package size={14} />} query={staged} to="/packages" />
      <InventoryTile title="Installed Packages" icon={<PackageCheck size={14} />} query={installed} to="/packages" />
      <InventoryTile title="Backup Summary" icon={<Archive size={14} />} query={backups} to="/backups" />
    </div>
  </div>;
}
function Tile({ title, icon, right, children }: { title: string; icon: ReactNode; right?: ReactNode; children: ReactNode }) {
  return <Card className="h-full"><CardHeader title={<span className="flex items-center gap-1.5">{icon}{title}</span>} right={right} /><CardBody>{children}</CardBody></Card>;
}
function InventoryTile({ title, icon, query, to }: { title: string; icon: ReactNode; query: ReturnType<typeof usePackageInventory> | ReturnType<typeof useBackupInventory>; to: string }) {
  const status = inventoryStatus(query);
  const data = availableInventory<ArtifactInventory>(query);
  const entries = data && ('packages' in data ? data.packages : data.backups);
  return <Tile title={title} icon={icon} right={<Badge tone={status.tone}>{status.label}</Badge>}>
    <div className="space-y-3">{query.isPending ? <LoadingState /> : query.isError ? <ErrorState error={query.error} /> : data && entries ? <div className="space-y-2 text-xs text-[var(--w3-text-muted)]"><div className="stat-value">{entries.length}{data.truncated ? '+' : ''}</div><p>{data.app.name} · listed files</p><p className="break-all"><code>{data.root}</code></p>{'totalSizeBytes' in data ? <p>Listed size: {formatBytes(data.totalSizeBytes)}</p> : null}<p>{status.message}</p></div> : <EmptyState>{status.message}</EmptyState>}
      <Link className="btn" to={to}>{to === '/backups' ? 'Open Backups' : 'Open Packages'}</Link>
    </div>
  </Tile>;
}
