import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Info, Play, ShieldCheck, Sliders } from 'lucide-react';
import { Card, CardBody, CardHeader } from '../components/ui/Card';
import { SectionHeader } from '../components/ui/SectionHeader';
import { LoadingState, ErrorState, EmptyState } from '../components/ui/States';
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
interface ListResp { controls: ControlPublic[]; counts: { total: number; riskLow: number } }
interface RunResult {
  controlId: string; appId: string; scriptName: string; args: string[];
  exitCode: number; durationMs: number; stdout: string; stderr: string; timedOut: boolean;
}
const APP_ID = 'w3forge';
const SECTIONS = [
  { id: 'workflow', label: 'Workflow', description: 'Inspect the registered engineering workflow.' },
  { id: 'review', label: 'Review', description: 'Review workspace changes and validation results.' },
  { id: 'inspect-test', label: 'Inspect / Test', description: 'Inspect and verify the development workspace.' },
  { id: 'system-health', label: 'System Health', description: 'Read the current engineering system state.' }
] as const;

// The standard Controls page presentation, using Forge's existing read-only registry.
// The action payload and safeRunner execution path remain unchanged.
export function ControlsPage() {
  const list = useQuery({ queryKey: ['controls'], queryFn: () => adminGet<ListResp>('/controls') });
  const data = list.data;
  const sections = SECTIONS.map((section) => ({ ...section, controls: data?.controls.filter((control) => control.category === section.id) ?? [] }));
  return (
    <div className="space-y-4">
      <SectionHeader title="Controls" subtitle="Operator actions for W3 Forge. Registry-driven and gated by safe wrappers."
        actions={<Badge tone="success"><ShieldCheck size={11} />Read Only</Badge>} />
      {list.isLoading ? <LoadingState label="Loading control registry…" /> : null}
      {list.isError ? <ErrorState error={list.error} title="Failed to load controls" /> : null}
      {data ? <>
        <div className="rounded-md border p-3 text-xs" style={{ background: 'var(--w3-card)', borderColor: 'var(--w3-border-tile)', color: 'var(--w3-text-muted)' }}>
          <div className="flex flex-wrap items-center gap-2">
            <Sliders size={13} style={{ color: 'var(--w3-gold-400)' }} />
            <span className="font-medium text-[var(--w3-text)]">{data.counts.total} control{data.counts.total === 1 ? '' : 's'}</span>
            <span className="text-[var(--w3-text-dim)]">Buckets: {data.controls.length} UI ready</span>
            <span className="text-[var(--w3-text-dim)]">Risk: {data.counts.riskLow} low</span>
          </div>
          <p className="mt-1.5 text-[11px]" style={{ color: 'var(--w3-text-dim)' }}>
            Cards below show the registered read-only controls available to Forge administrators. Each action runs through its approved wrapper and returns its output here.
          </p>
        </div>
        <div className="space-y-5">
          {sections.filter((section) => section.controls.length > 0).map((section) => <section key={section.id} id={`section-${section.id}`}>
            <header className="mb-2 flex flex-wrap items-end justify-between gap-2">
              <div><h3 className="text-sm font-semibold text-[var(--w3-text)]">{section.label}</h3><p className="text-[11px] text-[var(--w3-text-muted)]">{section.description}</p></div>
              <div className="flex flex-wrap items-center gap-1.5"><Badge tone="slate">{section.controls.length} item{section.controls.length === 1 ? '' : 's'}</Badge><Badge tone="success">{section.controls.length} UI ready</Badge></div>
            </header>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">{section.controls.map((control) => <ControlCard key={control.id} control={control} />)}</div>
          </section>)}
          {data.controls.length === 0 ? <EmptyState>No Registered Controls.</EmptyState> : null}
        </div>
      </> : null}
    </div>
  );
}

