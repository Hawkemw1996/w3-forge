import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Play, ShieldCheck } from 'lucide-react';
import { Card, CardHeader } from '../components/ui/Card';
import { SectionHeader } from '../components/ui/SectionHeader';
import { LoadingState, ErrorState } from '../components/ui/States';
import { Badge } from '../components/ui/Badge';
import { adminGet, adminPost } from '../lib/api';

interface ControlPublic {
  id: string;
  label: string;
  description: string;
  category: 'workflow' | 'review' | 'inspect-test' | 'system-health';
  scriptName: string;
  riskLevel: 'LOW';
  runStrategy: 'safe-direct';
  readOnly: true;
  timeoutSeconds: number;
  inputs: string[];
}
interface ListResp {
  controls: ControlPublic[];
  counts: { total: number; riskLow: number };
}
interface RunResult {
  controlId: string;
  appId: string;
  scriptName: string;
  args: string[];
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const APP_ID = 'w3forge';

export function ControlsPage() {
  const list = useQuery({
    queryKey: ['controls'],
    queryFn: () => adminGet<ListResp>('/controls')
  });

  if (list.isLoading) return <LoadingState label="Loading controls" />;
  if (list.isError) return <ErrorState error={list.error} />;
  const data = list.data!;

  const byCat: Record<string, ControlPublic[]> = {};
  for (const c of data.controls) {
    (byCat[c.category] ||= []).push(c);
  }

  return (
    <div className="space-y-5">
      <SectionHeader
        title="Controls"
        subtitle={`${data.counts.total} Forge-safe controls · all LOW · safe-direct · read-only`}
      />
      <div className="flex flex-wrap gap-2">
        <Badge tone="success">
          <ShieldCheck size={11} /> {data.counts.riskLow} LOW
        </Badge>
        <Badge tone="slate">App: {APP_ID}</Badge>
      </div>
      {Object.entries(byCat).map(([cat, ctrls]) => (
        <div key={cat} className="space-y-3">
          <div className="text-xs uppercase tracking-wider" style={{ color: 'var(--w3-text-muted)' }}>
            {cat}
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {ctrls.map((c) => (
              <ControlCard key={c.id} control={c} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function ControlCard({ control }: { control: ControlPublic }) {
  const [result, setResult] = useState<RunResult | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const qc = useQueryClient();
  const mutate = useMutation({
    mutationFn: async () =>
      adminPost<RunResult>(`/controls/${control.id}/run`, {
        controlId: control.id,
        appId: APP_ID
      }),
    onSuccess: (r) => {
      setErrMsg(null);
      setResult(r);
      qc.invalidateQueries({ queryKey: ['system'] });
    },
    onError: (e) => {
      setResult(null);
      setErrMsg(e instanceof Error ? e.message : String(e));
    }
  });

  return (
    <Card>
      <CardHeader
        title={control.label}
        subtitle={control.description}
        right={
          <button
            type="button"
            className="btn btn-primary"
            disabled={mutate.isPending}
            onClick={() => mutate.mutate()}
          >
            <Play size={12} />
            {mutate.isPending ? 'Running…' : 'Run'}
          </button>
        }
      />
      <div className="card-body space-y-2 text-xs" style={{ color: 'var(--w3-text-muted)' }}>
        <div>script: <span style={{ color: 'var(--w3-text)' }}>{control.scriptName}</span></div>
        <div>timeout: {control.timeoutSeconds}s · risk: {control.riskLevel}</div>
        {errMsg ? (
          <pre
            className="rounded-md p-2 text-[11px] whitespace-pre-wrap"
            style={{ background: 'var(--status-danger-bg)', color: 'var(--status-danger)' }}
          >
            {errMsg}
          </pre>
        ) : null}
        {result ? (
          <div className="space-y-1">
            <div className="flex gap-2">
              <Badge tone={result.exitCode === 0 ? 'success' : 'danger'}>
                exit {result.exitCode}
              </Badge>
              <Badge tone="slate">{result.durationMs} ms</Badge>
              {result.timedOut ? <Badge tone="warning">timed out</Badge> : null}
            </div>
            <details>
              <summary className="cursor-pointer">argv</summary>
              <pre className="rounded-md p-2 text-[11px]" style={{ background: 'var(--w3-surface)' }}>
                {JSON.stringify(result.args)}
              </pre>
            </details>
            {result.stdout ? (
              <details open>
                <summary className="cursor-pointer">stdout</summary>
                <pre
                  className="rounded-md p-2 text-[11px] whitespace-pre-wrap"
                  style={{ background: 'var(--w3-surface)', maxHeight: '40vh', overflow: 'auto' }}
                >
                  {result.stdout}
                </pre>
              </details>
            ) : null}
            {result.stderr ? (
              <details>
                <summary className="cursor-pointer">stderr</summary>
                <pre
                  className="rounded-md p-2 text-[11px] whitespace-pre-wrap"
                  style={{ background: 'var(--w3-surface)', maxHeight: '40vh', overflow: 'auto' }}
                >
                  {result.stderr}
                </pre>
              </details>
            ) : null}
          </div>
        ) : null}
      </div>
    </Card>
  );
}
