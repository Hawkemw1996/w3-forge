import { consoleApp } from '../../../../shared/consoleApp';
import { consoleText } from "../../../../shared/consoleApp";
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AdminListPage } from '../components/ui/AdminListPage';
import { Badge } from '../components/ui/Badge';
import { EmptyState, ErrorState, LoadingState } from '../components/ui/States';
import { adminGet } from '../lib/api';
import { formatBytes, formatRelative, formatTimestamp } from '../lib/format';

// =============================================================================
// BackupsPage — v0.5.4
// =============================================================================
//
// v0.5.4 backend now returns two kinds of entries from /api/admin/backups:
//
//   kind: 'paired'
//     Legacy nightly pair — separate w3buildcost_app_*.tar.gz + w3buildcost_db_*.sql.
//     pairTimestamp = the YYYY-MM-DD_HH-MM-SS suffix shared by both files.
//
//   kind: 'versioned-archive'
//     New v0.5.4 format — single archive that bundles app + DB:
//       w3buildcost-backup-vX.Y.Z-YYYYMMDD-HHMMSS.tar.gz
//       w3buildcost-vX.Y.Z-backup-YYYYMMDD-HHMMSS.tar.gz
//     parsedVersion = parsed canonical X.Y.Z. dbArchive is always null
//     for this kind (the DB lives inside the single tarball).
//
// The frontend treats both kinds uniformly in tables; we just show the
// version badge and an extra "Versioned Archive" pill where applicable.

interface BackupFileMeta {
  name: string;
  sizeBytes: number;
  mtime: string;
}

interface BackupEntry {
  pairTimestamp: string | null;
  appArchive: BackupFileMeta | null;
  dbArchive: BackupFileMeta | null;
  parsedVersion: string | null;
  kind: 'paired' | 'versioned-archive';
}

interface BackupsResponse {
  root: string;
  backups: BackupEntry[];
  totalSizeBytes: number;
}

// v0.5.0 was released at 2026-05-21 22:47:27 UTC; backup pairs older than
// that are "legacy candidates" for off-line cleanup. No delete is exposed.
const V050_RELEASE_ISO = consoleApp.legacyBackupCutoff;
const V050_RELEASE_MS = V050_RELEASE_ISO ? Date.parse(V050_RELEASE_ISO) : 0;

function isLegacy(b: BackupEntry): boolean {
  const ts =
    Date.parse(b.appArchive?.mtime ?? '') ||
    Date.parse(b.dbArchive?.mtime ?? '') ||
    Date.parse(b.pairTimestamp ?? '') ||
    0;
  return ts > 0 && ts < V050_RELEASE_MS;
}

function pairTotal(b: BackupEntry): number {
  return (b.appArchive?.sizeBytes ?? 0) + (b.dbArchive?.sizeBytes ?? 0);
}

function pairMtime(b: BackupEntry): string | null {
  return b.appArchive?.mtime ?? b.dbArchive?.mtime ?? null;
}

function pairKey(b: BackupEntry): string {
  return `${b.kind}|${b.pairTimestamp ?? ''}|${b.appArchive?.name ?? ''}|${b.dbArchive?.name ?? ''}`;
}

function pairStatus(b: BackupEntry): { label: string; tone: 'success' | 'warning' | 'slate' } {
  if (b.kind === 'versioned-archive') {
    // Versioned archives are single-file: app archive present implies a
    // complete bundle (DB lives inside).
    return b.appArchive ? { label: 'Complete', tone: 'success' } : { label: 'Empty', tone: 'slate' };
  }
  if (b.appArchive && b.dbArchive) return { label: 'Complete', tone: 'success' };
  if (b.appArchive && !b.dbArchive) return { label: 'Missing DB', tone: 'warning' };
  if (!b.appArchive && b.dbArchive) return { label: 'Missing App', tone: 'warning' };
  return { label: 'Empty', tone: 'slate' };
}

function versionBadge(b: BackupEntry) {
  if (!b.parsedVersion) {
    return <Badge tone="slate">Unknown</Badge>;
  }
  return <Badge tone="gold">v{b.parsedVersion}</Badge>;
}

