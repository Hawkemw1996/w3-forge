import { consoleApp, consoleText } from "../../../../shared/consoleApp";
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  Archive,
  Cpu,
  Database as DatabaseIcon,
  FolderTree,
  GitBranch,
  HardDrive,
  Lock,
  MemoryStick,
  Network,
  Package,
  Server,
  ShieldAlert,
  Tag,
  Terminal
} from 'lucide-react';
import { Badge, statusTone } from '../components/ui/Badge';
import { StatusPill, StatusTone } from '../components/ui/StatusPill';
import { ProgressBar } from '../components/ui/ProgressBar';
import { MetricTile } from '../components/ui/MetricTile';
import { SectionHeader } from '../components/ui/SectionHeader';
import { DashboardTile } from '../components/dashboard/DashboardTile';
import { adminGet } from '../lib/api';
import {
  formatBytes,
  formatDuration,
  formatRelative,
  formatTimestamp
} from '../lib/format';

// =============================================================================
// SystemStatusPage — v0.5.12
// =============================================================================
//
// v0.5.12 rolls the polished dashboard tile/card pattern out to System Status.
// The tile shells already came from DashboardTile (Card / CardHeader / CardBody),
// but the BODIES were a mix of raw grids, inline borders, and a broken
// `bg-[var(--w3-bg-deep)]` token (the token never existed, so that panel
// rendered transparent). v0.5.12 fixes the bodies:
//
//   - Every status sub-block lives inside a `.sys-section` inset panel so the
//     visual rhythm matches the working dashboard tiles.
//   - The Folder Usage table gets a `.sys-table-scroll` shell so wide column
//     content scrolls inside the tile body instead of overflowing the card
//     border on narrow viewports.
//   - Stat grids use `.sys-stat-grid` so they collapse cleanly on mobile.
//   - The Git commit blurb uses `.sys-commit` (real, bordered, dark inset)
//     instead of the previously-broken transparent box.
//
// Backend status calculations are unchanged. Tile data sources and the
// DashboardTile wrapper are unchanged. Dashboard pages are unchanged.

// -----------------------------------------------------------------------------
// Response types
// -----------------------------------------------------------------------------

interface SystemStatus {
  service: string;
  status: string;
  uptimeSeconds: number;
  startedAt: string;
  app: string;
  version: string;
  nodeEnv: string;
  hostname: string;
  platform: string;
  nodeVersion: string;
  database: { status: string; latencyMs: number | null };
  // v0.5.3.1: back-compat top-level fields plus structured process/container.
  memory: {
    rssBytes: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
    process?: {
      rssBytes: number;
      heapUsedBytes: number;
      heapTotalBytes: number;
      heapUsagePercent: number;
      externalBytes: number;
      arrayBuffersBytes: number;
    };
    container?: {
      usedBytes: number;
      limitBytes: number | null;
      availableBytes: number | null;
      usagePercent: number | null;
      source: 'cgroup-v2' | 'meminfo' | 'os' | 'unavailable';
      swap?: {
        usedBytes: number | null;
        limitBytes: number | null;
        source: 'cgroup-v2' | 'meminfo' | 'unavailable';
      };
    };
  };
  cpu: { loadAverage: number[]; cores: number };
  /** Legacy flat list (root + folders). Kept for back-compat; prefer
   *  `diskUsage` for v0.5.5+ rendering. */
  disk: Array<{
    path: string;
    sizeBytes: number | null;
    usedBytes: number | null;
    availableBytes: number | null;
    usePercent: number | null;
    available: boolean;
  }>;
  /** v0.5.5 split disk shape. */
  diskUsage?: {
    rootVolume: {
      path: string;
      sizeBytes: number | null;
      usedBytes: number | null;
      availableBytes: number | null;
      usePercent: number | null;
      available: boolean;
    };
    folders: Array<{
      path: string;
      sizeBytes: number | null;
      status: 'ok' | 'missing' | 'unavailable';
      measuredAt: string;
    }>;
    monitoredFolders: string[];
  };
}

interface GitStatus {
  deployRoot: string;
  isRepo: boolean;
  branch: string | null;
  headSha: string | null;
  headShortSha: string | null;
  describedTag: string | null;
  clean: boolean | null;
  uncommittedCount: number | null;
  remote: string | null;
  lastCommit: {
    sha: string;
    shortSha: string;
    author: string;
    date: string;
    subject: string;
  } | null;
  releaseVersion: string | null;
  status: string;
}

