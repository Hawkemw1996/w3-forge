import { consoleText } from "../../../../shared/consoleApp";
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ShieldCheck,
  ShieldAlert,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Database,
  Archive,
  FileText,
  Building2
} from 'lucide-react';
import { AdminListPage } from '../components/ui/AdminListPage';
import { Badge } from '../components/ui/Badge';
import { LoadingState, ErrorState } from '../components/ui/States';
import { adminGet, adminPost } from '../lib/api';
import { formatBytes, formatRelative, formatTimestamp } from '../lib/format';

// =============================================================================
// ProductionReadinessPage — v0.12.3
// =============================================================================
//
// Displays production readiness checklist, backup health, system status,
// production data mode flag, and the cutover record.
// Mounted at /admin/production-readiness.

interface CheckResult {
  key: string;
  label: string;
  pass: boolean;
  detail?: string;
}

interface BackupHealth {
  exists: boolean;
  filename: string | null;
  size_bytes: number | null;
  mtime: string | null;
  age_hours: number | null;
  health: 'green' | 'yellow' | 'red' | 'unknown';
}

interface CutoverRecord {
  id: number;
  enabled_at: string;
  enabled_by: number | null;
  enabled_version: string;
  notes: string | null;
}

interface ReadinessData {
  system: {
    version: string;
    gitCommit: string | null;
    environment: string;
  };
  migration_version: string | null;
  production_data_mode: boolean;
  all_checks_pass: boolean;
  pass_count: number;
  total_checks: number;
  checks: CheckResult[];
  backup: BackupHealth;
  cutover_record: CutoverRecord | null;
}

function backupHealthTone(health: BackupHealth['health']): 'success' | 'warning' | 'danger' | 'slate' {
  if (health === 'green') return 'success';
  if (health === 'yellow') return 'warning';
  if (health === 'red') return 'danger';
  return 'slate';
}

function backupHealthLabel(health: BackupHealth['health']): string {
  if (health === 'green') return 'Healthy';
  if (health === 'yellow') return 'Aging';
  if (health === 'red') return 'Stale';
  return 'Unknown';
}

function CheckRow({ check }: { check: CheckResult }) {
  return (
    <tr>
      <td>
        <div className="flex items-center gap-2">
          {check.pass ? (
            <CheckCircle size={15} className="shrink-0" style={{ color: 'var(--status-success)' }} />
          ) : (
            <XCircle size={15} className="shrink-0" style={{ color: 'var(--status-danger)' }} />
          )}
          <span className="text-sm" style={{ color: 'var(--w3-text)' }}>
            {check.label}
          </span>
        </div>
      </td>
      <td>
        <Badge tone={check.pass ? 'success' : 'danger'}>
          {check.pass ? 'PASS' : 'FAIL'}
        </Badge>
      </td>
      <td className="text-xs" style={{ color: 'var(--w3-text-muted)' }}>
        {check.detail ?? '—'}
      </td>
    </tr>
  );
}

// Mobile card variant
function CheckCard({ check }: { check: CheckResult }) {
  return (
    <div className="stack-card">
      <div className="stack-card__row">
        <div className="flex items-center gap-2">
          {check.pass ? (
            <CheckCircle size={14} style={{ color: 'var(--status-success)' }} />
          ) : (
            <XCircle size={14} style={{ color: 'var(--status-danger)' }} />
          )}
          <span className="stack-card__title">{check.label}</span>
        </div>
        <Badge tone={check.pass ? 'success' : 'danger'}>{check.pass ? 'PASS' : 'FAIL'}</Badge>
      </div>
      {check.detail ? (
        <div className="text-xs mt-1" style={{ color: 'var(--w3-text-muted)' }}>
          {check.detail}
        </div>
      ) : null}
    </div>
  );
}

