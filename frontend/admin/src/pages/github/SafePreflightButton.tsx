// =============================================================================
// W3 Core v0.5.31 - "Run Safe Preflight" button.
// =============================================================================
//
// One-click READ-ONLY pipeline warm-up.
//
// Sequence (in order, stopping on first failure):
//   1. pipeline-check-remote      (POST /api/admin/controls/pipeline-check-remote/run)
//   2. pipeline-fetch-tags        (POST /api/admin/controls/pipeline-fetch-tags/run)
//   3. branch list refresh        (invalidate ['admin', 'git', 'branches-dev'])
//   4. package list refresh       (invalidate ['admin', 'packages', 'pipeline'])
//   5. controls registry refresh  (invalidate ['admin', 'controls'])
//
// Explicitly forbidden in this orchestrator:
//   - no pipeline-package-dev
//   - no pipeline-verify-dev-pkg
//   - no pipeline-deploy-dev
//   - no pipeline-create-tag / pipeline-delete-tag
//   - no pipeline-rollback / pipeline-reset-tree
//   - no pipeline-push-dev
//   - no pipeline-checkout-dev / pipeline-pull-latest
//   - no pipeline-test-dev
//
// The two safe-pipeline controls invoked here are LOW-risk read-only actions
// already shipped in v0.5.29. This component does not modify the registry,
// safeRunner, validator, deployment scripts, auth, DB, schema, dependencies,
// CI, or production deploy logic.
// =============================================================================

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import { adminPost } from '../../lib/api';
import { Badge } from '../../components/ui/Badge';

// Same shape as ReleasePipelinePanel uses for /controls/:id/run responses.
interface RunResponseSlim {
  controlId: string;
  accepted: boolean;
  reason: string;
  runStatus: 'success' | 'failed' | 'refused' | 'error' | 'running' | string;
  exitCode?: number;
  durationMs?: number;
}

type Step =
  | 'idle'
  | 'check-remote'
  | 'fetch-tags'
  | 'refresh-branches'
  | 'refresh-packages'
  | 'refresh-controls'
  | 'done'
  | 'error';

interface StepResult {
  step: Exclude<Step, 'idle' | 'done' | 'error'>;
  ok: boolean;
  detail: string;
}

const STEP_LABEL: Record<Exclude<Step, 'idle' | 'done' | 'error'>, string> = {
  'check-remote': 'Check Remote',
  'fetch-tags': 'Fetch Tags',
  'refresh-branches': 'Refresh Branch List',
  'refresh-packages': 'Refresh Package List',
  'refresh-controls': 'Refresh Controls Registry'
};

function isSuccessRunStatus(s: string | undefined): boolean {
  return s === 'success';
}