export function BackupsPage() {
  const q = useQuery({
    queryKey: ['admin', 'backups'],
    queryFn: () => adminGet<BackupsResponse>('/backups'),
    refetchInterval: 60_000
  });

  const sortedNewestFirst = useMemo<BackupEntry[]>(() => {
    if (!q.data) return [];
    return q.data.backups
      .slice()
      .sort((a, b) => Date.parse(pairMtime(b) ?? '0') - Date.parse(pairMtime(a) ?? '0'));
  }, [q.data]);

  const latestCleanKey = useMemo<string | null>(() => {
    const clean = sortedNewestFirst.filter((b) => !isLegacy(b));
    return clean.length ? pairKey(clean[0]) : null;
  }, [sortedNewestFirst]);

  const latestPair = sortedNewestFirst[0] ?? null;

  return (
    <AdminListPage
      header={{
        title: 'Backups',
        subtitle: q.data?.root ?? consoleText('/opt/w3buildcost-backups'),
        actions: (
          <>
            <Badge tone="info">Local Only</Badge>
            {q.data ? (
              <>
                <Badge tone="slate">
                  {q.data.backups.length} Backup{q.data.backups.length === 1 ? '' : 's'}
                </Badge>
                <Badge tone="gold">Total {formatBytes(q.data.totalSizeBytes)}</Badge>
              </>
            ) : null}
          </>
        )
      }}
      standardCard={{
        title: 'Backup Naming Standard',
        subtitle: 'Versioned Archives (v0.5.4+) Or Legacy Pairs Are Both Recognized.',
        body: (
          <>
            <div className="space-y-1 font-mono text-xs">
              <div>
                <code
                  className="rounded px-2 py-1"
                  style={{
                    background: 'var(--w3-navy-800)',
                    border: '1px solid var(--w3-border)',
                    color: 'var(--w3-text)'
                  }}
                >
                  {consoleText("w3buildcost-backup-vX")}.Y.Z-YYYYMMDD-HHMMSS.tar.gz
                </code>
                <span className="ml-2 text-[var(--w3-text-muted)]">— v0.5.4 Versioned Archive</span>
              </div>
              <div>
                <code
                  className="rounded px-2 py-1"
                  style={{
                    background: 'var(--w3-navy-800)',
                    border: '1px solid var(--w3-border)',
                    color: 'var(--w3-text)'
                  }}
                >
                  {consoleText("w3buildcost_app_YYYY-MM-DD_HH-MM-SS")}.tar.gz
                </code>
                <span className="ml-2 text-[var(--w3-text-muted)]">— Legacy Application Archive</span>
              </div>
              <div>
                <code
                  className="rounded px-2 py-1"
                  style={{
                    background: 'var(--w3-navy-800)',
                    border: '1px solid var(--w3-border)',
                    color: 'var(--w3-text)'
                  }}
                >
                  {consoleText("w3buildcost_db_YYYY-MM-DD_HH-MM-SS")}.sql
                </code>
                <span className="ml-2 text-[var(--w3-text-muted)]">— Legacy Database Dump</span>
              </div>
            </div>
            <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-[var(--w3-text-muted)]">
              <li>
                v0.5.4 Standard: Single Versioned Archive Bundles The App And Database
                In One Canonical Tarball.
              </li>
              <li>
                Legacy Pairs Are Still Detected And Listed When The App + DB Files
                Share A Timestamp Suffix.
              </li>
              <li>Backups Are Local-Only In v0.5.4; Remote TrueNAS Copy Is A Future Item.</li>
              <li>
                Pre-v0.5.0 Backups Are Surfaced As{' '}
                <Badge tone="warning">Legacy Candidate</Badge> For Off-Line Cleanup Via{' '}
                <code className="font-mono text-[var(--w3-text)]">
                  cleanup-legacy-{consoleText("w3buildcost")}.sh
                </code>
                .
              </li>
            </ul>
          </>
        )
      }}
      currentStateCard={{
        title: 'Latest Backup Set',
        subtitle: 'Most Recent Versioned Archive Or Legacy Pair.',
        flush: true,
        body: q.isLoading ? (
          <div className="p-4">
            <LoadingState />
          </div>
        ) : q.error ? (
          <div className="p-4">
            <ErrorState error={q.error} />
          </div>
        ) : !latestPair ? (
          <div className="p-4">
            <EmptyState>No Backups Detected.</EmptyState>
          </div>
        ) : (
          <LatestBackupView pair={latestPair} />
        )
      }}
      historyTables={[
        {
          title: 'Backup History',
          subtitle: 'All Detected Backups, Newest First.',
          flush: true,
          body: q.isLoading ? (
            <div className="p-4">
              <LoadingState />
            </div>
          ) : q.error ? (
            <div className="p-4">
              <ErrorState error={q.error} />
            </div>
          ) : !q.data || q.data.backups.length === 0 ? (
            <div className="p-4">
              <EmptyState>No Backups Detected.</EmptyState>
            </div>
          ) : (
            <BackupHistoryView pairs={sortedNewestFirst} latestCleanKey={latestCleanKey} />
          )
        }
      ]}
      detailsSlot={
        q.data && q.data.backups.some(isLegacy) ? (
          <div
            className="rounded-md border p-3 text-xs text-[var(--w3-text-muted)]"
            style={{ borderColor: 'var(--w3-border)', background: 'var(--w3-card)' }}
          >
            "Legacy Candidate" Means The Backup Uses An Older File Naming Scheme
            (Released {formatTimestamp(V050_RELEASE_ISO)}). Cleanup Is Handled Out-Of-Band
            By <code className="font-mono text-[var(--w3-text)]">cleanup-legacy-{consoleText("w3buildcost")}.sh</code> —
            No Delete Or Purge Action Is Exposed Here, By Design.
          </div>
        ) : null
      }
    />
  );
}

