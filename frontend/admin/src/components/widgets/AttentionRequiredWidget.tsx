import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  AlertTriangle, Archive, CheckCircle2, CircleDot, Database, GitBranch,
  HardDrive, HardDriveDownload, PackagePlus, RefreshCw, ShieldAlert
} from 'lucide-react';
import { Card, CardBody, CardHeader } from '../ui/Card';
import { Badge, type BadgeTone } from '../ui/Badge';
import { ErrorState, LoadingState } from '../ui/States';
import { adminGet } from '../../lib/api';
import type { AttentionItem, AttentionOverview, AttentionSeverity } from '../../lib/attention';
import { formatRelative, formatTimestamp } from '../../lib/format';
import type { WidgetRenderProps } from './types';

const SEVERITY_TONE: Record<AttentionSeverity, BadgeTone> = {
  red: 'danger', amber: 'warning', gold: 'gold', info: 'info'
};

const SOURCE_ICON = {
  git: GitBranch,
  system: HardDrive,
  backup: Archive,
  packages: PackagePlus,
  database: Database,
  'admin-exposure': ShieldAlert,
  operations: HardDriveDownload
};

export function AttentionRequiredWidget({ density = 'standard' }: WidgetRenderProps) {
  const overviewQ = useQuery({
    queryKey: ['admin', 'overview'],
    queryFn: async () => {
      const data = await adminGet<AttentionOverview>('/overview');
      if (!Array.isArray(data?.attention?.sources) || !Array.isArray(data?.attention?.items)) {
        throw new Error('Attention checks are unavailable.');
      }
      return data;
    },
    refetchInterval: 30_000
  });
  const attention = overviewQ.data?.attention;
  const items = attention?.items ?? [];
  const sources = attention?.sources ?? [];
  const coverageComplete = attention?.coverageComplete === true &&
    sources.length > 0 && sources.every((source) => source.status === 'ok');
  const allClear = attention?.allClear === true && coverageComplete &&
    items.length === 0 && !overviewQ.isError;
  const checkedCount = sources.filter((source) => source.status === 'ok').length;
  const tone = items.some((item) => item.severity === 'red') ? 'danger' : 'warning';

  return (
    <Card>
      <CardHeader
        title={<span className="flex items-center gap-1.5"><AlertTriangle size={14} /> Attention Required</span>}
        right={
          <>
            {overviewQ.isLoading ? <Badge tone="slate">Checking</Badge>
              : overviewQ.isError ? <Badge tone="warning">Unavailable</Badge>
                : allClear ? <Badge tone="success">All Clear</Badge>
                  : items.length > 0 ? <Badge tone={tone}>{items.length} Active</Badge>
                    : <Badge tone="warning">Checks Incomplete</Badge>}
            <button
              type="button"
              aria-label="Refresh attention checks"
              title="Refresh attention checks"
              onClick={() => { void overviewQ.refetch(); }}
              disabled={overviewQ.isFetching}
              className="rounded p-1 text-[var(--w3-text-muted)] hover:text-[var(--w3-text)] disabled:opacity-50"
            >
              <RefreshCw size={13} className={overviewQ.isFetching ? 'animate-spin' : undefined} />
            </button>
          </>
        }
      />
      <CardBody>
        {overviewQ.isLoading ? <LoadingState label="Checking system signals…" />
          : !attention ? <ErrorState error={overviewQ.error} title="Unable to check system signals" />
            : (
              <div className="space-y-2 text-sm" aria-live="polite">
                {overviewQ.isError ? (
                  <p role="status" className="rounded-md border border-[var(--w3-border)] p-2 text-xs text-[var(--status-warning)]">
                    Unable to refresh. Showing the last results; current status is unconfirmed.
                  </p>
                ) : null}
                {items.length > 0 ? (
                  <ul className="space-y-1">
                    {items.map((item) => <AlertItem key={item.id} item={item} />)}
                  </ul>
                ) : allClear ? (
                  <div
                    className="flex items-center gap-2 rounded-md border p-2 text-xs"
                    style={{ background: 'var(--status-success-bg)', borderColor: 'rgba(34,197,94,0.4)', color: 'var(--status-success)' }}
                  >
                    <CheckCircle2 size={14} /> All Clear — No Active Alerts
                  </div>
                ) : (
                  <p className="text-xs text-[var(--w3-text-muted)]">
                    {overviewQ.isError
                      ? 'No active alerts in the last successful check.'
                      : 'Some checks could not finish. Current status is unconfirmed.'}
                  </p>
                )}
                {!coverageComplete ? (
                  <p className="text-[11px] text-[var(--status-warning)]">
                    {checkedCount} of {sources.length} status sources checked. Unavailable checks need review.
                  </p>
                ) : null}
                {density !== 'compact' ? (
                  <details className="border-t border-[var(--w3-border)] pt-2 text-[11px]">
                    <summary className="cursor-pointer text-[var(--w3-text-muted)]">
                      Status checks · {checkedCount} of {sources.length} available
                    </summary>
                    <ul className="mt-2 space-y-2">
                      {sources.map((source) => (
                        <li key={source.id}>
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[var(--w3-text)]">{source.label}</span>
                            <Badge tone={source.status === 'ok' ? 'slate' : 'warning'}>
                              {source.status === 'ok' ? 'Checked' : 'Unavailable'}
                            </Badge>
                          </div>
                          <p className="mt-0.5 break-words text-[var(--w3-text-muted)]">{source.detail}</p>
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
                <p className="text-[10px] text-[var(--w3-text-dim)]" title={formatTimestamp(overviewQ.data?.generatedAt)}>
                  Last checked {formatRelative(overviewQ.data?.generatedAt)} · Refreshes every 30 seconds
                </p>
              </div>
            )}
      </CardBody>
    </Card>
  );
}

function AlertItem({ item }: { item: AttentionItem }) {
  const Icon = item.id === 'failed-deploy' ? AlertTriangle
    : SOURCE_ICON[item.source as keyof typeof SOURCE_ICON] ?? CircleDot;
  return (
    <li
      className="rounded-md px-1 py-1"
      style={{ background: item.severity === 'red' ? 'rgba(239,68,68,0.06)' : item.severity === 'amber' ? 'rgba(217,164,65,0.06)' : undefined }}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Icon size={12} className="shrink-0 text-[var(--w3-gold-400)]" />
        <span className="min-w-0 flex-1 text-[var(--w3-text)]">{item.label}</span>
        <Badge tone={SEVERITY_TONE[item.severity]}>
          {item.severity === 'red' ? 'Critical' : item.severity === 'amber' ? 'Warning' : 'Info'}
        </Badge>
        <Link to={item.href} aria-label={`View ${item.label}`} className="text-[11px] text-[var(--w3-gold-400)] underline">View</Link>
      </div>
      <p className="ml-5 mt-0.5 whitespace-pre-wrap break-words text-[11px] text-[var(--w3-text-muted)]">{item.detail}</p>
    </li>
  );
}