export function ProductionReadinessPage() {
  const qc = useQueryClient();
  const [enableNotes, setEnableNotes] = useState('');
  const [showEnableConfirm, setShowEnableConfirm] = useState(false);

  const q = useQuery({
    queryKey: ['admin', 'production-readiness'],
    queryFn: () => adminGet<ReadinessData>('/production-readiness'),
    refetchInterval: 30_000
  });

  const enableProdMutation = useMutation({
    mutationFn: () =>
      adminPost('/production-cutover', { notes: enableNotes || undefined }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'production-readiness'] });
      setShowEnableConfirm(false);
    }
  });

  const data = q.data;

  const allPass = data?.all_checks_pass ?? false;
  const prodMode = data?.production_data_mode ?? false;

  return (
    <AdminListPage
      header={{
        title: (
          <span className="flex items-center gap-2">
            <ShieldCheck size={20} />
            Production Readiness
          </span>
        ),
        subtitle: 'System Checks Before Entering Live Business Data',
        actions: (
          <>
            {data ? (
              <>
                <Badge tone={allPass ? 'success' : 'warning'}>
                  {data.pass_count}/{data.total_checks} Checks Pass
                </Badge>
                <Badge tone={prodMode ? 'danger' : 'slate'}>
                  {prodMode ? 'PRODUCTION MODE' : 'Demo / Dev Mode'}
                </Badge>
                <Badge tone="gold">v{data.system.version}</Badge>
              </>
            ) : null}
          </>
        )
      }}
      standardCard={{
        title: 'What This Page Is For',
        subtitle: 'Pre-Cutover Verification Before Entering Real Business Data.',
        body: (
          <ul className="list-disc space-y-1 pl-5 text-xs" style={{ color: 'var(--w3-text-muted)' }}>
            <li>Verify the database, migrations, W3 Core sign-in and audit trail before entering real estimates.</li>
            <li>Confirm backups exist and are recent before committing production data.</li>
            <li>Enable <strong style={{ color: 'var(--w3-text)' }}>Production Data Mode</strong> to record that this installation now holds real estimating data.</li>
            <li>Record the cutover event for audit history.</li>
          </ul>
        )
      }}
      currentStateCard={{
        title: 'System Status',
        subtitle: 'Runtime Identity And Environment.',
        body: q.isLoading ? (
          <div className="p-4"><LoadingState /></div>
        ) : q.error ? (
          <div className="p-4"><ErrorState error={q.error} /></div>
        ) : data ? (
          <div className="desktop-table">
            <table className="table-dark">
              <tbody>
                <tr>
                  <td className="font-semibold text-xs" style={{ color: 'var(--w3-text-muted)', width: '160px' }}>Version</td>
                  <td><Badge tone="gold">v{data.system.version}</Badge></td>
                </tr>
                <tr>
                  <td className="font-semibold text-xs" style={{ color: 'var(--w3-text-muted)' }}>Environment</td>
                  <td>
                    <Badge tone={data.system.environment === 'production' ? 'success' : 'info'}>
                      {data.system.environment}
                    </Badge>
                  </td>
                </tr>
                <tr>
                  <td className="font-semibold text-xs" style={{ color: 'var(--w3-text-muted)' }}>Migration Version</td>
                  <td className="font-mono text-xs">{data.migration_version ?? '—'}</td>
                </tr>
                <tr>
                  <td className="font-semibold text-xs" style={{ color: 'var(--w3-text-muted)' }}>Production Mode</td>
                  <td>
                    <Badge tone={data.production_data_mode ? 'danger' : 'slate'}>
                      {data.production_data_mode ? 'Enabled' : 'Disabled'}
                    </Badge>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        ) : null
      }}
      secondaryStateCard={{
        title: 'Production Readiness Checklist',
        subtitle: 'All Items Must Pass Before Entering Live Data.',
        flush: true,
        body: q.isLoading ? (
          <div className="p-4"><LoadingState /></div>
        ) : q.error ? (
          <div className="p-4"><ErrorState error={q.error} /></div>
        ) : data ? (
          <>
            {/* Desktop table */}
            <div className="desktop-table">
              <table className="table-dark">
                <thead>
                  <tr>
                    <th>Check</th>
                    <th>Result</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {data.checks.map((c) => (
                    <CheckRow key={c.key} check={c} />
                  ))}
                </tbody>
              </table>
            </div>
            {/* Mobile cards */}
            <div className="mobile-cards p-3">
              {data.checks.map((c) => (
                <CheckCard key={c.key} check={c} />
              ))}
            </div>
          </>
        ) : null
      }}
      historyTables={[
        {
          title: 'Backup Health',
          subtitle: 'Last Backup Status And Age.',
          body: q.isLoading ? (
            <div className="p-4"><LoadingState /></div>
          ) : q.error ? (
            <div className="p-4"><ErrorState error={q.error} /></div>
          ) : data ? (
            <BackupHealthView backup={data.backup} />
          ) : null
        },
        {
          title: 'Production Cutover Record',
          subtitle: 'Written Once When Production Data Mode Is First Enabled.',
          body: q.isLoading ? (
            <div className="p-4"><LoadingState /></div>
          ) : data ? (
            <CutoverRecordView
              record={data.cutover_record}
              allPass={allPass}
              prodMode={prodMode}
              showEnableConfirm={showEnableConfirm}
              setShowEnableConfirm={setShowEnableConfirm}
              enableNotes={enableNotes}
              setEnableNotes={setEnableNotes}
              onEnable={() => enableProdMutation.mutate()}
              isEnabling={enableProdMutation.isPending}
              enableError={enableProdMutation.error}
            />
          ) : null
        }
      ]}
    />
  );
}

