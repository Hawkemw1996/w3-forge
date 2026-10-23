import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ApiError, apiGet, apiPost, errorMessages } from '../lib/authApi';
import { AgentMarkdown } from './Agents';
import ExecutionRecords from './ExecutionRecords';
import './execution.css';
export interface ExecutionJob {
    id: string;
    requestId: string;
    projectId: string;
    status: string;
    revision: number;
    round: number;
    baseCommit: string | null;
    candidateCommit: string | null;
    specification: string;
    summary: string;
    errorCode: string | null;
    cancelRequested: boolean;
    reconciliationRequired: boolean;
    createdAt: string;
    updatedAt: string;
    context: {
        request: {
            branch: string;
        };
        rules: {
            version: number;
            markdown: string;
            checksum: string;
        };
        profiles: Array<{
            id: string;
            slug: string;
            name: string;
            purpose: string;
            profileVersion: string;
            profileMarkdown: string;
            profileChecksum: string;
            provider: string;
            model: string | null;
        }>;
    };
}
interface Event {
    id: string;
    kind: string;
    data: Record<string, unknown>;
    createdAt: string;
}
const labels: Record<string, string> = { queued: 'Queued', planning: 'Writing specification', awaiting_approval: 'Awaiting specification approval', developing: 'Developing', testing: 'Running tests', reviewing: 'Reviewing candidate', ready: 'Ready for owner review', blocked: 'Blocked', cancelled: 'Cancelled' };
const reserved = (j: ExecutionJob) => !['ready', 'cancelled'].includes(j.status) || j.cancelRequested && j.status !== 'cancelled' || j.reconciliationRequired;
const date = (s: string) => new Date(s).toLocaleString();
const root = '/api/forge/execution';
function ErrorBox({ error }: {
    error: unknown;
}) { return error ? <div className="factory-alert factory-alert-error" role="alert">{errorMessages(error).map((m, i) => <p key={i}>{m}</p>)}</div> : null; }
export default function ExecutionPanel({ request, disabled, onChanged }: {
    request: {
        id: string;
        revision: number;
        status: string;
        branch: string;
    };
    disabled: boolean;
    onChanged: () => void | Promise<void>;
}) {
    const [selected, setSelected] = useState<string | null>(null), [pending, setPending] = useState(''), [failure, setFailure] = useState<string[]>([]);
    const availability = useQuery({ queryKey: ['forge-execution-status'], queryFn: () => apiGet<{
            available: boolean;
            message: string;
            maxCorrections: number;
        }>(root + '/status'), refetchInterval: 15000, retry: false });
    const history = useQuery({ queryKey: ['forge-execution-jobs', request.id], queryFn: () => apiGet<{
            jobs: ExecutionJob[];
        }>(root + '/requests/' + encodeURIComponent(request.id) + '/jobs'), refetchInterval: 2000, retry: false });
    const jobs = history.isError ? [] : [...(history.data?.jobs ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const id = jobs.find(j => j.id === selected)?.id ?? jobs[0]?.id;
    const detail = useQuery({ queryKey: ['forge-execution-job', id], queryFn: () => apiGet<ExecutionJob>(root + '/jobs/' + encodeURIComponent(id!)), enabled: !!id, refetchInterval: 2000, retry: false });
    const evidence = useQuery({ queryKey: ['forge-execution-events', id], queryFn: () => apiGet<{
            events: Event[];
        }>(root + '/jobs/' + encodeURIComponent(id!) + '/events'), enabled: !!id, refetchInterval: 2000, retry: false });
    const job = !history.isError && !detail.isError ? detail.data : undefined;
    const events = evidence.isError ? [] : evidence.data?.events ?? [];
    const diff = [...events].reverse().find(e => e.kind === 'candidate_diff' && typeof e.data.diff === 'string' && (!e.data.commit || e.data.commit === job?.candidateCommit));
    const busy = disabled || !!pending;
    async function refresh() { await Promise.all([availability.refetch(), history.refetch(), ...(id ? [detail.refetch(), evidence.refetch()] : []), Promise.resolve().then(onChanged).catch(() => undefined)]); }
    async function act(action: string) {
        if (busy || action !== 'start' && !job)
            return;
        setPending(action);
        setFailure([]);
        try {
            await apiPost(action === 'start' ? root + '/requests/' + encodeURIComponent(request.id) + '/start' : root + '/jobs/' + encodeURIComponent(job!.id) + '/' + action, { expectedRevision: action === 'start' ? request.revision : job!.revision });
            if (action === 'start' || action === 'retry')
                setSelected(null);
            await refresh();
        }
        catch (e) {
            setFailure(e instanceof ApiError && e.status === 409 ? ['The request or run changed. The latest state has been refreshed; review it before trying again.', ...errorMessages(e)] : errorMessages(e));
            await refresh();
        }
        finally {
            setPending('');
        }
    }
    function download() { if (!job || !diff)
        return; const url = URL.createObjectURL(new Blob([String(diff.data.diff)], { type: 'text/x-diff;charset=utf-8' })); const a = document.createElement('a'); a.href = url; a.download = 'forge-' + job.id + '.patch'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 0); }
    return <section className="card factory-card execution-panel" aria-labelledby="execution-heading">
  <div className="factory-section-heading execution-heading"><div><h2 id="execution-heading">Factory execution</h2><p>Generate a specification, approve it, then run development, tests and agent review.</p></div><button className="btn btn-primary" disabled={busy || request.status !== 'queued' || jobs.some(reserved) || history.isPending || history.isError || !availability.data?.available || availability.isError} onClick={() => void act('start')}>{pending === 'start' ? 'Starting…' : 'Start factory'}</button></div>
  <div className="factory-card-body execution-body"><p className="factory-muted">One factory run can execute at a time. Up to two correction attempts follow the initial development attempt. A completed run still needs owner review and the existing release process.</p>
   {failure.length > 0 && <div className="factory-alert factory-alert-error" role="alert">{failure.map((m, i) => <p key={i}>{m}</p>)}</div>}
   <ErrorBox error={availability.error}/><ErrorBox error={history.error}/>
   {availability.data && !availability.isError && !availability.data.available && <div className="execution-notice" role="status"><strong>Factory execution is unavailable</strong><p>{availability.data.message}</p></div>}
   {(availability.isPending || history.isPending) && <p role="status">Loading factory execution…</p>}
   {!history.isPending && !history.isError && !jobs.length && <p className="factory-muted">No factory execution has been recorded for this request.</p>}
   {jobs.length > 0 && <label className="execution-run-picker">Execution history<select className="input" value={id ?? ''} onChange={e => { setSelected(e.target.value); setFailure([]); }}>{jobs.map(j => <option key={j.id} value={j.id}>{date(j.createdAt)} · {j.cancelRequested && j.status !== 'cancelled' ? 'Cancellation requested' : labels[j.status]}</option>)}</select></label>}
   <ErrorBox error={id ? detail.error : null}/>
   {job && <div className="execution-run"><div className="execution-run-heading"><div><span className={'badge execution-status execution-status-' + job.status} role="status">{job.cancelRequested && job.status !== 'cancelled' ? 'Cancellation requested' : labels[job.status]}</span><p className="factory-muted">Updated {date(job.updatedAt)}</p></div><div className="execution-actions">
    {job.status === 'awaiting_approval' && !job.cancelRequested && <button className="btn btn-primary" disabled={busy || job.id !== jobs[0]?.id || !job.specification.trim()} onClick={() => void act('approve')}>{pending === 'approve' ? 'Approving…' : 'Approve specification and start development'}</button>}
    {!['ready', 'cancelled'].includes(job.status) && <button className="btn" disabled={busy || job.id !== jobs[0]?.id || job.cancelRequested} onClick={() => void act('cancel')}>{pending === 'cancel' || job.cancelRequested ? 'Cancellation requested' : 'Request cancellation'}</button>}
    {job.status === 'blocked' && <button className="btn" disabled={busy || job.id !== jobs[0]?.id || job.reconciliationRequired || job.cancelRequested} onClick={() => void act('retry')}>{pending === 'retry' ? 'Starting retry…' : 'Retry factory run'}</button>}
   </div></div>
   {job.summary && <p className="execution-summary">{job.summary}</p>}
   {job.cancelRequested && job.status !== 'cancelled' && <div className="execution-notice" role="status">Cancellation is pending. The run remains active until the worker confirms cleanup.</div>}
   {job.reconciliationRequired && <div className="execution-notice" role="status">Runtime cleanup must be verified before this run can be retried. Check the latest evidence for the recovery details.</div>}
   {job.errorCode && <p className="factory-muted">Runtime error: <code>{job.errorCode}</code></p>}
   <dl className="execution-facts"><div><dt>Branch</dt><dd><code>{job.context.request.branch}</code></dd></div><div><dt>Development attempt</dt><dd>{job.round === 0 ? 'Not started' : job.round + ' of 3'}</dd></div><div><dt>Base commit</dt><dd><code>{job.baseCommit || 'Not recorded yet'}</code></dd></div><div><dt>Candidate commit</dt><dd><code>{job.candidateCommit || 'Not recorded yet'}</code></dd></div></dl>
   {job.specification && <details className="execution-details" open={job.status === 'awaiting_approval'}><summary>Specification{job.status === 'awaiting_approval' ? ' · review before approving' : ''}</summary><div className="execution-markdown"><AgentMarkdown source={job.specification}/></div></details>}
   <details className="execution-details"><summary>Frozen profiles and model assignments · {job.context.profiles.length} profiles</summary><p className="factory-muted">This run keeps these profile versions and model assignments even if the Agents or AI Connections settings change.</p><div className="execution-profile-list">{job.context.profiles.map(p => <div className="execution-profile" key={p.id}><strong>{p.name}</strong> <span className="badge">v{p.profileVersion}</span><p>{p.purpose}</p><p className="factory-muted">{p.provider} · {p.model || 'Provider default model'}</p><details><summary>Profile Markdown</summary><div className="execution-markdown"><AgentMarkdown source={p.profileMarkdown}/></div><p className="execution-checksum">Checksum: <code>{p.profileChecksum}</code></p></details></div>)}</div><details className="execution-rules"><summary>Project rules · v{String(job.context.rules.version)}</summary><div className="execution-markdown"><AgentMarkdown source={job.context.rules.markdown}/></div><p className="execution-checksum"><code>{job.context.rules.checksum}</code></p></details></details>
   <ExecutionRecords key={job.id} jobId={job.id}/>
   <div className="execution-evidence-heading"><div><h3>Execution evidence</h3><p className="factory-muted">Recorded factory events. Earlier administrator-reported receipts are separate.</p></div>{diff && <button className="btn" onClick={download}>Download candidate diff</button>}</div><ErrorBox error={evidence.error}/>
   {!evidence.isError && <ol className="execution-events">{events.map(e => <li key={e.id}><details><summary><strong>{e.kind.replace(/[_-]+/g, ' ')}</strong><time dateTime={e.createdAt}>{date(e.createdAt)}</time></summary><pre>{e.kind === 'candidate_diff' ? String(e.data.diff) : JSON.stringify(e.data, null, 2)}</pre></details></li>)}</ol>}
   </div>}
  </div>
 </section>;
}