export function SafePreflightButton() {
  const qc = useQueryClient();
  const [current, setCurrent] = useState<Step>('idle');
  const [results, setResults] = useState<StepResult[]>([]);
  const [topError, setTopError] = useState<string | null>(null);

  const preflightM = useMutation({
    mutationFn: async () => {
      const collected: StepResult[] = [];

      // Step 1: pipeline-check-remote
      setCurrent('check-remote');
      try {
        const r = await adminPost<RunResponseSlim>(
          '/controls/pipeline-check-remote/run',
          { inputs: {}, confirmations: {} }
        );
        const ok = r.accepted && isSuccessRunStatus(r.runStatus);
        collected.push({
          step: 'check-remote',
          ok,
          detail: ok
            ? `exit ${r.exitCode ?? 0}${r.durationMs != null ? ` · ${Math.round(r.durationMs)} ms` : ''}`
            : `${r.runStatus}: ${r.reason || 'no detail'}`
        });
        if (!ok) {
          setResults(collected);
          throw new Error('Check Remote failed — stopping preflight.');
        }
      } catch (err) {
        if (collected.length === 0) {
          collected.push({
            step: 'check-remote',
            ok: false,
            detail: err instanceof Error ? err.message : String(err)
          });
        }
        setResults(collected);
        throw err;
      }

      // Step 2: pipeline-fetch-tags
      setCurrent('fetch-tags');
      try {
        const r = await adminPost<RunResponseSlim>(
          '/controls/pipeline-fetch-tags/run',
          { inputs: {}, confirmations: {} }
        );
        const ok = r.accepted && isSuccessRunStatus(r.runStatus);
        collected.push({
          step: 'fetch-tags',
          ok,
          detail: ok
            ? `exit ${r.exitCode ?? 0}${r.durationMs != null ? ` · ${Math.round(r.durationMs)} ms` : ''}`
            : `${r.runStatus}: ${r.reason || 'no detail'}`
        });
        if (!ok) {
          setResults(collected);
          throw new Error('Fetch Tags failed — stopping preflight.');
        }
      } catch (err) {
        collected.push({
          step: 'fetch-tags',
          ok: false,
          detail: err instanceof Error ? err.message : String(err)
        });
        setResults(collected);
        throw err;
      }

      // Step 3: refresh branches
      setCurrent('refresh-branches');
      await qc.invalidateQueries({ queryKey: ['admin', 'git', 'branches-dev'] });
      await qc.invalidateQueries({ queryKey: ['admin', 'git', 'status'] });
      collected.push({
        step: 'refresh-branches',
        ok: true,
        detail: 'invalidated branches-dev + git status'
      });

      // Step 4: refresh packages
      setCurrent('refresh-packages');
      await qc.invalidateQueries({ queryKey: ['admin', 'packages', 'pipeline'] });
      collected.push({
        step: 'refresh-packages',
        ok: true,
        detail: 'invalidated packages list'
      });

      // Step 5: refresh controls registry
      setCurrent('refresh-controls');
      await qc.invalidateQueries({ queryKey: ['admin', 'controls'] });
      collected.push({
        step: 'refresh-controls',
        ok: true,
        detail: 'invalidated controls registry'
      });

      setResults(collected);
      setCurrent('done');
    },
    onMutate: () => {
      setResults([]);
      setTopError(null);
    },
    onError: (err) => {
      setCurrent('error');
      setTopError(err instanceof Error ? err.message : String(err));
    }
  });

  const running = preflightM.isPending;
  const summaryTone =
    current === 'done'
      ? 'success'
      : current === 'error'
      ? 'danger'
      : running
      ? 'info'
      : 'slate';
  const summaryLabel =
    current === 'done'
      ? 'Preflight complete'
      : current === 'error'
      ? 'Preflight stopped'
      : running
      ? `Running: ${STEP_LABEL[current as keyof typeof STEP_LABEL] ?? current}`
      : 'Preflight not run yet this session';

  return (
    <div
      className="rounded-md border p-3"
      style={{
        borderColor: 'var(--w3-border-section)',
        background: 'rgba(15,23,42,0.45)'
      }}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ShieldCheck size={13} style={{ color: 'var(--status-info)' }} />
          <div className="text-[12px] font-semibold uppercase tracking-wide"
               style={{ color: 'var(--w3-text)' }}>
            Safe Preflight
          </div>
        </div>
        <Badge tone={summaryTone as 'success' | 'danger' | 'info' | 'slate'}>
          {summaryLabel}
        </Badge>
      </div>

      <p className="mb-2 text-[11px]" style={{ color: 'var(--w3-text-muted)' }}>
        Runs Check Remote &rarr; Fetch Tags &rarr; refresh branch / package / controls lists.
        Read-only. Does not package, verify, deploy, tag, reset, rollback, or push.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn"
          disabled={running}
          onClick={() => preflightM.mutate()}
        >
          {running ? <Loader2 size={11} className="animate-spin" /> : <ShieldCheck size={11} />}
          {running ? 'Running preflight...' : 'Run Safe Preflight'}
        </button>
        {topError ? (
          <span className="text-[11px]" style={{ color: 'var(--status-danger)' }}>
            {topError}
          </span>
        ) : null}
      </div>

      {results.length > 0 ? (
        <ul className="mt-3 space-y-1 text-[11px]">
          {results.map((r) => (
            <li key={r.step} className="flex items-start gap-2 font-mono">
              {r.ok ? (
                <CheckCircle2 size={11} style={{ color: 'var(--status-success)' }} />
              ) : (
                <AlertCircle size={11} style={{ color: 'var(--status-danger)' }} />
              )}
              <span style={{ color: 'var(--w3-text)' }}>{STEP_LABEL[r.step]}</span>
              <span style={{ color: 'var(--w3-text-muted)' }}>· {r.detail}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