// ---- BackupHealthView -------------------------------------------------------
function BackupHealthView({ backup }: { backup: BackupHealth }) {
  const tone = backupHealthTone(backup.health);
  const label = backupHealthLabel(backup.health);

  return (
    <div className="p-4 space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Archive size={16} style={{ color: 'var(--w3-text-muted)' }} />
        <span className="text-sm font-medium" style={{ color: 'var(--w3-text)' }}>
          {backup.exists ? backup.filename ?? 'Backup Found' : 'No Backup Found'}
        </span>
        <Badge tone={tone}>{label}</Badge>
        {backup.size_bytes !== null ? (
          <Badge tone="slate">{formatBytes(backup.size_bytes)}</Badge>
        ) : null}
      </div>
      {backup.exists ? (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 text-xs" style={{ color: 'var(--w3-text-muted)' }}>
          <div>
            <span className="font-semibold" style={{ color: 'var(--w3-text)' }}>Age: </span>
            {backup.age_hours !== null ? `${backup.age_hours}h ago` : '—'}
          </div>
          <div>
            <span className="font-semibold" style={{ color: 'var(--w3-text)' }}>Created: </span>
            {formatRelative(backup.mtime)}
          </div>
          <div>
            <span className="font-semibold" style={{ color: 'var(--w3-text)' }}>Size: </span>
            {formatBytes(backup.size_bytes)}
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--status-danger)' }}>
          <AlertTriangle size={13} />
          No backups detected. Run a backup before entering production data.
        </div>
      )}
      <div className="rounded px-3 py-2 text-xs" style={{ background: 'var(--w3-navy-800)', border: '1px solid var(--w3-border)' }}>
        <span className="font-semibold" style={{ color: 'var(--w3-text)' }}>Health: </span>
        <span style={{ color: 'var(--w3-text-muted)' }}>
          Green = backup less than 24 hours old. Yellow = 1–7 days old. Red = older than 7 days.
        </span>
      </div>
    </div>
  );
}

