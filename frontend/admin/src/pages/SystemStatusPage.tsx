import { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Activity, Archive, Cpu, Database, FolderTree, GitBranch, HardDrive, Lock, MemoryStick, Package, Server, ShieldAlert, Tag, Terminal } from 'lucide-react';
import { SectionHeader } from '../components/ui/SectionHeader';
import { MetricTile } from '../components/ui/MetricTile';
import { Badge } from '../components/ui/Badge';
import { DashboardTile } from '../components/operations/DashboardTile';
import { adminGet } from '../lib/api';
import { formatBytes, formatDuration, formatTimestamp } from '../lib/format';
import type { RuntimeSystem } from '../lib/runtime';
import { availableInventory, inventoryStatus, usePackageInventory, useBackupInventory, type ArtifactInventory } from '../lib/inventory';
import { LoadingState, EmptyState, ErrorState } from '../components/ui/States';


interface VersionResp { app: string; version: string; nodeEnv: string }
interface GitStatus { workspace: string; branch: string; dirty: boolean; head: string; upstream: string | null; branchAllowed: boolean }

// Standard Core / BuildCost System Status tile order and shells. Forge adapters
// provide only reported facts; absent telemetry is explicitly unavailable.
export function SystemStatusPage() {
  const q = useQuery({ queryKey: ['system'], queryFn: () => adminGet<RuntimeSystem>('/system'), refetchInterval: 30_000 });
  const version = useQuery({ queryKey: ['version'], queryFn: () => adminGet<VersionResp>('/version') });
  const git = useQuery({ queryKey: ['git', 'status'], queryFn: () => adminGet<GitStatus>('/git/status'), refetchInterval: 60_000 });
  const staged = usePackageInventory('staged');
  const installed = usePackageInventory('installed');
  const backups = useBackupInventory();
  const data = q.isError ? undefined : q.data;
  const hasMemory = data?.memory && Object.values(data.memory).some(value => value != null);
  const hasCpu = !!data?.cpu && (data.cpu.cores > 0 || !!data.cpu.loadAverage?.length);
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
        <DashboardTile icon={<MemoryStick size={14} />} title="Memory Status" subtitle="Host and Forge process footprint." loading={q.isPending} error={q.error} status={{ tone: hasMemory ? 'info' : 'slate', label: hasMemory ? 'Reported' : 'Unavailable' }}>
          {data?.memory ? <div className="sys-stat-grid"><MetricTile label="Process RSS" value={formatBytes(data.memory.processRssBytes)} /><MetricTile label="Process Heap Used" value={formatBytes(data.memory.processHeapUsedBytes)} /><MetricTile label="Process Heap Total" value={formatBytes(data.memory.processHeapTotalBytes)} /><MetricTile label="Host Total" value={formatBytes(data.memory.hostTotalBytes)} /><MetricTile label="Host Free" value={formatBytes(data.memory.hostFreeBytes)} /></div> : <EmptyState>Memory telemetry is unavailable.</EmptyState>}
        </DashboardTile>
        <DashboardTile icon={<Cpu size={14} />} title="CPU Status" subtitle="Host processor count and load average." loading={q.isPending} error={q.error} status={{ tone: hasCpu ? 'info' : 'slate', label: hasCpu ? 'Reported' : 'Unavailable' }}>
          {data?.cpu ? <><div className="sys-stat-grid"><MetricTile label="Host CPUs" value={data.cpu.cores > 0 ? data.cpu.cores : 'Unavailable'} /><MetricTile label="1 Minute Load" value={data.cpu.loadAverage?.[0]?.toFixed(2) ?? 'Unavailable'} /><MetricTile label="5 Minute Load" value={data.cpu.loadAverage?.[1]?.toFixed(2) ?? 'Unavailable'} /><MetricTile label="15 Minute Load" value={data.cpu.loadAverage?.[2]?.toFixed(2) ?? 'Unavailable'} /></div><p className="sys-section__helper">Load average is host-wide and is not CPU utilization. It is unavailable on unsupported platforms.</p></> : <EmptyState>CPU telemetry is unavailable.</EmptyState>}
        </DashboardTile>
        <DashboardTile icon={<HardDrive size={14} />} title="Root Volume" subtitle="Filesystem containing the Forge workspace." loading={q.isPending} error={q.error} status={{ tone: data?.disk ? 'info' : 'slate', label: data?.disk ? 'Reported' : 'Unavailable' }}>
          {data?.disk ? <><p className="mb-3 break-all text-xs font-mono text-[var(--w3-text-muted)]">{data.disk.root}</p><div className="sys-stat-grid"><MetricTile label="Total" value={formatBytes(data.disk.sizeBytes)} /><MetricTile label="Used" value={formatBytes(data.disk.usedBytes)} /><MetricTile label="Available" value={formatBytes(data.disk.availableBytes)} /></div></> : <EmptyState>Filesystem capacity is unavailable.</EmptyState>}
        </DashboardTile>
      </div>
      <DashboardTile icon={<FolderTree size={14} />} title="Folder Usage" subtitle="Actual on-disk size of monitored W3 Forge folders."
        status={{ tone: 'slate', label: 'Unavailable' }} loading={q.isLoading} error={q.error} noBodyPadding>
        {data ? <div className="sys-table-scroll"><table className="table-dark">
          <thead><tr><th>Folder</th><th>Path</th><th className="text-right">Size On Disk</th><th>Status</th><th>Sampled</th></tr></thead>
          <tbody><tr><td>Forge Workspace</td><td className="font-mono text-xs text-[var(--w3-text-muted)]">{data.forgeRoot}</td><td className="text-right font-mono">—</td><td><Badge tone="slate">Not Measured</Badge></td><td className="text-xs text-[var(--w3-text-muted)]">—</td></tr></tbody>
        </table></div> : null}
      </DashboardTile>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <DashboardTile icon={<Package size={14} />} title="Package System" subtitle="This app's staged and installed-directory inventories.">
          <div className="space-y-4"><InventoryDetail query={staged} label="Staged Packages" /><InventoryDetail query={installed} label="Installed Packages" /><Link className="btn" to="/packages">Open Packages</Link></div>
        </DashboardTile>
        <DashboardTile icon={<Archive size={14} />} title="Backup System" subtitle="This app's archive and database file metadata.">
          <div className="space-y-4"><InventoryDetail query={backups} label="Backup Files" /><Link className="btn" to="/backups">Open Backups</Link></div>
        </DashboardTile>
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
            <p className="sys-section__helper">Each app owns its repository and artifacts. Production release approval remains with the owner.</p>
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

function InventoryDetail({ query, label }: { query: ReturnType<typeof usePackageInventory> | ReturnType<typeof useBackupInventory>; label: string }) {
  const status = inventoryStatus(query);
  const data = availableInventory<ArtifactInventory>(query);
  const entries = data && ('packages' in data ? data.packages : data.backups);
  return <div className="space-y-2"><div className="flex flex-wrap items-center justify-between gap-2 text-xs"><span>{label}</span><Badge tone={status.tone}>{status.label}</Badge></div>{query.isPending ? <LoadingState /> : query.isError ? <ErrorState error={query.error} /> : data && entries ? <div className="space-y-1 text-xs text-[var(--w3-text-muted)]"><p>{entries.length} listed file{entries.length === 1 ? '' : 's'} · {data.app.name}</p><p className="break-all"><code>{data.root}</code></p>{'totalSizeBytes' in data ? <p>Listed size: {formatBytes(data.totalSizeBytes)}</p> : null}<p>{status.message}</p></div> : <EmptyState>{status.message}</EmptyState>}</div>;
}
