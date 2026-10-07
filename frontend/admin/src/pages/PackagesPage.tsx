import { consoleText } from "../../../../shared/consoleApp";
import { useQuery } from '@tanstack/react-query';
import { Lock } from 'lucide-react';
import { AdminListPage } from '../components/ui/AdminListPage';
import { Badge } from '../components/ui/Badge';
import { EmptyState, ErrorState, LoadingState } from '../components/ui/States';
import { adminGet } from '../lib/api';
import { formatBytes, formatTimestamp } from '../lib/format';

interface PackageEntry {
  name: string;
  path: string;
  sizeBytes: number;
  mtime: string;
  validName: boolean;
  parsedVersion: string | null;
}

interface PackagesResponse {
  root: string;
  packages: PackageEntry[];
}

interface VersionInfo {
  app: string;
  version: string;
  nodeEnv: string;
  startedAt: string;
}

export function PackagesPage() {
  const versionQ = useQuery({
    queryKey: ['admin', 'version'],
    queryFn: () => adminGet<VersionInfo>('/version')
  });
  const stagedQ = useQuery({
    queryKey: ['admin', 'packages', 'staged'],
    queryFn: () => adminGet<PackagesResponse>('/packages/staged'),
    refetchInterval: 30_000
  });
  const installedQ = useQuery({
    queryKey: ['admin', 'packages', 'installed'],
    queryFn: () => adminGet<PackagesResponse>('/packages/installed'),
    refetchInterval: 60_000
  });

  const currentVersion = versionQ.data?.version ?? null;

  return (
    <AdminListPage
      header={{
        title: 'Packages',
        subtitle: 'Read-Only Listing Of Staged And Installed Release Tarballs.',
        actions: (
          <>
            <Badge tone="warning">Read Only</Badge>
            {currentVersion ? (
              <Badge tone="gold">Installed: v{currentVersion}</Badge>
            ) : null}
          </>
        )
      }}
      standardCard={{
        title: 'Package Naming Standard',
        subtitle: consoleText('W3 BuildCost Release Tarballs Must Use The Canonical Name Below.'),
        body: (
          <>
            <code
              className="rounded px-2 py-1 text-xs font-mono"
              style={{
                background: 'var(--w3-navy-800)',
                border: '1px solid var(--w3-border)',
                color: 'var(--w3-text)'
              }}
            >
              {consoleText("w3buildcost-vX")}.Y.Z.tar.gz
            </code>
            <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-[var(--w3-text-muted)]">
              <li>
                Single Canonical Format For Every Release Build (lowercase{' '}
                <code className="font-mono text-[var(--w3-text)]">{consoleText("w3buildcost-v")}</code> Prefix).
              </li>
              <li>
                Files Not Matching The Pattern Are Listed But Flagged{' '}
                <Badge tone="warning">Non-Standard</Badge>. They Are Not Blocked At The OS
                Level.
              </li>
              <li>
                <code className="font-mono text-[var(--w3-text)]">deploy-{consoleText("w3buildcost")}.sh</code> Still
                Consumes The Newest Tarball In{' '}
                <code className="font-mono text-[var(--w3-text)]">{consoleText("/opt/w3buildcost-update-packages/")}</code>.
              </li>
              <li>
                Tarballs Must Contain A Single Inner{' '}
                <code className="font-mono text-[var(--w3-text)]">{consoleText("w3buildcost/")}</code> Root.
              </li>
            </ul>
          </>
        )
      }}
      currentStateCard={{
        title: 'Staged Packages',
        subtitle: consoleText('/opt/w3buildcost-update-packages'),
        flush: true,
        body: (
          <PackageTable q={stagedQ} currentVersion={currentVersion} kind="staged" />
        )
      }}
      historyTables={[
        {
          title: 'Installed Packages',
          subtitle: consoleText('/opt/w3buildcost-update-packages/installed'),
          flush: true,
          body: (
            <PackageTable
              q={installedQ}
              currentVersion={currentVersion}
              kind="installed"
            />
          )
        }
      ]}
    />
  );
}

function packageStatusBadges({
  p,
  currentVersion,
  kind
}: {
  p: PackageEntry;
  currentVersion: string | null;
  kind: 'staged' | 'installed';
}): { primary: 'Ready' | 'Current' | 'Canonical' | 'Non-Standard' | 'Invalid' | 'Older' | 'Newer' | 'Previous'; tone: 'success' | 'gold' | 'warning' | 'slate' } {
  if (!p.validName)
    return { primary: 'Non-Standard', tone: 'warning' };
  if (currentVersion && p.parsedVersion === currentVersion) {
    return { primary: 'Current', tone: 'gold' };
  }
  if (kind === 'installed') {
    return { primary: 'Previous', tone: 'slate' };
  }
  if (currentVersion && p.parsedVersion) {
    const c = currentVersion.split('.').map((n) => parseInt(n, 10));
    const v = p.parsedVersion.split('.').map((n) => parseInt(n, 10));
    for (let i = 0; i < 3; i++) {
      if ((v[i] ?? 0) > (c[i] ?? 0)) return { primary: 'Newer', tone: 'gold' };
      if ((v[i] ?? 0) < (c[i] ?? 0)) return { primary: 'Older', tone: 'slate' };
    }
  }
  return { primary: 'Ready', tone: 'success' };
}