// ---- CutoverRecordView -----------------------------------------------------
function CutoverRecordView({
  record,
  allPass,
  prodMode,
  showEnableConfirm,
  setShowEnableConfirm,
  enableNotes,
  setEnableNotes,
  onEnable,
  isEnabling,
  enableError
}: {
  record: CutoverRecord | null;
  allPass: boolean;
  prodMode: boolean;
  showEnableConfirm: boolean;
  setShowEnableConfirm: (v: boolean) => void;
  enableNotes: string;
  setEnableNotes: (v: string) => void;
  onEnable: () => void;
  isEnabling: boolean;
  enableError: Error | null;
}) {
  if (record) {
    return (
      <div className="p-4 space-y-3">
        <div
          className="rounded border p-3"
          style={{
            borderColor: 'var(--status-success)',
            background: 'rgba(var(--status-success-rgb, 74, 222, 128), 0.05)'
          }}
        >
          <div className="flex items-center gap-2 mb-2">
            <CheckCircle size={15} style={{ color: 'var(--status-success)' }} />
            <span className="text-sm font-semibold" style={{ color: 'var(--w3-text)' }}>
              Production Mode Activated
            </span>
            <Badge tone="success">Recorded</Badge>
          </div>
          <div className="grid grid-cols-1 gap-1 text-xs sm:grid-cols-2" style={{ color: 'var(--w3-text-muted)' }}>
            <div>
              <span className="font-semibold" style={{ color: 'var(--w3-text)' }}>Enabled: </span>
              {formatTimestamp(record.enabled_at)}
            </div>
            <div>
              <span className="font-semibold" style={{ color: 'var(--w3-text)' }}>Version: </span>
              <Badge tone="gold">v{record.enabled_version}</Badge>
            </div>
            {record.notes ? (
              <div className="sm:col-span-2">
                <span className="font-semibold" style={{ color: 'var(--w3-text)' }}>Notes: </span>
                {record.notes}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  // Not yet recorded
  return (
    <div className="p-4 space-y-4">
      <p className="text-sm" style={{ color: 'var(--w3-text-muted)' }}>
        No production cutover record exists. When you are ready to begin entering real business data,
        enable Production Data Mode below. This action is recorded and cannot be undone.
      </p>

      {!showEnableConfirm ? (
        <button
          type="button"
          className="btn"
          onClick={() => setShowEnableConfirm(true)}
          disabled={!allPass}
          title={!allPass ? 'All readiness checks must pass first' : undefined}
        >
          <ShieldCheck size={14} />
          Enable Production Data Mode
        </button>
      ) : (
        <div
          className="rounded border p-4 space-y-3"
          style={{ borderColor: 'var(--w3-gold-500)', background: 'rgba(217,164,65,0.06)' }}
        >
          <div className="flex items-center gap-2">
            <ShieldAlert size={15} style={{ color: 'var(--w3-gold-500)' }} />
            <span className="text-sm font-semibold" style={{ color: 'var(--w3-gold-400)' }}>
              Confirm Production Cutover
            </span>
          </div>
          <p className="text-xs" style={{ color: 'var(--w3-text-muted)' }}>
            This will turn on Production Data Mode and write a permanent cutover record to the
            {consoleText("W3 BuildCost")} database. This cannot be deleted.
          </p>
          <div>
            <label className="block text-xs mb-1" style={{ color: 'var(--w3-text-muted)' }}>
              Optional Notes
            </label>
            <input
              type="text"
              className="input w-full text-sm"
              placeholder="e.g. Initial entity entry begins"
              value={enableNotes}
              onChange={(e) => setEnableNotes(e.target.value)}
              disabled={isEnabling}
            />
          </div>
          {enableError ? (
            <div className="text-xs" style={{ color: 'var(--status-danger)' }}>
              {enableError.message}
            </div>
          ) : null}
          <div className="flex gap-2">
            <button
              type="button"
              className="btn btn-primary"
              onClick={onEnable}
              disabled={isEnabling}
            >
              {isEnabling ? 'Enabling…' : 'Confirm — Enable Production Mode'}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => setShowEnableConfirm(false)}
              disabled={isEnabling}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {!allPass ? (
        <p className="text-xs" style={{ color: 'var(--status-warning)' }}>
          All readiness checks must pass before production mode can be enabled.
        </p>
      ) : null}
    </div>
  );
}