interface PackageEntry {
  name: string;
  sizeBytes: number;
  mtime: string;
  parsedVersion: string | null;
}

interface BackupEntry {
  pairTimestamp: string | null;
  appArchive: { name: string; sizeBytes: number; mtime: string } | null;
  dbArchive: { name: string; sizeBytes: number; mtime: string } | null;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

// Friendly labels for the disk paths the backend reports. Order matters: the
// dashboard always shows root first then the W3 BuildCost paths in deploy order.
const DISK_LABELS: Record<string, string> = {
  '/': 'Root (/)',
  [consoleText('/opt/w3buildcost')]: 'App Dir',
  [consoleText('/opt/w3buildcost-deploy')]: 'Deploy Staging',
  [consoleText('/opt/w3buildcost-update-packages')]: 'Update Packages',
  [consoleText('/opt/w3buildcost-update-packages/installed')]: 'Installed Packages',
  [consoleText('/opt/w3buildcost-backups')]: 'Backups',
  [consoleText('/opt/logs/w3buildcost')]: 'Logs',
  [consoleText('/opt/w3buildcost-scripts')]: 'Scripts'
};

function diskLabel(p: string): string {
  return DISK_LABELS[p] ?? p;
}

// v0.5.5: folder usage status label — we never synthesize a fake percent
// for folders. Sizes are absolute, not fractions of a filesystem.
function folderSizeLabel(
  status: 'ok' | 'missing' | 'unavailable',
  sizeBytes: number | null,
  formatter: (b: number | null) => string
): string {
  if (status === 'missing') return 'Missing';
  if (status === 'unavailable') return 'Unavailable';
  return formatter(sizeBytes);
}

function diskTone(pct: number | null): StatusTone {
  if (pct == null) return 'slate';
  if (pct >= 90) return 'danger';
  if (pct >= 75) return 'warning';
  return 'success';
}

// -----------------------------------------------------------------------------
// Page
// -----------------------------------------------------------------------------

export function SystemStatusPage() {
  const sys = useQuery({
    queryKey: ['admin', 'system', 'status'],
    queryFn: () => adminGet<SystemStatus>('/system/status'),
    refetchInterval: 15_000
  });
  const git = useQuery({
    queryKey: ['admin', 'git', 'status'],
    queryFn: () => adminGet<GitStatus>('/git/status'),
    refetchInterval: 60_000
  });
  const staged = useQuery({
    queryKey: ['admin', 'packages', 'staged'],
    queryFn: () =>
      adminGet<{ root: string; packages: PackageEntry[] }>('/packages/staged'),
    refetchInterval: 60_000
  });
  const installed = useQuery({
    queryKey: ['admin', 'packages', 'installed'],
    queryFn: () =>
      adminGet<{ root: string; packages: PackageEntry[] }>('/packages/installed'),
    refetchInterval: 60_000
  });
  const backups = useQuery({
    queryKey: ['admin', 'backups'],
    queryFn: () =>
      adminGet<{ root: string; backups: BackupEntry[]; totalSizeBytes: number }>(
        '/backups'
      ),
    refetchInterval: 60_000
  });

  const data = sys.data;
  // v0.5.5: prefer the explicit split shape. Fall back to the legacy flat
  // array only if a future deploy somehow returns the old payload.
  const rootDisk = data?.diskUsage?.rootVolume ?? data?.disk.find((d) => d.path === '/');
  const folderUsage = data?.diskUsage?.folders ?? [];

  const heapPct = data
    ? Math.round(
        (data.memory.heapUsedBytes / Math.max(1, data.memory.heapTotalBytes)) * 100
      )
    : 0;
  const load1 = data?.cpu.loadAverage[0] ?? 0;
  const cpuPct = data
    ? Math.min(100, Math.round((load1 / Math.max(1, data.cpu.cores)) * 100))
    : 0;

  return (
    <div className="space-y-4">
      <SectionHeader
        title="System Status"
        subtitle={
          data ? `${data.hostname} · ${data.platform}` : 'Loading host info…'
        }
        actions={
          <div className="flex flex-wrap items-center gap-1.5">
            {data ? (
              <>
                <StatusPill tone={statusTone(data.status) as StatusTone} pulse>
                  <Activity size={11} /> Service: {data.status}
                </StatusPill>
                <StatusPill tone={statusTone(data.database.status) as StatusTone}>
                  <DatabaseIcon size={11} /> DB: {data.database.status}
                </StatusPill>
                <Badge tone="gold">
                  <Tag size={11} />
                  <span>v{data.version}</span>
                </Badge>
              </>
            ) : null}
            <Badge tone="warning">Internal Only</Badge>
          </div>
        }
      />

      {/* Row 1: Service · Database · API */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <DashboardTile
          icon={<Server size={14} />}
          title="Service Status"
          subtitle="Process and environment."
          status={
            data
              ? {
                  tone: statusTone(data.status) as StatusTone,
                  label: data.status,
                  pulse: true
                }
              : undefined
          }
          loading={sys.isLoading}
          error={sys.error}
        >
          {data ? (
            <div className="sys-stat-grid">
              <MetricTile label="Service" value={data.service} />
              <MetricTile label="Environment" value={data.nodeEnv} />
              <MetricTile label="App" value={data.app} />
              <MetricTile
                label="Version"
                value={<Badge tone="gold">v{data.version}</Badge>}
              />
              <MetricTile label="Node" value={data.nodeVersion} />
              <MetricTile
                label="Uptime"
                value={formatDuration(data.uptimeSeconds)}
                hint={`started ${formatTimestamp(data.startedAt)}`}
              />
            </div>
          ) : null}
        </DashboardTile>

        <DashboardTile
          icon={<DatabaseIcon size={14} />}
          title="Database Status"
          subtitle={'PostgreSQL · ' + consoleApp.databaseName + '.'}
          status={
            data
              ? {
                  tone: statusTone(data.database.status) as StatusTone,
                  label: data.database.status
                }
              : undefined
          }
          loading={sys.isLoading}
          error={sys.error}
        >
          {data ? (
            <div className="sys-stat-grid">
              <MetricTile
                label="Status"
                value={
                  <StatusPill tone={statusTone(data.database.status) as StatusTone}>
                    {data.database.status}
                  </StatusPill>
                }
              />
              <MetricTile
                label="Latency"
                value={
                  data.database.latencyMs == null
                    ? '—'
                    : `${data.database.latencyMs.toFixed(1)} ms`
                }
              />
              <MetricTile label="Engine" value="PostgreSQL 15" />
              <MetricTile label="Database" value={consoleApp.databaseName} />
            </div>
          ) : null}
        </DashboardTile>

        <DashboardTile
          icon={<Network size={14} />}
          title="API Status"
          subtitle="HTTP request metrics."
          status={{ tone: 'slate', label: 'Not Wired' }}
        >
          <div className="sys-section">
            <div className="sys-section__head">
              <span className="sys-section__label">Planned · v0.6.x</span>
            </div>
            <p className="sys-section__note">
              Request-rate, p95 latency, and error-rate counters are not collected
              in the current Admin Console foundation phase. They are planned for
              the v0.6.x request-metrics middleware.
            </p>
            <div className="sys-stat-grid">
              <MetricTile label="Reqs / Min" value="—" />
              <MetricTile label="p95 Latency" value="—" />
              <MetricTile label="Error Rate" value="—" />
              <MetricTile label="Active Conns" value="—" />
            </div>
          </div>
        </DashboardTile>
      </div>

      {/* Row 2: Memory · CPU · Disk Root */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <DashboardTile
          icon={<MemoryStick size={14} />}
          title="Memory Status"
          subtitle="Container and process footprint."
          loading={sys.isLoading}
          error={sys.error}
          status={
            data?.memory.container?.usagePercent != null
              ? {
                  tone:
                    data.memory.container.usagePercent >= 90
                      ? 'danger'
                      : data.memory.container.usagePercent >= 80
                        ? 'warning'
                        : 'success',
                  label: `Container ${Math.round(data.memory.container.usagePercent)}%`
                }
              : undefined
          }
        >
          {data ? (
            <>
              {/* Container memory — the real signal */}
              <div className="sys-section">
                <div className="sys-section__head">
                  <span className="sys-section__label">Container Memory</span>
                  {data.memory.container?.source ? (
                    <span className="sys-section__meta">
                      {data.memory.container.source}
                    </span>
                  ) : null}
                </div>
                {data.memory.container && data.memory.container.limitBytes ? (
                  <>
                    <div className="sys-metric">
                      <div className="sys-metric__head">
                        <span className="sys-metric__label">Used / Limit</span>
                        <span className="sys-metric__value">
                          {formatBytes(data.memory.container.usedBytes)} /{' '}
                          {formatBytes(data.memory.container.limitBytes)}{' '}
                          ({Math.round(data.memory.container.usagePercent ?? 0)}%)
                        </span>
                      </div>
                      <ProgressBar
                        value={Math.round(data.memory.container.usagePercent ?? 0)}
                        ariaLabel="Container memory usage"
                      />
                    </div>
                    <div className="sys-stat-grid">
                      <MetricTile
                        label="Available"
                        value={
                          data.memory.container.availableBytes != null
                            ? formatBytes(data.memory.container.availableBytes)
                            : '—'
                        }
                      />
                      <MetricTile
                        label="Swap"
                        value={
                          data.memory.container.swap &&
                          data.memory.container.swap.usedBytes != null
                            ? `${formatBytes(data.memory.container.swap.usedBytes)}${
                                data.memory.container.swap.limitBytes
                                  ? ` / ${formatBytes(
                                      data.memory.container.swap.limitBytes
                                    )}`
                                  : ''
                              }`
                            : '—'
                        }
                      />
                    </div>
                  </>
                ) : (
                  <p className="sys-section__note">
                    Container Memory Metrics Unavailable. Falling Back To Process Stats Only.
                  </p>
                )}
              </div>

              {/* Process memory — informational only, never drives a Critical alert */}
              <div className="sys-section">
                <div className="sys-section__head">
                  <span className="sys-section__label">{consoleText("W3 BuildCost")} Process Memory</span>
                </div>
                <div className="sys-stat-grid">
                  <MetricTile label="RSS" value={formatBytes(data.memory.rssBytes)} />
                  <MetricTile
                    label="Heap Used / Total"
                    value={`${formatBytes(data.memory.heapUsedBytes)} / ${formatBytes(
                      data.memory.heapTotalBytes
                    )} (${heapPct}%)`}
                  />
                  <MetricTile
                    label="External"
                    value={
                      data.memory.process?.externalBytes != null
                        ? formatBytes(data.memory.process.externalBytes)
                        : '—'
                    }
                  />
                  <MetricTile
                    label="Array Buffers"
                    value={
                      data.memory.process?.arrayBuffersBytes != null
                        ? formatBytes(data.memory.process.arrayBuffersBytes)
                        : '—'
                    }
                  />
                </div>
                <p className="sys-section__helper">
                  Heap Auto-Grows Up To The Container Limit — A High Heap Percent Is
                  Normal And Does Not Indicate Memory Pressure On Its Own.
                </p>
              </div>
            </>
          ) : null}
        </DashboardTile>

        <DashboardTile
          icon={<Cpu size={14} />}
          title="CPU Status"
          subtitle={data ? `${data.cpu.cores} Cores` : undefined}
          loading={sys.isLoading}
          error={sys.error}
        >
          {data ? (
            <div className="sys-section">
              <div className="sys-section__head">
                <span className="sys-section__label">CPU Load</span>
                <span className="sys-section__meta">{data.cpu.cores} cores</span>
              </div>
              <div className="sys-metric">
                <div className="sys-metric__head">
                  <span className="sys-metric__label">Load (1m / cores)</span>
                  <span className="sys-metric__value">
                    {load1.toFixed(2)} ({cpuPct}%)
                  </span>
                </div>
                <ProgressBar value={cpuPct} ariaLabel="CPU load" />
              </div>
              <div className="sys-stat-grid">
                <MetricTile label="Cores" value={data.cpu.cores} />
                <MetricTile
                  label="Load 1 / 5 / 15"
                  value={data.cpu.loadAverage.map((n) => n.toFixed(2)).join(' · ')}
                />
              </div>
            </div>
          ) : null}
        </DashboardTile>

        <DashboardTile
          icon={<HardDrive size={14} />}
          title="Root Volume"
          subtitle="Container root filesystem."
          status={
            rootDisk
              ? {
                  tone: diskTone(rootDisk.usePercent),
                  label:
                    rootDisk.usePercent == null
                      ? 'Unknown'
                      : `${rootDisk.usePercent}% Used`
                }
              : undefined
          }
          loading={sys.isLoading}
          error={sys.error}
          empty={!rootDisk}
          emptyContent="Root Volume Not Reported."
        >
          {rootDisk ? (
            <div className="sys-section">
              <div className="sys-section__head">
                <span className="sys-section__label">Root Volume Usage</span>
                <span className="sys-section__meta">
                  {rootDisk.usePercent != null ? `${rootDisk.usePercent}%` : '—'}
                </span>
              </div>
              <ProgressBar
                value={rootDisk.usePercent ?? 0}
                ariaLabel="Root volume usage"
              />
              <div className="sys-stat-grid sys-stat-grid--3">
                <MetricTile label="Total" value={formatBytes(rootDisk.sizeBytes)} />
                <MetricTile label="Used" value={formatBytes(rootDisk.usedBytes)} />
                <MetricTile
                  label="Avail"
                  value={formatBytes(rootDisk.availableBytes)}
                />
              </div>
            </div>
          ) : null}
        </DashboardTile>
      </div>

      {/* Row 3: Folder Usage (full width) — v0.5.5.
           This tile shows the actual on-disk size of each monitored W3 BuildCost
           operational folder (du -sb). v0.5.12 wraps the table in a
           `.sys-table-scroll` shell so wide content stays inside the tile body
           on narrow viewports and the table never visually escapes the card
           rounded corners. */}
      <DashboardTile
        icon={<FolderTree size={14} />}
        title="Folder Usage"
        subtitle={consoleText("Actual on-disk size of monitored W3 BuildCost folders.")}
        loading={sys.isLoading}
        error={sys.error}
        noBodyPadding
        empty={folderUsage.length === 0}
        emptyContent="No Monitored Folders Reported."
      >
        {folderUsage.length > 0 ? (
          <div className="sys-table-scroll">
            <table className="table-dark">
              <thead>
                <tr>
                  <th>Folder</th>
                  <th>Path</th>
                  <th className="text-right">Size On Disk</th>
                  <th>Status</th>
                  <th>Sampled</th>
                </tr>
              </thead>
              <tbody>
                {folderUsage.map((f) => (
                  <tr key={f.path}>
                    <td>{diskLabel(f.path)}</td>
                    <td className="font-mono text-xs text-[var(--w3-text-muted)]">
                      {f.path}
                    </td>
                    <td className="text-right font-mono">
                      {folderSizeLabel(f.status, f.sizeBytes, formatBytes)}
                    </td>
                    <td>
                      {f.status === 'ok' ? (
                        <Badge tone="success">OK</Badge>
                      ) : f.status === 'missing' ? (
                        <Badge tone="slate">Missing</Badge>
                      ) : (
                        <Badge tone="warning">Unavailable</Badge>
                      )}
                    </td>
                    <td className="text-xs text-[var(--w3-text-muted)]">
                      {f.measuredAt ? formatRelative(f.measuredAt) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </DashboardTile>

      {/* Row 4: Package System · Backup System · Git / Release */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <DashboardTile
          icon={<Package size={14} />}
          title="Package System"
          subtitle="Update tarball inventory."
          loading={staged.isLoading || installed.isLoading}
          error={staged.error ?? installed.error}
        >
          <div className="sys-stat-grid">
            <MetricTile
              label="Staged"
              value={staged.data?.packages.length ?? '—'}
              hint={staged.data?.root}
            />
            <MetricTile
              label="Installed"
              value={installed.data?.packages.length ?? '—'}
              hint={installed.data?.root}
            />
            <MetricTile
              label="Latest Staged"
              value={staged.data?.packages[0]?.name ?? 'None'}
              hint={
                staged.data?.packages[0]
                  ? formatRelative(staged.data.packages[0].mtime)
                  : undefined
              }
            />
            <MetricTile
              label="Latest Installed"
              value={installed.data?.packages[0]?.name ?? 'None'}
              hint={
                installed.data?.packages[0]
                  ? formatRelative(installed.data.packages[0].mtime)
                  : undefined
              }
            />
          </div>
        </DashboardTile>

        <DashboardTile
          icon={<Archive size={14} />}
          title="Backup System"
          subtitle="App and database archive pairs."
          loading={backups.isLoading}
          error={backups.error}
        >
          {(() => {
            const latest = backups.data?.backups[0];
            return (
              <div className="sys-stat-grid">
                <MetricTile
                  label="Pairs Stored"
                  value={backups.data?.backups.length ?? '—'}
                  hint={backups.data?.root}
                />
                <MetricTile
                  label="Total Size"
                  value={
                    backups.data?.totalSizeBytes != null
                      ? formatBytes(backups.data.totalSizeBytes)
                      : '—'
                  }
                />
                <MetricTile
                  label="Latest App"
                  value={latest?.appArchive?.name ?? 'None'}
                  hint={
                    latest?.appArchive
                      ? formatRelative(latest.appArchive.mtime)
                      : undefined
                  }
                />
                <MetricTile
                  label="Latest DB"
                  value={latest?.dbArchive?.name ?? 'None'}
                  hint={
                    latest?.dbArchive
                      ? formatRelative(latest.dbArchive.mtime)
                      : undefined
                  }
                />
              </div>
            );
          })()}
        </DashboardTile>

        <DashboardTile
          icon={<GitBranch size={14} />}
          title="Git / Release"
          subtitle="Deploy-staging repository state."
          status={
            git.data
              ? git.data.isRepo
                ? git.data.clean === false
                  ? { tone: 'warning', label: 'Dirty' }
                  : { tone: 'success', label: 'Clean' }
                : { tone: 'slate', label: 'Not A Repo' }
              : undefined
          }
          loading={git.isLoading}
          error={git.error}
        >
          {git.data ? (
            git.data.isRepo ? (
              <>
                <div className="sys-stat-grid">
                  <MetricTile label="Branch" value={git.data.branch ?? '—'} />
                  <MetricTile
                    label="Commit"
                    value={git.data.headShortSha ?? '—'}
                  />
                  <MetricTile
                    label="Described Tag"
                    value={git.data.describedTag ?? '—'}
                  />
                  <MetricTile
                    label="Release Version"
                    value={
                      git.data.releaseVersion ? (
                        <Badge tone="gold">v{git.data.releaseVersion}</Badge>
                      ) : (
                        '—'
                      )
                    }
                  />
                </div>
                {git.data.lastCommit ? (
                  <div className="sys-commit mt-3">
                    <div className="sys-commit__subject">
                      {git.data.lastCommit.subject}
                    </div>
                    <div className="sys-commit__meta">
                      {git.data.lastCommit.author} ·{' '}
                      {formatRelative(git.data.lastCommit.date)}
                    </div>
                  </div>
                ) : null}
              </>
            ) : (
              <div className="sys-section">
                <p className="sys-section__note">
                  {git.data.deployRoot} is not a git repository.
                </p>
              </div>
            )
          ) : null}
        </DashboardTile>
      </div>

      {/* Row 5: Security / Exposure · Recent Errors */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <DashboardTile
          icon={<Lock size={14} />}
          title="Security / Exposure"
          subtitle="Network reachability and guard status."
          status={{ tone: 'slate', label: 'Not Wired' }}
        >
          <div className="sys-section">
            <div className="sys-section__head">
              <span className="sys-section__label">Planned · v0.6.x</span>
            </div>
            <p className="sys-section__note">
              Public reachability probes (LAN, Tailscale, Caddy) and admin guard
              hits are not collected in the current Admin Console foundation
              phase. They are planned for the v0.6.x security module.
            </p>
            <div className="sys-stat-grid">
              <MetricTile label="LAN Reachable" value="—" />
              <MetricTile label="Tailscale" value="—" />
              <MetricTile label="Caddy" value="—" />
              <MetricTile label="Admin Guard" value="Localhost Only" />
            </div>
          </div>
        </DashboardTile>

        <DashboardTile
          icon={<Terminal size={14} />}
          title="Recent Errors"
          subtitle="Tail of error-level log entries."
          headerActions={
            <Badge tone="slate">
              <ShieldAlert size={11} /> See Logs Page
            </Badge>
          }
          status={{ tone: 'slate', label: 'Not Wired' }}
        >
          <div className="sys-section">
            <div className="sys-section__head">
              <span className="sys-section__label">Planned · v0.6.x</span>
            </div>
            <p className="sys-section__note">
              A live error-tail tile is planned for v0.6.x. For now, the full
              error-level filter is exposed on the Logs page.
            </p>
            <p className="sys-section__helper">
              Open <span className="font-mono">Logs → Filter: error</span> for the
              current error stream.
            </p>
          </div>
        </DashboardTile>
      </div>
    </div>
  );
}