function ControlCard({ control }: { control: ControlPublic }) {
  const [result, setResult] = useState<RunResult | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const qc = useQueryClient();
  const mutate = useMutation({
    mutationFn: () => adminPost<RunResult>(`/controls/${control.id}/run`, { controlId: control.id, appId: APP_ID }),
    onMutate: () => { setResult(null); setErrMsg(null); },
    onSuccess: (response) => { setResult(response); void qc.invalidateQueries({ queryKey: ['system'] }); },
    onError: (error) => { setResult(null); setErrMsg(error instanceof Error ? error.message : String(error)); }
  });
  return (
    <Card>
      <CardHeader title={<span className="truncate">{control.label}</span>}
        subtitle={<span className="font-mono text-[11px] truncate block" style={{ color: 'var(--w3-text-dim)' }} title={`${control.id} · ${control.scriptName}`}>{control.id} · {control.scriptName}</span>}
        right={<><Badge tone="success">{control.riskLevel}</Badge><Badge tone="success">UI Ready</Badge></>} />
      <CardBody>
        <p className="text-xs leading-relaxed text-[var(--w3-text-muted)]">{control.description}</p>
        <div className="mt-2 flex flex-wrap gap-1"><Badge tone="slate">Read Only</Badge><Badge tone="slate">Safe Direct</Badge></div>
        <details className="mt-3 rounded-md border" style={{ background: 'rgba(7,18,37,0.45)', borderColor: 'var(--w3-border-section)' }}>
          <summary className="flex cursor-pointer items-center gap-1.5 px-2.5 py-1.5 text-[10px] font-medium uppercase tracking-[0.1em]" style={{ color: 'var(--w3-text-dim)' }}><Info size={12} className="shrink-0" /><span>Technical Details</span></summary>
          <div className="space-y-1 px-2.5 pb-2.5 pt-1 text-[11px] leading-relaxed" style={{ color: 'var(--w3-text-muted)' }}>
            <div>App: {APP_ID}</div><div className="break-all">Script: {control.scriptName}</div><div>Strategy: {control.runStrategy}</div><div>Read Only: {String(control.readOnly)}</div>
          </div>
        </details>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t pt-2.5" style={{ borderColor: 'var(--w3-border-row)' }}>
          <div className="text-[10px] uppercase tracking-[0.1em] text-[var(--w3-text-dim)]">Timeout: {control.timeoutSeconds}s</div>
          <button type="button" onClick={() => mutate.mutate()} disabled={mutate.isPending} className="btn text-xs"
            style={{ background: 'var(--w3-gold-500)', color: '#1A1206', border: '1px solid var(--w3-gold-500)', opacity: mutate.isPending ? 0.6 : 1 }}>
            <span className="mr-1.5 inline-flex items-center"><Play size={12} /></span>{mutate.isPending ? 'Running…' : 'Run'}
          </button>
        </div>
        {errMsg ? <div className="mt-2 rounded-md border p-2 text-xs" role="alert" style={{ background: 'var(--status-danger-bg)', borderColor: 'rgba(239,68,68,0.4)', color: 'var(--status-danger)' }}>{errMsg}</div> : null}
        {result ? <div className="mt-3 rounded-md border p-2.5 text-[11px]" style={{ background: 'rgba(7,18,37,0.6)', borderColor: 'var(--w3-border-section)' }}>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={result.timedOut ? 'warning' : result.exitCode === 0 ? 'success' : 'danger'}>{result.timedOut ? 'Timed Out' : result.exitCode === 0 ? 'Success' : 'Failed'}</Badge>
            <span className="text-[var(--w3-text-muted)]">exit {result.exitCode}</span><span className="text-[var(--w3-text-muted)]">{result.durationMs}ms</span>
          </div>
          <details className="mt-2 text-[var(--w3-text-muted)]"><summary className="cursor-pointer">Arguments</summary><pre className="mt-1 overflow-x-auto whitespace-pre-wrap font-mono text-[10.5px]">{JSON.stringify(result.args)}</pre></details>
          {result.stdout ? <pre className="mt-2 max-h-[40vh] overflow-auto whitespace-pre-wrap font-mono text-[10.5px] leading-snug" style={{ color: 'var(--w3-text-muted)' }}>{result.stdout}</pre> : null}
          {result.stderr ? <pre className="mt-2 max-h-[40vh] overflow-auto whitespace-pre-wrap font-mono text-[10.5px] leading-snug" style={{ color: 'var(--status-warning)' }}>{result.stderr}</pre> : null}
        </div> : null}
      </CardBody>
    </Card>
  );
}