function PackageTable({
  q,
  currentVersion,
  kind
}: {
  q: ReturnType<typeof useQuery<PackagesResponse>>;
  currentVersion: string | null;
  kind: 'staged' | 'installed';
}) {
  if (q.isLoading)
    return (
      <div className="p-4">
        <LoadingState />
      </div>
    );
  if (q.error)
    return (
      <div className="p-4">
        <ErrorState error={q.error} />
      </div>
    );
  if (!q.data || q.data.packages.length === 0)
    return (
      <div className="p-4">
        <EmptyState>No Packages Found.</EmptyState>
      </div>
    );

  const isHistory = kind === 'installed';

  return (
    <>
      {/* Desktop table (≥ 768px) */}
      <div className="desktop-table">
        <table className="table-dark">
          <thead>
            <tr>
              <th>Name</th>
              <th>Version</th>
              <th>Size</th>
              <th>{isHistory ? 'Modified / Installed' : 'Modified'}</th>
              <th>Status</th>
              {isHistory ? <th>Notes</th> : <th>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {q.data.packages.map((p) => {
              const isCurrent =
                currentVersion != null && p.parsedVersion === currentVersion;
              const status = packageStatusBadges({ p, currentVersion, kind });
              return (
                <tr
                  key={p.path}
                  style={
                    isCurrent
                      ? {
                          boxShadow: 'inset 3px 0 0 0 var(--w3-gold-500)',
                          background: 'rgba(217,164,65,0.06)'
                        }
                      : undefined
                  }
                >
                  <td className="font-mono text-xs">
                    <div className="flex items-center gap-2">
                      <span>{p.name}</span>
                      {p.validName ? (
                        <Badge tone="success">Canonical</Badge>
                      ) : (
                        <Badge tone="warning">Non-Standard</Badge>
                      )}
                    </div>
                  </td>
                  <td>
                    {p.parsedVersion ? (
                      <Badge tone={isCurrent ? 'gold' : 'slate'}>v{p.parsedVersion}</Badge>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>{formatBytes(p.sizeBytes)}</td>
                  <td className="text-xs text-[var(--w3-text-muted)]">
                    {formatTimestamp(p.mtime)}
                  </td>
                  <td>
                    <Badge tone={status.tone}>{status.primary}</Badge>
                  </td>
                  <td>
                    {isHistory ? (
                      <span className="text-[11px] text-[var(--w3-text-muted)]">
                        {isCurrent ? 'Currently Installed' : 'Archived After Deploy'}
                      </span>
                    ) : (
                      <span title="Read Only In v0.5.2 — Write Actions Are Disabled.">
                        <button type="button" className="btn !px-2 !py-1" disabled>
                          <Lock size={11} />
                          Read Only
                        </button>
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Mobile stacked cards (< 768px) — v0.5.4 */}
      <div className="mobile-cards p-3">
        {q.data.packages.map((p) => {
          const isCurrent =
            currentVersion != null && p.parsedVersion === currentVersion;
          const status = packageStatusBadges({ p, currentVersion, kind });
          return (
            <div
              key={p.path}
              className="stack-card"
              style={
                isCurrent
                  ? {
                      boxShadow: 'inset 3px 0 0 0 var(--w3-gold-500)',
                      background: 'rgba(217,164,65,0.06)'
                    }
                  : undefined
              }
            >
              <div className="stack-card__row">
                <div className="stack-card__title font-mono">{p.name}</div>
                {p.validName ? (
                  <Badge tone="success">Canonical</Badge>
                ) : (
                  <Badge tone="warning">Non-Standard</Badge>
                )}
              </div>
              <div className="stack-card__meta">
                {p.parsedVersion ? (
                  <Badge tone={isCurrent ? 'gold' : 'slate'}>v{p.parsedVersion}</Badge>
                ) : (
                  <span>—</span>
                )}
                <Badge tone={status.tone}>{status.primary}</Badge>
                <span>{formatBytes(p.sizeBytes)}</span>
                <span>{formatTimestamp(p.mtime)}</span>
              </div>
              <div className="stack-card__row">
                {isHistory ? (
                  <span className="text-[11px] text-[var(--w3-text-muted)]">
                    {isCurrent ? 'Currently Installed' : 'Archived After Deploy'}
                  </span>
                ) : (
                  <button type="button" className="btn !px-2 !py-1" disabled>
                    <Lock size={11} />
                    Read Only
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