// -----------------------------------------------------------------------------
// LatestBackupView — single highlighted row + matching mobile card.
// -----------------------------------------------------------------------------

function LatestBackupView({ pair }: { pair: BackupEntry }) {
  const status = pairStatus(pair);
  const goldRow = {
    boxShadow: 'inset 3px 0 0 0 var(--w3-gold-500)',
    background: 'rgba(217,164,65,0.06)'
  } as const;

  const subjectLabel =
    pair.pairTimestamp ??
    pair.appArchive?.name ??
    pair.dbArchive?.name ??
    '(Unpaired)';

  return (
    <>
      {/* Desktop table */}
      <div className="desktop-table">
        <table className="table-dark">
          <thead>
            <tr>
              <th>Backup Set</th>
              <th>Version</th>
              <th>App Backup</th>
              <th>DB Backup</th>
              <th>Size</th>
              <th>Created</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            <tr style={goldRow}>
              <td className="font-mono text-xs">
                <div className="flex items-center gap-1.5">
                  <span>{subjectLabel}</span>
                  <Badge tone="gold">Latest</Badge>
                  {pair.kind === 'versioned-archive' ? (
                    <Badge tone="info">Versioned Archive</Badge>
                  ) : null}
                </div>
              </td>
              <td>{versionBadge(pair)}</td>
              <td className="truncate font-mono text-[11px]">
                {pair.appArchive?.name ?? '—'}
              </td>
              <td className="truncate font-mono text-[11px]">
                {pair.kind === 'versioned-archive'
                  ? '(In Archive)'
                  : (pair.dbArchive?.name ?? '—')}
              </td>
              <td>{formatBytes(pairTotal(pair))}</td>
              <td className="text-xs text-[var(--w3-text-muted)]">
                {formatTimestamp(pairMtime(pair))}
              </td>
              <td>
                <div className="flex flex-wrap items-center gap-1">
                  <Badge tone={status.tone}>{status.label}</Badge>
                  <Badge tone="info">Local</Badge>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Mobile card */}
      <div className="mobile-cards p-3">
        <div className="stack-card" style={goldRow}>
          <div className="stack-card__row">
            <div className="stack-card__title font-mono">{subjectLabel}</div>
            <Badge tone="gold">Latest</Badge>
          </div>
          <div className="stack-card__meta">
            {versionBadge(pair)}
            <Badge tone={status.tone}>{status.label}</Badge>
            {pair.kind === 'versioned-archive' ? (
              <Badge tone="info">Versioned Archive</Badge>
            ) : null}
            <Badge tone="info">Local</Badge>
            <span>{formatBytes(pairTotal(pair))}</span>
            <span>{formatTimestamp(pairMtime(pair))}</span>
          </div>
          <div className="body-muted text-[11px]">
            <div className="font-mono break-all">App: {pair.appArchive?.name ?? '—'}</div>
            <div className="font-mono break-all">
              DB: {pair.kind === 'versioned-archive' ? '(In Archive)' : (pair.dbArchive?.name ?? '—')}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

// -----------------------------------------------------------------------------
// BackupHistoryView — desktop table + mobile cards.
// -----------------------------------------------------------------------------

function BackupHistoryView({
  pairs,
  latestCleanKey
}: {
  pairs: BackupEntry[];
  latestCleanKey: string | null;
}) {
  return (
    <>
      {/* Desktop table */}
      <div className="desktop-table">
        <table className="table-dark">
          <thead>
            <tr>
              <th>Backup Set</th>
              <th>Version</th>
              <th>App Size</th>
              <th>DB Size</th>
              <th>Created</th>
              <th>Location</th>
              <th>Status</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {pairs.map((b) => {
              const key = pairKey(b);
              const legacy = isLegacy(b);
              const isLatest = key === latestCleanKey;
              const status = pairStatus(b);
              const subjectLabel =
                b.pairTimestamp ??
                b.appArchive?.name ??
                b.dbArchive?.name ??
                '(Unpaired)';
              return (
                <tr
                  key={key}
                  style={
                    isLatest
                      ? {
                          boxShadow: 'inset 3px 0 0 0 var(--w3-gold-500)',
                          background: 'rgba(217,164,65,0.06)'
                        }
                      : undefined
                  }
                >
                  <td className="font-mono text-xs">
                    <div className="flex items-center gap-1.5">
                      <span>{subjectLabel}</span>
                      {isLatest ? <Badge tone="gold">Latest</Badge> : null}
                      {b.kind === 'versioned-archive' ? (
                        <Badge tone="info">Versioned</Badge>
                      ) : null}
                    </div>
                  </td>
                  <td>{versionBadge(b)}</td>
                  <td>{b.appArchive ? formatBytes(b.appArchive.sizeBytes) : '—'}</td>
                  <td>
                    {b.kind === 'versioned-archive'
                      ? '(Inside)'
                      : b.dbArchive
                        ? formatBytes(b.dbArchive.sizeBytes)
                        : '—'}
                  </td>
                  <td className="text-xs text-[var(--w3-text-muted)]">
                    <span title={formatTimestamp(pairMtime(b))}>
                      {formatRelative(pairMtime(b))}
                    </span>
                  </td>
                  <td>
                    <Badge tone="info">Local</Badge>
                  </td>
                  <td>
                    <Badge tone={status.tone}>{status.label}</Badge>
                  </td>
                  <td className="text-[11px] text-[var(--w3-text-muted)]">
                    {legacy ? <Badge tone="warning">Legacy Candidate</Badge> : 'Clean'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Mobile cards */}
      <div className="mobile-cards p-3">
        {pairs.map((b) => {
          const key = pairKey(b);
          const legacy = isLegacy(b);
          const isLatest = key === latestCleanKey;
          const status = pairStatus(b);
          const subjectLabel =
            b.pairTimestamp ??
            b.appArchive?.name ??
            b.dbArchive?.name ??
            '(Unpaired)';
          return (
            <div
              key={key}
              className="stack-card"
              style={
                isLatest
                  ? {
                      boxShadow: 'inset 3px 0 0 0 var(--w3-gold-500)',
                      background: 'rgba(217,164,65,0.06)'
                    }
                  : undefined
              }
            >
              <div className="stack-card__row">
                <div className="stack-card__title font-mono">{subjectLabel}</div>
                {isLatest ? <Badge tone="gold">Latest</Badge> : null}
              </div>
              <div className="stack-card__meta">
                {versionBadge(b)}
                <Badge tone={status.tone}>{status.label}</Badge>
                {b.kind === 'versioned-archive' ? (
                  <Badge tone="info">Versioned</Badge>
                ) : null}
                <Badge tone="info">Local</Badge>
                {legacy ? <Badge tone="warning">Legacy Candidate</Badge> : null}
                <span>{formatBytes(pairTotal(b))}</span>
                <span title={formatTimestamp(pairMtime(b))}>
                  {formatRelative(pairMtime(b))}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
